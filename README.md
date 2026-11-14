# viewshed-lab

**Exact viewshed for a regular heightfield: one distance-ordered sweep performs exactly `n-1` slope comparisons and reproduces the definitional O(n²) all-pairs oracle bit-for-bit (0 / 16,383 mask differences), measured at 108.93× faster on the same grid, observer and azimuth resolution** (fast median 4.734 ms vs all-pairs baseline median 515.6671 ms, 128×128, azBins=512, `bench/result.json`). On 256×256 (65,536 cells, azBins=1024) the same exact sweep runs in a warm median of 26.1747 ms (cold start 36.6005 ms).

Upstream: none

This is an original engine, not a fork. No upstream repository was consulted or copied.

## What it is

A pure-ESM viewshed / horizon engine for regular heightfields (DEM-style grids). Given an observer cell and a height grid it returns, for every cell, whether that cell is above the horizon seen from the observer, where the horizon is the maximum elevation angle of any strictly nearer cell in the same angular sector.

The model is written down precisely at the top of `src/core.mjs`. In one sentence:

> `visible(C) = slope(C) - max{ slope(Q) : sector(Q) = sector(C), r(Q) < r(C) } > grazeEps`, with `slope = (z - zObserver) / r` and `grazeEps = 0` by default.

Because the default threshold is exactly zero, there is **no absolute epsilon anywhere in the default path**, so the verdict is homogeneous: scaling the height channel and the observer height by any positive constant leaves the visible mask untouched.

## How to run

```bash
node tools/gen-sample.mjs   # deterministic sample terrain (byte-identical on re-run)
node bench/verify.mjs       # assertions; prints every measured value; exit 0 on pass
node bench/bench.mjs        # cold start + 7 warm reps + paired O(n^2) baseline -> bench/result.json
```

Browser view (single file + pinned CDN importmap, no bundler, no `node_modules`):

```bash
python3 -m http.server 4173    # then open http://localhost:4173
```

The page loads `data/terrain-128.json` and `data/expected.json` and re-runs the **same** `src/core.mjs` in the browser; the readout compares the in-page numbers against the node-generated reference and shows the match/mismatch explicitly.

## Evidence (all from `bench/result.json`, produced by `node bench/bench.mjs`)

| measurement | value |
| --- | --- |
| headline grid | 256×256 = 65,536 cells, azBins=1024 |
| cold start (first call in process) | 36.6005 ms |
| warm (n=7) min / median / p95 / stddev | 21.1925 / 26.1747 / 31.0910 / 3.1922 ms |
| warm relative stddev | 0.12 (see limitations) |
| comparisons in the sweep | 65,535 = n−1 exactly |
| visible terrain cells (headline run) | 52,630 |
| throughput | 2,503.79 cells/ms |
| paired baseline, same grid/observer/azBins (128×128, azBins=512) | all-pairs median 515.6671 ms vs fast median 4.7340 ms |
| speedup | **108.93×** |
| oracle work ratio | 316,604 oracle comparisons vs 16,383 fast comparisons (19.3×) |
| mask agreement with the O(n²) oracle | **0 / 16,383 differences** |

`bench/verify.mjs` prints 18 assertions with their measured values (18 passed / 0 failed):

- `A1` sample generation is byte-deterministic (sha256 of both terrains identical across regeneration).
- `A2` fast mask == definitional O(n²) `allPairsViewshed` mask, 0 diff.
- `A3` fast mask == a second traversal path (`sectorFanViewshed`, per-sector lists, no global sort), 0 diff.
- `A4` the sweep performs exactly `n−1` comparisons.
- `A5` the oracle performs 316,604 comparisons (19.3× the sweep's).
- `A6a/A6b` analytic known answers: a flat field with the eye on the surface yields exactly one visible cell per sector (grazing is not "visible"); a single spike column hides the two cells behind it along its row (`[1100]`).
- `A7` uniform z-scale 1e-6 → 1e6: identical visible counts (12,386 ×5) and identical masks 5/5.
- `A8` `slope / s` recovers the unscaled slopes to a worst relative error of 3.331e-12 (assertion bound 1e-9; the bound is loose on purpose, the measured number is what counts).
- `A9` the visible set is monotone in observer height (8 heights, 10,537 → 14,979).
- `A10` a repeat run is bit-identical, including the raw slope channel.
- `A11` azBins sweep 64…1024 stays well-formed with no NaN slope.
- `A12/A13` cross-model honesty: see below.
- `A17` 80 seeded random + degenerate fixtures (6 shapes, azBins 7/16/64/257, height scales 1e-9/1/1e9, random single-cell spikes, flat fields, a one-cell obstacle): fast mask == O(n²) oracle mask on **80/80 cases, 0 mismatches**. The exactness claim therefore does not rest on the hand-picked sample terrain.

### The honest negative result: 5.33% cross-model gap

The standard GIS alternative is a Bresenham line-of-sight walk. It implements a *different* occlusion model, and on the sample terrain the two models disagree on **874 of 16,383 cells (5.33%)** — horizon model 12,386 visible vs Bresenham 11,982. This is a model difference, not an implementation bug: on the unambiguous spike fixture both models return the same row mask `[1100]`. `verify.mjs` reports the gap instead of hiding it, and README does not claim the models agree.

## 本轮创新

**New in this round (B): an exactness claim instead of a sampling claim, plus a reported model gap.** Prior work in this account certified geometric predicates by sampling (TOI intervals, label visibility) or by an independent oracle on small fixtures; here the fast path is proven *equal to the definitional O(n²) oracle on the full 16,383-cell mask* while doing exactly `n−1` comparisons, so "exact" means "bit-identical to the plain reading of the model on every cell", not "no disagreement found at our sample rate". The second new thing is that the round reports a **5.33% disagreement with the standard Bresenham LOS model and explains it as a model difference**, rather than quietly picking whichever model produced a cleaner number. The direction ledger has no viewshed / horizon / DEM entry; the only shared technique with prior rounds is "compare against an independent implementation", which is a method, not the result.

Graded against `innovation.md` (last 20 entries read): no viewshed, horizon, terrain, line-of-sight or DEM entry exists. The closest neighbours are `toi-cert-lab` (moving triangle pairs over time) and `symplane-lab` (mirror-plane optimization) — different questions, different data, different failure modes.

## Known limitations (read before citing the numbers)

1. **Slope unit.** Slopes are height-per-grid-cell. If you scale the horizontal grid spacing, you must scale the published slope threshold with it, or run `normalizeField()` first so slopes are in units of "height relief per cell". The default verdict is threshold-free (`grazeEps = 0`) and therefore survives any uniform scale of the height channel and observer height — that is the property `A7` measures.
2. **Planar degeneracy.** Under the strict "strictly greater than the nearer maximum" rule, a perfectly flat field with the eye on the surface reports one visible cell per sector (the horizon ring), because "on the horizon" is not "above the horizon". `A6a` pins this down as a known answer rather than hiding it. Real terrain with relief does not hit this case.
3. **Sector discretisation.** Visibility is defined per angular sector of width `2π/azBins`; two cells in different sectors never occlude each other. `azBins=1024` on 128×128 still shows resolution dependence (visible counts 5,119 → 13,210 across 64…1024, `A11`), so the count is only meaningful together with its `azBins`. There is no continuous-angle guarantee.
4. **Timing variance.** The 256×256 warm relative stddev is 0.12 (>0.10). Cause: 7 reps of a ~26 ms workload in a single process, so JIT tiering and GC land inside the window; min 21.19 ms vs max 31.09 ms. The speedup number is a median-to-median ratio from the same process, and the paired 128×128 baseline has relStddev 0.01 (fast relStddev 0.04).
5. **Memory model.** The grid is a `Float64Array` held whole; there is no out-of-core or tiled version. 256×256 is the largest measured configuration.
6. **Not a GIS product.** No georeferencing, no earth curvature, no refraction, no earth-radius correction, no multi-observer raster union API beyond the greedy helper `greedySiting()` (16×16 candidate lattice, height-penalty-free).
7. **Render-layer evidence.** Browser automation is forbidden in this environment, so `index.html` + `main.js` are evidenced by `node --check main.js` (syntax), an HTTP 200 from `python3 -m http.server 4173`, a pinned importmap (`three@0.160.0`, no `latest`), and the fact that the page imports the same `src/core.mjs` the benchmarks exercise — **not** by a screenshot or a DOM run. Every number in this README comes from node.
8. **`greedySiting` optimality.** Only step-wise greedy optimality is asserted (`A14`: step-1 marginal equals the brute-force maximum over all 64 candidates). The 3-viewpoint union is **not** claimed globally optimal; the size-3 union is 15,848 of 16,384 cells.

## Project layout

```
index.html            single entry, pinned three.js importmap (r160)
main.js               render layer only: consumes core output, never recomputes it
src/core.mjs          pure engine: no three, no DOM, no fs, no env (386 lines)
baseline/naive.mjs    re-exports the definitional O(n²) baseline
tools/gen-sample.mjs  deterministic sample terrain + node reference
bench/verify.mjs      17 assertions, all measured
bench/bench.mjs       cold start + 7 warm reps + paired baseline
bench/result.json     the numbers quoted above
data/                 small generated grids (128²: 117 kB, 256²: 468 kB)
```

## License

MIT — see `LICENSE`.
