import { test, expect } from 'vitest';
import { addFlyover, addRoad, emptyScenario, endpointRoles, parseScenario, setSignal, Simulation, updateRoad, type Scenario } from '../src/engine';
import { endpointLabels } from '../src/web/format';
import { newFlow } from '../src/web/TrafficPanel';
test('a network built with the editor tools validates, keeps its flows consistent through edits, and runs cleanly', () => {
  const two = { lanesFwd: 2, lanesBwd: 2, laneWidth: 3.5, speedLimit: 13.9 };
  const one = { lanesFwd: 1, lanesBwd: 1, laneWidth: 3.0, speedLimit: 11.1 };
  let sc: Scenario = emptyScenario('journey');
  sc = addRoad(sc, { x: -400, y: 0 }, { x: 400, y: 0 }, two).scenario;
  sc = addRoad(sc, { x: 0, y: -300 }, { x: 0, y: 300 }, one).scenario;
  sc = addRoad(sc, { x: 200, y: 250 }, { x: 200, y: 0 }, one).scenario;
  sc = addFlyover(sc, { x: -300, y: -250 }, { x: 350, y: 250 }, one).scenario;
  sc = addRoad(sc, { x: -400, y: 150 }, { x: -200, y: 150 }, { ...one, lanesBwd: 0 }).scenario;
  sc = setSignal(sc, sc.nodes.find((n) => n.x === 0 && n.y === 0)!.id, true);
  // Traffic tab: flows only from entry points.
  const roles = endpointRoles(sc);
  for (const id of endpointLabels(sc).keys()) if (roles.get(id)!.entry) sc = { ...sc, flows: [...sc.flows, { ...newFlow(sc, id), rate: 300 }] };
  expect(() => parseScenario(JSON.parse(JSON.stringify(sc)))).not.toThrow();
  // Extend a road from a flow origin: that flow is removed; the scenario stays valid.
  const origin = sc.flows[0].origin;
  const n = sc.nodes.find((x) => x.id === origin)!;
  const ext = addRoad(sc, origin, { x: n.x - 100, y: n.y + 120 }, one).scenario;
  expect(ext.flows.some((f) => f.origin === origin)).toBe(false);
  expect(() => parseScenario(JSON.parse(JSON.stringify(ext)))).not.toThrow();
  // Make a two-way exit one-way inbound: flows destined there fall back to any exit.
  const dest = [...roles.entries()].find(([, r]) => r.entry && r.exit)![0];
  const withDest: Scenario = { ...sc, flows: sc.flows.map((f, i) => (i === 1 ? { ...f, destination: dest } : f)) };
  const road = withDest.roads.find((r) => r.from === dest || r.to === dest)!;
  const oneWay = updateRoad(withDest, road.id, road.from === dest ? { lanesBwd: 0 } : { lanesFwd: 0 });
  expect(() => parseScenario(JSON.parse(JSON.stringify(oneWay)))).not.toThrow();
  // Run the hand-built network for 30 minutes with every safety check.
  const sim = new Simulation({ ...ext, seed: 3 });
  for (let i = 0; i < 18000; i++) { sim.step(); if (i % 20 === 0) expect(sim.invariantViolations()).toEqual([]); }
  const s = sim.summary();
  expect(s.unroutable).toBe(0);
  expect(s.safetyInterventions).toBe(0);
  expect(s.spawned).toBe(s.completed + s.active);
}, 60000);
