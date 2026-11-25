/** Deterministic, seedable PRNG (mulberry32). All engine randomness flows through this. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Exponentially distributed sample with the given rate (events per unit time). */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** Normal sample via Box–Muller, clamped to ±3σ so outliers stay physical. */
  normal(mean: number, sd: number): number {
    const u = Math.max(1e-12, this.next());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
    return mean + sd * Math.max(-3, Math.min(3, z));
  }

  pickWeighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, weight(item));
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }
}
