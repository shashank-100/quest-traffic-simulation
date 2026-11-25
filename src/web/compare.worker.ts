/// <reference lib="webworker" />
import { runScenario, type Scenario, type Sample, type Summary } from '../engine';

export interface CompareRequest {
  scenarios: [Scenario, Scenario];
  duration: number;
  seeds: number[];
}

export interface CompareRun {
  summary: Summary;
  samples: Sample[];
}

export type CompareMessage =
  | { kind: 'progress'; fraction: number }
  | { kind: 'done'; runs: [CompareRun[], CompareRun[]]; ms: number }
  | { kind: 'error'; message: string };

// Runs both scenarios headlessly for each seed (common random numbers: A and B share seeds).
self.onmessage = (e: MessageEvent<CompareRequest>) => {
  const { scenarios, duration, seeds } = e.data;
  const t0 = performance.now();
  try {
    const total = seeds.length * 2;
    let done = 0;
    const runs: [CompareRun[], CompareRun[]] = [[], []];
    for (const seed of seeds) {
      for (const k of [0, 1] as const) {
        const r = runScenario({ ...scenarios[k], seed }, duration, (f) => {
          (self as unknown as Worker).postMessage({ kind: 'progress', fraction: (done + f) / total } satisfies CompareMessage);
        });
        runs[k].push({ summary: r.summary, samples: r.samples });
        done++;
      }
    }
    (self as unknown as Worker).postMessage({ kind: 'done', runs, ms: performance.now() - t0 } satisfies CompareMessage);
  } catch (err) {
    (self as unknown as Worker).postMessage({ kind: 'error', message: String(err) } satisfies CompareMessage);
  }
};
