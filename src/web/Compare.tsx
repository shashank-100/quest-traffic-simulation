import { useEffect, useMemo, useRef, useState } from 'react';
import { preset, PRESETS, type Sample, type Scenario, type Summary } from '../engine';
import { Chart } from './Chart';
import type { CompareMessage, CompareRequest, CompareRun } from './compare.worker';
import { fmt, kmh } from './format';
import { Field, Section } from './ui';

interface Props {
  current: Scenario;
  onOpen: (sc: Scenario) => void;
}

type Metric = { key: keyof Summary; label: string; unit: string; better: 'lower' | 'higher' | null; scale?: (v: number) => number; digits?: number };

const METRICS: Metric[] = [
  { key: 'avgTravelTime', label: 'Average travel time', unit: 's', better: 'lower', digits: 1 },
  { key: 'avgDelay', label: 'Average delay', unit: 's/veh', better: 'lower', digits: 1 },
  { key: 'avgTripSpeed', label: 'Average trip speed', unit: 'km/h', better: 'higher', scale: kmh, digits: 1 },
  { key: 'throughputPerHour', label: 'Throughput', unit: 'veh/h', better: 'higher' },
  { key: 'completed', label: 'Trips completed', unit: '', better: 'higher' },
  { key: 'avgQueueLength', label: 'Average total queue', unit: 'm', better: 'lower', digits: 1 },
  { key: 'maxQueueLength', label: 'Longest queue', unit: 'm', better: 'lower' },
  { key: 'avgDensity', label: 'Average density', unit: 'veh/km/ln', better: 'lower', digits: 1 },
  { key: 'stopsShare', label: 'Time spent stopped', unit: '%', better: 'lower', scale: (v) => v * 100, digits: 1 },
  { key: 'backlog', label: 'Still waiting to enter', unit: 'veh', better: 'lower' },
];

const CURRENT = '__current__';

function stats(runs: CompareRun[], m: Metric) {
  const xs = runs.map((r) => (m.scale ? m.scale(r.summary[m.key]) : r.summary[m.key]));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean, sd };
}

function meanSeries(runs: CompareRun[], f: (s: Sample) => number): number[] {
  const n = Math.min(...runs.map((r) => r.samples.length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(runs.reduce((a, r) => a + f(r.samples[i]), 0) / runs.length);
  return out;
}

export function Compare({ current, onOpen }: Props) {
  const [a, setA] = useState('crossing-at-grade');
  const [b, setB] = useState('crossing-flyover');
  const [duration, setDuration] = useState(900);
  const [reps, setReps] = useState(3);
  const [seed, setSeed] = useState(42);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ runs: [CompareRun[], CompareRun[]]; names: [string, string]; ms: number } | null>(null);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);

  const options = useMemo(() => [{ id: CURRENT, name: `Current: ${current.name}` }, ...PRESETS.map((p) => ({ id: p.id, name: preset(p.id).name }))], [current.name]);
  const resolve = (id: string): Scenario => (id === CURRENT ? current : preset(id));

  useEffect(() => () => worker.current?.terminate(), []);

  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('./compare.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    const scenarios: [Scenario, Scenario] = [resolve(a), resolve(b)];
    const names: [string, string] = [scenarios[0].name, scenarios[1].name];
    setError('');
    setProgress(0);
    w.onmessage = (e: MessageEvent<CompareMessage>) => {
      const m = e.data;
      if (m.kind === 'progress') setProgress(m.fraction);
      else if (m.kind === 'done') {
        setProgress(null);
        setResult({ runs: m.runs, names, ms: m.ms });
        w.terminate();
      } else {
        setProgress(null);
        setError(m.message);
      }
    };
    const req: CompareRequest = { scenarios, duration, seeds: Array.from({ length: reps }, (_, i) => seed + i) };
    w.postMessage(req);
  };

  const headline = useMemo(() => {
    if (!result) return null;
    const delay = METRICS[1];
    const da = stats(result.runs[0], delay).mean;
    const db = stats(result.runs[1], delay).mean;
    const tt = METRICS[0];
    const ta = stats(result.runs[0], tt).mean;
    const tb = stats(result.runs[1], tt).mean;
    const pct = da > 0 ? ((db - da) / da) * 100 : 0;
    return { da, db, pct, ta, tb };
  }, [result]);

  const t = result ? result.runs[0][0].samples.slice(0, Math.min(result.runs[0][0].samples.length, result.runs[1][0].samples.length)).map((s) => s.t) : [];

  return (
    <div className="compare">
      <div className="compare-setup">
        <div className="compare-pick">
          <span className="ab a">A</span>
          <Field label="Baseline">
            <select value={a} onChange={(e) => setA(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="link" onClick={() => onOpen(resolve(a))}>
            Open in editor
          </button>
        </div>
        <div className="compare-pick">
          <span className="ab b">B</span>
          <Field label="Alternative">
            <select value={b} onChange={(e) => setB(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="link" onClick={() => onOpen(resolve(b))}>
            Open in editor
          </button>
        </div>
        <div className="compare-opts">
          <Field label="Simulated time">
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[300, 600, 900, 1800, 3600].map((d) => (
                <option key={d} value={d}>
                  {d / 60} min
                </option>
              ))}
            </select>
          </Field>
          <Field label="Replications" hint="seeds">
            <select value={reps} onChange={(e) => setReps(Number(e.target.value))}>
              {[1, 3, 5, 10].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="First seed">
            <input type="number" value={seed} onChange={(e) => setSeed(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </Field>
          <button type="button" className="primary big" onClick={run} disabled={progress !== null}>
            {progress !== null ? `Running… ${Math.round(progress * 100)}%` : 'Run comparison'}
          </button>
        </div>
        <p className="note">
          Both scenarios run headless in a background worker with the same seeds (common random numbers), so the difference reflects the design rather than random arrivals.
          Values are mean ± standard deviation across replications, measured after each run's warm-up (the time for the network to fill).
        </p>
        {progress !== null && (
          <div className="progress">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {result && headline && (
        <div className="compare-results">
          <div className="verdict">
            <div>
              <span className="eyebrow">Average delay per vehicle</span>
              <div className="verdict-figs">
                <span className="a">{fmt(headline.da, 1)} s</span>
                <span className="arrow">→</span>
                <span className="b">{fmt(headline.db, 1)} s</span>
              </div>
            </div>
            <div className={`verdict-pct ${headline.pct < 0 ? 'good' : 'bad'}`}>
              {headline.pct > 0 ? '+' : ''}
              {fmt(headline.pct, 0)}%
            </div>
            <p>
              <b>{result.names[1]}</b> {headline.pct < 0 ? 'cuts' : 'adds'} delay relative to <b>{result.names[0]}</b>. Average travel time {fmt(headline.ta, 1)} s → {fmt(headline.tb, 1)} s.
              {' '}
              {result.runs[0].length} replication(s) × {duration / 60} min simulated in {fmt(result.ms / 1000, 1)} s.
            </p>
          </div>
          <Section title="Metrics">
            <table className="table compare-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="a">A · {result.names[0]}</th>
                  <th className="b">B · {result.names[1]}</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => {
                  const sa = stats(result.runs[0], m);
                  const sb = stats(result.runs[1], m);
                  const diff = sb.mean - sa.mean;
                  const pct = Math.abs(sa.mean) > 1e-9 ? (diff / Math.abs(sa.mean)) * 100 : 0;
                  const good = m.better === null || Math.abs(diff) < 1e-9 ? '' : (diff < 0) === (m.better === 'lower') ? 'good' : 'bad';
                  const show = (x: { mean: number; sd: number }) => (
                    <>
                      {fmt(x.mean, m.digits ?? 0)}
                      {result.runs[0].length > 1 && <small> ±{fmt(x.sd, m.digits ?? 0)}</small>}
                    </>
                  );
                  return (
                    <tr key={m.key}>
                      <td>
                        {m.label} {m.unit && <small className="muted">{m.unit}</small>}
                      </td>
                      <td className="mono">{show(sa)}</td>
                      <td className="mono">{show(sb)}</td>
                      <td className={`mono delta ${good}`}>{Math.abs(sa.mean) > 1e-9 ? `${pct > 0 ? '+' : ''}${fmt(pct, 0)}%` : diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${fmt(diff, m.digits ?? 0)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
          <Section title="Over time (mean of replications)">
            <div className="chart-grid2">
              {(
                [
                  ['Mean speed', 'km/h', (s: Sample) => kmh(s.meanSpeed)],
                  ['Total queue length', 'm', (s: Sample) => s.queueLength],
                  ['Vehicles in network', '', (s: Sample) => s.active],
                  ['Throughput (rolling 60 s)', 'veh/h', (s: Sample) => s.throughput],
                ] as const
              ).map(([title, unit, f]) => (
                <Chart
                  key={title}
                  title={title}
                  unit={unit}
                  t={t}
                  height={150}
                  series={[
                    { name: 'A', color: 'var(--a)', values: meanSeries(result.runs[0], f) },
                    { name: 'B', color: 'var(--b)', values: meanSeries(result.runs[1], f) },
                  ]}
                />
              ))}
            </div>
          </Section>
        </div>
      )}
      {!result && progress === null && (
        <div className="compare-empty">
          <p>
            Pick two scenarios and run them side by side. The default pair is the same junction and the same demand, <b>before and after adding a flyover</b>.
          </p>
        </div>
      )}
    </div>
  );
}
