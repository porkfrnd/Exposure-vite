# Exposure Vite

**Relative PM2.5 exposure for real commute routes in the Kathmandu Valley.**

Search two real places. We route along actual OpenStreetMap streets, then tell you which
route has lower **modeled** exposure — and say "effectively tied" when the difference
is not real.

> Modeled estimate, not a measurement. Not medical advice.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run typecheck  # strict TypeScript
npm test           # vitest
npm run build      # production build
```

No API keys, no backend, no accounts. Requires network access for live data; degrades
honestly when offline.

---

## Where the data comes from

Everything on screen traces to one of these. Nothing is invented.

| What | Source | Keyless? |
|---|---|---|
| Place search | **Photon** (Komoot), biased to Kathmandu Valley | yes, CORS `*` |
| Route geometry + travel times | **FOSSGIS OSRM** — real `foot` / `bike` / `car` profiles | yes, CORS `*` |
| Road class, lane counts | **Valhalla** `/route` → `/trace_attributes` (OSM) | yes, CORS `*` |
| PM2.5, PM10, AQI, dust, aerosol depth | **Open-Meteo** air-quality | yes, CORS `*` |
| Wind, humidity, boundary layer, inversion | **Open-Meteo** forecast | yes, CORS `*` |
| Basemap tiles | OpenStreetMap | yes |

Two decisions worth knowing about:

- **`domains=cams_global` is not set here.** The sibling Exposure-Diary project needed it
  because that server would otherwise serve the CAMS *Europe* model. This client requests
  Kathmandu coordinates directly and was verified live, so no override is applied.
- **Nominatim is deliberately not used.** Its policy forbids client-side type-ahead, which is
  exactly what the search box does. Photon has no such restriction.

### What is *not* real

- **Traffic.** There is no keyless, no-signup traffic API for Nepal (Mapbox, HERE, TomTom and
  Google all require keys; open feeds are US/Canada city systems). Rather than show a
  plausible-looking fiction, traffic was removed. The app compares exposure and travel time.
- **Street-level concentration.** The gridded forecast cannot see individual streets. Route
  values are *relative estimates* built on assumed road-type multipliers.
- **Signals, bus stops, greenery, building density.** No keyless source exists, so these are
  held at neutral assumptions and do not differentiate routes. Stated in the Method panel.
- **Road multipliers.** Literature-informed assumptions, not Kathmandu measurements.

When a live call fails, the app shows an **honest error with a retry** — it never falls back to
fabricated routes or invented evidence pins. There are no seeded demo routes and no simulated
observation pins in the shipping build.

---

## How it works

```
src/engine/     pure, deterministic scientific core (no I/O, no Date.now, no Math.random)
src/data/       forecast, routing, geocoding, photo analysis, corrections, backtest
src/ui/         React UI; src/ui/wiring.ts is the only file importing engine/data
```

A frozen contract (`src/contracts/index.ts`) separates the three layers. Monte Carlo uses a
seeded PRNG, so every comparison is reproducible.

The model, in brief:

1. **Background.** A live hourly gridded forecast sets *when* pollution is worse across the
   valley. It sets the level; it cannot see streets.
2. **Street prior.** Real OSM road class plus measured distance to the nearest other main
   road produce a multiplicative prior around 1.
3. **Evidence.** Haze photos and crowd reports nudge nearby segments up or down *relative to
   each other*. They never change the regional level.
4. **Uncertainty decides.** Monte Carlo draws perturb the background once per comparison and
   each segment separately. A recommendation appears only when the same route wins clearly and
   repeatedly — otherwise the app says the options are effectively tied.

Every parameter is an explicit, labelled assumption. Nothing has been calibrated against field
measurements, and the app claims no accuracy figures.

---

## Validation

There is no accuracy number anywhere in this app, because none has been measured here. The
validation panel says *"Not yet validated. Requires real station data."*

To validate it yourself, download about a week of hourly PM2.5 for Kathmandu (OpenAQ or an
embassy monitor) as CSV with `time` and `pm25` columns, then open **Scientific Breakdown →
Validation** and upload it. The app fetches matching forecast history, aligns by UTC hour and
runs a **leave-one-day-out** backtest, reporting Pearson r, MAE, RMSE, bias and NMAE before and
after bias correction, plus effective sample size, skill versus persistence and split-conformal
coverage. You can then apply the fitted bias correction to the live model.

---

## Honest framing for a pitch

> Exposure Vite is a **modeled-estimate** tool for relative PM2.5 exposure along real commute
> routes in Kathmandu. It fuses a live gridded forecast with real OpenStreetMap road data and
> user-contributed evidence, then uses Monte Carlo uncertainty to decide whether a
> recommendation is robust enough to show. It recommends only when the evidence is clear —
> otherwise it honestly says the options are effectively tied.

---

## Limitations

- The forecast is a coarse gridded model; it cannot see individual streets.
- Road multipliers are assumptions from general air-pollution literature, not Kathmandu
  measurements.
- Photo haze is a relative index affected by light, cloud, sun angle and unknown scene depth.
- Dust from roadworks and unpaved roads is not captured by road class.
- Traffic is not modelled at all (no keyless data source for Nepal).
- Outputs are modeled exposure estimates, never medical or health-risk claims. The app never
  calls a route or an hour "safe" or "dangerous".

## License

MIT — but see the integrity notes above. This is a prototype, not a product.