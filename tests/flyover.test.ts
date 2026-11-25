import { describe, expect, it } from 'vitest';
import { addFlyover, addRoad, buildNetwork, emptyScenario, preset, reachableExits, runScenario, Simulation } from '../src/engine';
import { nodeAt } from './helpers';

const OPTS = { lanesFwd: 2, lanesBwd: 2, laneWidth: 3.5, speedLimit: 14 };

describe('editor: junctions versus flyovers', () => {
  it('drawing a ground road across another creates a 4-way junction', () => {
    let sc = addRoad(emptyScenario(), { x: -200, y: 0 }, { x: 200, y: 0 }, OPTS).scenario;
    sc = addRoad(sc, { x: 0, y: -200 }, { x: 0, y: 200 }, OPTS).scenario;
    expect(sc.roads).toHaveLength(4);
    const j = nodeAt(sc, 0, 0);
    expect(sc.roads.filter((r) => r.from === j || r.to === j)).toHaveLength(4);
  });

  it('a T-junction forms when a road ends on another road', () => {
    let sc = addRoad(emptyScenario(), { x: -200, y: 0 }, { x: 200, y: 0 }, OPTS).scenario;
    sc = addRoad(sc, { x: 50, y: 200 }, { x: 50, y: 1 }, OPTS, 0, 4).scenario;
    const j = nodeAt(sc, 50, 0);
    expect(sc.roads.filter((r) => r.from === j || r.to === j)).toHaveLength(3);
  });

  it('a flyover crosses a ground road without creating a junction', () => {
    let sc = addRoad(emptyScenario(), { x: 0, y: -200 }, { x: 0, y: 200 }, OPTS).scenario;
    sc = addFlyover(sc, { x: -300, y: 0 }, { x: 300, y: 0 }, OPTS).scenario;
    expect(sc.nodes.filter((n) => n.level === 1)).toHaveLength(2);
    // The ground road is untouched: still one road, no node at the crossing point.
    expect(sc.roads.filter((r) => r.from === nodeAt(sc, 0, -200))).toHaveLength(1);
    expect(sc.nodes.some((n) => n.x === 0 && n.y === 0)).toBe(false);
    const net = buildNetwork(sc);
    expect([...net.nodes.values()].every((n) => n.degree <= 2)).toBe(true);
    expect(net.connectors.every((c) => net.nodes.get(c.node)!.degree === 2)).toBe(true);
  });

  it('ground traffic under a flyover cannot turn onto it (no false intersection)', () => {
    const sc = preset('crossing-flyover');
    const net = buildNetwork(sc);
    const north = net.entryEdges.find((e) => net.nodes.get(net.edges[e].from)!.pos.y < -200)!;
    const exits = reachableExits(net, north);
    expect(exits).toHaveLength(1);
    expect(net.nodes.get(exits[0])!.pos.y).toBeGreaterThan(200);
  });

  it('a ground road drawn under an existing flyover deck is not split by it', () => {
    let sc = addFlyover(emptyScenario(), { x: -300, y: 0 }, { x: 300, y: 0 }, OPTS).scenario;
    const before = sc.roads.length;
    sc = addRoad(sc, { x: 0, y: -200 }, { x: 0, y: 200 }, OPTS).scenario;
    expect(sc.roads.length).toBe(before + 1);
  });
});

describe('flyover in simulation', () => {
  it('through traffic on the deck and the cross street never wait for each other', () => {
    const sim = new Simulation(preset('crossing-flyover'));
    sim.run(600);
    expect(sim.invariantViolations()).toEqual([]);
    expect(sim.summary().maxQueueLength).toBe(0);
    expect(sim.summary().stopsShare).toBeLessThan(0.01);
  });

  it('vehicles on the deck are elevated and ramps rise gradually', () => {
    const sim = new Simulation(preset('crossing-flyover'));
    const levels = new Set<number>();
    for (let i = 0; i < 1500; i++) {
      sim.step();
      for (const v of sim.vehicles) levels.add(Math.round(sim.pose(v).level * 4) / 4);
    }
    expect(levels.has(0)).toBe(true);
    expect(levels.has(1)).toBe(true);
    expect([...levels].some((l) => l > 0 && l < 1)).toBe(true);
  });

  it('before/after: the flyover reduces delay and queues for the same demand', () => {
    const before = runScenario(preset('crossing-at-grade')).summary;
    const after = runScenario(preset('crossing-flyover')).summary;
    expect(after.avgDelay).toBeLessThan(before.avgDelay * 0.5);
    expect(after.avgQueueLength).toBeLessThan(before.avgQueueLength);
    expect(after.avgTripSpeed).toBeGreaterThan(before.avgTripSpeed);
    // Both serve the same demand, so throughput is similar (demand-limited, not capacity-limited).
    expect(Math.abs(after.throughputPerHour - before.throughputPerHour) / before.throughputPerHour).toBeLessThan(0.1);
  });
});
