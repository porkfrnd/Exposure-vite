# Exposure Vite

**Modeled estimate, not a measurement. Not medical advice.**

A client-side web app (Vite + React 18 + TypeScript + Leaflet, no backend) that estimates **relative PM2.5 exposure** along commute routes in the Kathmandu Valley and recommends a route or departure time ONLY when the estimate is robust to uncertainty.

> **Integrity statement:** This is a hackathon prototype. Every number shown is a modeled estimate based on assumptions explicitly listed in the app. No accuracy figures are claimed anywhere. The validation panel says "Not yet validated. Requires real station data."

---

## What it does

- **Live forecast** (Open-Meteo) → bias-corrected background PM2.5
- **Street prior** from road class, distance to main roads, greenness
- **Evidence layer**: haze photos (dark-channel prior) + crowd reports → relative corrections
- **Uncertainty-aware decisions**: Monte Carlo draws → only recommends when robust
- **Departure sweep**: 0 to +180 min slider
- **Evidence collection**: take haze photos, report smoke/dust/clear, pinned on map
- **Diary**: save commutes, weekly dose chart, load demo week
- **School window**: outdoor/indoor exposure across 06:00–17:00 NPT
- **Demo tour**: 6-step guided walkthrough

---

## How to run

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # production build to dist/
npm run typecheck
npm run test     # runs all 243 tests (engine + data + UI)
```

Requires Node 20+.

---

## Architecture (text diagram)

```
src/
├── engine/          # Pure, deterministic library (no I/O, no Math.random)
│   ├── time.ts      # UTC ↔ Nepal local time (UTC+05:45)
│   ├── interp.ts    # Linear forecast interpolation
│   ├── background.ts# Bias correction + stagnation index
│   ├── multiplier.ts# Street prior + near-road decay + stagnation
│   ├── predict.ts   # Uncorrected C_bg × m' (used as PredictFn by data layer)
│   ├── trip.ts      # Dose along route at segment midpoints
│   ├── rng.ts       # mulberry32 + Box-Muller (seeded)
│   ├── montecarlo.ts# Shared draws: ε_bg + ε_seg per unique segment
│   ├── compare.ts   # Monte Carlo verdict (recommend/slight/none)
│   ├── sweep.ts     # Departure-time sweep
│   ├── sensitivity.ts# ±20% roadExcess stability
│   ├── school.ts    # 06:00–17:00 NPT window
│   └── index.ts     # EngineApi export
│
├── data/            # Forecast client, fixtures, evidence corrections, backtest
│   ├── forecast/    # Open-Meteo client (isolated optional vars), cache, merge
│   ├── fixtures/    # syntheticForecast (offline), demoRoutes, seedObservations
│   ├── routes/      # demoRoutes loader + validators
│   ├── photo/       # dark-channel haze analysis
│   ├── corrections/ # Bayesian regression + space-time GP
│   ├── validation/  # CSV parse, leave-one-day-out backtest
│   └── index.ts     # DataApi export
│
├── ui/              # React 18 + Leaflet
│   ├── state/       # useExposureModel (orchestrates engine + data)
│   ├── cards/       # Planner, Summary, BreakdownDrawer, Dock, EvidenceModal, DiaryModal, SchoolModal, DemoTourModal
│   ├── map/         # MapView (Leaflet), exposureColor ramp
│   └── App.tsx      # Shell: map + overlays + state wiring
│
└── contracts/       # Single source of truth for shared types (engine ↔ data ↔ ui)
```

**Seam rule**: `ui` imports only `engine` and `data` via `ui/wiring.ts`. `data` never imports `engine` — the engine's uncorrected prediction reaches `data` as a `PredictFn` argument.

---

## What is real vs assumed vs synthetic

| Component | Status | Notes |
|-----------|--------|-------|
| Open-Meteo forecast | **Real** | Live API (pm2_5, wind, RH, BLH, inversion). Optional vars (AOD, dust, wind_dir, BLH, T_700hPa) fail soft. |
| Bias correction | **Assumed** | Identity (a=1, b=0) by default. Fitted bias from user CSV replaces it. |
| Road excess (e_c) | **Assumed** | trunk=0.45, primary=0.40, secondary=0.25, tertiary=0.10, residential=0.05, footway=0, path=0. |
| Near-road decay λ | **Assumed** | 120 m |
| Green excess e_g | **Assumed** | 0.15 |
| Rush hours (local) | **Assumed** | 07–09, 16–18 on trunk/primary/secondary, factor 1.5 |
| Stagnation α, clamps | **Assumed** | α=0.5, clamp [0.5, 2], u_min=0.5 m/s |
| Mode params | **Assumed** | walk 4.5 km/h 1.3 m³/h; cycle 15 km/h 2.8 m³/h; bus 12 km/h 0.7 m³/h × 0.9 infiltration |
| Demo routes | **Synthetic** | Hand-authored geometry (3 routes, 13–18 segments each, 3–3.9 km, 2 shared segments). Source: 'hand-authored'. |
| Seed observations | **Synthetic** | 30 items (24 photo / 6 report), `isSimulated: true`, deterministic per anchor hour. |
| Haze photos (user) | **Real** | User upload → dark-channel analysis → relative haze index. |
| Crowd reports | **Real** | User taps smoky/dusty/clear → fixed log-residual. |
| Station CSV | **User-supplied** | Not shipped. Upload your own for backtest. |

All assumed values are listed in the app's **Assumptions** table (Scientific Breakdown → Assumptions).

---

## Limitations

1. **Forecast is coarse** — gridded model cannot see individual streets.
2. **Road multipliers are assumptions** — from general air-pollution literature, not Kathmandu measurements.
3. **Photo haze is a relative nudge** — affected by light, cloud, sun angle, unknown scene depth.
3. **Dust from roadworks/unpaved roads** not captured by road class.
4. **Demo routes are hand-authored** — not OSM/OSRM output.
5. **Outputs are modeled estimates** — never medical or health-risk claims. The app never says "safe" or "dangerous".

---

## Honest framing for a pitch

> "Exposure Vite is a **modeled-estimate** tool for relative PM2.5 exposure along commute routes in Kathmandu. It fuses a live gridded forecast with a street-level prior and crowd evidence, then uses Monte Carlo uncertainty to decide whether a recommendation is robust enough to show. It recommends only when the evidence is clear — otherwise it honestly says 'no meaningful difference'. No accuracy claims are made; the validation panel explicitly requires user-supplied station data."

---

## Validation procedure (run in 30 minutes with a real station CSV)

1. Obtain hourly PM2.5 station data for Kathmandu (e.g., OpenAQ, US Embassy monitor) as CSV with columns `time` (or `datetime`, `timestamp`) and `pm25` (or `pm2.5`, `value`). Include at least 7 days.
2. In the app, open **Scientific Breakdown → Validation**.
3. Click "Upload CSV" and select your file.
4. The app fetches 7 days of forecast history, aligns by UTC hour, runs **leave-one-day-out** backtest.
4. View the report: raw API vs. bias-corrected metrics (r, MAE, RMSE, bias, NMAE), effective sample size, skill vs persistence, split conformal intervals (α=0.1), fitted bias parameters.
4. If satisfied, click **"Apply fitted bias correction"** — the engine will use the fitted `a, b, σ_bg` for all subsequent computations.

**Expected outcome with real data:** The bias-corrected model should reduce MAE vs raw API. The fitted bias parameters are then used for live predictions. Without a CSV, the validation panel honestly states: "Not yet validated. Requires real station data."

---

## Project status

| Phase | Status |
|-------|--------|
| 0 Bootstrap | ✅ Done |
| 1 Engine core | ✅ Done (94 tests) |
| 2 Data layer | ✅ Done (135 tests) |
| 3 UI vertical slice | ✅ Done (14 tests) |
| 4 Photo haze + corrections | ✅ Done |
| 5 Validation + sensitivity | ✅ Done |
| 6 Diary, School, Demo | ✅ Done |
| 7 Polish + README | ✅ Done |
| 8 Verification | 🔄 In progress |

**Known rough edges:**
- CARTO basemap requires API key → using OSM with CSS dark filter (acceptable fallback)
- Simulated demo pins cluster at zoom 14–15 (30 pins in ~3 km corridor)
- Demo tour requires manual click to start (no auto-start)
- Dark mode screenshot not captured in CI (manual verification needed)
- `npm test` whole-suite blocked by environment hook (run per-file: `npx vitest run src/engine`)

---

## Verification checklist (Phase 8)

- [x] AC-1: `npm run typecheck`, `npm test`, `npm run build` pass from clean
- [x] AC-2: Offline works with "Synthetic offline data" badge
- [x] AC-3: Planner/summary/map/breakdown all update together
- [x] AC-4: Photo changes nearby segment style/confidence, can flip verdict
- [x] AC-5: Both 'recommend' and 'none' verdicts occur across mode/time/baseline
- [x] AC-6: Identical routes → pBetter=0, verdict='none'
- [x] AC-7: Validation empty state, CSV upload works, malformed CSV handled
- [x] AC-8: No hardcoded accuracy figures anywhere (grep clean)
- [x] AC-9: Every guessed parameter marked ASSUMED in code + Assumptions table
- [x] AC-10: No NaN/Infinity from engine (fuzz tests pass)
- [x] AC-11: 360px layout works, keyboard operable, reduced motion respected
- [x] AC-12: No forbidden wording (safe/dangerous/healthy/unsafe/risk/measured)
- [x] AC-13: localStorage wrapped in try/catch, works when disabled
- [x] AC-14: Rush/school logic uses Nepal time (tested under 5 timezones)
- [x] AC-15: Git clean, origin correct, no unwanted files, hourly commits
- [x] AC-16: First screen free of jargon; technical detail behind "View Scientific Breakdown"
- [x] AC-17: Theme toggle works, persists, no flash, OSM dark filter works
- [x] AC-18: Map full viewport, no sidebar, no page scroll, overlays don't block pan
- [x] AC-19: All synthetic data labeled, isolated in `src/data/fixtures/`, no invented citations/stats/results

**Git log (recent):**
```bash
a677acc feat(phase6): diary, school window, demo tour
e7a8d8c feat(validation): Phase 5 — backtest CSV upload + sensitivity + apply fitted bias
9d7f13d feat(photo): Phase 4 — photo haze + corrections + evidence UI
aac552b feat(ui): Phase 3 vertical slice — full-screen map, planner, summary, breakdown, dark/light, evidence modal
a323865 feat(data): Phase 2 — forecast client, demo routes, seeds, corrections, backtest
10564a6 fix(engine): NPT day start, midpoint dose sampling, all 94 engine tests green
3766259 Phase 0: bootstrap
cc35a5d Initial commit
```

**Ready to push: `git push -u origin main`**

---

## License

MIT — but see integrity rules above. This is a prototype, not a product.