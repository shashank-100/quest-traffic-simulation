import { VEHICLE_TYPES, type FlowDef, type Scenario, type Simulation, type VehicleType } from '../engine';
import { Field, Section, Slider } from './ui';

interface Props {
  sim: Simulation;
  scenario: Scenario;
  labels: Map<string, string>;
  onEdit: (sc: Scenario, opts?: { message?: string }) => void;
}

const TYPE_LABEL: Record<VehicleType, string> = { car: 'Cars', bike: 'Two-wheelers', bus: 'Buses', truck: 'Trucks' };

export function TrafficPanel({ sim, scenario, labels, onEdit }: Props) {
  const endpoints = [...labels.entries()];
  const setFlow = (id: string, patch: Partial<FlowDef>) =>
    onEdit({ ...scenario, flows: scenario.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)) }, { message: 'Traffic updated' });
  const addFlow = () => {
    const origin = endpoints.find(([id]) => !scenario.flows.some((f) => f.origin === id))?.[0] ?? endpoints[0]?.[0];
    if (!origin) return;
    onEdit({ ...scenario, flows: [...scenario.flows, newFlow(scenario, origin)] }, { message: 'Flow added' });
  };
  const generated = new Map<string, number>();
  for (const t of sim.trips) generated.set(t.flowId, (generated.get(t.flowId) ?? 0) + 1);
  for (const v of sim.vehicles) generated.set(v.flowId, (generated.get(v.flowId) ?? 0) + 1);
  return (
    <div className="inspector">
      <Section title="Experiment">
        <div className="row2">
          <Field label="Random seed" hint="reproducible">
            <input type="number" value={scenario.seed} onChange={(e) => onEdit({ ...scenario, seed: Math.max(0, Math.round(Number(e.target.value) || 0)) }, { message: 'Seed changed' })} />
          </Field>
          <Field label="Run length" hint="for comparisons">
            <select value={scenario.duration} onChange={(e) => onEdit({ ...scenario, duration: Number(e.target.value) })}>
              {[300, 600, 900, 1800, 3600].map((d) => (
                <option key={d} value={d}>
                  {d / 60} min
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row2">
          <Field label="Driving side">
            <select value={scenario.driveSide} onChange={(e) => onEdit({ ...scenario, driveSide: e.target.value as 'left' | 'right' }, { message: 'Driving side changed' })}>
              <option value="left">Left (India, UK)</option>
              <option value="right">Right (US, EU)</option>
            </select>
          </Field>
          <Field label="Routing">
            <select
              value={scenario.congestionAwareRouting ? 'live' : 'free'}
              onChange={(e) => onEdit({ ...scenario, congestionAwareRouting: e.target.value === 'live' }, { message: 'Routing changed' })}
            >
              <option value="free">Shortest free-flow time</option>
              <option value="live">Congestion-aware</option>
            </select>
          </Field>
        </div>
      </Section>
      <Section
        title={`Traffic flows · ${scenario.flows.length}`}
        aside={
          <button type="button" className="small" onClick={addFlow} disabled={endpoints.length < 2}>
            + Add
          </button>
        }
      >
        {endpoints.length < 2 && <p className="note">Draw roads with at least two loose ends to create entry and exit points.</p>}
        {scenario.flows.map((f) => {
          const total = VEHICLE_TYPES.reduce((a, k) => a + f.mix[k], 0) || 1;
          return (
            <div className="flow" key={f.id}>
              <div className="flow-head">
                <input className="flow-name" value={f.name ?? ''} placeholder={`Flow ${f.id}`} onChange={(e) => setFlow(f.id, { name: e.target.value })} aria-label="Flow name" />
                <span className="mono muted">{generated.get(f.id) ?? 0} veh</span>
                <button
                  type="button"
                  className="icon"
                  aria-label="Remove flow"
                  onClick={() => onEdit({ ...scenario, flows: scenario.flows.filter((x) => x.id !== f.id) }, { message: 'Flow removed' })}
                >
                  ×
                </button>
              </div>
              <div className="row2">
                <Field label="From">
                  <select value={f.origin} onChange={(e) => setFlow(f.id, { origin: e.target.value, destination: f.destination === e.target.value ? null : f.destination })}>
                    {endpoints.map(([id, l]) => (
                      <option key={id} value={id}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="To">
                  <select value={f.destination ?? ''} onChange={(e) => setFlow(f.id, { destination: e.target.value || null })}>
                    <option value="">Any exit (random)</option>
                    {endpoints
                      .filter(([id]) => id !== f.origin)
                      .map(([id, l]) => (
                        <option key={id} value={id}>
                          {l}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <Field label="Entry rate" hint="Poisson arrivals">
                <Slider label="Entry rate" value={f.rate} min={0} max={3000} step={20} format={(v) => `${v} veh/h`} onChange={(v) => setFlow(f.id, { rate: v })} />
              </Field>
              <Field label="Desired speed" hint="× vehicle nominal">
                <Slider label="Desired speed factor" value={f.speedFactor} min={0.5} max={1.5} step={0.05} format={(v) => `×${v.toFixed(2)}`} onChange={(v) => setFlow(f.id, { speedFactor: v })} />
              </Field>
              <div className="mix">
                {VEHICLE_TYPES.map((k) => (
                  <label key={k} className={`mix-item mix-${k}`}>
                    <span>{TYPE_LABEL[k]}</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round((f.mix[k] / total) * 100)}
                      onChange={(e) => {
                        const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                        const others = VEHICLE_TYPES.filter((x) => x !== k);
                        const rest = others.reduce((a, x) => a + f.mix[x], 0);
                        const mix = { ...f.mix, [k]: pct / 100 };
                        for (const x of others) mix[x] = rest > 0 ? (f.mix[x] / rest) * (1 - pct / 100) : (1 - pct / 100) / others.length;
                        setFlow(f.id, { mix });
                      }}
                    />
                    <i>%</i>
                  </label>
                ))}
              </div>
              <div className="mixbar" aria-hidden>
                {VEHICLE_TYPES.map((k) => (
                  <span key={k} className={`mix-${k}`} style={{ flexGrow: f.mix[k] }} />
                ))}
              </div>
              <div className="row2">
                <Field label="Vehicle cap" hint="optional">
                  <input
                    type="number"
                    min={0}
                    placeholder="unlimited"
                    value={f.maxVehicles ?? ''}
                    onChange={(e) => setFlow(f.id, { maxVehicles: e.target.value === '' ? undefined : Math.max(0, Math.round(Number(e.target.value))) })}
                  />
                </Field>
                <Field label="Active from" hint="seconds">
                  <input type="number" min={0} value={f.start} onChange={(e) => setFlow(f.id, { start: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
              </div>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

export function newFlow(scenario: Scenario, origin: string): FlowDef {
  let k = scenario.flows.length + 1;
  while (scenario.flows.some((f) => f.id === `f${k}`)) k++;
  return {
    id: `f${k}`,
    origin,
    destination: null,
    rate: 400,
    mix: { car: 0.62, bike: 0.25, bus: 0.06, truck: 0.07 },
    speedFactor: 1,
    start: 0,
    end: 1e9,
  };
}
