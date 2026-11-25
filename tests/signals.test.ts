import { describe, expect, it } from 'vitest';
import { autoPhases, buildNetwork, cycleLength, lightFor, preset, signalStatus, Simulation, type SignalDef } from '../src/engine';

const sig: SignalDef = { enabled: true, yellow: 3, allRed: 2, offset: 0, phases: [{ green: 20, approaches: ['a'] }, { green: 10, approaches: ['b'] }] };

describe('signal timing', () => {
  it('cycles green → yellow → all-red through each phase', () => {
    expect(cycleLength(sig)).toBe(40);
    expect(signalStatus(sig, 0)).toMatchObject({ phase: 0, stage: 'green' });
    expect(signalStatus(sig, 19.9)).toMatchObject({ phase: 0, stage: 'green' });
    expect(signalStatus(sig, 21)).toMatchObject({ phase: 0, stage: 'yellow' });
    expect(signalStatus(sig, 24)).toMatchObject({ phase: 0, stage: 'allRed' });
    expect(signalStatus(sig, 25)).toMatchObject({ phase: 1, stage: 'green' });
    expect(signalStatus(sig, 36)).toMatchObject({ phase: 1, stage: 'yellow' });
    expect(signalStatus(sig, 40)).toMatchObject({ phase: 0, stage: 'green' });
    expect(signalStatus(sig, 21).remaining).toBeCloseTo(2);
  });

  it('applies the cycle offset', () => {
    expect(signalStatus({ ...sig, offset: 25 }, 0)).toMatchObject({ phase: 1, stage: 'green' });
  });

  it('never shows green to two phases at once and gives every approach green each cycle', () => {
    const net = buildNetwork(preset('four-way'));
    const j = [...net.nodes.values()].find((n) => n.signal)!;
    const roads = j.roads.map((r) => r.roadId);
    const sawGreen = new Set<string>();
    for (let t = 0; t < cycleLength(j.signal!); t += 0.5) {
      const greens = roads.filter((r) => lightFor(j, r, t) === 'green');
      const phases = new Set(greens.flatMap((r) => j.phaseOfRoad.get(r)!));
      expect(phases.size).toBeLessThanOrEqual(1);
      greens.forEach((g) => sawGreen.add(g));
    }
    expect(sawGreen.size).toBe(roads.length);
  });

  it('groups opposing approaches into shared phases', () => {
    const sc = preset('four-way');
    const j = sc.nodes.find((n) => n.signal)!;
    expect(autoPhases(sc, j.id)).toHaveLength(2);
    const t = preset('t-junction');
    const tj = t.nodes.find((n) => t.roads.filter((r) => r.from === n.id || r.to === n.id).length === 3)!;
    expect(autoPhases(t, tj.id)).toHaveLength(2);
  });
});

describe('signal compliance in simulation', () => {
  it('no vehicle enters on red, and a grant does not survive the light turning red', () => {
    for (const id of ['four-way', 'crossing-at-grade', 'grid']) {
      const sim = new Simulation(preset(id));
      let entries = 0;
      const seen = new Set<number>();
      for (let i = 0; i < 6000; i++) {
        sim.step();
        for (const v of sim.vehicles) {
          const seg = sim.net.segments[v.seg];
          if (seg.kind === 'lane') {
            const node = sim.net.nodes.get(seg.toNode)!;
            // Nobody still approaching holds a grant while their light is red.
            if (node.signal && lightFor(node, seg.roadId, sim.t) === 'red') expect(v.grant, `${id} vehicle ${v.id}`).toBeNull();
            continue;
          }
          if (seen.has(v.id) || !sim.net.nodes.get(seg.node)!.signal) continue;
          seen.add(v.id);
          entries++;
          const lane = sim.net.segments[seg.fromLane];
          // Entering happens in the step it crosses the line, so check the light at the previous step.
          expect(lightFor(sim.net.nodes.get(seg.node)!, lane.kind === 'lane' ? lane.roadId : '', sim.t - 0.1), `${id} vehicle ${v.id}`).not.toBe('red');
        }
      }
      expect(entries, id).toBeGreaterThan(200);
      expect(sim.safetyInterventions, id).toBe(0);
    }
  });

  it('queues discharge from standstill at no more than the vehicle acceleration', () => {
    const sim = new Simulation(preset('crossing-at-grade'));
    let checked = 0;
    const last = new Map<number, number>();
    for (let i = 0; i < 3000; i++) {
      sim.step();
      for (const v of sim.vehicles) {
        const prev = last.get(v.id);
        if (prev !== undefined && prev < 0.1 && v.v > 0) {
          expect(v.v - prev).toBeLessThanOrEqual(v.p.accel * 0.1 + 1e-9);
          checked++;
        }
        last.set(v.id, v.v);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
