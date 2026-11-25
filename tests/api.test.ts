import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { preset, PRESETS } from '../src/engine';

/** In-memory stand-in for a KV namespace: get, put (with metadata) and lexicographic prefix listing. */
function memoryKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)?.value ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      // Yield first, so concurrent requests interleave as they would against a real store.
      await Promise.resolve();
      store.set(key, { value, metadata: opts?.metadata });
    },
    async list({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number }) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
      return { keys: names.map((name) => ({ name, metadata: store.get(name)!.metadata })), list_complete: true };
    },
  };
}

const allow = { limit: async () => ({ success: true }) };
const env = (limiter = allow) => ({ SCENARIOS: memoryKv(), SIMULATE_LIMIT: limiter, SAVE_LIMIT: limiter }) as never;
const call = (e: never, path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://test${path}`, init) as never, e) as Promise<Response>;

describe('backend API', () => {
  it('saves, lists and loads scenarios', async () => {
    const e = env();
    const sc = preset('t-junction');
    const res = await call(e, '/api/scenarios', { method: 'POST', body: JSON.stringify(sc) });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { id: string; name: string };
    expect(meta.name).toBe(sc.name);
    const list = (await (await call(e, '/api/scenarios')).json()) as { scenarios: { id: string }[] };
    expect(list.scenarios.map((s) => s.id)).toEqual([meta.id]);
    const loaded = (await (await call(e, `/api/scenarios/${meta.id}`)).json()) as typeof sc;
    expect(loaded.roads).toEqual(sc.roads);
    expect((await call(e, '/api/scenarios/doesnotexist')).status).toBe(404);
  });

  it('lists every one of many concurrent saves, newest first', async () => {
    const e = env();
    const saves = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(e, '/api/scenarios', { method: 'POST', body: JSON.stringify({ ...preset('t-junction'), name: `race ${i}` }) })),
    );
    expect(saves.every((r) => r.status === 201)).toBe(true);
    const ids = await Promise.all(saves.map(async (r) => ((await r.json()) as { id: string }).id));
    const list = (await (await call(e, '/api/scenarios')).json()) as { scenarios: { id: string; createdAt: string }[] };
    expect(list.scenarios.map((s) => s.id).sort()).toEqual([...ids].sort());
    const times = list.scenarios.map((s) => Date.parse(s.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('rejects invalid scenarios with a 400', async () => {
    const res = await call(env(), '/api/scenarios', { method: 'POST', body: JSON.stringify({ nodes: 1 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nodes/);
  });

  it('runs a headless simulation with the shared engine, deterministically', async () => {
    const body = JSON.stringify({ scenario: preset('four-way'), duration: 120, seed: 7 });
    const a = (await (await call(env(), '/api/simulate', { method: 'POST', body })).json()) as { summary: { spawned: number }; duration: number };
    const b = (await (await call(env(), '/api/simulate', { method: 'POST', body })).json()) as typeof a;
    expect(a.duration).toBe(120);
    expect(a.summary.spawned).toBeGreaterThan(10);
    expect(a.summary).toEqual(b.summary);
  });

  it('runs every preset at the maximum duration within the server budget', async () => {
    for (const p of PRESETS) {
      const res = await call(env(), '/api/simulate', { method: 'POST', body: JSON.stringify({ scenario: p.build(), duration: 600 }) });
      expect(res.status, p.id).toBe(200);
    }
  });

  it('refuses scenarios too large for the server with a 413 instead of running them', async () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, x: i * 50, y: 0 }));
    const roads = Array.from({ length: 299 }, (_, i) => ({ id: `r${i}`, from: `n${i}`, to: `n${i + 1}`, lanesFwd: 3, lanesBwd: 3, laneWidth: 3.5, speedLimit: 14 }));
    const scenario = { nodes, roads, flows: [{ id: 'f', origin: 'n0', destination: 'n299', rate: 3000, mix: { car: 1 } }] };
    const res = await call(env(), '/api/simulate', { method: 'POST', body: JSON.stringify({ scenario, duration: 600 }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);
  });

  it('rate-limits simulate and save per client with a 429', async () => {
    const deny = { limit: async () => ({ success: false }) };
    const sim = await call(env(deny), '/api/simulate', { method: 'POST', body: JSON.stringify({ scenario: preset('t-junction'), duration: 30 }) });
    const save = await call(env(deny), '/api/scenarios', { method: 'POST', body: JSON.stringify(preset('t-junction')) });
    expect([sim.status, save.status]).toEqual([429, 429]);
  });
});
