# Traffic Lab: an agent-based urban traffic simulator

Traffic Lab is a 2D top-down traffic simulator. You draw a road network, add traffic and signals, run an agent-based simulation, watch every vehicle move, and compare designs. A typical comparison is the same junction before and after adding a flyover.

Built for Project 2 of the QUEST Lab (IISc) Full Stack AI pre-doctoral application.

## What it does

| Area | Features |
| --- | --- |
| **Road editor** | Draw roads (1–5 lanes each way, one-way or two-way, lane width, speed limit). Crossing a ground road creates a 4-way junction automatically; ending a road on another creates a T-junction. Flyovers are drawn in one gesture: up-ramp, elevated deck, down-ramp. Other tools: drag nodes, delete, undo. |
| **Signals** | Add a signal to any junction. Default phases pair opposing approaches. Each phase has its own green time, and the signal has yellow, all-red and an offset (so neighbouring signals can form a green wave). The signal state shows live on the stop lines. |
| **Traffic** | Flows from any entry point to a specific exit or to "any exit". Arrivals are Poisson with a set rate (veh/h). Each flow has a car / two-wheeler / bus / truck mix, a desired-speed factor, a start time and a vehicle cap. |
| **Engine** | Each vehicle is an independent agent with position, velocity, acceleration and route. Car-following uses IDM; lane changes use MOBIL. Junction access is checked for conflicts. Vehicles obey signals, and routes are found by Dijkstra (optionally congestion-aware). |
| **Visualisation** | Canvas rendering with pan and zoom. Play, pause, resume, step, reset, and speeds from 0.5× to 32×. Congestion heat overlay, brake lights, and decks with a cast shadow. Clicking a road or junction shows its live speed, density and queues. |
| **Analytics** | Average speed, travel time, delay, throughput, queue lengths, density and time stopped, with time-series charts and a list of the most congested links. |
| **Comparison** | Runs two scenarios headless in a Web Worker over N seeds (common random numbers). Reports mean ± SD per metric, Δ%, and overlaid time series. |
| **Backend** | Cloudflare Worker with KV storage for saving and sharing scenarios (`?s=<id>` links), plus a headless `/api/simulate` endpoint that uses the same engine. |

## Architecture

```
src/engine/   Pure TypeScript simulation engine: no DOM, no timers, deterministic
  types.ts       Serializable Scenario model (network + signals + demand + seed)
  network.ts     Compiles a scenario into edges, lanes, junction connectors and conflict sets
  editor.ts      Pure editing operations (auto-junctions, flyovers, splits, deletes)
  simulation.ts  Agent loop: spawning, IDM, junction control, MOBIL, metrics
  vehicles.ts    Per-type IDM parameters (car, bus, two-wheeler, truck)
  signals.ts     Fixed-time signal plans and automatic phase grouping
  routing.ts     Dijkstra over directed edges; reachability
  schema.ts      Validation of untrusted scenario JSON (imports and API)
  presets.ts     Reproducible test and demo scenarios
src/web/      React UI. Reads engine state and renders it; never moves vehicles itself
src/worker/   Cloudflare Worker API (KV storage + headless simulation)
tests/        Vitest suites for the engine and the API
```

The engine advances in fixed 0.1 s steps. The browser decides only how many steps to run per animation frame (the speed multiplier), then draws vehicle poses the engine computed. No motion is interpolated or animated in the frontend. The same `runScenario()` function powers tests, the comparison worker and the server API.

## Simulation model

* **Network compilation.** Each road direction becomes an *edge* with one *lane* per lane count. Lanes are offset from the centre line on the driving side (left-hand traffic by default, configurable). Lanes stop short of junctions by a setback that depends on road widths and approach angles. Each junction gets *connectors*: Bézier movements from incoming to outgoing lanes, with U-turns excluded. Lane-use rules: kerb-side turns leave from the outer lane, far-side turns from the inner lane, and through movements from every lane.
* **Conflicts.** Two movements conflict if they merge into the same lane or their swept paths come within 2 m of each other. Movements that only share an origin lane don't conflict; their vehicles simply follow each other.
* **Flyovers.** Nodes have a level (ground or elevated), and roads connect only at shared nodes. The editor splits only roads on the same level. A deck that crosses a ground road geometrically therefore has no connector with it, no conflict, and no false intersection. Ramps raise the drawn elevation gradually.
* **Car following.** The Intelligent Driver Model (Treiber, Hennecke & Helbing, 2000). The leader is found along the vehicle's own path across segment boundaries. Red lights, ungranted junctions and wrong-lane lane ends act as virtual stopped obstacles. Vehicles slow for tight turns, with speed limited by lateral acceleration.
* **Junction control.** Vehicles near a stop line request their movement. Requests are served first come, first served, subject to:
  * the signal (red never requests; on yellow, a vehicle goes only if it cannot stop comfortably);
  * no conflict with movements already granted or occupied;
  * room on the exit lane, so vehicles don't block the box.

  A blocked earlier request reserves its movement, which prevents starvation. The same mechanism makes unsignalised junctions behave as priority-free "first come" intersections.
* **Lane changes.** MOBIL (Kesting, Treiber & Helbing, 2007) with a politeness factor and safe-braking checks. Mandatory changes steer vehicles into a lane that serves their next movement. A vehicle that still misses its lane re-routes from where it is.
* **Demand and routing.** Arrivals are seeded Poisson. Each driver's desired speed comes from the vehicle type, the flow factor and a personal N(1, 0.08) multiplier. Routes are the shortest free-flow time, or, with congestion-aware routing, use an exponentially smoothed estimate of observed travel time on each edge.
* **Determinism.** All randomness goes through one seeded PRNG (mulberry32), and agents update in a fixed order. The same scenario and seed give bit-identical results; a test checks this.

## Metrics

| Metric | Definition |
| --- | --- |
| Travel time | Network entry → exit, averaged over completed trips |
| Delay | Travel time minus free-flow time at the driver's desired speed |
| Trip speed | Total distance ÷ total travel time over completed trips |
| Throughput | Completed trips per hour (overall); also a rolling 60 s rate |
| Queue length | Per approach lane: the stopped (< 2 m/s) platoon contiguous with the stop line, in metres |
| Density | Vehicles per km per lane, per link and network-wide |
| Time stopped | Share of vehicle-time spent below 0.5 m/s |

## Validation

`npm test` runs 55 tests covering:

* **Vehicle movement:** IDM fixed points; acceleration bounds; speed limits; trip time; follower stops behind a stopped leader at about the minimum gap.
* **Road connectivity:** lane counts and sides for left- and right-hand traffic; setbacks; turn-to-lane assignment; one-way streets; shortest path; reachability.
* **Intersections:** for every preset over 400 s, no two conflicting movements are occupied at once and no vehicle overlaps another; no starvation at an unsignalised T; no gridlock; all turn types are used.
* **Traffic signals:** phase sequencing and offsets; never two phases green at once; no vehicle admitted on red (only clearance during all-red); queue discharge.
* **Flyovers:** a ground crossing creates a junction, but a flyover does not, in either drawing order; ground traffic can't turn onto the deck; vehicles are seen at ground, ramp and deck elevations.
* **Metrics and reproducibility:** conservation (spawned = completed + active); the throughput, travel time and speed formulas; density; time-series sampling; same seed gives identical results; validator round-trip; API save, load and simulate.

All presets run with **zero safety interventions**: the hard non-overlap clamp never has to act, because IDM and junction control keep vehicles apart by themselves.

Example comparison (built into the Compare view): the same demand (2,100 veh/h on the arterial, 840 veh/h on the cross street), 15 minutes, 3 seeds:

| | At-grade signal | Flyover |
| --- | --- | --- |
| Average delay | 22.9 ± 1.8 s | 4.3 ± 0.3 s (−81%) |
| Average travel time | 80.3 s | 62.7 s (−22%) |
| Average trip speed | 33.5 km/h | 42.7 km/h (+27%) |
| Average total queue | 48.6 m | 0 m |

Throughput is essentially unchanged (+1%) because demand is below capacity in both designs; the flyover removes delay and queues rather than adding capacity.

## Running locally

```bash
npm install
npm run dev        # cf dev: Vite + the Worker API at http://localhost:5173
npm test           # engine + API tests
npm run build      # typecheck + production build
npm run deploy     # tests, then cf deploy (Cloudflare Workers + static assets + KV)
```

## API

```
GET  /api/health
POST /api/scenarios          body: Scenario JSON → { id, name, createdAt }
GET  /api/scenarios          recently saved scenarios
GET  /api/scenarios/:id      a saved scenario
POST /api/simulate           { scenario, duration ≤ 600, seed? } → { summary, samples, warnings }
```

## Limitations and next steps

* Signals are fixed-time. Actuated or adaptive control, such as max-pressure, would plug into `lightFor`.
* Roads are straight segments between nodes; draw a curve as a chain of segments.
* Two-wheelers follow lane discipline. Lane filtering, which is common in Indian traffic, is not modelled.
* There is one elevated level, so two decks crossing each other create a junction on the deck.
