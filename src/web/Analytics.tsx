import type { Simulation } from '../engine';
import { Chart } from './Chart';
import { fmt, kmh } from './format';
import { Kpi, Section } from './ui';

export function Analytics({ sim }: { sim: Simulation }) {
  const s = sim.summary();
  const samples = sim.samples;
  const t = samples.map((x) => x.t);
  const last = samples[samples.length - 1];
  const live = sim.vehicles.length ? sim.vehicles.reduce((a, v) => a + v.v, 0) / sim.vehicles.length : 0;
  const worst = [...sim.net.edges]
    .map((e) => ({ e, live: sim.edgeLive(e.id) }))
    .filter((x) => x.live.count > 0)
    .sort((a, b) => b.live.congestion - a.live.congestion)
    .slice(0, 5);
  return (
    <div className="inspector">
      <div className="kpis">
        <Kpi label="Vehicles in network" value={fmt(sim.vehicles.length)} />
        <Kpi label="Mean speed now" value={fmt(kmh(live))} unit="km/h" />
        <Kpi label="Avg travel time" value={s.completed ? fmt(s.avgTravelTime, 1) : '—'} unit="s" />
        <Kpi label="Avg delay" value={s.completed ? fmt(s.avgDelay, 1) : '—'} unit="s/veh" tone={s.avgDelay > 45 ? 'bad' : s.avgDelay > 15 ? 'warn' : undefined} />
        <Kpi label="Throughput" value={fmt(s.throughputPerHour)} unit="veh/h" />
        <Kpi label="Queued now" value={fmt(last?.queueLength ?? 0)} unit="m" tone={(last?.queueLength ?? 0) > 150 ? 'bad' : undefined} />
        <Kpi label="Density" value={fmt(last?.density ?? 0, 1)} unit="veh/km/ln" />
        <Kpi label="Waiting to enter" value={fmt(s.backlog)} tone={s.backlog > 10 ? 'bad' : undefined} />
      </div>
      <Section title="Over time">
        {samples.length < 2 ? (
          <p className="note">Press play to collect data. One sample per simulated second.</p>
        ) : (
          <>
            <Chart title="Mean speed" unit="km/h" t={t} series={[{ name: 'speed', color: 'var(--green)', values: samples.map((x) => kmh(x.meanSpeed)) }]} />
            <Chart title="Vehicles in network" t={t} series={[{ name: 'active', color: 'var(--cyan)', values: samples.map((x) => x.active) }]} />
            <Chart title="Throughput (rolling 60 s)" unit="veh/h" t={t} series={[{ name: 'thr', color: 'var(--amber)', values: samples.map((x) => x.throughput) }]} />
            <Chart title="Total queue length" unit="m" t={t} series={[{ name: 'queue', color: 'var(--red)', values: samples.map((x) => x.queueLength) }]} />
          </>
        )}
      </Section>
      <Section title="Most congested links">
        {worst.length === 0 && <p className="note">No traffic yet.</p>}
        <table className="table">
          <tbody>
            {worst.map(({ e, live }) => (
              <tr key={e.id}>
                <td>{sim.net.roads.get(e.roadId)?.name ?? e.roadId}</td>
                <td className="mono">{fmt(kmh(live.meanSpeed))} km/h</td>
                <td className="mono">{fmt(live.density, 0)} /km/ln</td>
                <td>
                  <span className="dot" style={{ background: live.congestion > 0.66 ? 'var(--red)' : live.congestion > 0.33 ? 'var(--amber)' : 'var(--green)' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Run totals">
        <dl className="facts">
          <dt>Entered / completed</dt>
          <dd>
            {s.spawned} / {s.completed}
          </dd>
          <dt>Avg trip speed</dt>
          <dd>{fmt(kmh(s.avgTripSpeed), 1)} km/h</dd>
          <dt>Time spent stopped</dt>
          <dd>{fmt(s.stopsShare * 100, 1)} %</dd>
          <dt>Longest queue seen</dt>
          <dd>{fmt(s.maxQueueLength)} m</dd>
          <dt>Lane changes</dt>
          <dd>{sim.laneChangeCount}</dd>
          <dt>Safety interventions</dt>
          <dd>{s.safetyInterventions}</dd>
        </dl>
      </Section>
    </div>
  );
}
