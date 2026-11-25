import { describe, expect, it } from 'vitest';
import { preset, PRESETS, Simulation } from '../src/engine';

describe('junction rules', () => {
  for (const p of PRESETS) {
    it(`${p.id}: conflicting movements are never occupied at once and vehicles never overlap`, () => {
      const sim = new Simulation(p.build());
      for (let i = 0; i < 4000; i++) {
        sim.step();
        if (i % 5 === 0) expect(sim.invariantViolations()).toEqual([]);
      }
      expect(sim.safetyInterventions).toBe(0);
    });
  }

  it('unsignalised T-junction serves the side street (no starvation)', () => {
    const sc = preset('t-junction');
    const sim = new Simulation(sc);
    sim.run(600);
    const side = sc.flows[2].id;
    const sideTrips = sim.trips.filter((t) => t.flowId === side);
    expect(sideTrips.length).toBeGreaterThan(20);
    expect(Math.max(...sideTrips.map((t) => t.travelTime))).toBeLessThan(150);
  });

  it('does not gridlock: under sustained demand every preset keeps discharging', () => {
    for (const p of PRESETS) {
      const sim = new Simulation(p.build());
      sim.run(900);
      const s = sim.samples;
      const lastFiveMin = s[s.length - 1].exited - s[s.length - 301].exited;
      expect(lastFiveMin, p.id).toBeGreaterThan(30);
    }
  });

  it('turning vehicles complete every movement at a 4-way', () => {
    const sc = preset('four-way');
    const sim = new Simulation(sc);
    sim.run(600);
    const turns = new Set<string>();
    // Every vehicle that completed a trip passed through exactly one connector; tally by turn type.
    const seen = new Set<number>();
    const sim2 = new Simulation(sc);
    for (let i = 0; i < 6000; i++) {
      sim2.step();
      for (const v of sim2.vehicles) {
        const seg = sim2.net.segments[v.seg];
        if (seg.kind === 'connector' && !seen.has(v.id)) {
          seen.add(v.id);
          turns.add(seg.turn);
        }
      }
    }
    expect([...turns].sort()).toEqual(['left', 'right', 'straight']);
    expect(sim.trips.length).toBeGreaterThan(150);
  });
});

describe('simple connections versus intersections', () => {
  const controlsOf = (id: string) => [...new Simulation(preset(id)).net.nodes.values()].filter((n) => !n.isEndpoint).map((n) => n.control);

  it('classifies nodes: flyover joints are connections; crossings, merges and signals are intersections', () => {
    expect(controlsOf('crossing-flyover')).toEqual(['connection', 'connection']);
    expect(controlsOf('crossing-at-grade')).toEqual(['intersection']);
    expect(controlsOf('lane-drop')).toEqual(['intersection']); // merging movements
    expect(controlsOf('t-junction')).toEqual(['intersection']); // crossing movements, no signal
  });

  it('vehicles never request or hold permission at simple connections', () => {
    const sim = new Simulation(preset('crossing-flyover'));
    for (let i = 0; i < 4000; i++) {
      sim.step();
      for (const v of sim.vehicles) {
        const seg = sim.net.segments[v.seg];
        if (seg.kind === 'lane' && sim.net.nodes.get(seg.toNode)!.control === 'connection') {
          expect(v.grant).toBeNull();
          expect(v.requestT).toBe(-1);
        }
      }
    }
    expect(sim.summary().safetyInterventions).toBe(0);
  });

  it('a lone vehicle drives through connections and an empty intersection without braking or delay', () => {
    for (const id of ['crossing-flyover', 'crossing-at-grade']) {
      const sc = preset(id);
      for (const f of sc.flows) {
        // No signal, no other traffic: any braking or delay would come from the control logic itself.
        const lone = { ...sc, nodes: sc.nodes.map((n) => ({ ...n, signal: undefined })), flows: [{ ...f, rate: 3600, maxVehicles: 1, mix: { car: 1, bus: 0, bike: 0, truck: 0 } }] };
        const sim = new Simulation(lone);
        let braked = false;
        for (let i = 0; i < 3000 && sim.trips.length === 0; i++) {
          sim.step();
          for (const v of sim.vehicles) if (v.acc < -1e-6) braked = true;
        }
        const t = sim.trips[0];
        expect(braked, `${id} ${f.name}`).toBe(false);
        expect(Math.abs(t.travelTime - t.freeFlowTime), `${id} ${f.name}`).toBeLessThan(0.1); // one time step
      }
    }
  });
});
