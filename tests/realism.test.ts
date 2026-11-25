import { describe, expect, it } from 'vitest';
import { buildNetwork, preset, PRESETS, Simulation, type Connector } from '../src/engine';

describe('free-flow reference and delay', () => {
  it('no trip is faster than the same driver alone on the empty network (beyond half a time step)', () => {
    for (const p of PRESETS) {
      for (const seed of [1, 2, 3]) {
        const sim = new Simulation({ ...preset(p.id), seed });
        sim.run(900);
        const worst = Math.max(0, ...sim.trips.map((t) => t.freeFlowTime - t.travelTime));
        expect(worst, `${p.id} seed ${seed}`).toBeLessThan(0.05);
      }
    }
  });

  it('vehicles reach junction curves at their safe speed, also when following another vehicle', () => {
    const sim = new Simulation({ ...preset('grid'), seed: 2 });
    let worst = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step();
      for (const v of sim.vehicles) {
        const seg = sim.net.segments[v.seg];
        if (seg.kind === 'connector') worst = Math.max(worst, v.v - (seg as Connector).speedLimit);
      }
    }
    // Late braking at the comfortable deceleration overshoots by at most a fraction of one step.
    expect(worst).toBeLessThan(0.5);
  });
});

describe('throughput', () => {
  it('excludes the warm-up and matches the rate at which traffic enters an uncongested network', () => {
    for (const id of ['crossing-at-grade', 'crossing-flyover']) {
      for (const seed of [42, 43, 44]) {
        const sim = new Simulation({ ...preset(id), seed });
        sim.run(900);
        const s = sim.summary();
        const entered = (sim.spawned / 900) * 3600;
        expect(s.warmup, `${id} ${seed}`).toBeGreaterThan(60);
        expect(Math.abs(s.throughputPerHour - entered) / entered, `${id} ${seed}`).toBeLessThan(0.06);
      }
    }
  });
});

describe('main-road priority at unsignalised junctions', () => {
  const unsignalised = (id: string) => {
    const sc = preset(id);
    return { ...sc, nodes: sc.nodes.map((n) => ({ ...n, signal: undefined })) };
  };
  const majorNames = (id: string) => {
    const net = buildNetwork(unsignalised(id));
    return [...net.nodes.values()].filter((n) => n.control === 'intersection').map((n) => [...n.majorRoads].map((r) => net.roads.get(r)!.name).sort().join('+'));
  };

  it('picks the main road: wider/faster roads, else the straight-through pair; none when symmetric', () => {
    expect(majorNames('t-junction')).toEqual(['Main street+Main street']);
    expect(majorNames('crossing-at-grade')).toEqual(['Outer Ring Road+Outer Ring Road']);
    expect(majorNames('four-way')).toEqual(['']);
  });

  it('side-road traffic waits longer than main-road traffic at a T-junction', () => {
    for (const seed of [1, 2, 3]) {
      const sc = { ...preset('t-junction'), seed };
      const sim = new Simulation(sc);
      sim.run(900);
      const delay = (fid: string) => {
        const t = sim.trips.filter((r) => r.flowId === fid);
        return t.reduce((a, r) => a + r.travelTime - r.freeFlowTime, 0) / t.length;
      };
      const main = (delay(sc.flows[0].id) + delay(sc.flows[1].id)) / 2;
      expect(delay(sc.flows[2].id), `seed ${seed}`).toBeGreaterThan(main);
      expect(sim.summary().safetyInterventions).toBe(0);
    }
  });

  it('main-road through traffic never stops for the side road, and side-road capacity matches gap acceptance', () => {
    const sc = unsignalised('crossing-at-grade');
    const sim = new Simulation(sc);
    sim.run(900);
    const arterial = sim.trips.filter((t) => ['f1', 'f2'].includes(t.flowId));
    const side = sim.trips.filter((t) => ['f3', 'f4'].includes(t.flowId));
    expect(arterial.reduce((a, t) => a + t.stoppedTime, 0) / arterial.length).toBeLessThan(0.5);
    // HCM potential capacity against ~2,100 veh/h of conflicting flow is roughly 50 veh/h per
    // approach; the side road must get some gaps, but far fewer than its 840 veh/h demand.
    const sideRate = (side.length / 900) * 3600;
    expect(sideRate).toBeGreaterThan(20);
    expect(sideRate).toBeLessThan(250);
    expect(sim.invariantViolations()).toEqual([]);
  });
});
