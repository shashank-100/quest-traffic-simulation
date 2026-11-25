import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_ROAD, emptyScenario, parseScenario, removeNode, removeRoad, preset, PRESETS, Simulation, type RoadOptions, type Scenario } from '../engine';
import { Analytics } from './Analytics';
import { listScenarios, loadScenario, saveScenario, type SavedMeta } from './api';
import { Compare } from './Compare';
import { clock, endpointLabels, fmt, kmh } from './format';
import { Inspector } from './Inspector';
import { MapView, type Selection, type Tool } from './MapView';
import { newFlow, TrafficPanel } from './TrafficPanel';
import { Stepper } from './ui';

type Tab = 'inspect' | 'traffic' | 'analytics';
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32];

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: 'M5 3l14 8-6 1.5L10 19z' },
  { id: 'road', label: 'Road', key: 'R', icon: 'M4 20L10 4M20 20L14 4M12 6v2M12 11v2M12 16v2' },
  { id: 'flyover', label: 'Flyover', key: 'F', icon: 'M2 18h20M3 18c3-9 15-9 18 0M7 18v-4M17 18v-4M12 18v-6' },
  { id: 'signal', label: 'Signal', key: 'S', icon: 'M9 2h6v20H9zM12 6.5h.01M12 12h.01M12 17.5h.01' },
  { id: 'delete', label: 'Delete', key: 'D', icon: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' },
];

export function App() {
  const [scenario, setScenario] = useState<Scenario>(() => preset('four-way'));
  const [sim, setSim] = useState(() => new Simulation(scenario));
  const [fitKey, setFitKey] = useState(0);
  const [view, setView] = useState<'simulate' | 'compare'>('simulate');
  const [tab, setTab] = useState<Tab>('analytics');
  const [tool, setTool] = useState<Tool>('select');
  const [template, setTemplate] = useState<RoadOptions>(DEFAULT_ROAD);
  const [selection, setSelection] = useState<Selection>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [congestion, setCongestion] = useState(true);
  const [labels, setLabels] = useState(true);
  const [, setTick] = useState(0);
  const [toast, setToast] = useState<{ text: string; tone?: 'error' } | null>(null);
  const [saved, setSaved] = useState<SavedMeta[]>([]);
  const [menu, setMenu] = useState(false);
  const history = useRef<Scenario[]>([]);
  const toastTimer = useRef<number>(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string, tone?: 'error') => {
    setToast({ text, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), tone ? 4200 : 2400);
  }, []);

  // Any scenario change rebuilds the network and restarts the simulation from t = 0.
  const apply = useCallback((sc: Scenario) => {
    setScenario(sc);
    setSim(new Simulation(sc));
  }, []);

  const load = useCallback(
    (sc: Scenario, message?: string) => {
      history.current = [];
      apply(sc);
      setSelection(null);
      setFitKey((k) => k + 1);
      setPlaying(false);
      if (message) notify(message);
    },
    [apply, notify],
  );

  const onEdit = useCallback(
    (sc: Scenario, opts?: { transient?: boolean; message?: string }) => {
      if (!opts?.transient) history.current.push(scenario);
      if (history.current.length > 100) history.current.shift();
      apply(sc);
      // Edits can strand traffic (an entry point extended into a through road, a road made one-way);
      // the editor removes or redirects those flows, and the user should know.
      // Only road edits do this; deleting a flow or picking "any exit" by hand is not worth a warning.
      const roadsEdited = sc.roads !== scenario.roads;
      const removed = roadsEdited ? scenario.flows.length - sc.flows.length : 0;
      const redirected = roadsEdited ? sc.flows.filter((f) => f.destination === null && scenario.flows.some((o) => o.id === f.id && o.destination !== null)).length : 0;
      const note = [removed > 0 && `${removed} flow(s) removed: their entry point is gone`, redirected > 0 && `${redirected} flow(s) now go to any exit`].filter(Boolean).join(' · ');
      if (note) notify(`${opts?.message ? `${opts.message} · ` : ''}${note}`, 'error');
      else if (opts?.message) notify(opts.message + (sim.t > 0 ? ' · simulation restarted' : ''));
    },
    [apply, notify, scenario, sim.t],
  );
  const onBeginEdit = useCallback(() => {
    history.current.push(scenario);
  }, [scenario]);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) {
      apply(prev);
      notify('Undone');
    }
  }, [apply, notify]);

  // Load a shared scenario from ?s=<id>
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('s');
    if (id)
      loadScenario(id)
        .then((sc) => load(sc, `Loaded shared scenario “${sc.name}”`))
        .catch((e) => notify(`Could not load shared scenario: ${e.message}`, 'error'));
  }, [load, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t && view === 'simulate') setTool(t.id);
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        onEdit(selection.kind === 'road' ? removeRoad(scenario, selection.id) : removeNode(scenario, selection.id), { message: `Deleted ${selection.kind}` });
        setSelection(null);
      }
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, view, selection, onEdit, scenario]);

  const labelMap = useMemo(() => endpointLabels(scenario), [scenario]);
  const onFrame = useCallback(() => setTick((k) => k + 1), []);

  const reset = () => {
    setSim(new Simulation(scenario));
  };

  const share = async () => {
    try {
      const meta = await saveScenario(scenario);
      const url = `${location.origin}/?s=${meta.id}`;
      history.current = [...history.current];
      window.history.replaceState(null, '', `/?s=${meta.id}`);
      try {
        await navigator.clipboard.writeText(url);
        notify('Saved. Share link copied to clipboard.');
      } catch {
        notify(`Saved: ${url}`);
      }
    } catch (e) {
      notify(`Save failed: ${(e as Error).message}`, 'error');
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${scenario.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'scenario'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file: File) => {
    try {
      load(parseScenario(JSON.parse(await file.text())), `Imported “${file.name}”`);
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`, 'error');
    }
  };

  const openMenu = () => {
    setMenu((m) => !m);
    listScenarios()
      .then(setSaved)
      .catch(() => setSaved([]));
  };

  const s = sim.samples[sim.samples.length - 1];
  const liveSpeed = sim.vehicles.length ? sim.vehicles.reduce((a, v) => a + v.v, 0) / sim.vehicles.length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden>
            <rect x="9" y="2" width="14" height="28" rx="4" />
            <circle cx="16" cy="9" r="3" className="l-red" />
            <circle cx="16" cy="16" r="3" className="l-amber" />
            <circle cx="16" cy="23" r="3" className="l-green" />
          </svg>
          <div>
            <b>Traffic Lab</b>
            <span>agent-based urban traffic simulator</span>
          </div>
        </div>
        <nav className="views" aria-label="View">
          <button type="button" className={view === 'simulate' ? 'on' : ''} onClick={() => setView('simulate')}>
            Simulate
          </button>
          <button type="button" className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>
            Compare scenarios
          </button>
        </nav>
        <div className="scenario-menu">
          <button type="button" className="scenario-btn" onClick={openMenu} aria-expanded={menu}>
            <span className="eyebrow">Scenario</span>
            <span className="scenario-name">{scenario.name}</span>
            <span aria-hidden>▾</span>
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <div className="menu-title">Presets</div>
              {PRESETS.map((p) => {
                const sc = p.build();
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => {
                      load(sc, `Loaded “${sc.name}”`);
                      setView('simulate');
                      setMenu(false);
                    }}
                  >
                    <b>{sc.name}</b>
                    <small>{sc.description}</small>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  load(emptyScenario('My network'), 'Blank canvas. Press R to draw roads.');
                  setTool('road');
                  setView('simulate');
                  setMenu(false);
                }}
              >
                <b>Blank canvas</b>
                <small>Start from nothing and draw your own network.</small>
              </button>
              {saved.length > 0 && <div className="menu-title">Recently saved</div>}
              {saved.slice(0, 8).map((m) => (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => {
                    loadScenario(m.id)
                      .then((sc) => load(sc, `Loaded “${sc.name}”`))
                      .catch((e) => notify(e.message, 'error'));
                    setMenu(false);
                  }}
                >
                  <b>{m.name}</b>
                  <small>
                    {new Date(m.createdAt).toLocaleString()} · {m.id}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" onClick={share} title="Save to the server and copy a share link">
            Save &amp; share
          </button>
          <button type="button" onClick={exportJson} title="Download scenario JSON">
            Export
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} title="Load scenario JSON">
            Import
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        </div>
      </header>

      {view === 'compare' ? (
        <main className="compare-main">
          <Compare
            current={scenario}
            onOpen={(sc) => {
              load(sc, `Opened “${sc.name}”`);
              setView('simulate');
            }}
          />
        </main>
      ) : (
        <main className="workspace">
          <aside className="toolrail" aria-label="Editing tools">
            {TOOLS.map((t) => (
              <button type="button" key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d={t.icon} />
                </svg>
                <span>{t.label}</span>
                <kbd>{t.key}</kbd>
              </button>
            ))}
            {(tool === 'road' || tool === 'flyover') && (
              <div className="template">
                <span className="eyebrow">New road</span>
                <label>
                  Lanes each way
                  <Stepper label="lanes" value={template.lanesFwd} min={1} max={4} onChange={(v) => setTemplate({ ...template, lanesFwd: v, lanesBwd: template.lanesBwd ? v : 0 })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={template.lanesBwd === 0} onChange={(e) => setTemplate({ ...template, lanesBwd: e.target.checked ? 0 : template.lanesFwd })} />
                  One-way
                </label>
                <label>
                  Speed
                  <select value={Math.round(kmh(template.speedLimit))} onChange={(e) => setTemplate({ ...template, speedLimit: Number(e.target.value) / 3.6 })}>
                    {[30, 40, 50, 60, 80].map((v) => (
                      <option key={v} value={v}>
                        {v} km/h
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </aside>

          <div className="stage">
            <MapView
              sim={sim}
              scenario={scenario}
              fitKey={fitKey}
              tool={tool}
              template={template}
              selection={selection}
              playing={playing}
              speed={speed}
              congestion={congestion}
              labels={labels}
              endpointLabels={labelMap}
              onSelect={(sel) => {
                setSelection(sel);
                if (sel) setTab('inspect');
              }}
              onEdit={onEdit}
              onBeginEdit={onBeginEdit}
              onError={(m) => notify(m, 'error')}
              onFrame={onFrame}
            />
            <div className="hud">
              <div className="hud-item">
                <span>Sim time</span>
                <b className="mono">{clock(sim.t)}</b>
              </div>
              <div className="hud-item">
                <span>Vehicles</span>
                <b className="mono">{sim.vehicles.length}</b>
              </div>
              <div className="hud-item">
                <span>Mean speed</span>
                <b className="mono">{fmt(kmh(liveSpeed))} km/h</b>
              </div>
              <div className="hud-item">
                <span>Queues</span>
                <b className="mono">{fmt(s?.queueLength ?? 0)} m</b>
              </div>
            </div>
            <div className="legend">
              <label className="check">
                <input type="checkbox" checked={congestion} onChange={(e) => setCongestion(e.target.checked)} /> Congestion
              </label>
              <label className="check">
                <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Labels
              </label>
              <span className="legend-scale">
                <i className="g" />
                free
                <i className="a" />
                slow
                <i className="r" />
                jammed
              </span>
            </div>
            <div className="transport" role="toolbar" aria-label="Simulation controls">
              <button type="button" className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : sim.t > 0 ? 'Resume' : 'Play'}>
                {playing ? (
                  <svg viewBox="0 0 24 24">
                    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24">
                    <path d="M7 4l13 8-13 8z" />
                  </svg>
                )}
                <span>{playing ? 'Pause' : sim.t > 0 ? 'Resume' : 'Play'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  for (let i = 0; i < 10; i++) sim.step();
                  setTick((k) => k + 1);
                }}
                disabled={playing}
                title="Advance one simulated second"
              >
                +1 s
              </button>
              <button type="button" onClick={reset} title="Reset to t = 0">
                Reset
              </button>
              <div className="speeds" role="radiogroup" aria-label="Simulation speed">
                {SPEEDS.map((v) => (
                  <button type="button" key={v} role="radio" aria-checked={speed === v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>
                    {v}×
                  </button>
                ))}
              </div>
            </div>
            {toast && <div className={`toast ${toast.tone ?? ''}`}>{toast.text}</div>}
          </div>

          <aside className="panel">
            <nav className="tabs">
              {(['analytics', 'inspect', 'traffic'] as Tab[]).map((t) => (
                <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'inspect' ? (selection ? `Inspect ${selection.kind}` : 'Network') : t === 'traffic' ? 'Traffic' : 'Analytics'}
                </button>
              ))}
            </nav>
            <div className="panel-body">
              {tab === 'analytics' && <Analytics sim={sim} />}
              {tab === 'inspect' && (
                <Inspector
                  sim={sim}
                  scenario={scenario}
                  selection={selection}
                  labels={labelMap}
                  onEdit={onEdit}
                  onSelect={setSelection}
                  onAddFlow={(origin) => {
                    onEdit({ ...scenario, flows: [...scenario.flows, newFlow(scenario, origin)] }, { message: 'Flow added' });
                    setTab('traffic');
                  }}
                />
              )}
              {tab === 'traffic' && <TrafficPanel sim={sim} scenario={scenario} labels={labelMap} onEdit={onEdit} />}
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
