import type { CompiledNode } from './network';
import type { PhaseDef, Scenario, SignalDef } from './types';
import { roadsAtNode } from './network';

export type LightState = 'green' | 'yellow' | 'red';

export interface SignalStatus {
  phase: number;
  /** What the current phase's approaches are showing. */
  stage: 'green' | 'yellow' | 'allRed';
  remaining: number;
  cycle: number;
}

export function cycleLength(sig: SignalDef): number {
  return sig.phases.reduce((acc, p) => acc + p.green + sig.yellow + sig.allRed, 0);
}

export function signalStatus(sig: SignalDef, t: number): SignalStatus {
  const cycle = cycleLength(sig);
  if (cycle <= 0) return { phase: 0, stage: 'green', remaining: Infinity, cycle: 0 };
  let tc = (((t + sig.offset) % cycle) + cycle) % cycle;
  for (let i = 0; i < sig.phases.length; i++) {
    const p = sig.phases[i];
    if (tc < p.green) return { phase: i, stage: 'green', remaining: p.green - tc, cycle };
    tc -= p.green;
    if (tc < sig.yellow) return { phase: i, stage: 'yellow', remaining: sig.yellow - tc, cycle };
    tc -= sig.yellow;
    if (tc < sig.allRed) return { phase: i, stage: 'allRed', remaining: sig.allRed - tc, cycle };
    tc -= sig.allRed;
  }
  return { phase: 0, stage: 'green', remaining: 0, cycle };
}

/** Light shown to traffic arriving at `node` along `roadId` at time t. Unsignalised nodes are always green. */
export function lightFor(node: CompiledNode, roadId: string, t: number): LightState {
  if (!node.signal) return 'green';
  const st = signalStatus(node.signal, t);
  const phases = node.phaseOfRoad.get(roadId);
  if (!phases || !phases.includes(st.phase)) return 'red';
  return st.stage === 'green' ? 'green' : st.stage === 'yellow' ? 'yellow' : 'red';
}

/**
 * Default phase plan: approaches facing each other (within ~30° of opposite) share a phase,
 * so a 4-way gets two phases and a T-junction gets "main road" + "side road".
 */
export function autoPhases(scenario: Scenario, nodeId: string, green?: number): PhaseDef[] {
  const at = roadsAtNode(scenario, nodeId);
  const used = new Set<string>();
  const groups: string[][] = [];
  for (const a of at) {
    if (used.has(a.road.id)) continue;
    used.add(a.road.id);
    const group = [a.road.id];
    let best: { id: string; err: number } | null = null;
    for (const b of at) {
      if (used.has(b.road.id)) continue;
      let err = Math.abs(Math.abs(b.angle - a.angle) - Math.PI);
      err = Math.min(err, Math.abs(err - 2 * Math.PI));
      if (err < 0.55 && (!best || err < best.err)) best = { id: b.road.id, err };
    }
    if (best) {
      used.add(best.id);
      group.push(best.id);
    }
    groups.push(group);
  }
  const g = green ?? (groups.length <= 2 ? 25 : 18);
  return groups.map((approaches) => ({ green: g, approaches }));
}

export function defaultSignal(scenario: Scenario, nodeId: string): SignalDef {
  return { enabled: true, phases: autoPhases(scenario, nodeId), yellow: 3, allRed: 2, offset: 0 };
}
