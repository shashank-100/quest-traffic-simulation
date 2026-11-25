import { describe, expect, it } from 'vitest';
import { parseScenario, preset, PRESETS, type Scenario } from '../src/engine';

/** Two-node, one two-way road, plus a T-junction preset for signal and flow cases. */
const base = (): Scenario => JSON.parse(JSON.stringify(preset('t-junction')));
const reject = (sc: unknown, message: RegExp) => expect(() => parseScenario(sc)).toThrow(message);

describe('scenario validation', () => {
  it('accepts every preset', () => {
    for (const p of PRESETS) expect(() => parseScenario(p.build())).not.toThrow();
  });

  it('rejects duplicate node, road and flow ids', () => {
    const a = base();
    a.nodes.push({ ...a.nodes[0], x: 999 });
    reject(a, /Duplicate node id/);
    const b = base();
    b.roads.push({ ...b.roads[0] });
    reject(b, /Duplicate road id/);
    const c = base();
    c.flows.push({ ...c.flows[0] });
    reject(c, /Duplicate flow id/);
  });

  it('rejects roads that loop onto one node or have no lanes', () => {
    const a = base();
    a.roads[0] = { ...a.roads[0], to: a.roads[0].from };
    reject(a, /connects node .* to itself/);
    const b = base();
    b.roads[0] = { ...b.roads[0], lanesFwd: 0, lanesBwd: 0 };
    reject(b, /has no lanes/);
  });

  it('rejects signal phases that name roads not at that junction', () => {
    const sc = base();
    const j = sc.nodes.find((n) => sc.roads.filter((r) => r.from === n.id || r.to === n.id).length === 3)!;
    j.signal = { enabled: true, yellow: 3, allRed: 2, offset: 0, phases: [{ green: 20, approaches: ['no-such-road'] }] };
    reject(sc, /does not meet this junction/);
  });

  it('rejects flows that do not start at an entry point or end at an exit point', () => {
    const sc = base();
    const junction = sc.nodes.find((n) => sc.roads.filter((r) => r.from === n.id || r.to === n.id).length === 3)!.id;
    reject({ ...sc, flows: [{ ...sc.flows[0], origin: 'ghost' }] }, /origin ghost is not a node/);
    reject({ ...sc, flows: [{ ...sc.flows[0], origin: junction }] }, /is not an entry point/);
    reject({ ...sc, flows: [{ ...sc.flows[0], destination: 'ghost' }] }, /destination ghost is not a node/);
    reject({ ...sc, flows: [{ ...sc.flows[0], destination: junction }] }, /is not an exit point/);
    reject({ ...sc, flows: [{ ...sc.flows[0], destination: sc.flows[0].origin }] }, /same as the origin/);
    reject({ ...sc, flows: [{ ...sc.flows[0], mix: { car: 0, bus: 0, bike: 0, truck: 0 } }] }, /vehicle mix is empty/);
    reject({ ...sc, flows: [{ ...sc.flows[0], start: 100, end: 50 }] }, /ends before it starts/);
  });

  it('respects one-way roads: no entry at the outflow end, no exit at the inflow end', () => {
    const sc: Scenario = {
      ...base(),
      nodes: [
        { id: 'a', x: 0, y: 0, level: 0 },
        { id: 'b', x: 200, y: 0, level: 0 },
      ],
      roads: [{ id: 'r', from: 'a', to: 'b', lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 14 }],
      flows: [],
    };
    const flow = { id: 'f', origin: 'a', destination: 'b', rate: 100, mix: { car: 1, bus: 0, bike: 0, truck: 0 }, speedFactor: 1, start: 0, end: 1e9 };
    expect(() => parseScenario({ ...sc, flows: [flow] })).not.toThrow();
    reject({ ...sc, flows: [{ ...flow, origin: 'b', destination: 'a' }] }, /origin b is not an entry point/);
  });
});
