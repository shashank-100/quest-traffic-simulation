import { addRoad, emptyScenario, type FlowDef, type RoadOptions, type Scenario } from '../src/engine';

export const ONE_LANE: RoadOptions = { lanesFwd: 1, lanesBwd: 0, laneWidth: 3.5, speedLimit: 20 };

/** A single straight one-way road of the given length with one flow. */
export function straightRoad(length = 1000, flow: Partial<FlowDef> = {}, road: RoadOptions = ONE_LANE): Scenario {
  const r = addRoad(emptyScenario('straight'), { x: 0, y: 0 }, { x: length, y: 0 }, road);
  const sc = r.scenario;
  sc.flows.push({
    id: 'f1',
    origin: r.from,
    destination: r.to,
    rate: 3600,
    mix: { car: 1, bus: 0, bike: 0, truck: 0 },
    speedFactor: 1,
    start: 0,
    end: 1e9,
    maxVehicles: 1,
    ...flow,
  });
  return sc;
}

export function nodeAt(sc: Scenario, x: number, y: number, level = 0): string {
  const n = sc.nodes.find((k) => Math.abs(k.x - x) < 0.5 && Math.abs(k.y - y) < 0.5 && k.level === level);
  if (!n) throw new Error(`no node at ${x},${y}`);
  return n.id;
}

/** Steps until the first vehicle has entered the network. */
export function untilFirstVehicle(sim: import('../src/engine').Simulation) {
  for (let i = 0; i < 1000 && sim.vehicles.length === 0; i++) sim.step();
  if (!sim.vehicles.length) throw new Error('no vehicle spawned');
  return sim.vehicles[0];
}
