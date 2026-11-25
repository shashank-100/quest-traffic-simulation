import { dist, lerp, pointSegmentDistance, segmentIntersection, type Vec } from './geometry';
import { autoPhases, defaultSignal } from './signals';
import { endpointRoles } from './schema';
import type { Level, NodeDef, RoadDef, Scenario } from './types';

/**
 * Pure editing operations on a Scenario. Each returns a new scenario and never mutates its input.
 *
 * The key rule for flyovers lives here: drawing a road splits (and so joins) only roads on the
 * same level. Elevated decks and ramps pass over ground roads without creating a junction.
 */

export interface RoadOptions {
  lanesFwd: number;
  lanesBwd: number;
  laneWidth: number;
  speedLimit: number;
}

export const DEFAULT_ROAD: RoadOptions = { lanesFwd: 2, lanesBwd: 2, laneWidth: 3.5, speedLimit: 13.9 };

const MIN_SPLIT_SPACING = 6;

function nextId(sc: Scenario, prefix: string): string {
  let max = 0;
  for (const x of [...sc.nodes, ...sc.roads, ...sc.flows]) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

const clone = (sc: Scenario): Scenario => structuredClone(sc);

function roadLevel(sc: Scenario, r: RoadDef): Level | 'ramp' {
  const a = sc.nodes.find((n) => n.id === r.from)!;
  const b = sc.nodes.find((n) => n.id === r.to)!;
  return a.level === b.level ? a.level : 'ramp';
}

function nodeById(sc: Scenario, id: string): NodeDef {
  const n = sc.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`Unknown node ${id}`);
  return n;
}

function addNode(sc: Scenario, p: Vec, level: Level): NodeDef {
  const n: NodeDef = { id: nextId(sc, 'n'), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, level };
  sc.nodes.push(n);
  return n;
}

/** Splits a road at point p (projected onto it), returning the new middle node (or an existing end node if p is close to one). */
function splitRoadAt(sc: Scenario, roadId: string, p: Vec): string {
  const road = sc.roads.find((r) => r.id === roadId)!;
  const a = nodeById(sc, road.from);
  const b = nodeById(sc, road.to);
  const { t } = pointSegmentDistance(p, a, b);
  const at = lerp(a, b, t);
  if (dist(at, a) < MIN_SPLIT_SPACING) return a.id;
  if (dist(at, b) < MIN_SPLIT_SPACING) return b.id;
  const mid = addNode(sc, at, a.level);
  const tail: RoadDef = { ...road, id: nextId(sc, 'r'), from: mid.id, to: road.to };
  road.to = mid.id;
  sc.roads.push(tail);
  refreshSignals(sc, [a.id, b.id, mid.id]);
  return mid.id;
}

/** Resolves a clicked point to a node on `level`: an existing node, a split of an existing road, or a new node. */
function resolvePoint(sc: Scenario, p: Vec | string, level: Level, snap: number): string {
  if (typeof p === 'string') return p;
  let best: { id: string; d: number } | null = null;
  for (const n of sc.nodes) {
    const d = dist(n, p);
    if (n.level === level && d <= snap && (!best || d < best.d)) best = { id: n.id, d };
  }
  if (best) return best.id;
  let bestRoad: { id: string; d: number } | null = null;
  for (const r of sc.roads) {
    if (roadLevel(sc, r) !== level) continue;
    const { d } = pointSegmentDistance(p, nodeById(sc, r.from), nodeById(sc, r.to));
    if (d <= snap && (!bestRoad || d < bestRoad.d)) bestRoad = { id: r.id, d };
  }
  if (bestRoad) return splitRoadAt(sc, bestRoad.id, p);
  return addNode(sc, p, level).id;
}

/** Adds road(s) from a to b, creating junctions wherever the new road crosses a road on the same level. */
function addRoadBetween(sc: Scenario, fromId: string, toId: string, opts: RoadOptions, name?: string): string[] {
  const A = nodeById(sc, fromId);
  const B = nodeById(sc, toId);
  const created: string[] = [];
  const level = A.level === B.level ? A.level : null;
  const stops: { t: number; node: string }[] = [];
  if (level !== null) {
    const crossings: { t: number; roadId: string; point: Vec }[] = [];
    for (const r of sc.roads) {
      if (roadLevel(sc, r) !== level) continue;
      if ([r.from, r.to].some((id) => id === fromId || id === toId)) continue;
      const hit = segmentIntersection(A, B, nodeById(sc, r.from), nodeById(sc, r.to));
      if (hit) crossings.push({ t: hit.t, roadId: r.id, point: hit.point });
    }
    crossings.sort((x, y) => x.t - y.t);
    for (const c of crossings) {
      const node = splitRoadAt(sc, c.roadId, c.point);
      if (node !== fromId && node !== toId && !stops.some((s) => s.node === node)) stops.push({ t: c.t, node });
    }
  }
  const chain = [fromId, ...stops.map((s) => s.node), toId];
  for (let i = 0; i + 1 < chain.length; i++) {
    if (chain[i] === chain[i + 1]) continue;
    const exists = sc.roads.some(
      (r) => (r.from === chain[i] && r.to === chain[i + 1]) || (r.from === chain[i + 1] && r.to === chain[i]),
    );
    if (exists) continue;
    const road: RoadDef = { id: nextId(sc, 'r'), from: chain[i], to: chain[i + 1], ...opts, ...(name ? { name } : {}) };
    sc.roads.push(road);
    created.push(road.id);
  }
  refreshSignals(sc, chain);
  return created;
}

export interface EditResult {
  scenario: Scenario;
  roads: string[];
  from: string;
  to: string;
}

/** Draws a ground (or elevated, if level=1) road between two points or node ids. */
export function addRoad(
  input: Scenario,
  a: Vec | string,
  b: Vec | string,
  opts: RoadOptions = DEFAULT_ROAD,
  level: Level = 0,
  snap = 4,
  name?: string,
): EditResult {
  const sc = clone(input);
  const from = resolvePoint(sc, a, level, snap);
  const to = resolvePoint(sc, b, level, snap);
  if (from === to) return { scenario: input, roads: [], from, to };
  const roads = addRoadBetween(sc, from, to, opts, name);
  reconcileFlows(sc);
  return { scenario: sc, roads, from, to };
}

/**
 * Draws a flyover between two ground points: up-ramp → elevated deck → down-ramp.
 * Nothing on the ground beneath it is split, so crossing traffic does not interact with it.
 */
export function addFlyover(
  input: Scenario,
  a: Vec | string,
  b: Vec | string,
  opts: RoadOptions = DEFAULT_ROAD,
  snap = 4,
  name = 'Flyover',
): EditResult {
  const sc = clone(input);
  const from = resolvePoint(sc, a, 0, snap);
  const to = resolvePoint(sc, b, 0, snap);
  const A = nodeById(sc, from);
  const B = nodeById(sc, to);
  const L = dist(A, B);
  if (L < 80) throw new Error('A flyover needs at least 80 m between its ends.');
  const ramp = Math.min(90, L * 0.3) / L;
  const u1 = addNode(sc, lerp(A, B, ramp), 1);
  const u2 = addNode(sc, lerp(A, B, 1 - ramp), 1);
  const roads = [
    ...addRoadBetween(sc, from, u1.id, opts, `${name} ramp`),
    ...addRoadBetween(sc, u1.id, u2.id, opts, name),
    ...addRoadBetween(sc, u2.id, to, opts, `${name} ramp`),
  ];
  reconcileFlows(sc);
  return { scenario: sc, roads, from, to };
}

function pruneOrphans(sc: Scenario): void {
  const used = new Set(sc.roads.flatMap((r) => [r.from, r.to]));
  sc.nodes = sc.nodes.filter((n) => used.has(n.id));
  reconcileFlows(sc);
}

/**
 * Keeps traffic consistent with the network after an edit: a flow whose origin is no longer an
 * entry point (deleted, extended into a through road, or made exit-only) is removed; a flow whose
 * destination is no longer an exit point falls back to "any exit"; via points that are no longer
 * junctions are dropped.
 */
function reconcileFlows(sc: Scenario): void {
  const roles = endpointRoles(sc);
  const degree = new Map<string, number>();
  for (const r of sc.roads) for (const n of [r.from, r.to]) degree.set(n, (degree.get(n) ?? 0) + 1);
  sc.flows = sc.flows
    .filter((f) => roles.get(f.origin)?.entry)
    .map((f) => (f.destination !== null && !roles.get(f.destination)?.exit ? { ...f, destination: null } : f))
    .map((f) => {
      if (!f.via) return f;
      // Via points must still be junctions; collapse any repeats left after removals.
      const via = f.via.filter((n) => (degree.get(n) ?? 0) >= 2).filter((n, i, a) => i === 0 || a[i - 1] !== n);
      return via.length === f.via.length ? f : { ...f, via };
    });
}

export function removeRoad(input: Scenario, roadId: string): Scenario {
  const sc = clone(input);
  const road = sc.roads.find((r) => r.id === roadId);
  if (!road) return input;
  sc.roads = sc.roads.filter((r) => r.id !== roadId);
  pruneOrphans(sc);
  refreshSignals(sc, [road.from, road.to]);
  return sc;
}

export function removeNode(input: Scenario, nodeId: string): Scenario {
  const sc = clone(input);
  const neighbours = sc.roads.filter((r) => r.from === nodeId || r.to === nodeId).flatMap((r) => [r.from, r.to]);
  sc.roads = sc.roads.filter((r) => r.from !== nodeId && r.to !== nodeId);
  sc.nodes = sc.nodes.filter((n) => n.id !== nodeId);
  pruneOrphans(sc);
  refreshSignals(sc, neighbours);
  return sc;
}

export function moveNode(input: Scenario, nodeId: string, p: Vec): Scenario {
  const sc = clone(input);
  const n = nodeById(sc, nodeId);
  n.x = Math.round(p.x * 10) / 10;
  n.y = Math.round(p.y * 10) / 10;
  return sc;
}

export function updateRoad(input: Scenario, roadId: string, patch: Partial<RoadDef>): Scenario {
  const sc = clone(input);
  const r = sc.roads.find((x) => x.id === roadId);
  if (r) Object.assign(r, patch, { id: r.id, from: r.from, to: r.to });
  reconcileFlows(sc);
  return sc;
}

export function setSignal(input: Scenario, nodeId: string, enabled: boolean): Scenario {
  const sc = clone(input);
  const n = nodeById(sc, nodeId);
  n.signal = enabled ? (n.signal ? { ...n.signal, enabled: true } : defaultSignal(sc, nodeId)) : n.signal && { ...n.signal, enabled: false };
  if (enabled) refreshSignals(sc, [nodeId]);
  return sc;
}

/** Keeps signal plans consistent with the roads actually meeting at a node after topology edits. */
function refreshSignals(sc: Scenario, nodeIds: string[]): void {
  for (const id of new Set(nodeIds)) {
    const n = sc.nodes.find((x) => x.id === id);
    if (!n?.signal) continue;
    const present = new Set(sc.roads.filter((r) => r.from === id || r.to === id).map((r) => r.id));
    const listed = new Set(n.signal.phases.flatMap((p) => p.approaches));
    const same = present.size === listed.size && [...present].every((r) => listed.has(r));
    if (same) continue;
    const greens = n.signal.phases.map((p) => p.green);
    const phases = autoPhases(sc, id);
    phases.forEach((p, i) => (p.green = greens[i] ?? p.green));
    n.signal = { ...n.signal, phases };
  }
}
