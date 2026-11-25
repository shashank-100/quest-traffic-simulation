import { useEffect, useRef, useState } from 'react';
import {
  addFlyover,
  addRoad,
  DT,
  moveNode,
  removeNode,
  removeRoad,
  setSignal,
  type RoadOptions,
  type Scenario,
  type Simulation,
  type Vec,
} from '../engine';
import { fitCamera, focusCamera, hitTest, render, screenToWorld, type Camera } from './renderer';

export type Tool = 'select' | 'road' | 'flyover' | 'signal' | 'delete';
export type Selection = { kind: 'road' | 'node'; id: string } | null;

interface Props {
  sim: Simulation;
  scenario: Scenario;
  fitKey: number;
  tool: Tool;
  template: RoadOptions;
  selection: Selection;
  playing: boolean;
  speed: number;
  congestion: boolean;
  labels: boolean;
  endpointLabels: Map<string, string>;
  onSelect: (s: Selection) => void;
  onEdit: (sc: Scenario, opts?: { transient?: boolean; message?: string }) => void;
  onBeginEdit: () => void;
  onError: (msg: string) => void;
  onFrame: () => void;
}

const GRID = 5;

export function MapView(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const props = useRef(p);
  props.current = p;
  const draft = useRef<{ from: Vec; fromId?: string } | null>(null);
  const cursor = useRef<Vec | null>(null);
  const hover = useRef<Selection>(null);
  const drag = useRef<{ mode: 'pan' | 'node'; start: Vec; cam: Camera; nodeId?: string; moved: boolean; pointer: number } | null>(null);
  const [hint, setHint] = useState('');
  /** Active touch/pen/mouse pointers in screen coordinates, for two-finger pinch zoom. */
  const pointers = useRef(new Map<number, Vec>());
  const pinch = useRef<{ dist: number; cam: Camera; anchor: Vec } | null>(null);

  /** Zoom by factor k keeping the world point under screen point sp fixed. */
  const zoomAt = (sp: Vec, k: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const before = screenToWorld(cam.current, r.width, r.height, sp);
    const zoom = Math.max(0.15, Math.min(12, cam.current.zoom * k));
    const next = { ...cam.current, zoom };
    const after = screenToWorld(next, r.width, r.height, sp);
    cam.current = { ...next, x: next.x + before.x - after.x, y: next.y + before.y - after.y };
  };

  // Wheel and trackpad pinch zoom the map, never the page. React registers wheel listeners as
  // passive, which cannot cancel the browser's own Ctrl+wheel (pinch) page zoom, so these are
  // native, non-passive listeners. Safari reports trackpad pinch as gesture events instead.
  useEffect(() => {
    const c = canvasRef.current!;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Pinch arrives as small Ctrl+wheel deltas; a mouse wheel as larger plain ones.
      zoomAt(local(e), Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomAt(local(g), g.scale / gestureScale);
      gestureScale = g.scale;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('gesturestart', onGestureStart);
    c.addEventListener('gesturechange', onGestureChange);
    return () => {
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('gesturestart', onGestureStart);
      c.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);

  // Fit view when a new scenario is loaded.
  useEffect(() => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    cam.current = focusCamera(p.sim.net, r.width, r.height);
    draft.current = null;
  }, [p.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    draft.current = null;
    setHint(
      p.tool === 'road'
        ? 'Click to start a road, click again to place its end. Crossing a ground road creates a junction. Esc to stop.'
        : p.tool === 'flyover'
          ? 'Click two points on the ground. The flyover ramps up, passes over everything in between, and ramps down.'
          : p.tool === 'signal'
            ? 'Click a junction to add or remove a traffic signal.'
            : p.tool === 'delete'
              ? 'Click a road or node to delete it.'
              : '',
    );
  }, [p.tool]);

  // Render + simulation loop. The engine advances in fixed DT steps; rendering only reads state.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    const frame = (now: number) => {
      const cur = props.current;
      const c = canvasRef.current;
      if (!c) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (cur.playing) {
        acc += dt * cur.speed;
        let n = 0;
        while (acc >= DT && n < 800) {
          cur.sim.step();
          acc -= DT;
          n++;
        }
        if (n >= 800) acc = 0;
      }
      const ctx = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const d = draft.current;
      const editing = cur.tool !== 'select';
      let preview = null;
      if (d && cursor.current) {
        const to = snapPoint(cursor.current).p;
        const len = Math.hypot(to.x - d.from.x, to.y - d.from.y);
        preview = { from: d.from, to, flyover: cur.tool === 'flyover', valid: cur.tool === 'flyover' ? len >= 80 : len > 3 };
      }
      render(ctx, cur.sim, cam.current, w, h, {
        congestion: cur.congestion,
        labels: cur.labels,
        editing,
        selected: cur.selection,
        hover: hover.current,
        preview,
        endpointLabels: cur.endpointLabels,
      });
      if (now - lastUi > 200) {
        lastUi = now;
        cur.onFrame();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') draft.current = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }): Vec => {
    const r = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(cam.current, r.width, r.height, { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  /** Snap to a ground node within 12 px, else to the 5 m grid. */
  function snapPoint(w: Vec): { p: Vec; nodeId?: string } {
    const tol = 12 / cam.current.zoom;
    let best: { id: string; d: number; p: Vec } | null = null;
    for (const n of props.current.sim.net.nodes.values()) {
      if (n.level !== 0) continue;
      const d = Math.hypot(n.pos.x - w.x, n.pos.y - w.y);
      if (d < tol && (!best || d < best.d)) best = { id: n.id, d, p: n.pos };
    }
    if (best) return { p: best.p, nodeId: best.id };
    return { p: { x: Math.round(w.x / GRID) * GRID, y: Math.round(w.y / GRID) * GRID } };
  }

  const click = (w: Vec) => {
    const cur = props.current;
    const tol = 8 / cam.current.zoom;
    const hit = hitTest(cur.sim.net, w, tol);
    try {
      switch (cur.tool) {
        case 'select':
          cur.onSelect(hit);
          break;
        case 'delete':
          if (!hit) return;
          cur.onBeginEdit();
          cur.onEdit(hit.kind === 'road' ? removeRoad(cur.scenario, hit.id) : removeNode(cur.scenario, hit.id), { message: `Deleted ${hit.kind}` });
          cur.onSelect(null);
          break;
        case 'signal': {
          if (!hit || hit.kind !== 'node') return;
          const node = cur.sim.net.nodes.get(hit.id)!;
          if (node.degree < 3) {
            cur.onError('Signals go on junctions where three or more roads meet.');
            return;
          }
          const on = !(node.def.signal?.enabled ?? false);
          cur.onBeginEdit();
          cur.onEdit(setSignal(cur.scenario, hit.id, on), { message: on ? 'Signal added' : 'Signal removed' });
          cur.onSelect(hit);
          break;
        }
        case 'road':
        case 'flyover': {
          const s = snapPoint(w);
          if (!draft.current) {
            draft.current = { from: s.p, fromId: s.nodeId };
            return;
          }
          const d = draft.current;
          const snap = 10 / cam.current.zoom;
          cur.onBeginEdit();
          if (cur.tool === 'road') {
            const r = addRoad(cur.scenario, d.fromId ?? d.from, s.nodeId ?? s.p, cur.template, 0, snap);
            if (r.roads.length === 0) {
              draft.current = null;
              return;
            }
            cur.onEdit(r.scenario, { message: r.roads.length > 1 ? `Road added · ${r.roads.length - 1} junction(s) created` : 'Road added' });
            const end = r.scenario.nodes.find((n) => n.id === r.to)!;
            draft.current = { from: { x: end.x, y: end.y }, fromId: end.id };
          } else {
            const r = addFlyover(cur.scenario, d.fromId ?? d.from, s.nodeId ?? s.p, cur.template, snap);
            cur.onEdit(r.scenario, { message: 'Flyover added: no junction with roads beneath' });
            draft.current = null;
          }
          break;
        }
      }
    } catch (err) {
      cur.onError(err instanceof Error ? err.message : String(err));
      draft.current = null;
    }
  };

  const screenPoint = (e: { clientX: number; clientY: number }): Vec => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    c.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, screenPoint(e));
    if (pointers.current.size === 2) {
      // Second finger down: pinch replaces any pan or drag in progress.
      const [a, b] = [...pointers.current.values()];
      const r = c.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), cam: { ...cam.current }, anchor: screenToWorld(cam.current, r.width, r.height, mid) };
      drag.current = null;
      return;
    }
    if (pinch.current) return;
    if (e.button === 2) {
      draft.current = null;
      return;
    }
    const w = toWorld(e);
    const cur = props.current;
    if (cur.tool === 'select' && e.button === 0) {
      const hit = hitTest(cur.sim.net, w, 8 / cam.current.zoom);
      if (hit?.kind === 'node') {
        drag.current = { mode: 'node', start: { x: e.clientX, y: e.clientY }, cam: { ...cam.current }, nodeId: hit.id, moved: false, pointer: e.pointerId };
        return;
      }
    }
    drag.current = { mode: 'pan', start: { x: e.clientX, y: e.clientY }, cam: { ...cam.current }, moved: false, pointer: e.pointerId };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, screenPoint(e));
    const pz = pinch.current;
    if (pz && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = canvasRef.current!.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoom = Math.max(0.15, Math.min(12, pz.cam.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pz.dist))));
      // Keep the world point that started under the fingers' midpoint under it.
      cam.current = { zoom, x: pz.anchor.x - (mid.x - r.width / 2) / zoom, y: pz.anchor.y - (mid.y - r.height / 2) / zoom };
      return;
    }
    const w = toWorld(e);
    cursor.current = w;
    const cur = props.current;
    const d = drag.current;
    if (d && d.pointer === e.pointerId) {
      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        if (d.mode === 'node') cur.onBeginEdit();
      }
      if (!d.moved) return;
      if (d.mode === 'pan') {
        cam.current = { ...d.cam, x: d.cam.x - dx / d.cam.zoom, y: d.cam.y - dy / d.cam.zoom };
      } else if (d.nodeId) {
        const p = { x: Math.round(w.x / GRID) * GRID, y: Math.round(w.y / GRID) * GRID };
        cur.onEdit(moveNode(cur.scenario, d.nodeId, p), { transient: true });
      }
      return;
    }
    if (e.pointerType === 'mouse') hover.current = hitTest(cur.sim.net, w, 8 / cam.current.zoom);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      // A pinch never ends in a click; wait until every finger has lifted.
      if (pointers.current.size === 0) pinch.current = null;
      drag.current = null;
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (e.button === 2) return;
    if (d && d.moved) return;
    if (d?.mode === 'node' && props.current.tool === 'select') {
      props.current.onSelect({ kind: 'node', id: d.nodeId! });
      return;
    }
    click(toWorld(e));
  };

  const zoomBy = (k: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    zoomAt({ x: r.width / 2, y: r.height / 2 }, k);
  };
  const fit = () => {
    const r = canvasRef.current!.getBoundingClientRect();
    cam.current = fitCamera(props.current.sim.net, r.width, r.height);
  };

  return (
    <div className={`map tool-${p.tool}`} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          cursor.current = null;
          hover.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size === 0) pinch.current = null;
          drag.current = null;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          draft.current = null;
        }}
        aria-label="Road network map"
      />
      {hint && <div className="map-hint">{hint}</div>}
      <div className="map-zoom">
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={fit} aria-label="Fit network" title="Fit network">
          ⤢
        </button>
      </div>
    </div>
  );
}
