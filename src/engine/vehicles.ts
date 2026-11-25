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
 * `dv` = v - v_leader (closing speed).
 */
export function idmAccel(p: VehicleParams, v: number, v0: number, gap: number, dv: number): number {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.1, v0), IDM_DELTA);
  if (!Number.isFinite(gap)) return p.accel * free;
  const sStar = p.minGap + Math.max(0, v * p.headway + (v * dv) / (2 * Math.sqrt(p.accel * p.decel)));
  const g = Math.max(0.05, gap);
  return p.accel * (free - (sStar / g) * (sStar / g));
}
