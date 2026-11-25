import { addFlyover, addRoad, setSignal, type RoadOptions } from './editor';
import type { FlowDef, Scenario, VehicleMix } from './types';

const URBAN_MIX: VehicleMix = { car: 0.62, bike: 0.25, bus: 0.06, truck: 0.07 };
const ARTERIAL: RoadOptions = { lanesFwd: 2, lanesBwd: 2, laneWidth: 3.5, speedLimit: 13.9 };
const STREET: RoadOptions = { lanesFwd: 1, lanesBwd: 1, laneWidth: 3.25, speedLimit: 11.1 };

export function emptyScenario(name = 'Untitled scenario'): Scenario {
  return {
    id: 'custom',
    name,
    description: '',
    seed: 42,
    duration: 600,
    driveSide: 'left',
    congestionAwareRouting: false,
    nodes: [],
    roads: [],
    flows: [],
  };
}

function flow(sc: Scenario, origin: string, destination: string | null, rate: number, name?: string): FlowDef {
  const f: FlowDef = {
    id: `f${sc.flows.length + 1}`,
    name,
    origin,
    destination,
    rate,
    mix: { ...URBAN_MIX },
    speedFactor: 1,
    start: 0,
    end: 1e9,
  };
  sc.flows.push(f);
  return f;
}

function fourWay(): Scenario {
  let sc = { ...emptyScenario('Signalised 4-way junction'), id: 'four-way' };
  sc.description = 'Two 4-lane arterials meet at a signalised junction. Mixed traffic turns in all directions.';
  const ew = addRoad(sc, { x: -300, y: 0 }, { x: 300, y: 0 }, ARTERIAL, 0, 4, 'MG Road');
  sc = ew.scenario;
  const ns = addRoad(sc, { x: 0, y: -260 }, { x: 0, y: 260 }, ARTERIAL, 0, 4, 'Brigade Road');
  sc = ns.scenario;
  const j = sc.nodes.find((n) => n.x === 0 && n.y === 0)!;
  sc = setSignal(sc, j.id, true);
  for (const id of [ew.from, ew.to]) flow(sc, id, null, 520);
  for (const id of [ns.from, ns.to]) flow(sc, id, null, 380);
  return sc;
}

/** Shared demand for the before/after flyover comparison: identical endpoints and through movements. */
function crossingDemand(sc: Scenario, w: string, e: string, n: string, s: string): void {
  flow(sc, w, e, 1100, 'Westside → Eastside');
  flow(sc, e, w, 1000, 'Eastside → Westside');
  flow(sc, n, s, 420, 'North → South');
  flow(sc, s, n, 420, 'South → North');
}

function crossingAtGrade(): Scenario {
  let sc = { ...emptyScenario('Crossing: at-grade (before)'), id: 'crossing-at-grade' };
  sc.description = 'A busy arterial crosses a cross street at a signalised junction. Compare with the flyover version.';
  sc.duration = 900;
  const ew = addRoad(sc, { x: -420, y: 0 }, { x: 420, y: 0 }, ARTERIAL, 0, 4, 'Outer Ring Road');
  sc = ew.scenario;
  const ns = addRoad(sc, { x: 0, y: -260 }, { x: 0, y: 260 }, STREET, 0, 4, 'Cross street');
  sc = ns.scenario;
  const j = sc.nodes.find((n) => n.x === 0 && n.y === 0)!;
  sc = setSignal(sc, j.id, true);
  const sig = sc.nodes.find((n) => n.id === j.id)!.signal!;
  for (const ph of sig.phases) ph.green = ph.approaches.some((r) => sc.roads.find((x) => x.id === r)?.name === 'Outer Ring Road') ? 32 : 18;
  crossingDemand(sc, ew.from, ew.to, ns.from, ns.to);
  return sc;
}

function crossingFlyover(): Scenario {
  let sc = { ...emptyScenario('Crossing: flyover (after)'), id: 'crossing-flyover' };
  sc.description = 'Same demand as the at-grade crossing, but the arterial is carried over the cross street on a flyover.';
  sc.duration = 900;
  const ns = addRoad(sc, { x: 0, y: -260 }, { x: 0, y: 260 }, STREET, 0, 4, 'Cross street');
  sc = ns.scenario;
  const ew = addFlyover(sc, { x: -420, y: 0 }, { x: 420, y: 0 }, ARTERIAL, 4, 'Outer Ring Road flyover');
  sc = ew.scenario;
  crossingDemand(sc, ew.from, ew.to, ns.from, ns.to);
  return sc;
}

function tJunction(): Scenario {
  let sc = { ...emptyScenario('Priority T-junction'), id: 't-junction' };
  sc.description = 'An unsignalised T-junction. Movements are served first-come-first-served with conflict checks.';
  const main = addRoad(sc, { x: -300, y: 0 }, { x: 300, y: 0 }, STREET, 0, 4, 'Main street');
  sc = main.scenario;
  const side = addRoad(sc, { x: 0, y: 240 }, { x: 0, y: 0 }, STREET, 0, 4, 'Side street');
  sc = side.scenario;
  flow(sc, main.from, null, 420);
  flow(sc, main.to, null, 420);
  flow(sc, side.from, null, 220);
  return sc;
}

function laneDrop(): Scenario {
  let sc = { ...emptyScenario('Lane-drop bottleneck'), id: 'lane-drop' };
  sc.description = 'A 3-lane one-way road narrows to 2 lanes. Vehicles zipper-merge; watch the queue form upstream.';
  const a = addRoad(sc, { x: -450, y: 0 }, { x: 0, y: 0 }, { lanesFwd: 3, lanesBwd: 0, laneWidth: 3.5, speedLimit: 16.7 }, 0, 4, 'Expressway');
  sc = a.scenario;
  const b = addRoad(sc, a.to, { x: 450, y: 0 }, { lanesFwd: 2, lanesBwd: 0, laneWidth: 3.5, speedLimit: 16.7 }, 0, 4, 'Expressway (narrow)');
  sc = b.scenario;
  const f = flow(sc, a.from, b.to, 2600, 'Through traffic');
  f.mix = { car: 0.8, bike: 0.1, bus: 0.04, truck: 0.06 };
  return sc;
}

function grid(): Scenario {
  let sc = { ...emptyScenario('City grid (3×3)'), id: 'grid' };
  sc.description = 'Nine signalised junctions with a green wave on the middle avenue and congestion-aware routing.';
  sc.duration = 900;
  sc.congestionAwareRouting = true;
  const xs = [-200, 0, 200];
  const ends: string[] = [];
  for (const y of xs) {
    const r = addRoad(sc, { x: -380, y }, { x: 380, y }, y === 0 ? ARTERIAL : STREET, 0, 4, y === 0 ? 'Central Avenue' : `${y < 0 ? 'North' : 'South'} Street`);
    sc = r.scenario;
    ends.push(r.from, r.to);
  }
  for (const x of xs) {
    const r = addRoad(sc, { x, y: -380 }, { x, y: 380 }, STREET, 0, 4, `${x < 0 ? 'West' : x > 0 ? 'East' : 'Mid'} Cross`);
    sc = r.scenario;
    ends.push(r.from, r.to);
  }
  for (const n of [...sc.nodes]) {
    if (xs.includes(n.x) && xs.includes(n.y)) {
      sc = setSignal(sc, n.id, true);
      const node = sc.nodes.find((k) => k.id === n.id)!;
      // Green wave along Central Avenue (~200 m at ~11 m/s ≈ 18 s per block).
      if (n.y === 0) node.signal!.offset = Math.round(((n.x + 200) / 200) * 18);
    }
  }
  for (const id of ends) flow(sc, id, null, 190);
  return sc;
}

export interface Preset {
  id: string;
  build: () => Scenario;
}

export const PRESETS: Preset[] = [
  { id: 'four-way', build: fourWay },
  { id: 'crossing-at-grade', build: crossingAtGrade },
  { id: 'crossing-flyover', build: crossingFlyover },
  { id: 't-junction', build: tJunction },
  { id: 'lane-drop', build: laneDrop },
  { id: 'grid', build: grid },
];

export function preset(id: string): Scenario {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset ${id}`);
  return p.build();
}
