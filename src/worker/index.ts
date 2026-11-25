import { parseScenario, Simulation, type Scenario } from '../engine';

/**
 * Backend API. Static assets (the SPA) are served by the platform; only /api/* reaches this Worker.
 *
 *   POST /api/scenarios          save a scenario, returns { id, name, createdAt }
 *   GET  /api/scenarios          recently saved scenarios
 *   GET  /api/scenarios/:id      load a saved scenario
 *   POST /api/simulate           run a scenario headlessly with the same engine as the browser
 *   GET  /api/health
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SCENARIOS: KVNamespace;
  SIMULATE_LIMIT: RateLimiter;
  SAVE_LIMIT: RateLimiter;
}

interface Meta {
  id: string;
  name: string;
  createdAt: string;
}

const MAX_BODY = 512 * 1024;
const MAX_SIM_SECONDS = 600;
/**
 * Server-side simulation budget. The Workers clock does not advance during computation, so the
 * limits are in units of work rather than time. Per step the engine scans every lane and moves every
 * vehicle; lane-steps are known before running, vehicle-steps are counted while running. All
 * presets use well under a fifth of either budget; larger networks belong in the browser.
 */
const LIMITS = { nodes: 400, roads: 600, flows: 100, laneSteps: 3_000_000, vehicleSteps: 3_000_000 };
const RECENT_LIMIT = 30;
/** Index entries sort newest first: the key embeds (MAX_TIME − saved-at), zero-padded. */
const RECENT_PREFIX = 'recent:';
const MAX_TIME = 9_999_999_999_999;

/**
 * Every save writes its own index entry instead of rewriting a shared list, so saves made at the same
 * time never overwrite each other. The newest entries are read back with a single key listing.
 */
function recentKey(meta: Meta): string {
  return `${RECENT_PREFIX}${String(MAX_TIME - Date.parse(meta.createdAt)).padStart(13, '0')}:${meta.id}`;
}

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
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function newId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function simulateWithinBudget(scenario: Scenario, duration: number): Response {
  const tooBig = (what: string, n: number, max: number) =>
    fail(413, `Scenario too large for server-side simulation: ${n} ${what} (max ${max}). Run it in the browser instead.`);
  if (scenario.nodes.length > LIMITS.nodes) return tooBig('nodes', scenario.nodes.length, LIMITS.nodes);
  if (scenario.roads.length > LIMITS.roads) return tooBig('roads', scenario.roads.length, LIMITS.roads);
  if (scenario.flows.length > LIMITS.flows) return tooBig('flows', scenario.flows.length, LIMITS.flows);
  const sim = new Simulation(scenario);
  const steps = Math.round(duration * 10);
  const laneSteps = sim.net.lanes.length * steps;
  if (laneSteps > LIMITS.laneSteps) {
    return fail(413, `Scenario too large for server-side simulation: ${sim.net.lanes.length} lanes × ${duration} s exceeds the budget. Shorten the run or use the browser.`);
  }
  let vehicleSteps = 0;
  for (let i = 0; i < steps; i++) {
    sim.step();
    vehicleSteps += sim.vehicles.length;
    if (vehicleSteps > LIMITS.vehicleSteps) {
      return fail(413, `Simulation stopped at ${Math.round(sim.t)} s: traffic volume exceeds the server budget. Shorten the run or use the browser.`);
    }
  }
  return json({ scenario: scenario.name, seed: scenario.seed, duration, summary: sim.summary(), warnings: sim.net.warnings, samples: sim.samples });
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/health') return json({ ok: true, engine: 'agent-based IDM/MOBIL', time: new Date().toISOString() });

  const client = req.headers.get('cf-connecting-ip') ?? 'unknown';

  if (path === '/api/scenarios' && req.method === 'POST') {
    if (!(await env.SAVE_LIMIT.limit({ key: client })).success) throw new HttpError(429, 'Too many saves; try again in a minute');
    const scenario = parseScenario(await readJson(req));
    const meta: Meta = { id: newId(), name: scenario.name, createdAt: new Date().toISOString() };
    await env.SCENARIOS.put(`scenario:${meta.id}`, JSON.stringify({ ...scenario, id: meta.id }), { metadata: meta });
    await env.SCENARIOS.put(recentKey(meta), '', { metadata: meta });
    return json(meta, 201);
  }

  if (path === '/api/scenarios' && req.method === 'GET') {
    const listed = await env.SCENARIOS.list<Meta>({ prefix: RECENT_PREFIX, limit: RECENT_LIMIT });
    return json({ scenarios: listed.keys.flatMap((k) => (k.metadata ? [k.metadata] : [])) });
  }

  const m = /^\/api\/scenarios\/([a-z0-9]{4,32})$/.exec(path);
  if (m && req.method === 'GET') {
    const body = await env.SCENARIOS.get(`scenario:${m[1]}`);
    return body ? new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } }) : fail(404, 'Scenario not found');
  }

  if (path === '/api/simulate' && req.method === 'POST') {
    if (!(await env.SIMULATE_LIMIT.limit({ key: client })).success) throw new HttpError(429, 'Too many simulations; try again in a minute');
    const body = (await readJson(req)) as { scenario?: unknown; duration?: unknown; seed?: unknown };
    const scenario = parseScenario(body?.scenario ?? body);
    if (typeof body?.seed === 'number') scenario.seed = Math.max(0, Math.round(body.seed));
    const duration = Math.min(MAX_SIM_SECONDS, Math.max(10, Number(body?.duration ?? scenario.duration) || 0));
    return simulateWithinBudget(scenario, duration);
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
