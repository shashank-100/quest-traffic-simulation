import {
  autoPhases,
  removeNode,
  removeRoad,
  setSignal,
  signalStatus,
  updateRoad,
  type Scenario,
  type SignalDef,
  type Simulation,
} from '../engine';
import { fmt, kmh, roadLabel } from './format';
import type { Selection } from './MapView';
import { Field, Meter, Section, Slider, Stepper } from './ui';

interface Props {
  sim: Simulation;
  scenario: Scenario;
  selection: Selection;
  labels: Map<string, string>;
  onEdit: (sc: Scenario, opts?: { message?: string }) => void;
  onSelect: (s: Selection) => void;
  onAddFlow: (origin: string) => void;
}

export function Inspector(p: Props) {
  if (!p.selection) return <Overview {...p} />;
  if (p.selection.kind === 'road') return <RoadInspector {...p} roadId={p.selection.id} />;
  return <NodeInspector {...p} nodeId={p.selection.id} />;
}

function Overview({ sim, scenario }: Props) {
  const net = sim.net;
  const junctions = [...net.nodes.values()].filter((n) => n.degree >= 3);
  const elevated = net.lanes.filter((l) => l.levelFrom > 0 && l.levelTo > 0).length;
  const laneKm = net.edges.reduce((a, e) => a + (e.length * e.lanes.length) / 1000, 0);
  return (
    <div className="inspector">
      <Section title="Network">
        <dl className="facts">
          <dt>Roads</dt>
          <dd>{scenario.roads.length}</dd>
          <dt>Lane-km</dt>
          <dd>{fmt(laneKm, 2)}</dd>
          <dt>Junctions</dt>
          <dd>
            {junctions.length} <small>({junctions.filter((j) => j.signal).length} signalised)</small>
          </dd>
          <dt>Entry / exit points</dt>
          <dd>{net.entryEdges.length}</dd>
          <dt>Elevated lanes</dt>
          <dd>{elevated}</dd>
          <dt>Junction movements</dt>
          <dd>{net.connectors.length}</dd>
        </dl>
        {net.warnings.length > 0 && (
          <ul className="warnings">
            {net.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="How to">
        <ul className="howto">
          <li>
            <kbd>R</kbd> Draw roads. Crossing a ground road creates a junction; ending on a road creates a T.
          </li>
          <li>
            <kbd>F</kbd> Draw a flyover between two ground points. It never meets the roads it passes over.
          </li>
          <li>
            <kbd>S</kbd> Click a junction to add a signal, then tune its phases here.
          </li>
          <li>
            <kbd>V</kbd> Select a road or junction to inspect it. Drag nodes to reshape.
          </li>
          <li>
            <kbd>Space</kbd> Play or pause. <kbd>⌘Z</kbd> Undo.
          </li>
        </ul>
      </Section>
    </div>
  );
}

function RoadInspector({ sim, scenario, roadId, onEdit, onSelect }: Props & { roadId: string }) {
  const road = scenario.roads.find((r) => r.id === roadId);
  if (!road) return <p className="empty">Road no longer exists.</p>;
  const a = scenario.nodes.find((n) => n.id === road.from)!;
  const b = scenario.nodes.find((n) => n.id === road.to)!;
  const level = a.level === b.level ? (a.level ? 'Elevated deck' : 'Ground') : 'Ramp';
  const length = Math.hypot(a.x - b.x, a.y - b.y);
  const set = (patch: Partial<typeof road>, message = 'Road updated') => onEdit(updateRoad(scenario, road.id, patch), { message });
  const edges = sim.net.edges.filter((e) => e.roadId === road.id);
  return (
    <div className="inspector">
      <Section title={road.name || `Road ${road.id}`} aside={<span className={`tag ${level === 'Ground' ? '' : 'tag-deck'}`}>{level}</span>}>
        <Field label="Name">
          <input value={road.name ?? ''} placeholder={road.id} onChange={(e) => set({ name: e.target.value }, 'Renamed')} />
        </Field>
        <div className="row2">
          <Field label="Lanes →" hint={`${road.from}→${road.to}`}>
            <Stepper label="forward lanes" value={road.lanesFwd} min={road.lanesBwd ? 0 : 1} max={5} onChange={(v) => set({ lanesFwd: v })} />
          </Field>
          <Field label="Lanes ←" hint={road.lanesBwd ? '' : 'one-way'}>
            <Stepper label="backward lanes" value={road.lanesBwd} min={road.lanesFwd ? 0 : 1} max={5} onChange={(v) => set({ lanesBwd: v })} />
          </Field>
        </div>
        <Field label="Lane width">
          <Slider label="Lane width" value={road.laneWidth} min={2.75} max={4.5} step={0.25} format={(v) => `${v.toFixed(2)} m`} onChange={(v) => set({ laneWidth: v })} />
        </Field>
        <Field label="Speed limit">
          <Slider label="Speed limit" value={Math.round(kmh(road.speedLimit))} min={20} max={100} step={5} format={(v) => `${v} km/h`} onChange={(v) => set({ speedLimit: v / 3.6 })} />
        </Field>
        <dl className="facts">
          <dt>Length</dt>
          <dd>{fmt(length)} m</dd>
          <dt>Width</dt>
          <dd>{fmt((road.lanesFwd + road.lanesBwd) * road.laneWidth, 1)} m</dd>
        </dl>
      </Section>
      <Section title="Live traffic">
        {edges.length === 0 && <p className="empty">No lanes.</p>}
        {edges.map((e) => {
          const live = sim.edgeLive(e.id);
          return (
            <div className="live" key={e.id}>
              <div className="live-head">
                <span>
                  {e.from} → {e.to}
                </span>
                <span className="mono">{live.count} veh</span>
              </div>
              <Meter value={live.congestion} label="Congestion" />
              <div className="live-grid">
                <span>Speed</span>
                <b>{fmt(kmh(live.meanSpeed))} km/h</b>
                <span>Density</span>
                <b>{fmt(live.density, 1)} veh/km/lane</b>
                <span>Queue</span>
                <b>{fmt(live.queueLength)} m</b>
              </div>
            </div>
          );
        })}
      </Section>
      <button
        type="button"
        className="danger"
        onClick={() => {
          onEdit(removeRoad(scenario, road.id), { message: 'Road deleted' });
          onSelect(null);
        }}
      >
        Delete road
      </button>
    </div>
  );
}

function NodeInspector({ sim, scenario, nodeId, labels, onEdit, onSelect, onAddFlow }: Props & { nodeId: string }) {
  const node = scenario.nodes.find((n) => n.id === nodeId);
  const cn = sim.net.nodes.get(nodeId);
  if (!node || !cn) return <p className="empty">Node no longer exists.</p>;
  const kind = cn.isEndpoint ? 'Entry / exit point' : cn.degree >= 4 ? 'Four-way junction' : cn.degree === 3 ? 'T-junction' : node.level ? 'Deck joint' : 'Road joint';
  const sig = node.signal?.enabled ? node.signal : null;
  const setSig = (s: SignalDef, message = 'Signal timing updated') =>
    onEdit({ ...scenario, nodes: scenario.nodes.map((n) => (n.id === nodeId ? { ...n, signal: s } : n)) }, { message });
  const status = sig ? signalStatus(sig, sim.t) : null;
  const approaches = sim.net.nodes.get(nodeId)!.inEdges.map((e) => sim.net.edges[e]);
  const flows = scenario.flows.filter((f) => f.origin === nodeId);
  return (
    <div className="inspector">
      <Section title={labels.get(nodeId) ?? `Node ${nodeId}`} aside={<span className="tag">{kind}</span>}>
        <dl className="facts">
          <dt>Level</dt>
          <dd>{node.level ? 'Elevated' : 'Ground'}</dd>
          <dt>Position</dt>
          <dd className="mono">
            {fmt(node.x)}, {fmt(node.y)} m
          </dd>
          {!cn.isEndpoint && (
            <>
              <dt>Vehicles served</dt>
              <dd>{sim.nodeThroughput.get(nodeId) ?? 0}</dd>
            </>
          )}
        </dl>
        {cn.isEndpoint && (
          <>
            <p className="note">
              {flows.length ? `${flows.length} flow(s) enter here.` : 'No traffic enters here yet.'} Vehicles routed to this point leave the network here.
            </p>
            <button type="button" onClick={() => onAddFlow(nodeId)}>
              + Add flow from here
            </button>
          </>
        )}
      </Section>
      {cn.degree >= 3 && (
        <Section
          title="Traffic signal"
          aside={
            <label className="switch">
              <input type="checkbox" checked={!!sig} onChange={(e) => onEdit(setSignal(scenario, nodeId, e.target.checked), { message: e.target.checked ? 'Signal added' : 'Signal removed' })} />
              <span />
            </label>
          }
        >
          {!sig && <p className="note">Unsignalised: movements are served first come, first served, and only when they don't conflict with vehicles already in the junction.</p>}
          {sig && status && (
            <>
              <div className="phase-now">
                <span className={`lamp ${status.stage}`} />
                Phase {status.phase + 1} · {status.stage === 'allRed' ? 'all red' : status.stage} · {status.remaining.toFixed(0)} s left · cycle {fmt(status.cycle)} s
              </div>
              {sig.phases.map((ph, i) => (
                <div className={`phase ${status.phase === i ? 'active' : ''}`} key={i}>
                  <div className="phase-head">
                    <b>Phase {i + 1}</b>
                    <span className="chips">
                      {ph.approaches.map((r) => (
                        <span className="chip" key={r}>
                          {roadLabel(scenario, r)}
                        </span>
                      ))}
                    </span>
                  </div>
                  <Slider
                    label={`Phase ${i + 1} green`}
                    value={ph.green}
                    min={5}
                    max={90}
                    format={(v) => `${v} s green`}
                    onChange={(v) => setSig({ ...sig, phases: sig.phases.map((x, k) => (k === i ? { ...x, green: v } : x)) })}
                  />
                </div>
              ))}
              <div className="row3">
                <Field label="Yellow">
                  <Stepper label="yellow seconds" value={sig.yellow} min={2} max={6} onChange={(v) => setSig({ ...sig, yellow: v })} />
                </Field>
                <Field label="All-red">
                  <Stepper label="all-red seconds" value={sig.allRed} min={0} max={5} onChange={(v) => setSig({ ...sig, allRed: v })} />
                </Field>
                <Field label="Offset">
                  <Stepper label="offset seconds" value={sig.offset} min={0} max={120} onChange={(v) => setSig({ ...sig, offset: v })} />
                </Field>
              </div>
              <div className="btn-row">
                <button type="button" onClick={() => setSig({ ...sig, phases: autoPhases(scenario, nodeId) }, 'Phases regrouped')}>
                  Pair opposing approaches
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSig(
                      { ...sig, phases: sim.net.nodes.get(nodeId)!.roads.map((r) => ({ green: 15, approaches: [r.roadId] })) },
                      'One phase per approach',
                    )
                  }
                >
                  One per approach
                </button>
              </div>
            </>
          )}
        </Section>
      )}
      {!cn.isEndpoint && (
        <Section title="Approach queues">
          {approaches.map((e) => {
            const q = Math.max(0, ...e.lanes.map((l) => sim.laneQueue(l)));
            const live = sim.edgeLive(e.id);
            return (
              <div className="live" key={e.id}>
                <div className="live-head">
                  <span>{roadLabel(scenario, e.roadId)}</span>
                  <span className="mono">{fmt(q)} m queue</span>
                </div>
                <Meter value={Math.min(1, q / Math.max(30, e.length))} label="Queue" />
                <div className="live-grid">
                  <span>Approaching</span>
                  <b>{live.count} veh</b>
                  <span>Speed</span>
                  <b>{fmt(kmh(live.meanSpeed))} km/h</b>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      <button
        type="button"
        className="danger"
        onClick={() => {
          onEdit(removeNode(scenario, nodeId), { message: 'Node deleted' });
          onSelect(null);
        }}
      >
        Delete node and its roads
      </button>
    </div>
  );
}
