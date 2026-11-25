import type { VehicleType } from './types';

/** Per-type agent parameters for the Intelligent Driver Model (Treiber et al., 2000). */
export interface VehicleParams {
  length: number;
  width: number;
  /** Nominal desired speed, m/s (scaled per flow and per driver). */
  desiredSpeed: number;
  /** Max acceleration, m/s². */
  accel: number;
  /** Comfortable deceleration, m/s². */
  decel: number;
  /** Physical braking limit, m/s². */
  maxDecel: number;
  /** Minimum standstill gap, m. */
  minGap: number;
  /** Desired time headway, s. */
  headway: number;
  /** MOBIL politeness (0 = selfish). */
  politeness: number;
}

export const VEHICLE_PARAMS: Record<VehicleType, VehicleParams> = {
  car: { length: 4.5, width: 1.8, desiredSpeed: 15, accel: 1.8, decel: 2.5, maxDecel: 8, minGap: 2.0, headway: 1.4, politeness: 0.3 },
  bus: { length: 12, width: 2.5, desiredSpeed: 12, accel: 1.0, decel: 2.0, maxDecel: 6, minGap: 2.5, headway: 1.8, politeness: 0.5 },
  bike: { length: 2.0, width: 0.8, desiredSpeed: 13, accel: 2.5, decel: 3.0, maxDecel: 8, minGap: 1.2, headway: 1.0, politeness: 0.1 },
  truck: { length: 9, width: 2.4, desiredSpeed: 11, accel: 0.8, decel: 2.0, maxDecel: 6, minGap: 3.0, headway: 2.0, politeness: 0.5 },
};

export const IDM_DELTA = 4;

/**
 * IDM acceleration. `gap` is bumper-to-bumper distance to the leader (Infinity if none),
 * `dv` = v - v_leader (closing speed), `headway` overrides the desired time gap (lane-width effect).
 *
 * Above the desired speed (e.g. entering a slower road) the free-road term uses the IIDM form
 * (Treiber & Kesting 2013), which slows at most at the comfortable deceleration instead of
 * the very hard braking plain IDM produces when v ≫ v0.
 */
export function idmAccel(p: VehicleParams, v: number, v0: number, gap: number, dv: number, headway = p.headway): number {
  const vs = Math.max(0, v);
  const v0s = Math.max(0.1, v0);
  const free = vs <= v0s ? p.accel * (1 - Math.pow(vs / v0s, IDM_DELTA)) : -p.decel * (1 - Math.pow(v0s / vs, (p.accel * IDM_DELTA) / p.decel));
  if (!Number.isFinite(gap)) return free;
  const sStar = p.minGap + Math.max(0, vs * headway + (vs * dv) / (2 * Math.sqrt(p.accel * p.decel)));
  const g = Math.max(0.05, gap);
  const interaction = (sStar / g) * (sStar / g);
  return vs <= v0s ? p.accel * (1 - Math.pow(vs / v0s, IDM_DELTA) - interaction) : free - p.accel * interaction;
}

export interface LaneEffect {
  /** Multiplier on desired speed. */
  speed: number;
  /** Multiplier on desired time headway (>1 = drivers keep longer gaps). */
  headway: number;
}

/**
 * How lane width changes driving behaviour, for a vehicle of the given width.
 *
 * The lane is first converted to an "equivalent car lane width": the same lateral clearance a
 * 1.8 m car would have. A bus in a 3.5 m lane then behaves like a car in a 2.8 m lane, while a
 * two-wheeler is unaffected.
 *  - Speed follows the HCM free-flow-speed lane-width adjustment (no reduction ≥ 3.6 m, −3 % at
 *    3.3 m, −10 % at 3.0 m), extrapolated linearly below that and floored at 70 %.
 *  - Headway follows the HCM signalised saturation-flow lane-width factor f_w = 1 + (W − 3.6)/9,
 *    applied within HCM's valid range W ∈ [2.4, 4.8] m, as T_eff = T / f_w.
 */
export function laneWidthEffect(laneWidth: number, vehicleWidth: number): LaneEffect {
  const w = laneWidth - (vehicleWidth - 1.8);
  const pts: [number, number][] = [
    [2.4, 0.7],
    [3.0, 0.9],
    [3.3, 0.97],
    [3.6, 1],
  ];
  let speed = 1;
  if (w <= pts[0][0]) speed = pts[0][1];
  else
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      if (w >= x0 && w <= x1) speed = y0 + ((y1 - y0) * (w - x0)) / (x1 - x0);
    }
  const fw = 1 + (Math.max(2.4, Math.min(4.8, w)) - 3.6) / 9;
  return { speed, headway: 1 / fw };
}
