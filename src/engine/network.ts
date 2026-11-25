import { angleDiff, add, dist, norm, Path, rightNormal, scale, sub, type Vec } from './geometry';
import type { Level, NodeDef, RoadDef, Scenario, SignalDef } from './types';

/**
 * Compiles a Scenario's road graph into the structures the engine drives on:
 *  - Edge: one travel direction of a road (the routing graph's arcs)
 *  - Lane: a drivable strip on an edge, set back from the junctions at either end
 *  - Connector: a curve through a junction from one lane to another (a "movement")
 * Lanes and connectors share one id space as Segments, so a vehicle is always "on segment k at s metres".
 *
 * Roads only connect where they share a node. Since nodes carry a level, an elevated road (flyover)
 * can geometrically cross a ground road without any connector — and therefore without any conflict.
 */

export type Turn = 'straight' | 'left' | 'right';

export interface Lane {
  kind: 'lane';
  id: number;
  edge: number;
  roadId: string;
  index: number; // 0 = innermost (next to the centre line); increases toward the kerb
  path: Path;
  length: number;
  width: number;
  speedLimit: number;
  fromNode: string;
  toNode: string;
  levelFrom: Level;
  levelTo: Level;
  connectorsOut: number[];
  /** Neighbouring lane ids on the same edge (inner = toward centre, outer = toward kerb). */
  inner: number | null;
  outer: number | null;
}

export interface Connector {
  kind: 'connector';
  id: number;
  node: string;
  fromLane: number;
  toLane: number;
  fromEdge: number;
  toEdge: number;
  path: Path;
  length: number;
  width: number;
  turn: Turn;
  speedLimit: number;
  level: Level;
  conflicts: number[];
}

export type Segment = Lane | Connector;

export interface Edge {
  id: number;
  key: string; // `${roadId}:${dir}`
  roadId: string;
  dir: 1 | -1;
  from: string;
  to: string;
  lanes: number[];
  length: number;
  speedLimit: number;
  /** Edges reachable through this edge's end junction. */
  next: number[];
}

export interface CompiledNode {
  def: NodeDef;
  id: string;
  pos: Vec;
  level: Level;
  degree: number;
  isEndpoint: boolean;
  setback: number;
  roads: { roadId: string; angle: number }[];
  inEdges: number[];
  outEdges: number[];
  connectors: number[];
  signal: SignalDef | null;
  /** roadId → phase indices in which that approach has green. */
  phaseOfRoad: Map<string, number[]>;
}

export interface Network {
  scenario: Scenario;
  nodes: Map<string, CompiledNode>;
  roads: Map<string, RoadDef>;
  edges: Edge[];
  edgeByKey: Map<string, number>;
  segments: Segment[];
  lanes: Lane[];
  connectors: Connector[];
  entryEdges: number[];
  exitEdges: number[];
  warnings: string[];
}

const CONFLICT_DISTANCE = 2.0;

export function roadWidth(r: RoadDef): number {
  return (r.lanesFwd + r.lanesBwd) * r.laneWidth;
}

/** Outward direction angle of each road at a node. */
export function roadsAtNode(scenario: Scenario, nodeId: string): { road: RoadDef; angle: number }[] {
  const nodes = new Map(scenario.nodes.map((n) => [n.id, n]));
  const node = nodes.get(nodeId);
  if (!node) return [];
  const out: { road: RoadDef; angle: number }[] = [];
  for (const road of scenario.roads) {
    if (road.from !== nodeId && road.to !== nodeId) continue;
    const other = nodes.get(road.from === nodeId ? road.to : road.from);
    if (!other) continue;
    out.push({ road, angle: Math.atan2(other.y - node.y, other.x - node.x) });
  }
  return out.sort((a, b) => a.angle - b.angle);
}

export function buildNetwork(scenario: Scenario): Network {
  const warnings: string[] = [];
  const nodeDefs = new Map(scenario.nodes.map((n) => [n.id, n]));
  const roads = new Map<string, RoadDef>();
  for (const r of scenario.roads) {
    const a = nodeDefs.get(r.from);
    const b = nodeDefs.get(r.to);
    if (!a || !b) {
      warnings.push(`Road ${r.id} references a missing node and was ignored.`);
      continue;
    }
    if (r.from === r.to || dist(a, b) < 1) {
      warnings.push(`Road ${r.id} has zero length and was ignored.`);
      continue;
    }
    if (r.lanesFwd + r.lanesBwd === 0) {
      warnings.push(`Road ${r.id} has no lanes and was ignored.`);
      continue;
    }
    roads.set(r.id, r);
  }
  const validScenario: Scenario = { ...scenario, roads: [...roads.values()] };

  // --- Nodes and junction setbacks ---
  const nodes = new Map<string, CompiledNode>();
  for (const def of scenario.nodes) {
    const at = roadsAtNode(validScenario, def.id);
    const degree = at.length;
    let setback = 0;
    if (degree >= 2) {
      const maxHalf = Math.max(...at.map((x) => roadWidth(x.road) / 2));
      if (degree === 2 && Math.abs(Math.abs(angleDiff(at[0].angle, at[1].angle)) - Math.PI) < 0.35) {
        // A straight continuation (e.g. a lane drop or a ramp joint) only needs a short transition.
        const sameLanes = at[0].road.lanesFwd + at[0].road.lanesBwd === at[1].road.lanesFwd + at[1].road.lanesBwd;
        setback = sameLanes ? 1 : 6;
      } else {
        let minGap = Math.PI * 2;
        for (let i = 0; i < at.length; i++) {
          const gap = i + 1 < at.length ? at[i + 1].angle - at[i].angle : at[0].angle + Math.PI * 2 - at[i].angle;
          minGap = Math.min(minGap, gap);
        }
        const acute = maxHalf / Math.tan(Math.max(0.2, minGap) / 2);
        setback = Math.min(40, Math.max(maxHalf + 1.5, acute + 1));
      }
    }
    nodes.set(def.id, {
      def,
      id: def.id,
      pos: { x: def.x, y: def.y },
      level: def.level,
      degree,
      isEndpoint: degree === 1,
      setback,
      roads: at.map((x) => ({ roadId: x.road.id, angle: x.angle })),
      inEdges: [],
      outEdges: [],
      connectors: [],
      signal: null,
      phaseOfRoad: new Map(),
    });
  }

  // --- Edges and lanes ---
  const edges: Edge[] = [];
  const edgeByKey = new Map<string, number>();
  const segments: Segment[] = [];
  const lanes: Lane[] = [];
  const sideSign = scenario.driveSide === 'right' ? 1 : -1;

  for (const road of roads.values()) {
    const A = nodes.get(road.from)!;
    const B = nodes.get(road.to)!;
    const L = dist(A.pos, B.pos);
    let sbA = A.setback;
    let sbB = B.setback;
    if (sbA + sbB > L - 4) {
      const k = Math.max(0, L - 4) / (sbA + sbB);
      sbA *= k;
      sbB *= k;
      warnings.push(`Road ${road.id} is short for its junctions; junction areas were shrunk.`);
    }
    const twoWay = road.lanesFwd > 0 && road.lanesBwd > 0;
    for (const dir of [1, -1] as const) {
      const n = dir === 1 ? road.lanesFwd : road.lanesBwd;
      if (n <= 0) continue;
      const from = dir === 1 ? A : B;
      const to = dir === 1 ? B : A;
      const sbFrom = dir === 1 ? sbA : sbB;
      const sbTo = dir === 1 ? sbB : sbA;
      const d = norm(sub(to.pos, from.pos));
      const side = scale(rightNormal(d), sideSign);
      const edge: Edge = {
        id: edges.length,
        key: `${road.id}:${dir}`,
        roadId: road.id,
        dir,
        from: from.id,
        to: to.id,
        lanes: [],
        length: L - sbFrom - sbTo,
        speedLimit: road.speedLimit,
        next: [],
      };
      for (let i = 0; i < n; i++) {
        const offset = (twoWay ? i + 0.5 : i + 0.5 - n / 2) * road.laneWidth;
        const start = add(add(from.pos, scale(d, sbFrom)), scale(side, offset));
        const end = add(add(to.pos, scale(d, -sbTo)), scale(side, offset));
        const path = new Path([start, end]);
        const lane: Lane = {
          kind: 'lane',
          id: segments.length,
          edge: edge.id,
          roadId: road.id,
          index: i,
          path,
          length: path.length,
          width: road.laneWidth,
          speedLimit: road.speedLimit,
          fromNode: from.id,
          toNode: to.id,
          levelFrom: from.level,
          levelTo: to.level,
          connectorsOut: [],
          inner: null,
          outer: null,
        };
        segments.push(lane);
        lanes.push(lane);
        edge.lanes.push(lane.id);
      }
      edge.lanes.forEach((id, i) => {
        const lane = segments[id] as Lane;
        lane.inner = i > 0 ? edge.lanes[i - 1] : null;
        lane.outer = i < edge.lanes.length - 1 ? edge.lanes[i + 1] : null;
      });
      edges.push(edge);
      edgeByKey.set(edge.key, edge.id);
      from.outEdges.push(edge.id);
      to.inEdges.push(edge.id);
    }
  }

  // --- Junction movements (connectors) ---
  const connectors: Connector[] = [];
  for (const node of nodes.values()) {
    if (node.degree < 2) continue;
    for (const inId of node.inEdges) {
      const eIn = edges[inId];
      const inLane0 = segments[eIn.lanes[0]] as Lane;
      const inHeading = inLane0.path.pose(inLane0.length).heading;
      const moves: { eOut: Edge; delta: number; nearness: number }[] = [];
      for (const outId of node.outEdges) {
        const eOut = edges[outId];
        if (eOut.roadId === eIn.roadId) continue; // no U-turns on the same road
        const outLane0 = segments[eOut.lanes[0]] as Lane;
        const delta = angleDiff(inHeading, outLane0.path.pose(0).heading);
        if (Math.abs(delta) > (170 * Math.PI) / 180) continue;
        moves.push({ eOut, delta, nearness: sideSign * delta });
      }
      if (moves.length === 0) continue;
      const main = moves.reduce((best, m) => (Math.abs(m.delta) < Math.abs(best.delta) ? m : best));
      const n = eIn.lanes.length;
      for (const mv of moves) {
        const m = mv.eOut.lanes.length;
        const pairs: [number, number][] = [];
        if (mv === main) for (let i = 0; i < n; i++) pairs.push([i, Math.min(i, m - 1)]);
        else if (mv.nearness < main.nearness) pairs.push([0, 0]);
        else pairs.push([n - 1, m - 1]);
        const turn: Turn =
          Math.abs(mv.delta) < (30 * Math.PI) / 180 ? 'straight' : mv.delta > 0 ? 'right' : 'left';
        for (const [i, j] of pairs) {
          const lin = segments[eIn.lanes[i]] as Lane;
          const lout = segments[mv.eOut.lanes[j]] as Lane;
          const p0 = lin.path.points[1];
          const p3 = lout.path.points[0];
          const k = Math.max(1, dist(p0, p3) * 0.4);
          const tIn = norm(sub(lin.path.points[1], lin.path.points[0]));
          const tOut = norm(sub(lout.path.points[1], lout.path.points[0]));
          const path = Path.cubic(p0, add(p0, scale(tIn, k)), sub(p3, scale(tOut, k)), p3);
          // Tighter turns are taken slower: v ≈ sqrt(a_lat · r), with r estimated from chord & angle.
          const r = Math.abs(mv.delta) > 0.1 ? dist(p0, p3) / (2 * Math.sin(Math.abs(mv.delta) / 2)) : Infinity;
          const turnSpeed = Math.sqrt(2.5 * r);
          const c: Connector = {
            kind: 'connector',
            id: segments.length,
            node: node.id,
            fromLane: lin.id,
            toLane: lout.id,
            fromEdge: eIn.id,
            toEdge: mv.eOut.id,
            path,
            length: path.length,
            width: Math.min(lin.width, lout.width),
            turn,
            speedLimit: Math.max(4, Math.min(lin.speedLimit, lout.speedLimit, turnSpeed)),
            level: node.level,
            conflicts: [],
          };
          segments.push(c);
          connectors.push(c);
          lin.connectorsOut.push(c.id);
          node.connectors.push(c.id);
          if (!eIn.next.includes(mv.eOut.id)) eIn.next.push(mv.eOut.id);
        }
      }
    }
    // Conflicts: movements that merge into the same lane or whose swept paths cross or come too close.
    for (let a = 0; a < node.connectors.length; a++) {
      for (let b = a + 1; b < node.connectors.length; b++) {
        const ca = segments[node.connectors[a]] as Connector;
        const cb = segments[node.connectors[b]] as Connector;
        if (ca.fromLane === cb.fromLane) continue;
        if (ca.toLane === cb.toLane || ca.path.minDistanceTo(cb.path) < CONFLICT_DISTANCE) {
          ca.conflicts.push(cb.id);
          cb.conflicts.push(ca.id);
        }
      }
    }
    // Signal plan
    const sig = node.def.signal;
    if (sig?.enabled && sig.phases.length > 0 && node.degree >= 2) {
      node.signal = sig;
      sig.phases.forEach((ph, i) => {
        for (const rid of ph.approaches) {
          const list = node.phaseOfRoad.get(rid) ?? [];
          list.push(i);
          node.phaseOfRoad.set(rid, list);
        }
      });
      for (const { roadId } of node.roads) {
        if (!node.phaseOfRoad.has(roadId)) {
          warnings.push(`Signal at ${node.id}: road ${roadId} is in no phase; it was given phase 1.`);
          node.phaseOfRoad.set(roadId, [0]);
        }
      }
    }
  }

  const entryEdges = edges.filter((e) => nodes.get(e.from)!.isEndpoint).map((e) => e.id);
  const exitEdges = edges.filter((e) => nodes.get(e.to)!.isEndpoint).map((e) => e.id);

  return {
    scenario,
    nodes,
    roads,
    edges,
    edgeByKey,
    segments,
    lanes,
    connectors,
    entryEdges,
    exitEdges,
    warnings,
  };
}

/** Elevation (0..1) at arc length s on a segment — ramps interpolate between their end levels. */
export function segmentLevel(seg: Segment, s: number): number {
  if (seg.kind === 'connector') return seg.level;
  if (seg.levelFrom === seg.levelTo) return seg.levelFrom;
  const t = Math.max(0, Math.min(1, s / seg.length));
  return seg.levelFrom + (seg.levelTo - seg.levelFrom) * t;
}
