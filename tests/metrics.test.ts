import { describe, expect, it } from 'vitest';
import { parseScenario, preset, PRESETS, runScenario, Simulation } from '../src/engine';
import { straightRoad } from './helpers';

describe('simulation metrics', () => {
  it('conserves vehicles: spawned = completed + active', () => {
    for (const p of PRESETS) {
      const sim = new Simulation(p.build());
      sim.run(300);
      const s = sim.summary();
      expect(s.spawned, p.id).toBe(s.completed + s.active);
      expect(s.unroutable, p.id).toBe(0);
    }
  });

  it('computes throughput, travel time and trip speed from trip records', () => {
    const sim = new Simulation(preset('four-way'));
    sim.run(400);
    const s = sim.summary();
    // Trip averages use trips that entered after the warm-up; time averages use samples after it.
    const measured = sim.trips.filter((t) => t.exitT - t.travelTime >= s.warmup);
    const total = measured.reduce((a, t) => a + t.travelTime, 0);
    const after = sim.samples.filter((x) => x.t > s.warmup);
    expect(s.measuredTrips).toBe(measured.length);
    expect(s.measuredTrips).toBeGreaterThan(50);
    expect(s.completed).toBe(sim.trips.length);
    expect(s.avgQueueLength).toBeCloseTo(after.reduce((a, x) => a + x.queueLength, 0) / after.length, 9);
    expect(s.maxQueueLength).toBeCloseTo(Math.max(...after.map((x) => x.maxLaneQueue)), 9);
    expect(s.warmup).toBeGreaterThan(0);
    expect(s.warmup).toBeLessThanOrEqual(200);
    expect(s.warmup).toBeCloseTo(Math.min(200, Math.max(...sim.trips.map((t) => t.freeFlowTime))), 9);
    expect(s.throughputPerHour).toBeCloseTo((sim.trips.filter((t) => t.exitT > s.warmup).length / (400 - s.warmup)) * 3600, 6);
    expect(s.avgTravelTime).toBeCloseTo(total / measured.length, 6);
    expect(s.avgTripSpeed).toBeCloseTo(measured.reduce((a, t) => a + t.distance, 0) / total, 6);
    expect(s.avgDelay).toBeGreaterThan(0);
  });

  it('a free-flowing vehicle has near-zero delay and no queue', () => {
    const r = runScenario(straightRoad(800, { rate: 300, maxVehicles: 10 }), 300);
    expect(r.summary.completed).toBe(10);
    expect(r.summary.avgDelay).toBeLessThan(3);
    expect(r.summary.maxQueueLength).toBe(0);
  });

  it('measures density as vehicles per km per lane', () => {
    const sim = new Simulation(straightRoad(1000, { rate: 1800, maxVehicles: 1000 }));
    sim.run(120);
    const edge = sim.net.edges[0];
    const live = sim.edgeLive(edge.id);
    expect(live.count).toBe(sim.vehicles.length);
    expect(live.density).toBeCloseTo(live.count / (edge.length / 1000), 6);
  });

  it('reports queues at a red light and samples time series every second', () => {
    const sim = new Simulation(preset('crossing-at-grade'));
    sim.run(120);
    expect(sim.samples).toHaveLength(120);
    expect(Math.max(...sim.samples.map((s) => s.queueLength))).toBeGreaterThan(10);
    expect(sim.summary().maxQueueLength).toBeGreaterThan(10);
  });
});

describe('reproducibility', () => {
  it('the same scenario and seed give identical results', () => {
    const a = runScenario(preset('grid'), 300);
    const b = runScenario(preset('grid'), 300);
    expect(a.summary).toEqual(b.summary);
    expect(a.samples).toEqual(b.samples);
  });

  it('a different seed gives a different realisation', () => {
    const sc = preset('four-way');
    const a = runScenario(sc, 300).summary;
    const b = runScenario({ ...sc, seed: sc.seed + 1 }, 300).summary;
    expect(a).not.toEqual(b);
  });

  it('scenarios survive a JSON round trip through the validator', () => {
    for (const p of PRESETS) {
      const sc = p.build();
      expect(parseScenario(JSON.parse(JSON.stringify(sc)))).toEqual(sc);
    }
  });

  it('rejects malformed scenarios', () => {
    expect(() => parseScenario({ nodes: 'x' })).toThrow();
    expect(() => parseScenario({ nodes: [], roads: [{ id: 'r', from: 'a', to: 'b', lanesFwd: 1, lanesBwd: 1, laneWidth: 3.5, speedLimit: 10 }], flows: [] })).toThrow(/unknown node/);
  });
});
