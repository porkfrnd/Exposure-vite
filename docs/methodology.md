# Exposure Vite — Tiers & Mathematical Logic

**Goal:** For a commute in Kathmandu, estimate relative PM2.5 exposure per route and departure time, and recommend an option only when the data supports a clear difference.

**Core principle:** A model predicts, observations correct it, and uncertainty decides whether we speak. Every number shown is a *modeled estimate*, not a measurement.

> All parameter values below marked *(assumed)* are starting guesses. Replace them with values from sources you have actually read, and cite those on a slide.

---

## 0. Notation

| Symbol     | Meaning                                           |
| ---------- | ------------------------------------------------- |
| `t`        | clock time (hourly resolution)                    |
| `C_api(t)` | Open-Meteo modeled PM2.5 for the valley, µg/m³    |
| `C_bg(t)`  | bias-corrected background PM2.5                   |
| `s`        | a road segment (from OSM), length `L_s`           |
| `m_s(t)`   | street multiplier for segment `s`                 |
| `C_s(t)`   | estimated PM2.5 on segment `s`                    |
| `v_mode`   | breathing (ventilation) rate by travel mode, m³/h |
| `D`        | inhaled dose for a trip, µg                       |
| `E`        | exposure score shown to the user                  |

---

## Tier 1 — Core engine (must work by midday Day 1)

**What it does:** compares 2–3 routes and shows how exposure changes with departure time.

### 1.1 Background concentration (time + absolute scale)

Pull hourly data from Open-Meteo: `pm2_5`, plus `wind_speed_10m` and `boundary_layer_height` (verify the variables are available on your endpoint).

The API is a gridded atmospheric model, so the whole valley is roughly one or two cells. It gives us **when** pollution is bad, not **where**.

**Bias correction** (fit once on a manually downloaded week of station CSV):

```text
C_bg(t) = a · C_api(t) + b
```

Fit `a, b` by least squares on training days:

```text
a = Σ (C_api − mean_api)(C_obs − mean_obs) / Σ (C_api − mean_api)²
b = mean_obs − a · mean_api
```

If time is very short, use a single scale factor instead: `k = mean(C_obs) / mean(C_api)`, `C_bg = k · C_api`.

### 1.2 Street multiplier (spatial prior)

PM2.5 is mostly regional, so street differences are modest. We model them as multiplicative deviations around 1:

```text
m_s(t) = base(road_class) · rush(t, road_class)
```

| OSM class              | base *(assumed)* |
| ---------------------- | ---------------- |
| trunk / primary        | 1.4              |
| secondary              | 1.25             |
| tertiary / residential | 1.0              |
| footway / path / park  | 0.8              |

```text
rush(t, class) = 1.15   if class ∈ {trunk, primary, secondary} and hour ∈ [7,10] ∪ [16,19]
               = 1.0    otherwise
```

These multipliers are **assumptions** from the near-road pollution gradient idea (land-use-regression style). Cite real literature you have read. Do not present them as measured.

### 1.3 Stagnation amplification (valley trapping)

When the boundary layer is low and wind is weak, pollutants stay trapped and street differences matter more. Define a stagnation index:

```text
S(t) = clamp( (H_ref / H(t)) · (u_ref / max(u(t), u_min)),  0.5, 2.0 )
```

with `H` boundary-layer height, `u` wind speed, and reference values `H_ref, u_ref` set to the medians over your data window. `u_min` (e.g. 0.5 m/s) *(assumed)* prevents division blow-up.

Apply it to the *deviation* from 1, not to the whole multiplier:

```text
m'_s(t) = 1 + (m_s(t) − 1) · S(t)^α
```

So on a stagnant morning main roads look worse and parks look better; on a windy afternoon everything flattens toward 1.

### 1.4 Segment concentration

```text
C_s(t) = C_bg(t) · m'_s(t)
```

### 1.5 Dose along a route

Time on segment `s` depends on travel speed for the mode:

```text
τ_s = L_s / speed_mode          (hours)
```

Time advances as you travel, so each segment uses the forecast at the time you actually reach it:

```text
t_k = t_0 + Σ_{j<k} τ_j
```

Inhaled dose:

```text
D = Σ_k  C_{s_k}(t_k) · v_mode · τ_{s_k}        (µg)
```

| Mode          | speed km/h *(assumed)* |          v_mode m³/h *(assumed)* |
| ------------- | ---------------------: | -------------------------------: |
| walk          |                    4.5 |                              1.3 |
| cycle         |                     15 |                              2.8 |
| bus / vehicle |                     12 | 0.7 (× enclosure factor 0.8–1.0) |

This is why a cyclist on a main road can score worst: higher concentration **and** higher breathing rate.

### 1.6 What we display

Relative comparison is the headline, because it is far more robust than absolute values:

```text
ΔE = (D_A − D_B) / D_A          "Route B has about ΔE% lower exposure"
```

Optional normalizations (label as conventions, not medical thresholds):

* **% of reference daily dose:** `D / D_ref`, with `D_ref = 15 µg/m³ × 15 m³ ≈ 225 µg` (WHO 24-h PM2.5 guideline value times a rough daily air volume).
* **Cigarette equivalent:** common heuristic of roughly 22 µg/m³ over 24 h ≈ 1 cigarette. Present as a popularization aid only.

### 1.7 Depart-time slider

Recompute `D` for departure times `t_0 ∈ {now, +30, +60, ..., +180 min}` using forecast hours. Plot `D` against `t_0`. This is the visual hook.

---

## Tier 2 — Observations correct the model (Day 1 afternoon / Day 2 morning)

Build only if Tier 1 is solid. The model has assumed multipliers; photos and reports provide **evidence** that nudges them.

### 2.1 Haze index from a photo (dark channel prior)

Haze image model (from image-dehazing research):

```text
I(x) = J(x) · t(x) + A · (1 − t(x))
```

`I` = observed image, `J` = haze-free scene, `A` = atmospheric light, `t` = transmission.

Dark channel over a local patch `Ω(x)`:

```text
J_dark(x) = min_{y ∈ Ω(x)}  min_{c ∈ {R,G,B}}  J^c(y)   ≈ 0  for haze-free outdoor scenes
```

So the dark channel of the hazy image estimates haze:

```text
t(x) = 1 − ω · min_{y ∈ Ω(x)} min_c ( I^c(y) / A^c )          (ω ≈ 0.95)
```

`A` is taken from the brightest ~0.1% of pixels in the dark channel.

**Haze index:** mean of `(1 − t)` over non-sky pixels (exclude the sky or you measure clouds):

```text
H_photo = mean_{x ∈ non-sky} (1 − t(x))
```

`H_photo` is a *relative* index. Distance to objects is unknown for phone photos, so it cannot be converted to extinction directly.

### 2.2 Time-of-day normalization

Sun angle and sky brightness change the index. Normalize by hour using the median of your own photos for that hour band:

```text
H_norm = H_photo − median(H_photo | same hour band)
```

With few photos, use coarse bands (morning / midday / evening).

### 2.3 Calibration: haze → concentration

Haze extinction rises with particle mass, roughly monotonic. Fit a simple log-linear map using photos taken at times where `C_bg` is known:

```text
ln C_photo = γ0 + γ1 · H_norm
```

Fit `γ0, γ1` by least squares on your calibration photos. **Test it:** if `γ1` is not clearly nonzero (check the correlation and sample size), switch this layer off or reduce its weight. Report that honestly.

### 2.4 Residual

For a photo `i` at location `x_i`, time `t_i`, compare with what the model predicted there:

```text
ρ_i = ln C_photo,i − ln C_model(x_i, t_i)
```

`ρ_i > 0` means the street is hazier than predicted.

### 2.5 Spreading the correction (shrinkage kernel)

Each observation has reliability weight `w_i` (photo ≤ 0.3, crowd report ≈ 0.05 *(assumed)*). Spatial kernel and time decay:

```text
K(d)  = exp( −d² / (2ℓ²) )         ℓ ≈ 300 m (assumed)
T(Δt) = exp( −Δt / τ_decay )        τ_decay ≈ 2 h (assumed)
```

Data support at segment `s`:

```text
n_s = Σ_i  w_i · K(d_{s,i}) · T(Δt_i)
```

Shrunk correction:

```text
δ_s = ( Σ_i w_i · K · T · ρ_i ) / ( λ + n_s )
```

`λ` (e.g. 1.0) is a shrinkage constant. With **no nearby data, δ_s → 0** and the prior stands, so we never invent corrections out of nothing.

Corrected concentration:

```text
C_s(t) = C_bg(t) · m'_s(t) · exp(δ_s)
```

### 2.6 Crowd reports

"Smoky" or "dusty" taps use the same mechanism with a fixed small residual (`ρ = +ln 1.3`, `w = 0.05`, assumed). "Clear" gives a negative residual. Seed fake pins for the demo only if they are **labeled as simulated**.

---

## Tier 3 — Decisiveness, confidence, and polish (Day 2)

This tier is what makes the output *credible* rather than just pretty.

### 3.1 Confidence per segment

```text
c_s = n_s / (n_s + λ)          ∈ [0, 1)
```

* `c_s ≥ 0.5`: well-supported, draw solid.
* `c_s < 0.3`: "estimated only", draw hatched or faded.

More users means higher `c_s` everywhere. That is the Impact story: the map improves as people contribute.

### 3.2 Uncertainty on log-concentration

```text
σ_s² = σ_prior² · (1 − c_s) + σ_floor²
```

Starting values *(assumed)*: `σ_prior = 0.25` (about 25% uncertainty in the multiplier prior), `σ_floor = 0.10`. Also include background uncertainty `σ_bg` from your backtest residuals (Section 5).

### 3.3 Decisiveness: when do we recommend?

A recommendation should only appear when the difference is both large enough and robust to our uncertainty. Use Monte Carlo:

For `n = 200` draws:

1. Sample background error: `C_bg* = C_bg · exp(ε_bg)`, `ε_bg ~ N(0, σ_bg²)` (one draw per trip, shared by both routes, since regional error is common).
2. For each segment: `ε_s ~ N(0, σ_s²)`, `C_s* = C_s · exp(ε_s)`.
3. Recompute `D_A*`, `D_B*`.

Then:

```text
P(B better) = fraction of draws where D_B* < D_A*
ΔE_median   = median over draws of (D_A* − D_B*) / D_A*
```

**Decision rule:**

```text
if P(B better) ≥ 0.80  and  ΔE_median ≥ 10%   → "Take Route B (about ΔE% lower exposure)"
elif P(B better) ≥ 0.60                          → "Slight edge to Route B, low confidence"
else                                             → "No meaningful difference. Choose by convenience."
```

The thresholds (0.8, 10%) are design choices. State them on a slide. A tool that says "no real difference" when that is true looks more trustworthy than one that always picks a winner.

### 3.4 Sensitivity test (no external data needed)

Re-run the ranking with all base multipliers shifted by ±20% and report:

```text
Ranking stability = (route pairs with the same winner under all perturbations) / (total route pairs)
```

Example slide line: "Rankings held in X of Y route pairs under ±20% multiplier changes."

### 3.5 School go/no-go window

For outdoor activity (assembly, PE) at the school location `x_sch`:

```text
E_h = C_bg(h) · m'_sch(h)  · exp(δ_sch)       for each hour h
```

Recommend the contiguous window of hours where `E_h` is within 10% of the day's minimum, or below a threshold you choose and state (for example the 24-h WHO guideline of 15 µg/m³ for a simple traffic-light view).

### 3.6 Self-calibration chart

Every time a photo is taken near a station reading, store `(H_norm, ln C_obs)`. Refit `γ0, γ1` periodically and plot rolling MAE of the haze layer over time. Only show this chart if the error genuinely goes down.

---

## 4. Data model (minimal)

```text
Route      { id, mode, segments: [segment_id], departure_options }
Segment    { id, road_class, length_m, geometry }
Forecast   { hour, pm25_api, wind, bl_height }
Photo      { id, lat, lon, time, H_photo, H_norm, is_simulated }
Report     { id, lat, lon, time, type, is_simulated }
Computed   { segment_id, hour, C_s, c_s, sigma_s }
```

Keep an `is_simulated` flag on every demo seed item and show it in the UI.

---

## 5. Validation (the accuracy claim)

**Headline metric:** correlation and error of the bias-corrected background vs. real station readings on days the model was not fit on.

1. Manually export about 7 days of hourly Kathmandu station PM2.5 (OpenAQ or embassy monitor) as CSV.
2. Fit `a, b` on the first ~4 days (train).
3. Predict the remaining ~3 days (test) and compute:

```text
Pearson r = cov(C_bg, C_obs) / (σ_bg · σ_obs)
MAE       = mean |C_bg − C_obs|
Bias      = mean (C_bg − C_obs)
```

Report before and after bias correction. Use the test-day residual standard deviation as `σ_bg` in Section 3.3.

**Results (fill in from your actual run — do not pre-fill):**

| Metric              | Raw API | Bias-corrected |
| ------------------- | ------- | -------------- |
| Days (train / test) |         |                |
| Pearson r           |         |                |
| MAE (µg/m³)         |         |                |
| Mean bias (µg/m³)   |         |                |

### Optional photo-layer test

Hand-label n = 20–30 photos as clear / hazy / very hazy and report how often the haze index orders them correctly. Also report whether adding the photo layer lowered the error against the held-out station readings. If it did not, say so.

### Slide line template

"Backtested on N days of station data: r = X, MAE = Y µg/m³ on held-out days. Street-level values are relative estimates; we recommend routes only when they differ clearly and the result is stable under uncertainty."

---

## 6. Honest limitations (put these on a slide)

* API is gridded and coarse; it cannot see individual streets.
* Road multipliers are assumptions from the literature, not Kathmandu measurements.
* Photo haze is affected by light, cloud, and sun angle; it is a rough nudge.
* Dust from roadworks and unpaved roads is not captured by road class.
* Outputs are exposure estimates, not medical or health-risk claims.

---

## 7. Build order

| Tier | Contents                                                                                           | Done when                                                  |
| ---- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | API fetch, bias fix, OSM multipliers for 2–3 hardcoded routes, dose formula, depart-time slider    | Route comparison and slider work end to end (midday Day 1) |
| 2    | Photo haze index, calibration, residual spreading, crowd reports                                   | Pin lands on map and shifts nearby segment scores          |
| 3    | Confidence hatching, Monte Carlo decision rule, sensitivity test, school window, calibration chart | Recommendation text changes with confidence                |

If Tier 1 is not solid by midday Day 1, drop Tier 3. One flawless core flow beats five half-working features.

---

---

# EXTENDED TIERS (4–9): Higher-Fidelity Estimation

## Read this first (blunt caveat)

More layers do not automatically mean more accuracy. A layer helps only if it carries information the model doesn't already have **and** you have data to constrain it.

Your calibration data is small and heavily autocorrelated. With 7 days of hourly data (n = 168) and lag-1 autocorrelation ρ₁ ≈ 0.9, the effective sample size is roughly:

```text
ESS ≈ n · (1 − ρ₁) / (1 + ρ₁) = 168 · 0.1 / 1.9 ≈ 9
```

About nine independent data points. You cannot freely fit many parameters on that. So the extended tiers use **informative priors with Bayesian shrinkage** instead of free fitting, and every layer must earn its place through the ablation test in Tier 9. Anything that doesn't lower held-out error gets cut or moved to the roadmap slide.

Also: street-level accuracy cannot be truly validated without street-level reference measurements. You can validate the *regional/temporal* layer against stations, and show *internal consistency* and *decision robustness* for the street layers. Say exactly that.

---

## Tier 4 — Expanded data inventory

| #  | Variable                                                                                                               | Source                                                           | Why it matters                                                                                                                                        | Effort           | Verdict                         |
| -- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------- |
| 1  | Aerosol optical depth, dust                                                                                            | Open-Meteo air-quality API (`aerosol_optical_depth`, `dust`)     | Separates dust/regional haze from combustion; same call as PM2.5                                                                                      | Low              | Use                             |
| 2  | Relative humidity, temperature, precipitation                                                                          | Open-Meteo weather API                                           | Hygroscopic growth (photo layer), rain washout of PM                                                                                                  | Low              | Use                             |
| 3  | Wind speed and direction                                                                                               | Open-Meteo                                                       | Ventilation and transport                                                                                                                             | Low              | Use                             |
| 4  | Boundary-layer height; inversion strength `ΔT_inv = T_2m − T_upper`                                                    | Open-Meteo (`boundary_layer_height`; pressure-level temperature) | Valley trapping. The valley floor is ~1,300 m (~870 hPa), so 850 hPa is near ground level. Use 800 or 700 hPa as the upper level. Verify availability | Low              | Use                             |
| 5  | Diurnal profile `p(h) = mean(C_obs at hour h) / mean(C_obs)`                                                           | Your station CSV                                                 | Captures the local rush-hour and inversion cycle                                                                                                      | Low              | Use                             |
| 6  | Day type (Saturday is Nepal's weekly holiday; festival periods)                                                        | Calendar                                                         | Traffic regime and firecracker spikes                                                                                                                 | Low              | Use                             |
| 7  | OSM segment covariates: road class, intersection density, traffic signals, bus stops, green fraction, building density | OSM (precompute for demo routes)                                 | Spatial prior                                                                                                                                         | Medium           | Use                             |
| 8  | Extra stations                                                                                                         | OpenAQ / embassy CSV                                             | Enables leave-one-station-out                                                                                                                         | Low–Med          | Use if 2+ stations downloadable |
| 9  | Active fire detections (upwind, past 48 h)                                                                             | NASA FIRRS, manual CSV                                           | Smoke episodes (season-dependent)                                                                                                                     | Medium           | Only if your week had fires     |
| 10 | Satellite AOD (MODIS MAIAC, 1 km)                                                                                      | NASA Earthdata (login)                                           | Independent regional signal                                                                                                                           | High, cloud gaps | Roadmap                         |
| 11 | Sentinel-5P NO₂                                                                                                        | Copernicus                                                       | Traffic proxy, but ~5 km pixels carry no street information                                                                                           | Medium           | Skip                            |

Items 1–6 and 8 are cheap and genuinely informative. Items 9–11 are slide material, not build material.

---

## Tier 5 — Bayesian regression for segment multipliers

Replaces the fixed `base(road_class)` table from Tier 1.2 with a feature model whose prior *is* that table.

```text
ln m_s = x_sᵀ β
x_s = [ 1, road-class dummies, ln(1 + d_main), intersection density,
        1_signal, 1_busstop, green fraction, building density ]
```

**Prior:** `β ~ N(β₀, Λ⁻¹)`, with `β₀` set from your Tier 1 literature-informed multipliers (log scale) and `Λ = diag(1/τ_k²)`, `τ_k ≈ 0.15` *(assumed)*.

**Observations** (photos, reports): each gives `y_i = ln C_obs-proxy,i − ln C_bg(t_i)` with model `y_i = x_iᵀβ + ε_i`, `ε_i ~ N(0, σ_i²)`. Use `σ_photo ≈ 0.4`, `σ_report ≈ 0.7` *(assumed; photos are noisy)*.

**Posterior** (conjugate, closed form):

```text
Σ_β = ( Λ + Σ_i x_i x_iᵀ / σ_i² )⁻¹
β̂   = Σ_β ( Λ β₀ + Σ_i x_i y_i / σ_i² )
```

**Uncertainty on any segment's log-multiplier:**

```text
Var(ln m_s) = x_sᵀ Σ_β x_s
```

This replaces the hand-set `σ_prior` in Tier 3.2. With no observations, `β̂ = β₀` and you recover Tier 1 exactly. Each photo shifts the estimate in proportion to its precision `1/σ_i²`. Implementation: about 30 lines of linear algebra.

---

## Tier 6 — Space-time Gaussian process (regression kriging)

Handles the **local residual** left after Tier 5. This is the principled version of the Tier 2.5 shrinkage kernel.

```text
r(x,t) = ln C_obs-proxy − ln C_model(x,t)  ~  GP(0, k)

k((x,t),(x',t')) = σ_f² · M32(‖x − x'‖ / ℓ_s) · exp( −|t − t'| / ℓ_t )

M32(u) = (1 + √3 u) · exp(−√3 u)
```

Starting hyperparameters *(assumed)*: `σ_f = 0.2`, `ℓ_s = 300 m`, `ℓ_t = 2 h`.

**Posterior at a query point (x*, t*):**

```text
μ* = k*ᵀ (K + Σ_n)⁻¹ r
v* = k(x*,x*) − k*ᵀ (K + Σ_n)⁻¹ k*
```

`Σ_n = diag(σ_i²)` carries the per-source noise (photo, report). Corrected concentration:

```text
C_s(t) = C_bg(t) · m'_s(t) · exp(μ*)
```

**Confidence** (replaces Tier 3.1):

```text
c_s = 1 − v* / σ_f²          ∈ [0, 1]
```

**Hyperparameters:** with ≥ 30 observations, choose by maximizing the log marginal likelihood:

```text
ln p(r | θ) = −½ rᵀ (K + Σ_n)⁻¹ r − ½ ln |K + Σ_n| − (n/2) ln 2π
```

Cost is O(n³) via Cholesky, which is fine for n ≤ 200 in the browser. With fewer observations, keep the assumed values and say so.

---

## Tier 7 — Temporal state-space model and ensemble

### 7.1 Kalman filter for regional log-bias

State: `b_t = ln C_obs(t) − ln C_api(t)`, evolving as a random walk.

```text
State:        b_t = b_{t−1} + w,        w ~ N(0, q)
Observation:  y_t = b_t + θᵀ z_t + v,   v ~ N(0, r)       (when a reading exists)

Predict:   P⁻ = P + q
Gain:      K  = P⁻ / (P⁻ + r)
Update:    b  = b⁻ + K (y − b⁻),    P = (1 − K) P⁻
```

Corrected background: `C_bg(t) = C_api(t) · exp(b_t)`.

* With a weekly offline CSV, estimate `q` as the variance of hourly changes in `b`, and `r` from short-lag noise.
* Exogenous regressors `z_t` (humidity, rain flag, day type, `ΔT_inv`) are allowed, but given ESS ≈ 9, use **at most two**, ridge-regularized.
* If the demo can accept a manually entered "latest station reading", the filter runs live and the correction visibly updates.

### 7.2 Lead-time uncertainty

Forecast skill decays with lead time `h` (hours), so uncertainty widens for later departures:

```text
σ_bg(h)² = σ₀² + q·h + κ²·h²
```

`σ₀` from held-out residuals, `q` from 7.1, `κ` fitted if you have enough days, otherwise assumed small. Effect: a "+3 h" slider option has wider intervals, so the Tier 3.3 decision rule recommends it less often. That is correct behavior.

### 7.3 Ensemble of background predictors

Candidates `ŷ_k(t)`:

1. Raw API
2. Bias-corrected API (Tier 1.1)
3. Kalman-corrected API (7.1)
4. Persistence (latest observation held constant)
5. Diurnal climatology `p(h) · mean(C_obs)`

Weights by inverse held-out MSE (simple and stable at tiny n):

```text
w_k = (1 / MSE_k) / Σ_j (1 / MSE_j)
ŷ   = Σ_k w_k ŷ_k
```

Predictive variance by the law of total variance:

```text
Var(ŷ) = Σ_k w_k σ_k²   +   Σ_k w_k (ŷ_k − ŷ)²
         (within-model)     (between-model disagreement)
```

Persistence usually wins at 1–2 h lead; the API wins at longer leads. If you have enough data, fit weights per lead bucket.

---

## Tier 8 — Physical corrections

### 8.1 Humidity-corrected photo haze

Optical depth along the view path from the dark-channel transmission:

```text
τ_opt = −ln( t̄ )          (t̄ = mean transmission over non-sky pixels)
```

This is optical depth, **not** extinction: it also contains the unknown scene depth `d`. Humidity swells particles and increases scattering:

```text
f(RH) = (1 − RH)^(−γ),     RH ∈ [0, 0.95],   γ ≈ 0.5 (assumed)
```

Extinction scales as `β ≈ α_ext · C · f(RH)`, with `β = τ_opt / d`. Taking logs, the calibration regression (replaces Tier 2.3) becomes:

```text
ln C_photo = γ₀ + γ₁ · [ ln τ_opt − ln f(RH) ] + γ_scene
```

`γ_scene` is a categorical term (open view vs. street canyon) that absorbs the unknown depth. Alternative: require photos toward a far landmark so `d` is roughly constant. Fit `γ` only if you have enough calibration photos; otherwise fix `γ₁ = 1` and treat the output purely as a relative index.

### 8.2 Near-road decay (line-source style)

Replaces the "footway = 0.8" shortcut. Excess concentration from road `r` decays with perpendicular distance:

```text
m_s(t) = 1 + Σ_r  e_{c(r)} · rush(t) · exp( −d_{s,r} / λ )   −   e_g · g_s
```

* `e_c` = relative excess for road class `c` (e.g. primary 0.4, secondary 0.25, residential 0.05) *(assumed)*
* `d_{s,r}` = distance from segment `s` to road `r` (0 if `s` lies on `r`)
* `λ ≈ 100–150 m` decay length *(assumed; check near-road gradient literature)*
* `g_s` = green fraction within a 100 m buffer, `e_g ≈ 0.15` *(assumed)*

Example: a park path 20 m from a primary road with `λ = 120 m` retains `exp(−20/120) ≈ 0.85` of the road's excess, so it is much worse than a path 300 m away (`exp(−2.5) ≈ 0.08`). Pure geometry, no extra data.

### 8.3 Microenvironment infiltration

Refines the Tier 1.5 enclosure factor into a proper microenvironment sum:

```text
D = Σ_e  C_out,e · F_e · v_e · t_e
```

| Environment                   | F_e (assumed) |
| ----------------------------- | ------------- |
| Outdoors                      | 1.0           |
| Open-window bus               | 0.9           |
| Closed vehicle, recirculating | 0.5           |
| School indoors                | 0.6           |

Lets you answer "is staying indoors for PE better?" quantitatively in the school dashboard.

---

## Tier 9 — Calibrated uncertainty and evaluation

### 9.1 Blocked cross-validation

Use **leave-one-day-out** (7 folds), not random hourly splits. Hours within a day are correlated, so random splits leak information and inflate scores.

### 9.2 Metrics

```text
MAE  = mean |ŷ − y|          NMAE = MAE / mean(y)
RMSE = sqrt( mean (ŷ − y)² )  Bias = mean (ŷ − y)
```

Probabilistic score, the continuous ranked probability score for a Gaussian prediction `N(μ, σ²)`:

```text
z    = (y − μ) / σ
CRPS = σ · [ z (2Φ(z) − 1) + 2φ(z) − 1/√π ]
```

`Φ`, `φ` = standard normal CDF and PDF. Lower is better. It rewards both accuracy and honest spread.

### 9.3 Skill versus baselines

```text
SS = 1 − MAE_model / MAE_baseline
```

Baselines: raw API, persistence, diurnal climatology. A model that cannot beat persistence at 1 h lead only earns its keep at longer leads. Report skill by lead time.

### 9.4 Split conformal intervals (log scale)

Calibration-day residuals `e_j = |ln y_j − ln ŷ_j|`. For miscoverage level `α`:

```text
q = the ⌈(n+1)(1 − α)⌉-th smallest e_j
interval = ŷ · exp(± q)
```

Then check **empirical coverage on held-out days**. Caveat: time series violate the exchangeability assumption, so coverage is approximate. Report the measured coverage, not the nominal one.

### 9.5 Ablation table (the honest accuracy story)

Add layers cumulatively. Keep a layer only if held-out error drops. **Fill from your own runs:**

| Configuration                   | LODO MAE | CRPS | 90% coverage |
| ------------------------------- | -------- | ---- | ------------ |
| Raw API                         |          |      |              |
| + bias correction               |          |      |              |
| + Kalman bias tracker           |          |      |              |
| + ensemble                      |          |      |              |
| + humidity/inversion covariates |          |      |              |

For street layers (Tiers 5, 6, 8.1–8.2) use **leave-one-photo-out** and report whether error against held-out photo-implied values drops. Caveat to state: photo-implied values are not ground truth, so this shows internal consistency, not true street accuracy.

### 9.6 Decision robustness (not accuracy)

The Tier 3.3 quantity `P(B better)` and the Tier 3.4 ranking-stability score measure how stable a **recommendation** is under uncertainty. Name them "decision robustness" on slides, never "accuracy".

---

## What to actually build vs. put on the roadmap slide

**Build (cheap, high value):**

* Tier 4 items 1–6 and 8 (API covariates, diurnal profile, day type)
* Tier 8.2 near-road decay (pure geometry)
* Tier 8.1 humidity normalization (one line)
* Tier 7.3 ensemble with inverse-MSE weights (3 predictors is enough)
* Tier 9.1, 9.2, 9.4 in one script (LODO, MAE/CRPS, conformal)

**Stretch (only if Tiers 1–3 are solid):**

* Tier 5 Bayesian regression (~30 lines)
* Tier 6 Gaussian process (~60 lines with a small matrix library)
* Tier 7.1 Kalman filter

**Roadmap slide only:** satellite AOD, NO₂, fire data, learned ML models.

**Presentation warning:** do not show all nine tiers. The pitch is **"uncertainty-aware data fusion"**: a prior, evidence that corrects it, and honest confidence. Show the architecture diagram, one ablation table with real numbers, and one live recommendation that changes when confidence changes. Extra tiers that never reach the demo cost you Presentation points and add nothing to Functionality.
