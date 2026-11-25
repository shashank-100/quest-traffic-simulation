import { buildNetwork, segmentLevel, type CompiledNode, type Connector, type Lane, type Network, type Segment } from './network';
import { Rng } from './rng';
import { freeFlowCost, reachableExits, shortestRoute, shortestRouteVia, viaReached, type EdgeCost } from './routing';
import { lightFor, signalStatus, type LightState } from './signals';
import { idmAccel, laneWidthEffect, VEHICLE_PARAMS, type LaneEffect, type VehicleParams } from './vehicles';
import { rightNormal, scale, norm, sub } from './geometry';
import type { FlowDef, Scenario, VehicleType } from './types';

export const DT = 0.1;
const SAMPLE_EVERY = 1; // seconds between metric samples
const LANE_CHANGE_EVERY = 5; // steps
const MOBIL_THRESHOLD = 0.25;
const SAFE_DECEL = 4;
const QUEUE_SPEED = 2; // m/s below which a vehicle counts as queued
/** Fraction (0–1] of a step's displacement `ds` covered before crossing a line it overshot by `over`. */
function exitFraction(over: number, ds: number): number {
  return ds > 0 ? Math.min(1, Math.max(0, 1 - over / ds)) : 1;
}

/**
 * Acceleration limit from the junction curves ahead, for a vehicle at `speed` with maximum
 * acceleration `accel` and comfortable deceleration `decel`. For each curve the vehicle must slow
 * for, r = (speed² − limit²) / (2·distance) is the deceleration that would bring it to the curve's
 * safe speed exactly at the curve. The limit is accel − r·(1 + accel/decel): full acceleration
 * while no slowing is needed (r = 0), tapering continuously to zero and then to braking at exactly
 * `decel` when r reaches it, and harder beyond. Being continuous in speed and distance, vehicles
 * ease off before braking (as drivers do), never crawl between curves, and arrive at each curve at
 * its safe speed. `upcoming` lists the movements ahead with their distance from the front bumper.
 * Shared by the simulation and the free-flow reference so both take curves identically.
 */
export function curveAccelLimit(speed: number, accel: number, decel: number, upcoming: Iterable<{ dist: number; limit: number }>): number {
  let bound = Infinity;
  for (const { dist, limit } of upcoming) {
    if (speed <= limit) continue;
    const r = (speed * speed - limit * limit) / (2 * Math.max(0.5, dist));
    bound = Math.min(bound, accel - r * (1 + accel / decel));
  }
  return bound;
}

/**
 * How far ahead along its route a vehicle looks for leaders and stop lines (m). Beyond about twice
 * the IDM desired gap at urban speeds (s* ≈ 90 m at 60 km/h), an obstacle has no measurable effect.
 */
const LOOKAHEAD = 300;
/** Height of a flyover deck above ground (m); sets ramp gradients. */
export const DECK_HEIGHT = 6;
const G = 9.81;

export interface Vehicle {
  id: number;
  type: VehicleType;
  p: VehicleParams;
  /** Personal desired speed (m/s). */
  v0: number;
  seg: number;
  /** Front-bumper position along the current segment. */
  s: number;
  v: number;
  acc: number;
  route: number[];
  /** Junctions this vehicle must still pass through in order (its flow's via-points). */
  via: string[];
  /** Index into route of the edge being driven (or being left, while on a connector). */
  ri: number;
  dest: string;
  flowId: string;
  spawnT: number;
  entryWait: number;
  dist: number;
  freeFlowTime: number;
  /** Connector this vehicle may enter at the next junction. */
  grant: number | null;
  /** Connector whose junction area this vehicle's body still occupies. */
  occupying: number | null;
  requestT: number;
  stuckT: number;
  stoppedTime: number;
  lastLaneChange: number;
  /** Lateral offset (m, toward kerb) still being animated after a lane change. */
  lat: number;
  edgeEnterT: number;
}

export interface TripRecord {
  id: number;
  type: VehicleType;
  flowId: string;
  travelTime: number;
  freeFlowTime: number;
  distance: number;
  entryWait: number;
  stoppedTime: number;
  exitT: number;
}

export interface Sample {
  t: number;
  active: number;
  meanSpeed: number;
  throughput: number; // veh/h over the last 60 s
  exited: number;
  queued: number;
  queueLength: number; // total metres of queues at junction approaches
  maxLaneQueue: number; // longest single-lane queue (m)
  backlog: number;
  density: number; // network-wide veh/km/lane
}

export interface EdgeLive {
  count: number;
  meanSpeed: number;
  density: number; // veh/km/lane
  congestion: number; // 0 free-flow … 1 jammed
  queueLength: number; // metres, longest lane queue at the downstream junction
}

export interface Summary {
  simTime: number;
  spawned: number;
  completed: number;
  active: number;
  backlog: number;
  avgTravelTime: number;
  avgDelay: number;
  avgTripSpeed: number;
  avgSpeed: number;
  /** Steady-state exit rate: trips completed after the warm-up, per hour of measurement. */
  throughputPerHour: number;
  /**
   * Seconds discarded before measuring: the longest free-flow trip time among completed trips (by
   * then vehicles that entered at the start have had time to cross the longest route), capped at
   * half the run so there is always a measurement window.
   */
  warmup: number;
  /** Trips that entered after the warm-up and have completed: the basis of the trip averages. */
  measuredTrips: number;
  avgQueueLength: number;
  maxQueueLength: number;
  avgDensity: number;
  stopsShare: number;
  unroutable: number;
  safetyInterventions: number;
}

interface FlowState {
  def: FlowDef;
  nextT: number;
  generated: number;
  backlog: { type: VehicleType; dest: string | null; requestT: number }[];
  entryEdge: number | null;
}

export class Simulation {
  readonly net: Network;
  readonly scenario: Scenario;
  t = 0;
  steps = 0;
  vehicles: Vehicle[] = [];
  trips: TripRecord[] = [];
  samples: Sample[] = [];
  /** Vehicles per segment, sorted by s ascending. */
  occ: Vehicle[][];
  /** Vehicles that entered each junction (node id → count). */
  nodeThroughput = new Map<string, number>();
  spawned = 0;
  laneChangeCount = 0;
  unroutable = 0;
  safetyInterventions = 0;

  private rng: Rng;
  private nextId = 1;
  private flows: FlowState[];
  private routeCache = new Map<string, number[] | null>();
  private edgeTT: Float64Array;
  private cost: EdgeCost;
  private sideSign: number;
  private exitTimes: number[] = [];
  /** Per segment, per vehicle type: lane-width effect on desired speed and headway. */
  private laneEffect: Record<VehicleType, LaneEffect>[];
  /** Per segment: uphill gradient (rise/run, ≥ 0). */
  private grade: Float64Array;
  private queueByLane = new Map<number, number>();
  /** Vehicles on, or granted onto, each connector that has merge partners (rebuilt every step). */
  private mergeUsers = new Map<number, Vehicle[]>();
  /** Simulation time at which a vehicle last entered each connector (indexed by segment id). */
  private lastEntry: Float64Array;
  /** Connectors ending in each lane (indexed by lane segment id). */
  private connectorsInto: number[][];

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.net = buildNetwork(scenario);
    this.rng = new Rng(scenario.seed);
    this.occ = this.net.segments.map(() => []);
    this.connectorsInto = this.net.segments.map(() => []);
    this.lastEntry = new Float64Array(this.net.segments.length).fill(-Infinity);
    for (const c of this.net.connectors) this.connectorsInto[c.toLane].push(c.id);
    this.laneEffect = this.net.segments.map((seg) => {
      const e = {} as Record<VehicleType, LaneEffect>;
      for (const k of ['car', 'bus', 'bike', 'truck'] as const) e[k] = laneWidthEffect(seg.width, VEHICLE_PARAMS[k].width);
      return e;
    });
    this.grade = Float64Array.from(this.net.segments, (seg) =>
      seg.kind === 'lane' && seg.levelTo > seg.levelFrom ? (DECK_HEIGHT * (seg.levelTo - seg.levelFrom)) / seg.length : 0,
    );
    this.sideSign = scenario.driveSide === 'right' ? 1 : -1;
    const ff = freeFlowCost(this.net);
    this.edgeTT = new Float64Array(this.net.edges.length);
    this.net.edges.forEach((e) => (this.edgeTT[e.id] = e.length / Math.max(1, e.speedLimit)));
    this.cost = scenario.congestionAwareRouting
      ? (id) => ff(id) - this.net.edges[id].length / Math.max(1, this.net.edges[id].speedLimit) + this.edgeTT[id]
      : ff;
    this.flows = scenario.flows.map((def) => {
      const entry = this.net.entryEdges.find((e) => this.net.edges[e].from === def.origin) ?? null;
      if (entry === null) this.net.warnings.push(`Flow ${def.name ?? def.id}: origin is not an entry point.`);
      return {
        def,
        entryEdge: entry,
        generated: 0,
        backlog: [],
        nextT: def.start + (def.rate > 0 ? this.rng.exponential(def.rate / 3600) : Infinity),
      };
    });
  }

  // ---------------------------------------------------------------- public API

  step(): void {
    this.t += DT;
    this.steps++;
    this.spawn();
    this.junctionControl();
    this.move();
    this.rebuildOccupancy();
    if (this.steps % LANE_CHANGE_EVERY === 0) this.laneChanges();
    this.updateStuck();
    this.animateLateral();
    if (this.scenario.congestionAwareRouting && this.steps % 300 === 0) this.routeCache.clear();
    if (this.steps % Math.round(SAMPLE_EVERY / DT) === 0) this.sample();
  }

  run(seconds: number, onProgress?: (fraction: number) => void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.step();
      if (onProgress && i % 500 === 0) onProgress(i / n);
    }
  }

  segment(id: number): Segment {
    return this.net.segments[id];
  }

  pose(v: Vehicle): { x: number; y: number; heading: number; level: number } {
    const seg = this.net.segments[v.seg];
    const p = seg.path.pose(v.s - v.p.length / 2);
    let { x, y } = p;
    if (v.lat !== 0 && seg.kind === 'lane') {
      const d = norm(sub(seg.path.points[1], seg.path.points[0]));
      const side = scale(rightNormal(d), this.sideSign);
      x += side.x * v.lat;
      y += side.y * v.lat;
    }
    return { x, y, heading: p.heading, level: segmentLevel(seg, v.s) };
  }

  /** Moves a vehicle to another lane position (used by tests and tooling to set up situations). */
  relocate(v: Vehicle, laneId: number, s: number): void {
    const lane = this.net.segments[laneId];
    if (lane.kind !== 'lane') throw new Error('relocate expects a lane');
    v.seg = laneId;
    v.s = s;
    v.ri = v.route.indexOf(lane.edge);
    v.grant = null;
    v.requestT = -1;
    this.rebuildOccupancy();
  }

  backlogCount(): number {
    return this.flows.reduce((a, f) => a + f.backlog.length, 0);
  }

  edgeLive(edgeId: number): EdgeLive {
    const e = this.net.edges[edgeId];
    let count = 0;
    let speed = 0;
    let queue = 0;
    for (const lid of e.lanes) {
      for (const v of this.occ[lid]) {
        count++;
        speed += v.v;
      }
      queue = Math.max(queue, this.queueByLane.get(lid) ?? 0);
    }
    const meanSpeed = count ? speed / count : e.speedLimit;
    const density = count / Math.max(0.001, (e.length * e.lanes.length) / 1000);
    return {
      count,
      meanSpeed,
      density,
      congestion: count ? Math.max(0, Math.min(1, 1 - meanSpeed / e.speedLimit)) : 0,
      queueLength: queue,
    };
  }

  laneQueue(laneId: number): number {
    return this.queueByLane.get(laneId) ?? 0;
  }

  /**
   * Performance summary. Everything is measured after the warm-up (see Summary.warmup), when the
   * network has filled: trip averages over trips that entered after it, time averages over samples
   * taken after it. Counts (spawned, completed, active, backlog) cover the whole run.
   */
  summary(): Summary {
    const all = this.trips;
    const warmup = Math.min(this.t / 2, all.reduce((a, r) => Math.max(a, r.freeFlowTime), 0));
    const done = all.filter((r) => r.exitT - r.travelTime >= warmup);
    const n = done.length;
    const sum = (f: (r: TripRecord) => number) => done.reduce((a, r) => a + f(r), 0);
    const totalTime = sum((r) => r.travelTime);
    const samples = this.samples.filter((s) => s.t > warmup);
    const avg = (f: (s: Sample) => number) => (samples.length ? samples.reduce((a, s) => a + f(s), 0) / samples.length : 0);
    const speedSamples = samples.filter((s) => s.active > 0);
    return {
      simTime: this.t,
      spawned: this.spawned,
      completed: all.length,
      active: this.vehicles.length,
      backlog: this.backlogCount(),
      avgTravelTime: n ? totalTime / n : 0,
      avgDelay: n ? sum((r) => Math.max(0, r.travelTime - r.freeFlowTime)) / n : 0,
      avgTripSpeed: totalTime > 0 ? sum((r) => r.distance) / totalTime : 0,
      avgSpeed: speedSamples.length ? speedSamples.reduce((a, s) => a + s.meanSpeed, 0) / speedSamples.length : 0,
      throughputPerHour: this.t > warmup ? (all.filter((r) => r.exitT > warmup).length / (this.t - warmup)) * 3600 : 0,
      warmup,
      measuredTrips: n,
      avgQueueLength: avg((s) => s.queueLength),
      maxQueueLength: Math.max(0, ...samples.map((s) => s.maxLaneQueue)),
      avgDensity: avg((s) => s.density),
      stopsShare: totalTime > 0 ? sum((r) => r.stoppedTime) / totalTime : 0,
      unroutable: this.unroutable,
      safetyInterventions: this.safetyInterventions,
    };
  }

  /**
   * Invariant check used by tests: bumper overlaps on any segment, and pairs of conflicting
   * junction movements occupied at the same time.
   */
  invariantViolations(): string[] {
    const out: string[] = [];
    for (let id = 0; id < this.occ.length; id++) {
      const list = this.occ[id];
      for (let i = 0; i + 1 < list.length; i++) {
        const f = list[i];
        const l = list[i + 1];
        if (f.s > l.s - l.p.length + 1e-6) out.push(`overlap on segment ${id}: ${f.id} into ${l.id}`);
      }
    }
    for (const lane of this.net.lanes) {
      const list = this.occ[lane.id];
      let waiting = false;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].grant === null) waiting = true;
        else if (waiting) out.push(`vehicle ${list[i].id} holds a grant behind a waiting vehicle on lane ${lane.id}`);
      }
    }
    for (const c of this.net.connectors) {
      for (const kid of c.merges) {
        if (kid < c.id) continue;
        const k = this.net.segments[kid] as Connector;
        for (const a of this.occ[c.id]) {
          for (const b of this.occ[kid]) {
            const da = c.length - a.s;
            const db = k.length - b.s;
            // Projected onto the merge point, the two bodies must not overlap.
            if (da < db + b.p.length - 1e-6 && db < da + a.p.length - 1e-6) out.push(`merging vehicles ${a.id} and ${b.id} overlap at movements ${c.id}/${kid}`);
          }
        }
      }
    }
    const occupied = new Set<number>();
    for (const v of this.vehicles) if (v.occupying !== null) occupied.add(v.occupying);
    for (const c of occupied) {
      for (const k of (this.net.segments[c] as Connector).conflicts) {
        if (k > c && occupied.has(k)) out.push(`conflicting movements ${c} and ${k} occupied together`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- demand

  private routeFor(entryEdge: number, dest: string, via: readonly string[]): number[] | null {
    const key = `${entryEdge}>${via.join('>')}>${dest}`;
    if (!this.routeCache.has(key)) this.routeCache.set(key, shortestRouteVia(this.net, entryEdge, via, dest, this.cost));
    return this.routeCache.get(key)!;
  }

  /** Exits reachable from an entry edge after passing the via-points (excluding the origin itself). */
  private exitsAfter(entryEdge: number, via: readonly string[], origin: string): string[] {
    const prefix = via.length ? shortestRouteVia(this.net, entryEdge, via, null, this.cost) : [entryEdge];
    if (!prefix) return [];
    return reachableExits(this.net, prefix[prefix.length - 1]).filter((x) => x !== origin);
  }

  private spawn(): void {
    for (const f of this.flows) {
      const d = f.def;
      while (this.t >= f.nextT && f.nextT < d.end && (d.maxVehicles === undefined || f.generated < d.maxVehicles)) {
        const type = this.rng.pickWeighted(['car', 'bus', 'bike', 'truck'] as const, (k) => d.mix[k]) ?? 'car';
        let dest = d.destination;
        if (!dest && f.entryEdge !== null) {
          const exits = this.exitsAfter(f.entryEdge, d.via ?? [], d.origin);
          dest = exits.length ? exits[this.rng.int(exits.length)] : null;
        }
        f.backlog.push({ type, dest, requestT: f.nextT });
        f.generated++;
        f.nextT += this.rng.exponential(Math.max(1e-6, d.rate) / 3600);
      }
      if (f.entryEdge === null) {
        this.unroutable += f.backlog.length;
        f.backlog.length = 0;
        continue;
      }
      if (f.backlog.length > 0) this.tryInsert(f, f.entryEdge);
    }
  }

  private tryInsert(f: FlowState, entry: number): void {
    const spec = f.backlog[0];
    const dest = spec.dest;
    const route = dest ? this.routeFor(entry, dest, f.def.via ?? []) : null;
    if (!route || !dest) {
      f.backlog.shift();
      this.unroutable++;
      return;
    }
    const p = VEHICLE_PARAMS[spec.type];
    const edge = this.net.edges[entry];
    const v0 = Math.max(3, p.desiredSpeed * f.def.speedFactor * this.rng.normal(1, 0.08));
    // Prefer lanes that already serve the next movement, then the one with the most room.
    let best: { lane: Lane; gap: number; leaderV: number } | null = null;
    for (const lid of edge.lanes) {
      const lane = this.net.segments[lid] as Lane;
      const list = this.occ[lid];
      const leader = list[0];
      const gap = leader ? leader.s - leader.p.length : Infinity;
      const serves = route.length < 2 || lane.connectorsOut.some((c) => (this.net.segments[c] as Connector).toEdge === route[1]);
      const score = (serves ? 1e6 : 0) + Math.min(gap, 1e5);
      const bestServes = best && (route.length < 2 || best.lane.connectorsOut.some((c) => (this.net.segments[c] as Connector).toEdge === route[1]));
      const bestScore = best ? (bestServes ? 1e6 : 0) + Math.min(best.gap, 1e5) : -Infinity;
      if (score > bestScore) best = { lane, gap, leaderV: leader?.v ?? Infinity };
    }
    if (!best) return;
    // Enter the way a vehicle arriving from upstream would: at the leader's speed with an
    // equilibrium gap, or creeping into a standing queue that has backed up to the entry.
    const eff = this.laneEffect[best.lane.id][spec.type];
    const T = p.headway * eff.headway;
    let v = Math.min(v0 * eff.speed, best.lane.speedLimit);
    if (Number.isFinite(best.gap)) {
      if (best.leaderV >= 3) {
        v = Math.min(v, best.leaderV);
        if (best.gap < p.minGap + v * T) return;
      } else {
        if (best.gap < p.minGap + 1) return;
        v = Math.min(v, best.leaderV + 1, Math.max(0, (best.gap - p.minGap) / T));
      }
    }
    f.backlog.shift();
    const veh: Vehicle = {
      id: this.nextId++,
      type: spec.type,
      p,
      v0,
      seg: best.lane.id,
      s: 0,
      v,
      acc: 0,
      route,
      via: f.def.via ?? [],
      ri: 0,
      dest,
      flowId: f.def.id,
      spawnT: this.t,
      entryWait: this.t - spec.requestT,
      dist: 0,
      freeFlowTime: this.soloTravelTime(route, best.lane.id, v, v0, spec.type),
      grant: null,
      occupying: null,
      requestT: -1,
      stuckT: 0,
      stoppedTime: 0,
      lastLaneChange: -Infinity,
      lat: 0,
      edgeEnterT: this.t,
    };
    this.vehicles.push(veh);
    this.occ[best.lane.id].unshift(veh);
    this.spawned++;
  }

  /**
   * Free-flow reference for delay: the time this same driver (type, desired speed, entry lane and
   * speed) would take to drive its route alone. It is computed with the engine's own longitudinal
   * model, stepped exactly like the simulation, so it includes everything a lone vehicle really
   * does: lane-width speed effects, slowing for junction curves and accelerating back out, and
   * reduced acceleration on ramps. Without other traffic there are no leaders, stop lines or
   * waits; a lane change (if the route needs one) is lateral and does not change progress.
   */
  private soloTravelTime(route: number[], startLane: number, startSpeed: number, v0: number, type: VehicleType): number {
    const p = VEHICLE_PARAMS[type];
    // The segments this vehicle drives: its lanes along the route and the movements between them.
    const path: number[] = [startLane];
    let lane = startLane;
    for (let i = 0; i + 1 < route.length; i++) {
      const pick = (lid: number) => (this.net.segments[lid] as Lane).connectorsOut.find((c) => (this.net.segments[c] as Connector).toEdge === route[i + 1]);
      let cid = pick(lane);
      if (cid === undefined) for (const lid of this.net.edges[route[i]].lanes) cid ??= pick(lid);
      const c = this.net.segments[cid!] as Connector;
      path.push(c.id, c.toLane);
      lane = c.toLane;
    }
    let k = 0;
    let s = 0;
    let v = startSpeed;
    for (let steps = 0; ; steps++) {
      const seg = this.net.segments[path[k]];
      // Same acceleration as accelFor() with nothing ahead: free-road IDM towards the same desired
      // speed (lane-width effect and speed limit), the same curve limit over the same LOOKAHEAD, and
      // the same gradient limit.
      const curves: { dist: number; limit: number }[] = [];
      let dist = seg.length - s;
      for (let j = k + 1; j < path.length && dist < LOOKAHEAD; j++) {
        const next = this.net.segments[path[j]];
        if (next.kind === 'connector') curves.push({ dist, limit: next.speedLimit });
        dist += next.length;
      }
      const desired = Math.min(v0 * this.laneEffect[seg.id][type].speed, seg.speedLimit);
      let a = Math.min(idmAccel(p, v, desired, Infinity, 0), curveAccelLimit(v, p.accel, p.decel, curves));
      a = Math.max(-p.maxDecel, Math.min(Math.max(0.05, p.accel - G * this.grade[seg.id]), a));
      const nv = v + a * DT;
      let ds: number;
      if (nv < 0) {
        ds = a < 0 ? -(v * v) / (2 * a) : 0;
        v = 0;
      } else {
        ds = v * DT + 0.5 * a * DT * DT;
        v = nv;
      }
      s += ds;
      while (s >= this.net.segments[path[k]].length) {
        // Exits at the moment its front crosses the end of its last lane, interpolated within the
        // step exactly as move() does for real trips; the entry step starts at time zero.
        if (k === path.length - 1) return (steps + exitFraction(s - this.net.segments[path[k]].length, ds)) * DT;
        s -= this.net.segments[path[k]].length;
        k++;
      }
    }
  }

  // ---------------------------------------------------------------- junctions

  /** The connector this vehicle needs from its current lane, or null if it is in the wrong lane / exiting. */
  private wantedConnector(v: Vehicle, laneId = v.seg, ri = v.ri): number | null {
    const lane = this.net.segments[laneId];
    if (lane.kind !== 'lane' || ri >= v.route.length - 1) return null;
    const next = v.route[ri + 1];
    for (const c of lane.connectorsOut) if ((this.net.segments[c] as Connector).toEdge === next) return c;
    return null;
  }

  private isExiting(v: Vehicle): boolean {
    const seg = this.net.segments[v.seg];
    return seg.kind === 'lane' && v.ri === v.route.length - 1 && this.net.nodes.get(seg.toNode)!.isEndpoint;
  }

  /**
   * Distance before an intersection's stop line at which a vehicle requests its movement, and from
   * which it treats the stop line as an obstacle until granted: its comfortable stopping distance,
   * plus one desired time headway of reaction, plus the 20 m it needs to come to rest smoothly with
   * IDM (so that, at green, it is granted before the stop line ever influences it).
   */
  private requestZone(v: Pick<Vehicle, 'v' | 'p'>): number {
    return Math.max(30, (v.v * v.v) / (2 * v.p.decel) + v.v * v.p.headway + 20);
  }

  /**
   * Whether the light lets a vehicle `distance` from the stop line enter (or keep its grant).
   *  - Green: yes.
   *  - Yellow: only if it is sure to reach the stop line before the yellow ends. Until the line it
   *    only slows for the curves it is planning for, and the curve limit never slows it below a
   *    curve's safe speed, so its speed stays at or above min(current speed, the lowest safe speed
   *    among those curves); distance / that floor bounds its arrival time. A vehicle waiting at the
   *    line (such as a turner that found no gap during the green) may clear on yellow if it can
   *    cross the line in time. Anyone refused can still stop.
   *  - Red: no; a grant issued earlier is withdrawn.
   * A grant is never withdrawn from a vehicle that can no longer stop before the line even at its
   * braking limit: pulling it then would leave it stranded in the junction mouth.
   */
  private lightAllows(light: LightState, v: Vehicle, distance: number, yellowLeft: number, holding: boolean): boolean {
    if (light === 'green') return true;
    if (holding && distance < (v.v * v.v) / (2 * v.p.maxDecel)) return true;
    if (light === 'red') return false;
    let floor = v.v;
    for (const c of this.upcomingCurves(v)) floor = Math.min(floor, c.limit);
    // A vehicle (nearly) at rest at the line, typically a turner that waited for a gap, is bounded
    // instead by accelerating at no less than half its maximum: √(4·distance / a_max).
    const arrival = Math.min(floor > 0 ? distance / floor : Infinity, Math.sqrt((4 * distance) / v.p.accel));
    return arrival <= yellowLeft;
  }

  /** Free room at the start of a lane, in metres. Moving tails count as room since they clear ahead of us. */
  private laneRoom(laneId: number): number {
    const tail = this.occ[laneId][0];
    if (!tail) return this.net.segments[laneId].length;
    if (tail.v > 3) return Infinity;
    return tail.s - tail.p.length;
  }

  /**
   * Junction access control. Vehicles approaching a junction request their movement; requests are
   * served first-come-first-served, subject to the signal, to conflicts with movements already
   * granted or occupied, and to room on the exit lane ("don't block the box"). A blocked earlier
   * request reserves its movement so later conflicting traffic cannot starve it.
   */
  private junctionControl(): void {
    type Cand = { v: Vehicle; c: Connector; pred: Vehicle | null };
    const byNode = new Map<string, Cand[]>();
    for (const lane of this.net.lanes) {
      const list = this.occ[lane.id];
      if (list.length === 0) continue;
      const node = this.net.nodes.get(lane.toNode)!;
      if (node.control !== 'intersection') continue;
      const light = lightFor(node, lane.roadId, this.t);
      const yellowLeft = light === 'yellow' ? signalStatus(node.signal!, this.t).remaining : 0;
      let pred: Vehicle | null = null;
      // Walk the lane front to back. A vehicle may only hold a grant while every vehicle ahead of
      // it on the lane holds one too: grants behind a vehicle that has to wait are withdrawn, or a
      // stale grant would block crossing traffic that is itself blocking the queue's head.
      let stop = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        const distance = lane.length - v.s;
        const c = this.wantedConnector(v);
        if (distance > this.requestZone(v) || c === null) {
          stop = i;
          break;
        }
        if (v.grant !== null && v.grant !== c) v.grant = null;
        const allowed = this.lightAllows(light, v, distance, yellowLeft, v.grant === c);
        if (v.grant === c && (pred === null || pred.grant !== null) && allowed) {
          pred = v;
          continue;
        }
        v.grant = null;
        if (!allowed) {
          stop = i - 1;
          break;
        }
        if (v.requestT < 0) v.requestT = this.t;
        const list2 = byNode.get(node.id) ?? [];
        list2.push({ v, c: this.net.segments[c] as Connector, pred: pred && pred.grant !== null ? null : pred });
        byNode.set(node.id, list2);
        pred = v;
      }
      for (let i = stop; i >= 0; i--) list[i].grant = null;
    }
    if (byNode.size === 0) return;

    const busyByNode = new Map<string, Set<number>>();
    const pendingByLane = new Map<number, number>();
    const usersOf = new Map<number, Vehicle[]>();
    for (const v of this.vehicles) {
      for (const c of [v.grant, v.occupying]) {
        if (c === null) continue;
        const users = usersOf.get(c) ?? [];
        users.push(v);
        usersOf.set(c, users);
        const conn = this.net.segments[c] as Connector;
        const set = busyByNode.get(conn.node) ?? new Set<number>();
        set.add(c);
        busyByNode.set(conn.node, set);
        if (c === v.grant || this.net.segments[v.seg].kind === 'connector') {
          pendingByLane.set(conn.toLane, (pendingByLane.get(conn.toLane) ?? 0) + v.p.length + v.p.minGap);
        }
      }
    }
    for (const [nodeId, cands] of byNode) {
      // On a main road with priority, main-road traffic is served first; side roads then yield.
      // Higher-ranked movements (main road, then straight-on and kerb-side turns) are served first.
      const node = this.net.nodes.get(nodeId)!;
      cands.sort((a, b) => this.movementRank(node, b.c) - this.movementRank(node, a.c) || a.v.requestT - b.v.requestT || a.v.id - b.v.id);
      const busy = busyByNode.get(nodeId) ?? new Set<number>();
      const reserved = new Set<number>();
      for (const { v, c, pred } of cands) {
        if (pred && pred.grant === null) continue;
        const blocked =
          c.conflicts.some((k) => busy.has(k) || reserved.has(k)) ||
          c.merges.some((k) => reserved.has(k)) ||
          !this.mergeClear(v, c, usersOf) ||
          !this.priorityGap(v, c, node);
        if (blocked) {
          reserved.add(c.id);
          continue;
        }
        const pending = pendingByLane.get(c.toLane) ?? 0;
        if (this.laneRoom(c.toLane) - pending < v.p.length + v.p.minGap) continue;
        v.grant = c.id;
        busy.add(c.id);
        const users = usersOf.get(c.id) ?? [];
        users.push(v);
        usersOf.set(c.id, users);
        pendingByLane.set(c.toLane, pending + v.p.length + v.p.minGap);
      }
    }
  }

  /** Whether a movement turns across the opposing traffic stream (a right turn when driving on the left). */
  private crossesOncoming(c: Connector): boolean {
    return c.turn !== 'straight' && (c.turn === 'right') === (this.scenario.driveSide === 'left');
  }

  /**
   * Right-of-way rank of a movement at an intersection (higher goes first):
   *  - main-road movements outrank side-road movements (unsignalised junctions with a main road);
   *  - within a road level, straight-on and kerb-side turns outrank turns across oncoming traffic,
   *    wherever there is a priority order at all (signalised, or unsignalised with a main road).
   * Symmetric unsignalised junctions have no order: every movement ranks the same (first come,
   * first served).
   */
  private movementRank(node: CompiledNode, c: Connector): number {
    const ordered = node.signal !== null || node.majorRoads.size > 0;
    if (!ordered) return 0;
    const road = node.majorRoads.has((this.net.segments[c.fromLane] as Lane).roadId) ? 2 : 0;
    return road + (this.crossesOncoming(c) ? 0 : 1);
  }

  /**
   * Critical gap (s) for a movement that gives way. Side-road traffic giving way to a main road uses
   * the HCM base critical headways for two-way stop control on a two-lane main road (6.2 s
   * kerb-side turn, 6.5 s straight across, 7.1 s across traffic). A turn across oncoming traffic
   * within its own road level uses the HCM permitted-turn values: 4.5 s at a signal, 4.1 s for a
   * main-road turn at an unsignalised junction.
   */
  private criticalGap(node: CompiledNode, c: Connector): number {
    const sideRoad = node.majorRoads.size > 0 && !node.majorRoads.has((this.net.segments[c.fromLane] as Lane).roadId);
    if (sideRoad) return c.turn === 'straight' ? 6.5 : this.crossesOncoming(c) ? 7.1 : 6.2;
    return node.signal ? 4.5 : 4.1;
  }

  /**
   * Gap acceptance against higher-ranked traffic. The streams v must give way to are the movements
   * from other approaches that rank above c, cross or merge with it, and may currently move (not
   * held by a red). A critical gap is a headway between successive vehicles of those streams, so
   * the gap "now" falls in runs from the last such vehicle entering the junction to the next one
   * reaching its stop line. v may enter when that gap is at least its critical gap and the next one
   * arrives no sooner than v needs to drive clear of the junction. (Vehicles already granted or in
   * the junction are covered by the conflict and merge checks.)
   */
  private priorityGap(v: Vehicle, c: Connector, node: CompiledNode): boolean {
    const rank = this.movementRank(node, c);
    const interacts = (k: number) => this.movementRank(node, this.net.segments[k] as Connector) > rank && (c.conflicts.includes(k) || c.merges.includes(k));
    if (!c.conflicts.some(interacts) && !c.merges.some(interacts)) return true;
    const critical = this.criticalGap(node, c);
    let last = -Infinity;
    let next = Infinity;
    for (const eid of node.inEdges) {
      if (eid === c.fromEdge) continue;
      const edge = this.net.edges[eid];
      if (node.signal && lightFor(node, edge.roadId, this.t) === 'red') continue;
      for (const lid of edge.lanes) {
        const lane = this.net.segments[lid] as Lane;
        for (const k of lane.connectorsOut) if (interacts(k)) last = Math.max(last, this.lastEntry[k]);
        const list = this.occ[lid];
        for (let i = list.length - 1; i >= 0; i--) {
          const o = list[i];
          const arrival = (lane.length - o.s) / Math.max(o.v, 0.5);
          // Vehicles behind cannot arrive before the one ahead of them.
          if (arrival >= critical) break;
          const k = this.wantedConnector(o);
          if ((k === null ? lane.connectorsOut : [k]).some(interacts)) next = Math.min(next, arrival);
        }
      }
    }
    if (!Number.isFinite(next)) return true; // no higher-ranked arrival within the critical gap
    const gap = this.t - last + next;
    const lane = this.net.segments[v.seg];
    const clear = lane.length - v.s + c.length + v.p.length;
    const timeToClear = (-v.v + Math.sqrt(v.v * v.v + 2 * v.p.accel * clear)) / v.p.accel;
    return gap >= critical && next >= timeToClear;
  }

  /**
   * Distance from a vehicle's front bumper to the end of connector k (the merge point), measured
   * along its own path; negative once it has passed onto the exit lane. Null if it isn't using k.
   */
  private mergeDistance(o: Vehicle, k: Connector): number | null {
    const seg = this.net.segments[o.seg];
    if (o.seg === k.id) return k.length - o.s;
    if (o.grant === k.id && seg.kind === 'lane') return seg.length - o.s + k.length;
    if (o.occupying === k.id && o.seg === k.toLane) return -o.s;
    return null;
  }

  /**
   * Gap acceptance for converging movements: the candidate may enter if, projected onto the shared
   * exit lane, it ends up either behind every merging vehicle with at least its standstill gap, or
   * ahead of it with room for that vehicle to keep following comfortably.
   */
  private mergeClear(v: Vehicle, c: Connector, usersOf: Map<number, Vehicle[]>): boolean {
    const lane = this.net.segments[v.seg];
    const dc = lane.length - v.s + c.length;
    for (const kid of c.merges) {
      const k = this.net.segments[kid] as Connector;
      for (const o of usersOf.get(kid) ?? []) {
        if (o === v) continue;
        const d = this.mergeDistance(o, k);
        if (d === null) continue;
        if (dc >= d + o.p.length + v.p.minGap) continue;
        if (d >= dc + v.p.length + o.p.minGap + o.v * o.p.headway * 0.5) continue;
        return false;
      }
    }
    return true;
  }

  /** Nearest vehicle on (or granted onto) a converging movement that will be ahead of us at the merge point. */
  private mergeLeader(c: Connector, distToEnd: number): { gap: number; v: number } | null {
    let best: { gap: number; v: number } | null = null;
    for (const kid of c.merges) {
      const k = this.net.segments[kid] as Connector;
      for (const o of this.mergeUsers.get(kid) ?? []) {
        const d = this.mergeDistance(o, k);
        if (d === null || d < 0 || d >= distToEnd) continue;
        const gap = distToEnd - d - o.p.length;
        if (!best || gap < best.gap) best = { gap, v: o.v };
      }
    }
    return best;
  }

  private desiredSpeed(v: Vehicle, segId: number): number {
    const seg = this.net.segments[segId];
    return Math.min(v.v0 * this.laneEffect[segId][v.type].speed, seg.speedLimit);
  }

  private headwayOn(v: Vehicle, segId: number): number {
    return v.p.headway * this.laneEffect[segId][v.type].headway;
  }

  // ---------------------------------------------------------------- longitudinal

  /**
   * The nearest obstacle along the vehicle's own route: another vehicle (on this segment, in a
   * junction mouth shared with a diverging movement, merging from another approach, or further down
   * the route), or a virtual stopped obstacle at an intersection stop line it has not been granted
   * (seen only within its request zone) or at the end of a lane that does not serve its route.
   * Simple connections are driven through. (Curves are handled separately by upcomingCurves().)
   */
  private obstacleAhead(v: Vehicle): { gap: number; dv: number } {
    const list = this.occ[v.seg];
    const leader = list[list.indexOf(v) + 1];
    let gap = Infinity;
    let leaderSpeed = 0;
    const see = (g: number, speed: number) => {
      if (g < gap) {
        gap = g;
        leaderSpeed = speed;
      }
    };
    const done = () => ({ gap, dv: Number.isFinite(gap) ? v.v - leaderSpeed : 0 });

    let seg = this.net.segments[v.seg];
    let ri = v.ri;
    let dist = seg.length - v.s; // from our front bumper to the end of `seg`
    if (leader) {
      see(leader.s - leader.p.length - v.s, leader.v);
      return done();
    }
    if (seg.kind === 'connector') {
      const m = this.mergeLeader(seg, dist);
      if (m) see(m.gap, m.v);
      seg = this.net.segments[seg.toLane];
      ri++;
      const tail = this.occ[seg.id][0];
      if (tail) {
        see(dist + tail.s - tail.p.length, tail.v);
        return done();
      }
      dist += seg.length;
    }
    while (dist < LOOKAHEAD) {
      const lane = seg as Lane;
      const node = this.net.nodes.get(lane.toNode)!;
      if (node.isEndpoint) break; // the route leaves the network here
      const current = lane.id === v.seg;
      const cid = this.wantedConnector(v, lane.id, ri);
      if (cid === null) {
        // Our own lane does not continue our route: stop at its end unless we change lanes first.
        // A future lane that does not serve the route is resolved by a lane change before we get there.
        if (current) see(dist + v.p.minGap - 1, 0);
        break;
      }
      const c = this.net.segments[cid] as Connector;
      if (node.control === 'intersection') {
        if (!(current && v.grant === cid)) {
          if (dist <= this.requestZone(v)) see(dist + v.p.minGap - 1, 0);
          break;
        }
        const m = this.mergeLeader(c, dist + c.length);
        if (m) see(m.gap, m.v);
      }
      // A vehicle that left this lane on a diverging movement obstructs us until the paths separate.
      for (const sib of c.siblings) {
        const o = this.occ[sib.id][0];
        if (o && o.s - o.p.length < sib.diverge) see(dist + o.s - o.p.length, o.v);
      }
      const onC = this.occ[cid][0];
      if (onC) {
        see(dist + onC.s - onC.p.length, onC.v);
        break;
      }
      dist += c.length;
      seg = this.net.segments[c.toLane];
      ri++;
      const tail = this.occ[seg.id][0];
      if (tail) {
        see(dist + tail.s - tail.p.length, tail.v);
        break;
      }
      dist += seg.length;
    }
    return done();
  }

  /**
   * The junction movements on the vehicle's route within LOOKAHEAD, with their distance ahead. A
   * driver plans for the turns it intends to make whatever the signal shows, so this ignores grants
   * and other traffic. Where its current lane cannot make the next movement (a lane change is still
   * to come), the movement from the lane it will change into is used.
   */
  private *upcomingCurves(v: Vehicle): Generator<{ dist: number; limit: number }> {
    const seg = this.net.segments[v.seg];
    let dist = seg.length - v.s;
    let ri = v.ri;
    let lane: Lane;
    if (seg.kind === 'connector') {
      lane = this.net.segments[seg.toLane] as Lane;
      ri++;
      dist += lane.length;
    } else lane = seg;
    while (dist < LOOKAHEAD && ri < v.route.length - 1) {
      let cid = this.wantedConnector(v, lane.id, ri);
      if (cid === null) for (const lid of this.net.edges[lane.edge].lanes) cid ??= this.wantedConnector(v, lid, ri);
      if (cid === null) return;
      const c = this.net.segments[cid] as Connector;
      yield { dist, limit: c.speedLimit };
      lane = this.net.segments[c.toLane] as Lane;
      ri++;
      dist += c.length + lane.length;
    }
  }

  private accelFor(v: Vehicle): number {
    const ob = this.obstacleAhead(v);
    const a = Math.min(
      idmAccel(v.p, v.v, this.desiredSpeed(v, v.seg), ob.gap, ob.dv, this.headwayOn(v, v.seg)),
      curveAccelLimit(v.v, v.p.accel, v.p.decel, this.upcomingCurves(v)),
    );
    // Climbing a ramp costs g·sinθ of the available acceleration (heavy vehicles feel it most).
    const maxAccel = Math.max(0.05, v.p.accel - G * this.grade[v.seg]);
    return Math.max(-v.p.maxDecel, Math.min(maxAccel, a));
  }

  private move(): void {
    this.mergeUsers.clear();
    for (const v of this.vehicles) {
      const seg = this.net.segments[v.seg];
      const c = seg.kind === 'connector' ? seg.id : v.grant;
      if (c === null || (this.net.segments[c] as Connector).merges.length === 0) continue;
      const list = this.mergeUsers.get(c) ?? [];
      list.push(v);
      this.mergeUsers.set(c, list);
    }
    for (const v of this.vehicles) v.acc = this.accelFor(v);
    const exited: { v: Vehicle; frac: number }[] = [];
    for (const v of this.vehicles) {
      let ds: number;
      const nv = v.v + v.acc * DT;
      if (nv < 0) {
        ds = v.acc < 0 ? -(v.v * v.v) / (2 * v.acc) : 0;
        v.v = 0;
      } else {
        ds = v.v * DT + 0.5 * v.acc * DT * DT;
        v.v = nv;
      }
      v.s += ds;
      v.dist += ds;
      if (v.v < 0.5) v.stoppedTime += DT;
      for (;;) {
        const seg = this.net.segments[v.seg];
        if (v.s < seg.length) break;
        if (seg.kind === 'lane') {
          if (this.isExiting(v)) {
            exited.push({ v, frac: exitFraction(v.s - seg.length, ds) });
            break;
          }
          // Intersections need a grant; simple connections are driven through along the route.
          const node = this.net.nodes.get(seg.toNode)!;
          const cid = node.control === 'intersection' ? v.grant : this.wantedConnector(v);
          if (cid === null || !seg.connectorsOut.includes(cid)) {
            // Would overrun a stop line without permission: hold it (counts as a safety intervention).
            v.s = seg.length - 0.01;
            v.v = 0;
            this.safetyInterventions++;
            break;
          }
          const c = this.net.segments[cid] as Connector;
          const prevEdge = seg.edge;
          this.edgeTT[prevEdge] = 0.85 * this.edgeTT[prevEdge] + 0.15 * (this.t - v.edgeEnterT);
          v.s -= seg.length;
          v.seg = c.id;
          v.occupying = c.id;
          this.lastEntry[c.id] = this.t;
          v.grant = null;
          v.requestT = -1;
          v.lat = 0;
          this.nodeThroughput.set(c.node, (this.nodeThroughput.get(c.node) ?? 0) + 1);
        } else {
          v.s -= seg.length;
          v.seg = seg.toLane;
          v.ri++;
          v.edgeEnterT = this.t;
        }
      }
      if (v.occupying !== null && this.net.segments[v.seg].kind === 'lane' && v.s - v.p.length >= 0) v.occupying = null;
    }
    if (exited.length) {
      const gone = new Set(exited.map((e) => e.v));
      for (const { v, frac } of exited) {
        this.trips.push({
          id: v.id,
          type: v.type,
          flowId: v.flowId,
          // Whole moves before the one in which it crossed the exit, plus how far into that move it
          // crossed: the same clock soloTravelTime() uses for the free-flow reference.
          travelTime: this.t - v.spawnT + frac * DT,
          freeFlowTime: v.freeFlowTime,
          distance: v.dist,
          entryWait: v.entryWait,
          stoppedTime: v.stoppedTime,
          exitT: this.t,
        });
        this.exitTimes.push(this.t);
      }
      this.vehicles = this.vehicles.filter((v) => !gone.has(v));
    }
  }

  private rebuildOccupancy(): void {
    for (const list of this.occ) list.length = 0;
    for (const v of this.vehicles) this.occ[v.seg].push(v);
    for (const list of this.occ) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.s - b.s || b.id - a.id);
      // Hard non-overlap guarantee; IDM should make this a no-op.
      for (let i = list.length - 2; i >= 0; i--) {
        const f = list[i];
        const l = list[i + 1];
        const limit = l.s - l.p.length - 0.05;
        if (f.s > limit) {
          f.dist -= f.s - limit;
          f.s = limit;
          f.v = Math.min(f.v, l.v);
          this.safetyInterventions++;
        }
      }
    }
  }

  /** A vehicle stuck at the end of a lane that cannot serve its route (missed lane change) re-routes from there. */
  private updateStuck(): void {
    for (const v of this.vehicles) {
      const seg = this.net.segments[v.seg];
      if (seg.kind !== 'lane' || this.isExiting(v)) continue;
      if (this.wantedConnector(v) !== null) {
        v.stuckT = 0;
        continue;
      }
      if (seg.length - v.s < 10 && v.v < 0.5) v.stuckT += DT;
      if (v.stuckT > 6) this.reroute(v, seg);
    }
  }

  private reroute(v: Vehicle, lane: Lane): void {
    // Keep the via-points it has not yet passed.
    const remaining = v.via.slice(viaReached(this.net, v.route, v.ri, v.via));
    let best: number[] | null = null;
    for (const cid of lane.connectorsOut) {
      const c = this.net.segments[cid] as Connector;
      const tail = shortestRouteVia(this.net, c.toEdge, remaining, v.dest, this.cost);
      if (tail && (!best || tail.length < best.length)) best = tail;
    }
    if (!best && lane.connectorsOut.length) {
      const c = this.net.segments[lane.connectorsOut[0]] as Connector;
      const exits = reachableExits(this.net, c.toEdge);
      if (exits.length) {
        v.dest = exits[0];
        best = shortestRoute(this.net, c.toEdge, v.dest, this.cost);
      }
    }
    if (best) {
      v.route = [...v.route.slice(0, v.ri + 1), ...best];
      v.stuckT = 0;
    }
  }

  // ---------------------------------------------------------------- lateral

  /**
   * Leader and follower around position s on a lane. With nobody behind on the lane itself, the
   * follower is the nearest vehicle still crossing the junction into this lane, at a negative
   * position (distance before the lane start).
   */
  private neighbours(laneId: number, s: number): { lead: Vehicle | null; follow: Vehicle | null; followS: number } {
    const list = this.occ[laneId];
    let lead: Vehicle | null = null;
    let follow: Vehicle | null = null;
    for (const o of list) {
      if (o.s >= s) {
        lead = o;
        break;
      }
      follow = o;
    }
    if (follow) return { lead, follow, followS: follow.s };
    let followS = -Infinity;
    for (const cid of this.connectorsInto[laneId]) {
      const c = this.net.segments[cid] as Connector;
      const o = this.occ[cid][this.occ[cid].length - 1];
      if (o && o.s - c.length > followS) {
        follow = o;
        followS = o.s - c.length;
      }
    }
    return { lead, follow, followS };
  }

  private idmWith(v: Vehicle, s: number, leader: Vehicle | null, laneId: number): number {
    const v0 = this.desiredSpeed(v, laneId);
    const T = this.headwayOn(v, laneId);
    if (!leader) return idmAccel(v.p, v.v, v0, Infinity, 0, T);
    return idmAccel(v.p, v.v, v0, leader.s - leader.p.length - s, v.v - leader.v, T);
  }

  /** MOBIL lane changing (Kesting, Treiber & Helbing 2007) plus mandatory changes for route-following. */
  private laneChanges(): void {
    let changed = false;
    for (const v of this.vehicles) {
      const seg = this.net.segments[v.seg];
      if (seg.kind !== 'lane' || v.grant !== null || v.occupying !== null) continue;
      if (this.t - v.lastLaneChange < 3 || v.s < v.p.length + 1 || seg.length - v.s < 2) continue;
      const exiting = v.ri === v.route.length - 1;
      const mandatory = !exiting && this.wantedConnector(v) === null;
      const candidates: number[] = [];
      if (mandatory) {
        const edge = this.net.edges[seg.edge];
        const good = edge.lanes.filter((l) => this.wantedConnector(v, l) !== null);
        if (good.length === 0) continue;
        const target = good.reduce((a, b) => (Math.abs(b - seg.id) < Math.abs(a - seg.id) ? b : a));
        candidates.push(target < seg.id ? seg.inner! : seg.outer!);
      } else {
        for (const l of [seg.inner, seg.outer]) {
          if (l !== null && (exiting || this.wantedConnector(v, l) !== null)) candidates.push(l);
        }
      }
      const toEnd = seg.length - v.s;
      const bSafe = mandatory ? (toEnd < 40 ? v.p.maxDecel * 0.75 : SAFE_DECEL) : SAFE_DECEL;
      const minGap = mandatory && toEnd < 40 ? 0.5 : 1.0;
      let bestLane: number | null = null;
      let bestGain = mandatory ? -Infinity : MOBIL_THRESHOLD;
      const curIdx = this.occ[seg.id].indexOf(v);
      const realLead = this.occ[seg.id][curIdx + 1] ?? null;
      const oldFollow = curIdx > 0 ? this.occ[seg.id][curIdx - 1] : null;
      const aCur = this.idmWith(v, v.s, realLead, seg.id);
      for (const target of candidates) {
        const { lead, follow, followS } = this.neighbours(target, v.s);
        if (lead && lead.s - lead.p.length - v.s < minGap) continue;
        if (follow && v.s - v.p.length - followS < minGap) continue;
        const aNew = this.idmWith(v, v.s, lead, target);
        // In stationary queues vehicles let each other in (zipper merge), so only moving traffic is judged on braking.
        if (aNew < -bSafe && v.v > 1) continue;
        const nfAfter = follow ? this.idmWith(follow, followS, v, target) : 0;
        if (follow && nfAfter < -bSafe && !(mandatory && follow.v < 1)) continue;
        if (follow && follow.grant !== null) continue;
        const nfBefore = follow ? this.idmWith(follow, followS, lead, target) : 0;
        const ofBefore = oldFollow ? this.idmWith(oldFollow, oldFollow.s, v, seg.id) : 0;
        const ofAfter = oldFollow ? this.idmWith(oldFollow, oldFollow.s, realLead, seg.id) : 0;
        const gain = aNew - aCur + v.p.politeness * (nfAfter - nfBefore + ofAfter - ofBefore);
        if (gain > bestGain) {
          bestGain = gain;
          bestLane = target;
        }
      }
      if (bestLane === null) continue;
      const from = seg;
      const to = this.net.segments[bestLane] as Lane;
      v.lat += (from.index - to.index) * from.width;
      v.seg = bestLane;
      v.requestT = -1;
      v.lastLaneChange = this.t;
      v.stuckT = 0;
      // keep occupancy sorted for the rest of this pass
      const oldList = this.occ[from.id];
      oldList.splice(oldList.indexOf(v), 1);
      const newList = this.occ[bestLane];
      let k = 0;
      while (k < newList.length && newList[k].s < v.s) k++;
      newList.splice(k, 0, v);
      this.laneChangeCount++;
      changed = true;
    }
    if (changed) this.rebuildOccupancy();
  }

  private animateLateral(): void {
    const step = 1.2 * DT; // lateral speed 1.2 m/s
    for (const v of this.vehicles) {
      if (v.lat === 0) continue;
      v.lat = Math.abs(v.lat) <= step ? 0 : v.lat - Math.sign(v.lat) * step;
    }
  }

  // ---------------------------------------------------------------- metrics

  private computeQueues(): number {
    let total = 0;
    this.queueByLane.clear();
    for (const lane of this.net.lanes) {
      if (this.net.nodes.get(lane.toNode)!.isEndpoint) continue;
      const list = this.occ[lane.id];
      let back = lane.length;
      let q = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (v.v > QUEUE_SPEED || v.s < back - v.p.minGap - 8) break;
        back = v.s - v.p.length;
        q = lane.length - back;
      }
      if (q > 0) {
        this.queueByLane.set(lane.id, q);
        total += q;
      }
    }
    return total;
  }

  private sample(): void {
    const queueLength = this.computeQueues();
    let speed = 0;
    let queued = 0;
    for (const v of this.vehicles) {
      speed += v.v;
      if (v.v < QUEUE_SPEED) queued++;
    }
    while (this.exitTimes.length && this.exitTimes[0] < this.t - 60) this.exitTimes.shift();
    let laneKm = 0;
    for (const e of this.net.edges) laneKm += (e.length * e.lanes.length) / 1000;
    this.samples.push({
      t: Math.round(this.t * 10) / 10,
      active: this.vehicles.length,
      meanSpeed: this.vehicles.length ? speed / this.vehicles.length : 0,
      throughput: (this.exitTimes.length * 3600) / Math.max(1, Math.min(60, this.t)),
      exited: this.trips.length,
      queued,
      queueLength,
      maxLaneQueue: Math.max(0, ...this.queueByLane.values()),
      backlog: this.backlogCount(),
      density: laneKm > 0 ? this.vehicles.length / laneKm : 0,
    });
  }
}

export interface RunResult {
  summary: Summary;
  samples: Sample[];
  warnings: string[];
}

/** Headless run used by tests, scenario comparison (in a Web Worker) and the API. */
export function runScenario(scenario: Scenario, duration = scenario.duration, onProgress?: (f: number) => void): RunResult {
  const sim = new Simulation(scenario);
  sim.run(duration, onProgress);
  return { summary: sim.summary(), samples: sim.samples, warnings: sim.net.warnings };
}
