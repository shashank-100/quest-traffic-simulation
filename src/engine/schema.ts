import type { FlowDef, NodeDef, RoadDef, Scenario, SignalDef } from './types';

/**
 * Validates untrusted JSON (imports, API payloads) into a Scenario, clamping values to sane ranges.
 * Throws with a readable message when the shape is wrong.
 */
export function parseScenario(raw: unknown): Scenario {
  const o = obj(raw, 'scenario');
  const nodes = arr(o.nodes, 'nodes', 2000).map((n, i): NodeDef => {
    const x = obj(n, `nodes[${i}]`);
    return {
      id: str(x.id, `nodes[${i}].id`),
      x: num(x.x, -1e5, 1e5),
      y: num(x.y, -1e5, 1e5),
      level: x.level === 1 ? 1 : 0,
      ...(x.signal ? { signal: signal(x.signal, i) } : {}),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const roads = arr(o.roads, 'roads', 4000).map((r, i): RoadDef => {
    const x = obj(r, `roads[${i}]`);
    const road: RoadDef = {
      id: str(x.id, `roads[${i}].id`),
      from: str(x.from, `roads[${i}].from`),
      to: str(x.to, `roads[${i}].to`),
      lanesFwd: Math.round(num(x.lanesFwd, 0, 6)),
      lanesBwd: Math.round(num(x.lanesBwd, 0, 6)),
      laneWidth: num(x.laneWidth, 2.75, 5),
      speedLimit: num(x.speedLimit, 2, 40),
    };
    if (typeof x.name === 'string') road.name = x.name.slice(0, 80);
    if (!ids.has(road.from) || !ids.has(road.to)) throw new Error(`roads[${i}] references an unknown node`);
    return road;
  });
  const flows = arr(o.flows ?? [], 'flows', 500).map((f, i): FlowDef => {
    const x = obj(f, `flows[${i}]`);
    const mix = obj(x.mix ?? { car: 1 }, `flows[${i}].mix`);
    return {
      id: str(x.id, `flows[${i}].id`),
      ...(typeof x.name === 'string' ? { name: x.name.slice(0, 80) } : {}),
      origin: str(x.origin, `flows[${i}].origin`),
      destination: x.destination == null ? null : str(x.destination, `flows[${i}].destination`),
      rate: num(x.rate, 0, 10000),
      mix: { car: num(mix.car ?? 0, 0, 1e3), bus: num(mix.bus ?? 0, 0, 1e3), bike: num(mix.bike ?? 0, 0, 1e3), truck: num(mix.truck ?? 0, 0, 1e3) },
      speedFactor: num(x.speedFactor ?? 1, 0.3, 2),
      start: num(x.start ?? 0, 0, 1e9),
      end: num(x.end ?? 1e9, 0, 1e9),
      ...(x.maxVehicles != null ? { maxVehicles: Math.round(num(x.maxVehicles, 0, 1e6)) } : {}),
    };
  });
  return {
    id: typeof o.id === 'string' ? o.id.slice(0, 64) : 'custom',
    name: typeof o.name === 'string' ? o.name.slice(0, 120) : 'Untitled scenario',
    description: typeof o.description === 'string' ? o.description.slice(0, 2000) : '',
    seed: Math.round(num(o.seed ?? 1, 0, 2 ** 32 - 1)),
    duration: num(o.duration ?? 600, 10, 7200),
    driveSide: o.driveSide === 'right' ? 'right' : 'left',
    congestionAwareRouting: o.congestionAwareRouting === true,
    nodes,
    roads,
    flows,
  };
}

function signal(raw: unknown, i: number): SignalDef {
  const s = obj(raw, `nodes[${i}].signal`);
  return {
    enabled: s.enabled !== false,
    yellow: num(s.yellow ?? 3, 0, 10),
    allRed: num(s.allRed ?? 2, 0, 10),
    offset: num(s.offset ?? 0, -1e4, 1e4),
    phases: arr(s.phases, `nodes[${i}].signal.phases`, 12).map((p, k) => {
      const x = obj(p, `phase ${k}`);
      return { green: num(x.green, 1, 300), approaches: arr(x.approaches, 'approaches', 12).map((a) => str(a, 'approach')) };
    }),
  };
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  if (v.length > max) throw new Error(`${what} has more than ${max} items`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) throw new Error(`${what} must be a short string`);
  return v;
}
function num(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return Math.max(min, Math.min(max, n));
}
