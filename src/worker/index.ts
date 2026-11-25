import { parseScenario, runScenario } from '../engine';

/**
 * Backend API. Static assets (the SPA) are served by the platform; only /api/* reaches this Worker.
 *
 *   POST /api/scenarios          save a scenario, returns { id, name, createdAt }
 *   GET  /api/scenarios          recently saved scenarios
 *   GET  /api/scenarios/:id      load a saved scenario
 *   POST /api/simulate           run a scenario headlessly with the same engine as the browser
 *   GET  /api/health
 */

interface Env {
  SCENARIOS: KVNamespace;
}

interface Meta {
  id: string;
  name: string;
  createdAt: string;
}

const MAX_BODY = 512 * 1024;
const MAX_SIM_SECONDS = 600;
const RECENT_KEY = 'index:recent';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (status: number, error: string) => json({ error }, status);

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Payload too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function newId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/health') return json({ ok: true, engine: 'agent-based IDM/MOBIL', time: new Date().toISOString() });

  if (path === '/api/scenarios' && req.method === 'POST') {
    const scenario = parseScenario(await readJson(req));
    const meta: Meta = { id: newId(), name: scenario.name, createdAt: new Date().toISOString() };
    await env.SCENARIOS.put(`scenario:${meta.id}`, JSON.stringify({ ...scenario, id: meta.id }), { metadata: meta });
    const recent = ((await env.SCENARIOS.get<Meta[]>(RECENT_KEY, 'json')) ?? []).filter((m) => m.id !== meta.id);
    await env.SCENARIOS.put(RECENT_KEY, JSON.stringify([meta, ...recent].slice(0, 30)));
    return json(meta, 201);
  }

  if (path === '/api/scenarios' && req.method === 'GET') {
    return json({ scenarios: (await env.SCENARIOS.get<Meta[]>(RECENT_KEY, 'json')) ?? [] });
  }

  const m = /^\/api\/scenarios\/([a-z0-9]{4,32})$/.exec(path);
  if (m && req.method === 'GET') {
    const body = await env.SCENARIOS.get(`scenario:${m[1]}`);
    return body ? new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } }) : fail(404, 'Scenario not found');
  }

  if (path === '/api/simulate' && req.method === 'POST') {
    const body = (await readJson(req)) as { scenario?: unknown; duration?: unknown; seed?: unknown };
    const scenario = parseScenario(body?.scenario ?? body);
    if (typeof body?.seed === 'number') scenario.seed = Math.max(0, Math.round(body.seed));
    const duration = Math.min(MAX_SIM_SECONDS, Math.max(10, Number(body?.duration ?? scenario.duration) || 0));
    const t0 = Date.now();
    const result = runScenario(scenario, duration);
    return json({ scenario: scenario.name, seed: scenario.seed, duration, wallMs: Date.now() - t0, summary: result.summary, warnings: result.warnings, samples: result.samples });
  }

  return fail(404, 'Not found');
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      return fail(400, err instanceof Error ? err.message : 'Bad request');
    }
  },
} satisfies ExportedHandler<Env>;
