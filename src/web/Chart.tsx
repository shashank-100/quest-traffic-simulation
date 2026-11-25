import { useMemo, useRef, useState } from 'react';

export interface Series {
  name: string;
  color: string;
  values: number[];
  dashed?: boolean;
}

interface Props {
  title: string;
  unit?: string;
  t: number[];
  series: Series[];
  height?: number;
  digits?: number;
}

/** Small dependency-free SVG line chart with a hover read-out. */
export function Chart({ title, unit, t, series, height = 120, digits = 0 }: Props) {
  const W = 320;
  const H = height;
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const { maxY, maxT, paths } = useMemo(() => {
    const maxT = Math.max(1, t[t.length - 1] ?? 1);
    let maxY = 0;
    for (const s of series) for (const v of s.values) if (Number.isFinite(v)) maxY = Math.max(maxY, v);
    maxY = niceMax(maxY);
    const x = (tt: number) => pad.l + (tt / maxT) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
    const step = Math.max(1, Math.floor(t.length / 400));
    const paths = series.map((s) => {
      let d = '';
      for (let i = 0; i < s.values.length; i += step) d += `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(s.values[i]).toFixed(1)}`;
      return d;
    });
    return { maxY, maxT, paths };
  }, [t, series, H]);
  const ticksY = [0, maxY / 2, maxY];
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const tt = ((fx - pad.l) / (W - pad.l - pad.r)) * maxT;
    if (!t.length) return;
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (t[m] < tt) lo = m;
      else hi = m;
    }
    setHover(Math.abs(t[lo] - tt) < Math.abs(t[hi] - tt) ? lo : hi);
  };
  const hx = hover !== null ? pad.l + (t[hover] / maxT) * (W - pad.l - pad.r) : 0;
  return (
    <figure className="chart">
      <figcaption>
        <span>{title}</span>
        {hover !== null ? (
          <span className="chart-read">
            t={Math.round(t[hover])}s
            {series.map((s) => (
              <b key={s.name} style={{ color: s.color }}>
                {' '}
                {(s.values[hover] ?? 0).toFixed(digits)}
              </b>
            ))}
            {unit ? ` ${unit}` : ''}
          </span>
        ) : (
          unit && <span className="chart-unit">{unit}</span>
        )}
      </figcaption>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
        {ticksY.map((v) => {
          const y = pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
          return (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="chart-grid" />
              <text x={pad.l - 5} y={y + 3} className="chart-tick" textAnchor="end">
                {formatTick(v)}
              </text>
            </g>
          );
        })}
        <text x={pad.l} y={H - 4} className="chart-tick">0</text>
        <text x={W - pad.r} y={H - 4} className="chart-tick" textAnchor="end">
          {Math.round(maxT)}s
        </text>
        {paths.map((d, i) => (
          <path key={series[i].name} d={d} fill="none" stroke={series[i].color} strokeWidth={1.6} strokeDasharray={series[i].dashed ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} className="chart-cursor" />}
      </svg>
    </figure>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function formatTick(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`;
  return v % 1 ? v.toFixed(1) : String(v);
}
