import { describe, expect, it } from 'vitest';
import { addRoad, emptyScenario, idmAccel, Simulation, VEHICLE_PARAMS, type Connector, type Lane } from '../src/engine';
import { nodeAt, straightRoad, untilFirstVehicle } from './helpers';

describe('Intelligent Driver Model', () => {
  const p = VEHICLE_PARAMS.car;
  it('accelerates at a_max from standstill on a free road', () => {
    expect(idmAccel(p, 0, 15, Infinity, 0)).toBeCloseTo(p.accel);
  });
  it('does not accelerate at the desired speed', () => {
    expect(idmAccel(p, 15, 15, Infinity, 0)).toBeCloseTo(0);
  });
  it('brakes hard when closing in on a stopped obstacle', () => {
    expect(idmAccel(p, 15, 15, 10, 15)).toBeLessThan(-p.maxDecel);
  });
  it('is in equilibrium at the steady-state gap', () => {
    const v = 10;
    const v0 = 15;
    const sStar = p.minGap + v * p.headway;
    const gap = sStar / Math.sqrt(1 - (v / v0) ** 4);
    expect(idmAccel(p, v, v0, gap, 0)).toBeCloseTo(0, 6);
  });
});

describe('vehicle movement', () => {
  it('accelerates smoothly to its desired speed and never exceeds it', () => {
    const sim = new Simulation(straightRoad(2000));
    const v = untilFirstVehicle(sim);
    let maxSpeed = 0;
    let prev = v.v;
    for (let i = 0; i < 600 && sim.vehicles.length; i++) {
      sim.step();
      maxSpeed = Math.max(maxSpeed, v.v);
      expect((v.v - prev) / 0.1).toBeLessThanOrEqual(v.p.accel + 1e-9);
      prev = v.v;
    }
    expect(maxSpeed).toBeLessThanOrEqual(Math.min(v.v0, 20) + 1e-6);
    expect(maxSpeed).toBeGreaterThan(0.97 * Math.min(v.v0, 20));
  });

  it('obeys the road speed limit', () => {
    const sim = new Simulation(straightRoad(1500, {}, { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 8 }));
    let max = 0;
    for (let i = 0; i < 1200; i++) {
      sim.step();
      for (const v of sim.vehicles) max = Math.max(max, v.v);
    }
    expect(max).toBeLessThanOrEqual(8 + 1e-6);
  });

  it('completes the trip in about length / speed, and records it', () => {
    const sim = new Simulation(straightRoad(1000));
    sim.run(200);
    expect(sim.trips).toHaveLength(1);
    const trip = sim.trips[0];
    const vmax = Math.min(20, sim.trips[0].distance / trip.travelTime + 5);
    expect(trip.distance).toBeGreaterThan(995);
    expect(trip.travelTime).toBeGreaterThan(1000 / vmax);
    expect(trip.travelTime).toBeLessThan(1000 / 10 + 15);
  });

  it('keeps safe gaps in dense platoons: no overlaps, no safety interventions', () => {
    const sim = new Simulation(straightRoad(1500, { rate: 2200, maxVehicles: 80, mix: { car: 0.6, bus: 0.1, bike: 0.2, truck: 0.1 } }));
    for (let i = 0; i < 3000; i++) {
      sim.step();
      expect(sim.invariantViolations()).toEqual([]);
    }
    expect(sim.safetyInterventions).toBe(0);
    expect(sim.trips.length).toBeGreaterThan(30);
  });

  it('a follower stops behind a stopped leader at roughly the minimum gap', () => {
    // A red signal (that never turns green for this approach) stops the platoon.
    let sc = straightRoad(600, { rate: 1800, maxVehicles: 6 }, { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 15 });
    sc = addRoad(sc, { x: 400, y: -100 }, { x: 400, y: 100 }, { lanesFwd: 1, lanesBwd: 1, laneWidth: 3.5, speedLimit: 10 }).scenario;
    const j = sc.nodes.find((n) => n.x === 400 && n.y === 0)!;
    const ns = sc.roads.filter((r) => r.from === j.id || r.to === j.id).filter((r) => r.name === undefined && (sc.nodes.find((n) => n.id === (r.from === j.id ? r.to : r.from))!.x === 400));
    j.signal = { enabled: true, yellow: 3, allRed: 2, offset: 0, phases: [{ green: 1000, approaches: ns.map((r) => r.id) }, { green: 10, approaches: sc.roads.filter((r) => !ns.includes(r)).map((r) => r.id) }] };
    const sim = new Simulation(sc);
    sim.run(150);
    expect(sim.vehicles).toHaveLength(6);
    expect(sim.nodeThroughput.get(j.id) ?? 0).toBe(0);
    const queue = sim.occ.flat().sort((a, b) => b.s - a.s);
    for (const v of queue) expect(v.v).toBeLessThan(0.05);
    for (let i = 1; i < queue.length; i++) {
      const gap = queue[i - 1].s - queue[i - 1].p.length - queue[i].s;
      expect(gap).toBeGreaterThan(queue[i].p.minGap * 0.8);
      expect(gap).toBeLessThan(queue[i].p.minGap + 1.5);
    }
  });
});

describe('lane changes', () => {
  it('changes lane to reach a turn that its current lane cannot make', () => {
    let sc = emptyScenario();
    sc = addRoad(sc, { x: -400, y: 0 }, { x: 0, y: 0 }, { lanesFwd: 2, lanesBwd: 0, laneWidth: 3.5, speedLimit: 14 }).scenario;
    sc = addRoad(sc, { x: 0, y: 0 }, { x: 300, y: 0 }, { lanesFwd: 2, lanesBwd: 0, laneWidth: 3.5, speedLimit: 14 }).scenario;
    sc = addRoad(sc, { x: 0, y: 0 }, { x: 0, y: -300 }, { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 14 }).scenario;
    // Heading east under left-hand traffic, north is a left (kerb-side) turn: only the outer lane may take it.
    sc.flows.push({ id: 'f', origin: nodeAt(sc, -400, 0), destination: nodeAt(sc, 0, -300), rate: 3600, mix: { car: 1, bus: 0, bike: 0, truck: 0 }, speedFactor: 1, start: 0, end: 1e9, maxVehicles: 1 });
    const sim = new Simulation(sc);
    const v = untilFirstVehicle(sim);
    const edge = sim.net.edges[v.route[0]];
    const inner = edge.lanes[0];
    const innerLane = sim.net.segments[inner] as Lane;
    expect(innerLane.connectorsOut.some((c) => (sim.net.segments[c] as Connector).toEdge === v.route[1])).toBe(false);
    sim.relocate(v, inner, 30);
    sim.run(120);
    expect(sim.laneChangeCount).toBeGreaterThanOrEqual(1);
    expect(sim.trips).toHaveLength(1);
  });

  it('overtakes slow vehicles on multi-lane roads (discretionary MOBIL changes)', () => {
    const sc = straightRoad(2000, { rate: 900, maxVehicles: 40, mix: { car: 0.6, bus: 0, bike: 0, truck: 0.4 } }, { lanesFwd: 2, lanesBwd: 0, laneWidth: 3.5, speedLimit: 20 });
    const sim = new Simulation(sc);
    for (let i = 0; i < 2500; i++) {
      sim.step();
      expect(sim.invariantViolations()).toEqual([]);
    }
    expect(sim.laneChangeCount).toBeGreaterThan(3);
  });
});
