import type { Scenario } from '../engine';

export const kmh = (ms: number) => ms * 3.6;
export const fmt = (n: number, digits = 0) =>
  Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';

export function clock(t: number): string {
  const s = Math.floor(t);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Human labels for entry/exit points: compass direction from the network centre plus the road name. */
export function endpointLabels(sc: Scenario): Map<string, string> {
  const degree = new Map<string, number>();
  for (const r of sc.roads) {
    degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
    degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
  }
  const ends = sc.nodes.filter((n) => degree.get(n.id) === 1);
  const cx = sc.nodes.reduce((a, n) => a + n.x, 0) / Math.max(1, sc.nodes.length);
  const cy = sc.nodes.reduce((a, n) => a + n.y, 0) / Math.max(1, sc.nodes.length);
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const out = new Map<string, string>();
  const used = new Map<string, number>();
  for (const n of ends) {
    const a = Math.atan2(n.y - cy, n.x - cx);
    const d = dirs[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
    const road = sc.roads.find((r) => r.from === n.id || r.to === n.id);
    const name = road?.name?.replace(/ (flyover )?ramp$/i, '');
    const base = name ? `${d} · ${name}` : `${d} end`;
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    out.set(n.id, k > 1 ? `${base} ${k}` : base);
  }
  // Disambiguate the first of any duplicated label too.
  for (const [base, k] of used) if (k > 1) for (const [id, l] of out) if (l === base) out.set(id, `${base} 1`);
  return out;
}

export function roadLabel(sc: Scenario, roadId: string): string {
  const r = sc.roads.find((x) => x.id === roadId);
  return r?.name ? `${r.name} (${r.id})` : (r?.id ?? roadId);
}

/** "MG Road × Brigade Road (n5)": the distinct names of the roads meeting at a junction. */
export function junctionLabel(sc: Scenario, nodeId: string): string {
  const names = [...new Set(sc.roads.filter((r) => r.from === nodeId || r.to === nodeId).map((r) => r.name?.replace(/ (flyover )?ramp$/i, '') ?? r.id))];
  return `${names.join(' × ')} (${nodeId})`;
}
