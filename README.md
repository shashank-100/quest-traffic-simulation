# Traffic Lab

An agent-based urban traffic simulator. Draw a road network, add traffic and signals, watch every vehicle, and compare designs, such as a junction before and after a flyover.

Built for Project 2 of the QUEST Lab (IISc Bangalore) Full Stack AI pre-doctoral application.

**Live:** https://quest-traffic-simulation.shashank-telkhade.workers.dev

![Traffic Lab running the 3×3 city grid preset](docs/screenshot.jpg)

## Run it

Requires Node.js 22.18+.

```bash
git clone https://github.com/shashank-100/quest-traffic-simulation.git
cd quest-traffic-simulation
npm install
npm run dev        # app + API at http://localhost:5173
npm test           # 76 tests
npm run build      # typecheck + production build
```

**Deploy to Cloudflare:** run `npx cf auth login` once, then `npm run deploy`. That runs the tests and deploys one Worker serving the app, the API, and a KV store for saved scenarios; the KV store is created automatically.

## Use it

- **Presets:** open the *Scenario* menu (4-way signal, before/after flyover, T-junction, lane drop, 3×3 grid). Press **Play**; the speed buttons run 0.5×–32×.
- **Draw:**
  - `R` draws a road. Crossing a ground road creates a junction; ending on a road creates a T.
  - `F` draws a flyover. It ramps up, passes over other roads without meeting them, and ramps down.
  - `S` adds a signal to a junction.
  - `V` selects a road or junction to edit lanes, width and speed limit, or signal timings.
- **Traffic tab:** flows (origin, destination, veh/h, vehicle mix, speed factor), the seed, driving side, and routing.
- **Compare scenarios:** runs two scenarios over several seeds and shows mean ± SD, % change and charts.
- **Save & share:** stores the scenario on the server and copies a `?s=<id>` link. **Export** and **Import** handle JSON files.

## How it works

- **Engine (`src/engine`):** pure TypeScript with fixed 0.1 s steps and a seeded random generator, so the same seed always gives the same result. The UI only draws what the engine computes; the same engine powers the tests, the Compare view (in a Web Worker) and `POST /api/simulate`.
- **Vehicles:** each vehicle (car, two-wheeler, bus, truck) is an independent agent with position, speed, acceleration and route.
  - **Following:** the Intelligent Driver Model (IDM), with the improved free-road term (IIDM) when above desired speed.
  - **Lane changes:** MOBIL, plus mandatory changes into a lane that serves the next turn.
  - **Routing:** shortest path (Dijkstra), optionally based on observed travel times.
- **Lane geometry:**
  - **Count:** each lane is its own queue.
  - **Width:** follows Highway Capacity Manual (HCM) adjustments, applied to each vehicle's side clearance. Narrow lanes lower desired speed (−10% at 3.0 m) and lengthen the desired headway (factor 1 + (W − 3.6)/9).
- **Junctions:**
  - **Simple connections:** nodes with no signal and no crossing or merging movements, such as flyover deck joints and bends. Vehicles drive straight through.
  - **Intersections:** vehicles request their movement within a request zone and are served first come, first served. A request is refused if it crosses a movement already in use or would leave the vehicle stuck in the junction. Merging traffic uses gap acceptance.
  - **Signals:**
    - On yellow, a vehicle may enter only if it will reach the line before red.
    - On red, nobody enters, and any earlier permission is withdrawn.
- **Flyovers:** roads only meet at shared nodes on the same level, so a deck never creates a false intersection. Ramps climb 6 m, and the slope reduces how hard vehicles can accelerate.

## Results

**Lane count and width:** cars on a straight road, oversaturated, measured over 10 minutes.

| | 1 lane | 2 lanes | 3 lanes |
| --- | --- | --- | --- |
| Capacity (3.5 m lanes) | 1,644 veh/h | 3,288 veh/h | 4,932 veh/h |

| Lane width | 2.75 m | 3.0 m | 3.5 m | 4.0 m |
| --- | --- | --- | --- | --- |
| Capacity (1 lane) | 1,488 veh/h | 1,548 veh/h | 1,644 veh/h | 1,704 veh/h |
| Free-flow trip speed (mixed traffic) | 39.6 km/h | 42.2 km/h | 48.8 km/h | 53.1 km/h |

**Lane drop:** a 3→2 lane drop discharges 2,682 veh/h, about 80% of two free lanes, in line with the capacity drop seen at real merges.

**Before vs after a flyover.** Same demand (2,100 veh/h on the arterial, 840 veh/h on the cross street), 15 minutes, seeds 42–44:

| | At-grade signal | Flyover | Change |
| --- | --- | --- | --- |
| Average delay | 25.8 ± 4.4 s | 3.9 ± 0.4 s | −85% |
| Average travel time | 86.8 s | 64.6 s | −26% |
| Average trip speed | 31.1 km/h | 41.6 km/h | +34% |
| Average total queue | 60.5 m | 0 m | −100% |
| Steady-state throughput (300–900 s) | ≈ 2,940 veh/h | ≈ 2,940 veh/h | none: both carry the full demand |

Demand (2,940 veh/h) is below capacity in both designs, so the flyover doesn't add throughput; it removes delay and queues. Delay is measured against the same driver alone on the empty network, simulated with identical dynamics (slowing for turns, ramps, lane widths). A lone vehicle therefore has exactly zero delay on every route, so the flyover's remaining 3.9 s comes entirely from vehicles interacting.

**Safety and robustness:** every preset was run for 30 minutes on several seeds. In every run:
- no crossing movements were ever inside a junction together;
- no vehicles overlapped, and nobody entered on red;
- no gridlock;
- the emergency anti-overlap correction never fired.

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | status |
| `POST` | `/api/scenarios` | save a scenario → `{ id }` |
| `GET` | `/api/scenarios` | recently saved |
| `GET` | `/api/scenarios/:id` | load one |
| `POST` | `/api/simulate` | `{ scenario, duration ≤ 600, seed? }` → summary + time series |

## Limitations

- **Signals:** fixed-time only. Unsignalised junctions have no main-road priority.
- **Lane width at signals:** changes discharge by about 1%, against about 7% in the HCM.
- **Two-wheelers:** stay in lanes; filtering between lanes isn't modelled.
- **Elevation:** there is only one elevated level.
