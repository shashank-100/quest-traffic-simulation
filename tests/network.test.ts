import { describe, expect, it } from 'vitest';
import { addRoad, buildNetwork, emptyScenario, preset, reachableExits, shortestRoute, freeFlowCost, type Connector, type Lane } from '../src/engine';
import { nodeAt } from './helpers';

describe('road network compilation', () => {
  it('creates one lane per lane count and direction', () => {
    const sc = addRoad(emptyScenario(), { x: 0, y: 0 }, { x: 200, y: 0 }, { lanesFwd: 3, lanesBwd: 1, laneWidth: 3.5, speedLimit: 14 }).scenario;
    const net = buildNetwork(sc);
    expect(net.edges).toHaveLength(2);
    expect(net.edges.map((e) => e.lanes.length).sort()).toEqual([1, 3]);
    expect(net.lanes).toHaveLength(4);
  });

  it('places lanes on the correct side for left- and right-hand traffic', () => {
    for (const side of ['left', 'right'] as const) {
      const base = { ...emptyScenario(), driveSide: side };
      const net = buildNetwork(addRoad(base, { x: 0, y: 0 }, { x: 200, y: 0 }, { lanesFwd: 2, lanesBwd: 2, laneWidth: 3.5, speedLimit: 14 }).scenario);
      const eastbound = net.edges.find((e) => e.dir === 1)!;
      for (const id of eastbound.lanes) {
        const y = (net.segments[id] as Lane).path.points[0].y;
        // Screen y grows downward: heading east, the driver's left is -y.
        if (side === 'left') expect(y).toBeLessThan(0);
        else expect(y).toBeGreaterThan(0);
      }
      // Lane index 0 is the inner lane (closest to the centre line).
      const [inner, outer] = eastbound.lanes.map((id) => Math.abs((net.segments[id] as Lane).path.points[0].y));
      expect(inner).toBeLessThan(outer);
    }
  });

  it('sets lanes back from junctions and connects every approach to every other road at a 4-way', () => {
    const net = buildNetwork(preset('four-way'));
    const j = [...net.nodes.values()].find((n) => n.degree === 4)!;
    expect(j.setback).toBeGreaterThan(7);
    expect(j.inEdges).toHaveLength(4);
    for (const e of j.inEdges) {
      expect(net.edges[e].next).toHaveLength(3); // left, straight, right; no U-turn
      expect(net.edges[e].next.every((n) => net.edges[n].roadId !== net.edges[e].roadId)).toBe(true);
    }
  });

  it('assigns turns to lanes: kerb-side turns from the outer lane, far-side turns from the inner lane', () => {
    const net = buildNetwork(preset('four-way')); // left-hand traffic
    const j = [...net.nodes.values()].find((n) => n.degree === 4)!;
    for (const cid of j.connectors) {
      const c = net.segments[cid] as Connector;
      const from = net.segments[c.fromLane] as Lane;
      if (c.turn === 'left') expect(from.index).toBe(1);
      if (c.turn === 'right') expect(from.index).toBe(0);
    }
    expect(j.connectors.map((c) => (net.segments[c] as Connector).turn).filter((t) => t === 'straight')).toHaveLength(8);
  });

  it('marks crossing and merging movements as conflicts, but not parallel ones', () => {
    const net = buildNetwork(preset('four-way'));
    const j = [...net.nodes.values()].find((n) => n.degree === 4)!;
    const conns = j.connectors.map((c) => net.segments[c] as Connector);
    const heading = (c: Connector) => {
      const p = c.path.points;
      return Math.round(Math.atan2(p[p.length - 1].y - p[0].y, p[p.length - 1].x - p[0].x) / (Math.PI / 2));
    };
    const straights = conns.filter((c) => c.turn === 'straight');
    const east = straights.filter((c) => heading(c) === 0);
    const west = straights.filter((c) => Math.abs(heading(c)) === 2);
    const south = straights.filter((c) => heading(c) === 1);
    expect(east).toHaveLength(2);
    expect(east[0].conflicts).not.toContain(east[1].id); // parallel lanes
    expect(east[0].conflicts).not.toContain(west[0].id); // opposing through traffic
    expect(east[0].conflicts).toContain(south[0].id); // crossing
    for (const a of conns) for (const b of conns) {
      if (a !== b && a.toLane === b.toLane && a.fromLane !== b.fromLane) expect(a.conflicts).toContain(b.id); // merging
    }
  });

  it('ignores roads that reference missing nodes and reports a warning', () => {
    const sc = emptyScenario();
    sc.nodes.push({ id: 'a', x: 0, y: 0, level: 0 });
    sc.roads.push({ id: 'r', from: 'a', to: 'ghost', lanesFwd: 1, lanesBwd: 1, laneWidth: 3.5, speedLimit: 10 });
    const net = buildNetwork(sc);
    expect(net.edges).toHaveLength(0);
    expect(net.warnings[0]).toMatch(/missing node/);
  });
});

describe('connectivity and routing', () => {
  it('finds every other exit from each entry of a 4-way', () => {
    const net = buildNetwork(preset('four-way'));
    for (const e of net.entryEdges) {
      const exits = reachableExits(net, e);
      expect(exits).toHaveLength(3);
      expect(exits).not.toContain(net.edges[e].from);
    }
  });

  it('respects one-way streets', () => {
    const sc = addRoad(emptyScenario(), { x: 0, y: 0 }, { x: 200, y: 0 }, { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 14 }).scenario;
    const net = buildNetwork(sc);
    expect(net.entryEdges).toHaveLength(1);
    expect(shortestRoute(net, net.entryEdges[0], nodeAt(sc, 0, 0), freeFlowCost(net))).toBeNull();
    expect(shortestRoute(net, net.entryEdges[0], nodeAt(sc, 200, 0), freeFlowCost(net))).toHaveLength(1);
  });

  it('chooses the shorter of two alternative paths', () => {
    // Square A-B-C-D with a long detour: from west entry to east exit, the direct road should win.
    let sc = emptyScenario();
    const opts = { lanesFwd: 1, lanesBwd: 1, laneWidth: 3.5, speedLimit: 14 };
    sc = addRoad(sc, { x: -100, y: 0 }, { x: 0, y: 0 }, opts).scenario;
    sc = addRoad(sc, { x: 0, y: 0 }, { x: 300, y: 0 }, opts).scenario;
    sc = addRoad(sc, { x: 300, y: 0 }, { x: 400, y: 0 }, opts).scenario;
    sc = addRoad(sc, { x: 0, y: 0 }, { x: 0, y: 400 }, opts).scenario;
    sc = addRoad(sc, { x: 0, y: 400 }, { x: 300, y: 400 }, opts).scenario;
    sc = addRoad(sc, { x: 300, y: 400 }, { x: 300, y: 0 }, opts).scenario;
    const net = buildNetwork(sc);
    const entry = net.entryEdges.find((e) => net.edges[e].from === nodeAt(sc, -100, 0))!;
    const route = shortestRoute(net, entry, nodeAt(sc, 400, 0), freeFlowCost(net))!;
    expect(route).toHaveLength(3);
  });
});
