import { describe, expect, it } from 'vitest';
import { buildNetwork, freeFlowCost, parseScenario, preset, removeRoad, shortestRoute, shortestRouteVia, Simulation, type Scenario } from '../src/engine';

/** The 3×3 grid: junction ids by position, and endpoint ids. */
const grid = () => preset('grid');
const nodeAt = (sc: Scenario, x: number, y: number) => sc.nodes.find((n) => n.x === x && n.y === y)!.id;

describe('via points', () => {
  it('routes through each via point in order, and reports impossible orders', () => {
    const sc = grid();
    const net = buildNetwork(sc);
    const west = nodeAt(sc, -380, 0);
    const east = nodeAt(sc, 380, 0);
    const entry = net.entryEdges.find((e) => net.edges[e].from === west)!;
    const direct = shortestRoute(net, entry, east, freeFlowCost(net))!;
    const northWest = nodeAt(sc, -200, -200);
    const southEast = nodeAt(sc, 200, 200);
    const detour = shortestRouteVia(net, entry, [northWest, southEast], east, freeFlowCost(net))!;
    const passed = detour.map((e) => net.edges[e].to);
    expect(passed.indexOf(northWest)).toBeGreaterThanOrEqual(0);
    expect(passed.indexOf(southEast)).toBeGreaterThan(passed.indexOf(northWest));
    expect(passed[passed.length - 1]).toBe(east);
    expect(detour.length).toBeGreaterThan(direct.length);
    // A one-way street makes some orders impossible.
    const oneWay: Scenario = { ...sc, roads: sc.roads.map((r) => ({ ...r, lanesBwd: 0, lanesFwd: Math.max(1, r.lanesFwd) })) };
    const net2 = buildNetwork(oneWay);
    const entry2 = net2.entryEdges.find((e) => net2.edges[e].from === west)!;
    expect(shortestRouteVia(net2, entry2, [nodeAt(sc, 200, 0), nodeAt(sc, -200, 0)], east, freeFlowCost(net2))).toBeNull();
  });

  it('vehicles of a flow with via points drive through them, with zero delay when alone', () => {
    const sc = grid();
    const via = [nodeAt(sc, -200, -200), nodeAt(sc, 200, 200)];
    const flow = { ...sc.flows[0], origin: nodeAt(sc, -380, 0), destination: nodeAt(sc, 380, 0), via, rate: 300 };
    // Alone, without signals: travel time equals the free-flow reference along the detour, to
    // within half a 0.1 s time step (this route includes a lane change, which the reference treats
    // as free while the vehicle sees its lane end until it changes).
    const lone = new Simulation({ ...sc, nodes: sc.nodes.map((n) => ({ ...n, signal: undefined })), flows: [{ ...flow, maxVehicles: 1, mix: { car: 1, bus: 0, bike: 0, truck: 0 } }] });
    lone.run(400);
    expect(lone.trips).toHaveLength(1);
    expect(Math.abs(lone.trips[0].travelTime - lone.trips[0].freeFlowTime)).toBeLessThan(0.05);
    // In traffic: every vehicle of the flow passes both junctions, in order.
    const sim = new Simulation({ ...sc, flows: [...sc.flows.slice(1), flow] });
    const visited = new Map<number, string[]>();
    for (let i = 0; i < 9000; i++) {
      sim.step();
      for (const v of sim.vehicles) {
        const seg = sim.net.segments[v.seg];
        if (v.flowId !== flow.id || seg.kind !== 'connector') continue;
        const list = visited.get(v.id) ?? [];
        if (list[list.length - 1] !== seg.node) list.push(seg.node);
        visited.set(v.id, list);
      }
    }
    const done = sim.trips.filter((t) => t.flowId === flow.id);
    expect(done.length).toBeGreaterThan(15);
    for (const t of done) {
      const path = visited.get(t.id)!;
      expect(path.indexOf(via[1])).toBeGreaterThan(path.indexOf(via[0]));
      expect(path.indexOf(via[0])).toBeGreaterThanOrEqual(0);
    }
    expect(sim.summary().unroutable).toBe(0);
  });

  it('with "any exit", the exit is chosen among those reachable after the last via point', () => {
    const sc = grid();
    const via = [nodeAt(sc, 0, 200)];
    const flow = { ...sc.flows[0], origin: nodeAt(sc, -380, -200), destination: null, via, rate: 600 };
    const sim = new Simulation({ ...sc, flows: [flow] });
    sim.run(600);
    expect(sim.trips.length).toBeGreaterThan(30);
    expect(sim.summary().unroutable).toBe(0);
  });

  it('validation rejects via points that are unknown, road ends, or repeated', () => {
    const sc = grid();
    const f = sc.flows[0];
    const end = nodeAt(sc, 380, 0);
    const j = nodeAt(sc, 0, 0);
    expect(() => parseScenario({ ...sc, flows: [{ ...f, via: ['ghost'] }] })).toThrow(/via point ghost is not a node/);
    expect(() => parseScenario({ ...sc, flows: [{ ...f, via: [end] }] })).toThrow(/is not a junction/);
    expect(() => parseScenario({ ...sc, flows: [{ ...f, via: [j, j] }] })).toThrow(/listed twice in a row/);
    expect(() => parseScenario({ ...sc, flows: [{ ...f, via: [j] }] })).not.toThrow();
  });

  it('drops via points that stop being junctions after an edit', () => {
    const sc = preset('t-junction');
    const j = sc.nodes.find((n) => sc.roads.filter((r) => r.from === n.id || r.to === n.id).length === 3)!.id;
    const withVia: Scenario = { ...sc, flows: sc.flows.map((f, i) => (i === 0 ? { ...f, via: [j] } : f)) };
    // Remove the side street: the junction becomes a plain joint (still two roads), so it stays.
    const side = sc.roads.find((r) => (r.from === j || r.to === j) && sc.nodes.find((n) => n.id === (r.from === j ? r.to : r.from))!.y !== 0)!;
    const noSide = removeRoad(withVia, side.id);
    expect(noSide.flows[0].via).toEqual([j]);
    // Remove one half of the main street too: the node is now a road end, so the via point goes.
    const half = noSide.roads.find((r) => r.from === j || r.to === j)!;
    const after = removeRoad(noSide, half.id);
    expect(after.flows.every((f) => !f.via?.includes(j))).toBe(true);
  });
});
