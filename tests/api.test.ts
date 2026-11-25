import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import { preset } from '../src/engine';

/** In-memory stand-in for a KV namespace, enough for the API's get/put calls. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key) ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const env = () => ({ SCENARIOS: memoryKv() }) as never;
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
});
