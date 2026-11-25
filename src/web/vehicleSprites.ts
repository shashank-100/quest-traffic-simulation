import type { VehicleType } from '../engine';

/**
 * Top-down vehicle drawings. Each is drawn in the vehicle's own frame: origin at its centre, +x
 * pointing in the direction of travel (front), +y to its right, in metres. The caller translates
 * and rotates the context to the vehicle's pose, so shapes turn with the heading.
 *
 * Detail scales with on-screen size (`lod`): 0 = a plain pill, 1 = body + glass, 2 = full detail
 * (wheels, bumpers, lights, mirrors, roof panels).
 */

export type Lod = 0 | 1 | 2;

const GLASS = '#18202b';
const GLASS_SHEEN = 'rgba(180, 205, 235, 0.16)';
const TYRE = '#0a0c0f';
const HEADLIGHT = 'rgba(246, 236, 196, 0.92)';
const TAIL = '#8f2a24';
const BRAKE = '#ff3b30';

/** Lighten (f > 0) or darken (f < 0) a #rrggbb colour by mixing towards white or black. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f));
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** Rounded rectangle with separate corner radii at the front (+x) and the rear (−x). */
function capsule(ctx: CanvasRenderingContext2D, x0: number, x1: number, halfW: number, rFront: number, rRear: number) {
  const rf = Math.min(rFront, halfW, (x1 - x0) / 2);
  const rr = Math.min(rRear, halfW, (x1 - x0) / 2);
  ctx.beginPath();
  ctx.moveTo(x0 + rr, -halfW);
  ctx.lineTo(x1 - rf, -halfW);
  ctx.quadraticCurveTo(x1, -halfW, x1, -halfW + rf);
  ctx.lineTo(x1, halfW - rf);
  ctx.quadraticCurveTo(x1, halfW, x1 - rf, halfW);
  ctx.lineTo(x0 + rr, halfW);
  ctx.quadraticCurveTo(x0, halfW, x0, halfW - rr);
  ctx.lineTo(x0, -halfW + rr);
  ctx.quadraticCurveTo(x0, -halfW, x0 + rr, -halfW);
  ctx.closePath();
}

/** A trapezoid across the vehicle from x0 to x1, with half-widths h0 at x0 and h1 at x1. */
function trapezoid(ctx: CanvasRenderingContext2D, x0: number, h0: number, x1: number, h1: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x0 + r, -h0);
  ctx.lineTo(x1 - r, -h1);
  ctx.quadraticCurveTo(x1, -h1, x1, -h1 + r);
  ctx.lineTo(x1, h1 - r);
  ctx.quadraticCurveTo(x1, h1, x1 - r, h1);
  ctx.lineTo(x0 + r, h0);
  ctx.quadraticCurveTo(x0, h0, x0, h0 - r);
  ctx.lineTo(x0, -h0 + r);
  ctx.quadraticCurveTo(x0, -h0, x0 + r, -h0);
  ctx.closePath();
}

function fill(ctx: CanvasRenderingContext2D, color: string) {
  ctx.fillStyle = color;
  ctx.fill();
}

/** Wheels that peek out from under the body sides, one pair per axle position (fraction of L). */
function wheels(ctx: CanvasRenderingContext2D, L: number, W: number, axles: number[], tyreLen: number, out: number) {
  ctx.fillStyle = TYRE;
  const t = W * 0.16;
  for (const a of axles) {
    const x = a * L - tyreLen / 2;
    ctx.fillRect(x, -W / 2 - out, tyreLen, t);
    ctx.fillRect(x, W / 2 + out - t, tyreLen, t);
  }
}

/** Head- and tail-lights at the corners; brake lights glow with a soft halo. */
function lights(ctx: CanvasRenderingContext2D, L: number, W: number, braking: boolean, inset: number) {
  const lw = Math.max(0.12, L * 0.035);
  const lh = W * 0.2;
  ctx.fillStyle = HEADLIGHT;
  ctx.fillRect(L / 2 - inset - lw, -W / 2 + W * 0.1, lw, lh);
  ctx.fillRect(L / 2 - inset - lw, W / 2 - W * 0.1 - lh, lw, lh);
  if (braking) {
    ctx.fillStyle = 'rgba(255, 59, 48, 0.28)';
    ctx.beginPath();
    ctx.ellipse(-L / 2, -W * 0.3, W * 0.32, W * 0.2, 0, 0, Math.PI * 2);
    ctx.ellipse(-L / 2, W * 0.3, W * 0.32, W * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = braking ? BRAKE : TAIL;
  ctx.fillRect(-L / 2 + inset, -W / 2 + W * 0.1, lw, lh);
  ctx.fillRect(-L / 2 + inset, W / 2 - W * 0.1 - lh, lw, lh);
}

function car(ctx: CanvasRenderingContext2D, L: number, W: number, color: string, lod: Lod, braking: boolean) {
  const h = W / 2;
  if (lod === 2) {
    wheels(ctx, L, W, [0.31, -0.3], L * 0.15, W * 0.05);
    // mirrors
    ctx.fillStyle = shade(color, -0.35);
    ctx.fillRect(L * 0.1, -h - W * 0.09, L * 0.04, W * 0.1);
    ctx.fillRect(L * 0.1, h - W * 0.01, L * 0.04, W * 0.1);
  }
  // body: rounder nose, squarer tail
  capsule(ctx, -L / 2, L / 2, h, W * 0.42, W * 0.26);
  fill(ctx, color);
  if (lod === 0) return;
  // cabin roof sits between the windscreen and the rear window
  trapezoid(ctx, -L * 0.2, h * 0.78, L * 0.1, h * 0.8, W * 0.08);
  fill(ctx, shade(color, -0.14));
  // windscreen (raked, wider at the base) and rear window
  trapezoid(ctx, L * 0.1, h * 0.8, L * 0.27, h * 0.9, W * 0.06);
  fill(ctx, GLASS);
  trapezoid(ctx, -L * 0.33, h * 0.86, -L * 0.2, h * 0.78, W * 0.05);
  fill(ctx, GLASS);
  if (lod === 1) return;
  // side glass along the cabin
  ctx.fillStyle = GLASS;
  ctx.fillRect(-L * 0.19, -h * 0.9, L * 0.28, h * 0.1);
  ctx.fillRect(-L * 0.19, h * 0.8, L * 0.28, h * 0.1);
  // sheen on the windscreen
  ctx.fillStyle = GLASS_SHEEN;
  ctx.fillRect(L * 0.15, -h * 0.55, L * 0.03, h * 0.6);
  // bumpers
  ctx.fillStyle = shade(color, -0.3);
  ctx.fillRect(L / 2 - L * 0.025, -h * 0.72, L * 0.025, h * 1.44);
  ctx.fillRect(-L / 2, -h * 0.76, L * 0.025, h * 1.52);
  // bonnet crease
  ctx.fillStyle = shade(color, 0.12);
  ctx.fillRect(L * 0.3, -W * 0.02, L * 0.16, W * 0.04);
  lights(ctx, L, W, braking, L * 0.012);
}

function bus(ctx: CanvasRenderingContext2D, L: number, W: number, color: string, lod: Lod, braking: boolean) {
  const h = W / 2;
  if (lod === 2) wheels(ctx, L, W, [0.33, -0.27], L * 0.075, W * 0.04);
  capsule(ctx, -L / 2, L / 2, h, W * 0.22, W * 0.14);
  fill(ctx, color);
  if (lod === 0) return;
  // windscreen across the full front
  trapezoid(ctx, L * 0.43, h * 0.86, L * 0.485, h * 0.9, W * 0.05);
  fill(ctx, GLASS);
  // roof: lighter inset panel with a darker A/C unit and hatches
  capsule(ctx, -L * 0.47, L * 0.41, h * 0.72, W * 0.1, W * 0.08);
  fill(ctx, shade(color, 0.14));
  if (lod === 1) return;
  // side windows as a continuous strip along each side
  ctx.fillStyle = GLASS;
  ctx.fillRect(-L * 0.44, -h * 0.97, L * 0.84, h * 0.17);
  ctx.fillRect(-L * 0.44, h * 0.8, L * 0.84, h * 0.17);
  ctx.fillStyle = shade(color, -0.18);
  ctx.fillRect(-L * 0.1, -h * 0.42, L * 0.2, h * 0.84);
  ctx.fillStyle = shade(color, -0.08);
  ctx.fillRect(L * 0.22, -h * 0.25, L * 0.07, h * 0.5);
  ctx.fillRect(-L * 0.34, -h * 0.25, L * 0.07, h * 0.5);
  // rear window and bumpers
  ctx.fillStyle = GLASS;
  ctx.fillRect(-L * 0.495, -h * 0.6, L * 0.02, h * 1.2);
  ctx.fillStyle = shade(color, -0.35);
  ctx.fillRect(L / 2 - L * 0.012, -h * 0.8, L * 0.012, h * 1.6);
  lights(ctx, L, W, braking, L * 0.005);
}

function truck(ctx: CanvasRenderingContext2D, L: number, W: number, color: string, lod: Lod, braking: boolean) {
  const h = W / 2;
  const cabStart = L * 0.24; // the cab occupies the front ~26%
  if (lod === 2) wheels(ctx, L, W, [0.38, -0.2, -0.33], L * 0.09, W * 0.04);
  // cargo box: neutral, slightly narrower than the cab is tall
  capsule(ctx, -L / 2, cabStart - L * 0.02, h * 0.98, W * 0.06, W * 0.06);
  fill(ctx, lod === 0 ? color : '#8b8f97');
  // cab
  capsule(ctx, cabStart, L / 2, h * 0.94, W * 0.3, W * 0.08);
  fill(ctx, color);
  if (lod === 0) return;
  trapezoid(ctx, L * 0.4, h * 0.78, L * 0.47, h * 0.86, W * 0.05);
  fill(ctx, GLASS);
  if (lod === 1) return;
  // cab roof, box ribs, mirrors and bumpers
  trapezoid(ctx, cabStart + L * 0.03, h * 0.74, L * 0.4, h * 0.78, W * 0.06);
  fill(ctx, shade(color, -0.14));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  for (let i = 1; i < 5; i++) ctx.fillRect(-L / 2 + (i * (cabStart + L / 2)) / 5, -h * 0.98, L * 0.008, W * 0.98);
  ctx.fillStyle = shade(color, -0.35);
  ctx.fillRect(L * 0.36, -h - W * 0.1, L * 0.025, W * 0.12);
  ctx.fillRect(L * 0.36, h - W * 0.02, L * 0.025, W * 0.12);
  ctx.fillRect(L / 2 - L * 0.015, -h * 0.75, L * 0.015, h * 1.5);
  lights(ctx, L, W, braking, L * 0.006);
}

function bike(ctx: CanvasRenderingContext2D, L: number, W: number, color: string, lod: Lod, braking: boolean) {
  const h = W / 2;
  // tyres front and back
  ctx.fillStyle = TYRE;
  capsule(ctx, L * 0.22, L / 2, h * 0.24, h * 0.24, h * 0.24);
  ctx.fill();
  capsule(ctx, -L / 2, -L * 0.2, h * 0.28, h * 0.28, h * 0.28);
  ctx.fill();
  // frame / tank
  capsule(ctx, -L * 0.3, L * 0.3, h * 0.36, h * 0.3, h * 0.3);
  fill(ctx, shade(color, -0.2));
  if (lod === 0) {
    capsule(ctx, -L * 0.2, L * 0.14, h, h * 0.7, h * 0.7);
    fill(ctx, color);
    return;
  }
  // handlebar
  ctx.fillStyle = '#c9ccd2';
  ctx.fillRect(L * 0.2, -h * 0.95, L * 0.04, W * 0.95);
  // rider: shoulders wider than the bike (a light jacket keeps it readable on dark asphalt), helmet on top
  ctx.beginPath();
  ctx.ellipse(-L * 0.06, 0, L * 0.13, h * 1.05, 0, 0, Math.PI * 2);
  fill(ctx, '#8a93a3');
  ctx.beginPath();
  ctx.arc(L * 0.01, 0, h * 0.5, 0, Math.PI * 2);
  fill(ctx, color);
  if (lod === 2) {
    ctx.fillStyle = GLASS;
    ctx.fillRect(L * 0.06, -h * 0.3, L * 0.035, h * 0.6);
    ctx.fillStyle = HEADLIGHT;
    ctx.fillRect(L / 2 - L * 0.03, -h * 0.14, L * 0.03, h * 0.28);
  }
  ctx.fillStyle = braking ? BRAKE : TAIL;
  ctx.fillRect(-L / 2, -h * 0.14, L * 0.03, h * 0.28);
}

/** Draws a vehicle of the given drawn size (L × W metres) in its own frame. */
export function drawVehicleSprite(ctx: CanvasRenderingContext2D, type: VehicleType, L: number, W: number, color: string, lod: Lod, braking: boolean) {
  if (type === 'car') car(ctx, L, W, color, lod, braking);
  else if (type === 'bus') bus(ctx, L, W, color, lod, braking);
  else if (type === 'truck') truck(ctx, L, W, color, lod, braking);
  else bike(ctx, L, W, color, lod, braking);
}

/** The vehicle's outline, used for its drop shadow. */
export function vehicleOutline(ctx: CanvasRenderingContext2D, type: VehicleType, L: number, W: number) {
  const h = W / 2;
  if (type === 'bike') capsule(ctx, -L / 2, L / 2, h * 0.7, h * 0.5, h * 0.5);
  else capsule(ctx, -L / 2, L / 2, h, W * (type === 'car' ? 0.42 : 0.2), W * 0.2);
}
