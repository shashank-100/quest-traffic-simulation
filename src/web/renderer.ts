import {
  lightFor,
  rightNormal,
  scale,
  norm,
  sub,
  add,
  type Connector,
  type Lane,
  type Network,
  type Simulation,
  type Vec,
  type Vehicle,
} from '../engine';

/**
 * Canvas renderer. Reads simulation state; never changes it. Everything on screen is drawn from
 * the engine's vehicle positions; the frontend does not interpolate or invent motion.
 */

export interface Camera {
  x: number; // world point at the viewport centre
  y: number;
  zoom: number; // pixels per metre
}

export interface Overlay {
  congestion: boolean;
  labels: boolean;
  editing: boolean;
  selected: { kind: 'road' | 'node'; id: string } | null;
  hover: { kind: 'road' | 'node'; id: string } | null;
  preview: { from: Vec; to: Vec; flyover: boolean; valid: boolean } | null;
  endpointLabels: Map<string, string>;
}

const C = {
  bg: '#0d0f12',
  grid: 'rgba(255,255,255,0.035)',
  gridMajor: 'rgba(255,255,255,0.06)',
  asphalt: '#2a2e35',
  asphaltDeck: '#3a3f48',
  kerb: '#4b515c',
  deckEdge: '#c9ccd2',
  marking: 'rgba(235,232,222,0.75)',
  centre: '#f5b301',
  shadow: 'rgba(0,0,0,0.55)',
  select: '#4cc9f0',
  red: '#ff4d3d',
  amber: '#f5b301',
  green: '#2fbf71',
};

const CAR_COLORS = ['#e8e6df', '#9aa4b1', '#5b8def', '#d6453d', '#2f3540', '#c9b48a', '#6fb3a0', '#b7bcc4'];
const TYPE_COLORS = { bus: '#f08c2e', truck: '#a68a5b', bike: '#4cc9f0' } as const;

export function worldToScreen(cam: Camera, w: number, h: number, p: Vec): Vec {
  return { x: (p.x - cam.x) * cam.zoom + w / 2, y: (p.y - cam.y) * cam.zoom + h / 2 };
}
export function screenToWorld(cam: Camera, w: number, h: number, p: Vec): Vec {
  return { x: (p.x - w / 2) / cam.zoom + cam.x, y: (p.y - h / 2) / cam.zoom + cam.y };
}

/** Camera that fits all nodes into the viewport with some padding. */
export function fitCamera(net: Network, w: number, h: number): Camera {
  const pts = [...net.nodes.values()].map((n) => n.pos);
  if (pts.length === 0) return { x: 0, y: 0, zoom: 1.2 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Leave room for endpoint signs and the floating controls.
  const padX = Math.min(300, w * 0.22);
  const padY = Math.min(170, h * 0.3);
  const zoom = Math.min((w - padX) / Math.max(1, maxX - minX), (h - padY) / Math.max(1, maxY - minY), 6);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: Math.max(0.2, zoom) };
}

function laneElevated(l: Lane): boolean {
  return l.levelFrom > 0 || l.levelTo > 0;
}

function congestionColor(c: number, alpha: number): string {
  // green → amber → red
  const stops = [
    [47, 191, 113],
    [245, 179, 1],
    [255, 77, 61],
  ];
  const t = Math.max(0, Math.min(1, c)) * 2;
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const a = stops[i];
  const b = stops[i + 1];
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgba(${mix(0)},${mix(1)},${mix(2)},${alpha})`;
}

export function render(ctx: CanvasRenderingContext2D, sim: Simulation, cam: Camera, w: number, h: number, ov: Overlay): void {
  const net = sim.net;
  const dpr = ctx.getTransform().a;
  ctx.save();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  drawGrid(ctx, cam, w, h);

  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  const px = 1 / cam.zoom; // one screen pixel in world units

  const groundLanes = net.lanes.filter((l) => !laneElevated(l));
  const upperLanes = net.lanes.filter(laneElevated);
  const groundConns = net.connectors.filter((c) => c.level === 0);
  const upperConns = net.connectors.filter((c) => c.level > 0);

  // ---- ground layer
  drawSurface(ctx, net, groundLanes, groundConns, false, px);
  drawMarkings(ctx, net, groundLanes, px);
  if (ov.congestion) drawCongestion(ctx, sim, groundLanes, px);
  drawStopLines(ctx, sim, groundLanes, px);
  drawVehicles(ctx, sim, (v) => sim.pose(v).level < 0.02, px, false);

  // ---- elevated layer (decks and ramps), with a cast shadow
  if (upperLanes.length) {
    ctx.save();
    ctx.translate(5, 7);
    ctx.globalAlpha = 0.9;
    for (const l of upperLanes) strokePath(ctx, l.path.points, l.width + 1.6, C.shadow, 'butt');
    for (const c of upperConns) strokePath(ctx, c.path.points, c.width + 1.6, C.shadow, 'round');
    ctx.restore();
    drawSurface(ctx, net, upperLanes, upperConns, true, px);
    drawMarkings(ctx, net, upperLanes, px);
    if (ov.congestion) drawCongestion(ctx, sim, upperLanes, px);
    drawVehicles(ctx, sim, (v) => sim.pose(v).level >= 0.02, px, true);
  }

  if (ov.editing || ov.selected || ov.hover) drawEditorMarks(ctx, sim, ov, px);
  if (ov.preview) drawPreview(ctx, ov.preview, px);
  ctx.restore();

  if (ov.labels) drawLabels(ctx, sim, cam, w, h, ov, dpr);
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number) {
  const step = cam.zoom > 2 ? 10 : cam.zoom > 0.6 ? 50 : 100;
  const tl = screenToWorld(cam, w, h, { x: 0, y: 0 });
  const br = screenToWorld(cam, w, h, { x: w, y: h });
  ctx.lineWidth = 1;
  for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
    const sx = Math.round((x - cam.x) * cam.zoom + w / 2) + 0.5;
    ctx.strokeStyle = x % (step * 5) === 0 ? C.gridMajor : C.grid;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
    const sy = Math.round((y - cam.y) * cam.zoom + h / 2) + 0.5;
    ctx.strokeStyle = y % (step * 5) === 0 ? C.gridMajor : C.grid;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }
}

function strokePath(ctx: CanvasRenderingContext2D, pts: Vec[], width: number, color: string, cap: CanvasLineCap) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function laneSide(l: Lane, net: Network): Vec {
  const d = norm(sub(l.path.points[1], l.path.points[0]));
  return scale(rightNormal(d), net.scenario.driveSide === 'right' ? 1 : -1);
}

function drawSurface(ctx: CanvasRenderingContext2D, net: Network, lanes: Lane[], conns: Connector[], deck: boolean, px: number) {
  // Kerb / barrier halo first, then asphalt on top.
  const edge = deck ? C.deckEdge : C.kerb;
  const fill = deck ? C.asphaltDeck : C.asphalt;
  const halo = deck ? 1.0 : 0.6;
  for (const l of lanes) strokePath(ctx, l.path.points, l.width + halo, edge, 'butt');
  // Junction pads: hull of lane ends meeting at each junction
  const pads = new Map<string, Vec[]>();
  for (const c of conns) {
    const list = pads.get(c.node) ?? [];
    list.push(...c.path.points.filter((_, i, a) => i === 0 || i === a.length - 1));
    pads.set(c.node, list);
  }
  for (const c of conns) strokePath(ctx, c.path.points, c.width + halo, edge, 'round');
  for (const l of lanes) strokePath(ctx, l.path.points, l.width + 0.05, fill, 'butt');
  for (const [nodeId, pts] of pads) {
    const node = net.nodes.get(nodeId)!;
    if (node.degree < 3) continue;
    const hull = convexHull(pts);
    ctx.beginPath();
    hull.forEach((p, i) => {
      const q = add(p, scale(norm(sub(p, node.pos)), 1.6));
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  for (const c of conns) strokePath(ctx, c.path.points, c.width + 0.05, fill, 'round');
  void px;
}

function drawMarkings(ctx: CanvasRenderingContext2D, net: Network, lanes: Lane[], px: number) {
  ctx.save();
  for (const l of lanes) {
    const side = laneSide(l, net);
    const [a, b] = l.path.points;
    const edge = net.edges[l.edge];
    const road = net.roads.get(l.roadId)!;
    const twoWay = road.lanesFwd > 0 && road.lanesBwd > 0;
    // Dashed separator on the kerb side of every lane that has an outer neighbour.
    if (l.outer !== null) {
      const off = scale(side, l.width / 2);
      ctx.setLineDash([3, 4.5]);
      ctx.lineWidth = Math.max(0.15, 1.2 * px);
      ctx.strokeStyle = C.marking;
      ctx.beginPath();
      ctx.moveTo(a.x + off.x, a.y + off.y);
      ctx.lineTo(b.x + off.x, b.y + off.y);
      ctx.stroke();
    }
    // Centre line drawn once per road (forward edge, inner lane).
    if (twoWay && l.index === 0 && edge.dir === 1) {
      const off = scale(side, -l.width / 2);
      ctx.setLineDash([]);
      ctx.lineWidth = Math.max(0.2, 1.5 * px);
      ctx.strokeStyle = C.centre;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(a.x + off.x, a.y + off.y);
      ctx.lineTo(b.x + off.x, b.y + off.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function drawCongestion(ctx: CanvasRenderingContext2D, sim: Simulation, lanes: Lane[], px: number) {
  const done = new Map<number, number>();
  for (const l of lanes) {
    if (!done.has(l.edge)) {
      const live = sim.edgeLive(l.edge);
      done.set(l.edge, live.count ? live.congestion : -1);
    }
    const c = done.get(l.edge)!;
    if (c < 0) continue;
    strokePath(ctx, l.path.points, l.width * 0.92, congestionColor(c, 0.17), "butt");
  }
  void px;
}

function drawStopLines(ctx: CanvasRenderingContext2D, sim: Simulation, lanes: Lane[], px: number) {
  for (const l of lanes) {
    const node = sim.net.nodes.get(l.toNode)!;
    if (!node.signal) continue;
    const light = lightFor(node, l.roadId, sim.t);
    const side = laneSide(l, sim.net);
    const end = l.path.points[1];
    const a = add(end, scale(side, -l.width / 2 + 0.2));
    const b = add(end, scale(side, l.width / 2 - 0.2));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = Math.max(0.9, 3 * px);
    ctx.lineCap = 'round';
    ctx.strokeStyle = light === 'green' ? C.green : light === 'yellow' ? C.amber : C.red;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawVehicles(ctx: CanvasRenderingContext2D, sim: Simulation, include: (v: Vehicle) => boolean, px: number, elevated: boolean) {
  for (const v of sim.vehicles) {
    if (!include(v)) continue;
    const pose = sim.pose(v);
    const k = 1 + 0.06 * pose.level;
    const L = v.p.length * k;
    const W = v.p.width * k;
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.heading);
    if (elevated || pose.level > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-L / 2 + 0.6, -W / 2 + 0.8, L, W);
    }
    const color = v.type === 'car' ? CAR_COLORS[v.id % CAR_COLORS.length] : TYPE_COLORS[v.type];
    ctx.fillStyle = color;
    roundRect(ctx, -L / 2, -W / 2, L, W, Math.min(W / 2.5, v.type === 'bike' ? 0.4 : 0.7));
    ctx.fill();
    if (px < 0.35) {
      // windscreen
      ctx.fillStyle = 'rgba(15,20,28,0.75)';
      if (v.type === 'bike') ctx.fillRect(L / 2 - 0.7, -W / 4, 0.35, W / 2);
      else ctx.fillRect(L / 2 - (v.type === 'car' ? 1.6 : 1.2), -W / 2 + 0.25, 0.55, W - 0.5);
    }
    // brake lights
    if (v.acc < -1.2) {
      ctx.fillStyle = '#ff3b30';
      ctx.shadowColor = '#ff3b30';
      ctx.shadowBlur = 6;
      ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.1, 0.35, W * 0.28);
      ctx.fillRect(-L / 2 - 0.05, W / 2 - 0.1 - W * 0.28, 0.35, W * 0.28);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
}

function drawEditorMarks(ctx: CanvasRenderingContext2D, sim: Simulation, ov: Overlay, px: number) {
  const net = sim.net;
  const hi = (kind: 'road' | 'node', id: string) =>
    (ov.selected?.kind === kind && ov.selected.id === id) || (ov.hover?.kind === kind && ov.hover.id === id);
  for (const r of net.roads.values()) {
    if (!hi('road', r.id)) continue;
    const a = net.nodes.get(r.from)!.pos;
    const b = net.nodes.get(r.to)!.pos;
    const sel = ov.selected?.kind === 'road' && ov.selected.id === r.id;
    ctx.setLineDash(sel ? [] : [6 * px, 4 * px]);
    strokePath(ctx, [a, b], (r.lanesFwd + r.lanesBwd) * r.laneWidth + 3, sel ? 'rgba(76,201,240,0.28)' : 'rgba(76,201,240,0.14)', 'round');
    ctx.setLineDash([]);
  }
  for (const n of net.nodes.values()) {
    const show = ov.editing || hi('node', n.id);
    if (!show) continue;
    const sel = hi('node', n.id);
    const r = Math.max(1.6, (n.isEndpoint ? 5 : 4) * px);
    ctx.beginPath();
    ctx.arc(n.pos.x, n.pos.y, sel ? r * 1.6 : r, 0, Math.PI * 2);
    ctx.fillStyle = sel ? C.select : n.level > 0 ? '#c9ccd2' : n.isEndpoint ? C.amber : 'rgba(232,230,223,0.7)';
    ctx.fill();
    if (n.signal) {
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = C.green;
      ctx.beginPath();
      ctx.arc(n.pos.x, n.pos.y, r * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawPreview(ctx: CanvasRenderingContext2D, p: NonNullable<Overlay['preview']>, px: number) {
  ctx.setLineDash([8 * px, 6 * px]);
  strokePath(ctx, [p.from, p.to], 7, p.valid ? (p.flyover ? 'rgba(201,204,210,0.35)' : 'rgba(76,201,240,0.3)') : 'rgba(255,77,61,0.3)', 'round');
  ctx.setLineDash([]);
  strokePath(ctx, [p.from, p.to], 2 * px, p.valid ? C.select : C.red, 'round');
  for (const q of [p.from, p.to]) {
    ctx.beginPath();
    ctx.arc(q.x, q.y, 4 * px, 0, Math.PI * 2);
    ctx.fillStyle = C.select;
    ctx.fill();
  }
}

function drawLabels(ctx: CanvasRenderingContext2D, sim: Simulation, cam: Camera, w: number, h: number, ov: Overlay, dpr: number) {
  void dpr;
  ctx.save();
  ctx.font = '600 11px "Barlow Condensed", sans-serif';
  ctx.textBaseline = 'middle';
  for (const [id, label] of ov.endpointLabels) {
    const n = sim.net.nodes.get(id);
    if (!n) continue;
    const s = worldToScreen(cam, w, h, n.pos);
    const text = label.toUpperCase();
    const tw = ctx.measureText(text).width;
    const out = n.roads[0] ? { x: -Math.cos(n.roads[0].angle), y: -Math.sin(n.roads[0].angle) } : { x: 0, y: -1 };
    const cx = s.x + out.x * (tw / 2 + 16);
    const cy = s.y + out.y * 16;
    ctx.fillStyle = 'rgba(11,107,58,0.92)';
    roundRect(ctx, cx - tw / 2 - 6, cy - 9, tw + 12, 18, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    roundRect(ctx, cx - tw / 2 - 4, cy - 7, tw + 8, 14, 2);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, cy + 0.5);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function convexHull(points: Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Hit test in world coordinates: nodes first (within `tol`), then roads (within half width + tol). */
export function hitTest(net: Network, p: Vec, tol: number): { kind: 'road' | 'node'; id: string } | null {
  let best: { kind: 'road' | 'node'; id: string; d: number } | null = null;
  for (const n of net.nodes.values()) {
    const d = Math.hypot(n.pos.x - p.x, n.pos.y - p.y);
    if (d <= tol * 1.4 && (!best || d < best.d)) best = { kind: 'node', id: n.id, d };
  }
  if (best) return { kind: best.kind, id: best.id };
  // Prefer elevated roads (drawn on top).
  const roads = [...net.roads.values()].sort((a, b) => (net.nodes.get(b.from)!.level + net.nodes.get(b.to)!.level) - (net.nodes.get(a.from)!.level + net.nodes.get(a.to)!.level));
  for (const r of roads) {
    const a = net.nodes.get(r.from)!.pos;
    const b = net.nodes.get(r.to)!.pos;
    const ab = sub(b, a);
    const l2 = ab.x * ab.x + ab.y * ab.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
    const d = Math.hypot(a.x + ab.x * t - p.x, a.y + ab.y * t - p.y);
    if (d <= ((r.lanesFwd + r.lanesBwd) * r.laneWidth) / 2 + tol) return { kind: 'road', id: r.id };
  }
  return null;
}
