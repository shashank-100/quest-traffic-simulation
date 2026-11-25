import { parseScenario, type Scenario } from '../engine';

export interface SavedMeta {
  id: string;
  name: string;
  createdAt: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep status text */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function saveScenario(sc: Scenario): Promise<SavedMeta> {
  return json(await fetch('/api/scenarios', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sc) }));
}

export async function loadScenario(id: string): Promise<Scenario> {
  return parseScenario(await json(await fetch(`/api/scenarios/${encodeURIComponent(id)}`)));
}

export async function listScenarios(): Promise<SavedMeta[]> {
  return (await json<{ scenarios: SavedMeta[] }>(await fetch('/api/scenarios'))).scenarios;
}
