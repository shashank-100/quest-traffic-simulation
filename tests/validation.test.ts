import { describe, expect, it } from 'vitest';
import { addFlyover, addRoad, emptyScenario, idmAccel, laneWidthEffect, preset, Simulation, VEHICLE_PARAMS, type Connector, type Scenario, type VehicleMix } from '../src/engine';

const CARS: VehicleMix = { car: 1, bus: 0, bike: 0, truck: 0 };

function road(lanes: number, width: number, rate: number, mix: VehicleMix = CARS, maxVehicles?: number): Scenario {
  const r = addRoad(emptyScenario(), { x: 0, y: 0 }, { x: 900, y: 0 }, { lanesFwd: lanes, lanesBwd: 0, laneWidth: width, speedLimit: 16.7 });
  r.scenario.flows.push({ id: 'f', origin: r.from, destination: r.to, rate, mix, speedFactor: 1.2, start: 0, end: 1e9, ...(maxVehicles ? { maxVehicles } : {}) });
  return r.scenario;
}

/** Vehicles per hour leaving the network over a 10-minute window after a 5-minute warm-up. */
function discharge(sc: Scenario): number {
  const sim = new Simulation(sc);
  sim.run(300);
  const before = sim.trips.length;
  sim.run(600);
  return ((sim.trips.length - before) / 600) * 3600;
}

describe('road capacity responds to lane count and lane width', () => {
  it('capacity scales with the number of lanes, at a realistic per-lane value', () => {
    const q = [1, 2, 3].map((n) => discharge(road(n, 3.5, 9000)));
    expect(q[0]).toBeGreaterThan(1500);
    expect(q[0]).toBeLessThan(2100);
    expect(q[1] / q[0]).toBeGreaterThan(1.9);
    expect(q[2] / q[0]).toBeGreaterThan(2.8);
  });

  it('wider lanes carry more traffic (shorter headways)', () => {
    const q = [2.75, 3.0, 3.5, 4.0].map((w) => discharge(road(1, w, 4000)));
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThan(q[i - 1]);
    expect(q[3] / q[0]).toBeGreaterThan(1.08);
  });

  it('wider lanes raise free-flow speed, most for wide vehicles', () => {
    const mixed: VehicleMix = { car: 0.6, bus: 0.15, bike: 0.1, truck: 0.15 };
    const speed = (w: number) => {
      const sim = new Simulation(road(1, w, 300, mixed));
      sim.run(900);
      return sim.summary().avgTripSpeed;
    };
    const s = [2.75, 3.0, 3.5, 4.0].map(speed);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
    expect(laneWidthEffect(3.5, VEHICLE_PARAMS.bus.width).speed).toBeLessThan(laneWidthEffect(3.5, VEHICLE_PARAMS.car.width).speed);
    expect(laneWidthEffect(3.0, VEHICLE_PARAMS.bike.width).speed).toBe(1);
  });

  it('lane-width factors follow the HCM adjustments', () => {
    expect(laneWidthEffect(3.6, 1.8)).toEqual({ speed: 1, headway: 1 });
    expect(laneWidthEffect(3.0, 1.8).speed).toBeCloseTo(0.9);
    expect(1 / laneWidthEffect(3.0, 1.8).headway).toBeCloseTo(1 + (3.0 - 3.6) / 9); // HCM f_w
  });

  it('a 3→2 lane drop discharges well above one lane, with both merging lanes used at once', () => {
    const sc = preset('lane-drop');
    sc.flows[0].rate = 3400;
    const sim = new Simulation(sc);
    const merging = sim.net.connectors.filter((c) => c.merges.length > 0);
    expect(merging.length).toBe(2);
    let concurrent = 0;
    for (let i = 0; i < 6000; i++) {
      sim.step();
      if (merging.every((c) => sim.occ[c.id].length > 0)) concurrent++;
      if (i % 10 === 0) expect(sim.invariantViolations()).toEqual([]);
    }
    expect(concurrent).toBeGreaterThan(0); // merging is shared (gap acceptance), not exclusive
    const q = discharge(sc);
    console.log(`lane-drop discharge ${q.toFixed(0)} veh/h`);
    expect(q).toBeGreaterThan(2500); // was ~2,390 with exclusive merges; 1-lane capacity ≈ 1,650
  });
});

describe('vehicle dynamics refinements', () => {
  it('above the desired speed, vehicles slow at no more than the comfortable deceleration (IIDM)', () => {
    const p = VEHICLE_PARAMS.car;
    expect(idmAccel(p, 20, 10, Infinity, 0)).toBeLessThan(0);
    expect(idmAccel(p, 20, 10, Infinity, 0)).toBeGreaterThanOrEqual(-p.decel);
    expect(idmAccel(p, 10.01, 10, Infinity, 0)).toBeCloseTo(0, 1);
  });

  it('heavy vehicles accelerate more slowly climbing a flyover ramp', () => {
    const r = addFlyover(emptyScenario(), { x: 0, y: 0 }, { x: 600, y: 0 }, { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 16.7 });
    const sc = r.scenario;
    sc.flows.push({ id: 'f', origin: r.from, destination: r.to, rate: 600, mix: { car: 0, bus: 0, bike: 0, truck: 1 }, speedFactor: 1, start: 0, end: 1e9, maxVehicles: 5 });
    const sim = new Simulation(sc);
    const upRamp = sim.net.lanes.find((l) => l.levelTo > l.levelFrom)!;
    let maxOnRamp = 0;
    for (let i = 0; i < 2000; i++) {
      sim.step();
      for (const v of sim.vehicles) if (v.seg === upRamp.id) maxOnRamp = Math.max(maxOnRamp, v.acc);
    }
    expect(maxOnRamp).toBeLessThanOrEqual(VEHICLE_PARAMS.truck.accel - 9.81 * (6 / upRamp.length) + 1e-9);
    expect(sim.trips).toHaveLength(5);
  });
});

describe('long-run robustness', () => {
  it('no gridlock and no rule violations over 30 minutes on several seeds', () => {
    for (const id of ['four-way', 'grid']) {
      for (const seed of [1, 2, 3]) {
        const sim = new Simulation({ ...preset(id), seed });
        for (let i = 0; i < 18000; i++) {
          sim.step();
          if (i % 50 === 0) expect(sim.invariantViolations(), `${id} seed ${seed}`).toEqual([]);
        }
        const s = sim.samples;
        expect(s[s.length - 1].exited - s[s.length - 301].exited, `${id} seed ${seed}`).toBeGreaterThan(100);
        expect(sim.summary().safetyInterventions).toBe(0);
      }
    }
  });

  it('merging movements at a 4-way are classified as merges, crossing ones as conflicts', () => {
    const sim = new Simulation(preset('four-way'));
    for (const c of sim.net.connectors) {
      for (const k of c.merges) expect((sim.net.segments[k] as Connector).toLane).toBe(c.toLane);
      expect(c.merges.some((k) => c.conflicts.includes(k))).toBe(false);
    }
  });
});
