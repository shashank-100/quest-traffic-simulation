export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function norm(a: Vec): Vec {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

/** Right-hand normal in screen coordinates (y grows downward). */
export const rightNormal = (d: Vec): Vec => ({ x: -d.y, y: d.x });

/** Signed smallest difference b - a, in (-π, π]. Positive is clockwise on screen (a right turn). */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

/** Intersection of segments p1p2 and p3p4, returned as parameters along each, or null. */
export function segmentIntersection(p1: Vec, p2: Vec, p3: Vec, p4: Vec): { t: number; u: number; point: Vec } | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const w = sub(p3, p1);
  const t = (w.x * d2.y - w.y * d2.x) / denom;
  const u = (w.x * d1.y - w.y * d1.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: add(p1, scale(d1, t)) };
}

export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
  return { d: dist(p, add(a, scale(ab, t))), t };
}

function segmentSegmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentIntersection(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d).d,
    pointSegmentDistance(b, c, d).d,
    pointSegmentDistance(c, a, b).d,
    pointSegmentDistance(d, a, b).d,
  );
}

/** A sampled path with arc-length lookup; used for lanes and junction connectors alike. */
export class Path {
  readonly points: Vec[];
  readonly cum: number[];
  readonly length: number;

  constructor(points: Vec[]) {
    this.points = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + dist(points[i - 1], points[i]));
    this.length = this.cum[this.cum.length - 1];
  }

  static cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, samples = 16): Path {
    const pts: Vec[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const mt = 1 - t;
      pts.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
      });
    }
    return new Path(pts);
  }

  private locate(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Position and heading at arc length s (clamped to the path). */
  pose(s: number): { x: number; y: number; heading: number } {
    const n = this.points.length;
    if (n === 1) return { ...this.points[0], heading: 0 };
    // Beyond either end the path is extended straight, so a vehicle body straddling two segments renders smoothly.
    const i = s <= 0 ? 0 : s >= this.length ? n - 2 : Math.min(this.locate(s), n - 2);
    const a = this.points[i];
    const b = this.points[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 1e-9 ? (s - this.cum[i]) / segLen : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  minDistanceTo(other: Path): number {
    let best = Infinity;
    for (let i = 0; i < this.points.length - 1; i++) {
      for (let j = 0; j < other.points.length - 1; j++) {
        best = Math.min(best, segmentSegmentDistance(this.points[i], this.points[i + 1], other.points[j], other.points[j + 1]));
        if (best === 0) return 0;
      }
    }
    return best;
  }
}
