#!/usr/bin/env node
// bench/verify.mjs -- every number printed here is measured, never assumed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allPairsViewshed,
  computeViewshed,
  createField,
  fieldStats,
  greedySiting,
  maskDiff,
  scaleField,
  sectorFanViewshed,
} from '../src/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name} :: ${detail}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} :: ${detail}`);
  }
}

function load(grid) {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', `terrain-${grid}.json`), 'utf8'));
  return createField(j.w, j.h, j.z);
}
function sha(grid) {
  return createHash('sha256').update(readFileSync(join(ROOT, 'data', `terrain-${grid}.json`))).digest('hex').slice(0, 16);
}

console.log('viewshed-lab verify · model = horizon-limited visibility on a regular heightfield');

// A1 -- sample generation is deterministic
{
  const before = [sha(128), sha(256)];
  execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-sample.mjs')], { cwd: ROOT, stdio: 'ignore' });
  const after = [sha(128), sha(256)];
  check('A1 gen-sample deterministic', before[0] === after[0] && before[1] === after[1], `sha256 ${before.join('/')} == ${after.join('/')}`);
}

const f128 = load(128);
const f256 = load(256);
const OBS = { x: 51, y: 79, height: 12 };
const AZ = 512;

const fast = computeViewshed(f128, OBS, { azBins: AZ });

// A2 -- definitional O(n^2) oracle reproduces the fast mask exactly
const allPairs = allPairsViewshed(f128, OBS, { azBins: AZ });
check('A2 fast == allPairs(O(n^2)) mask', maskDiff(fast.visible, allPairs.visible) === 0,
  `diff=${maskDiff(fast.visible, allPairs.visible)} fast=${fast.visibleTerrain} allPairs=${allPairs.visibleTerrain}`);

// A3 -- second traversal path (per-sector lists, no global sort) reproduces it too
const fan = sectorFanViewshed(f128, OBS, { azBins: AZ });
check('A3 fast == sectorFan mask', maskDiff(fast.visible, fan.visible) === 0,
  `diff=${maskDiff(fast.visible, fan.visible)} sectorFan=${fan.visibleTerrain}`);

// A4 -- the fast pass performs exactly one comparison per non-observer cell
check('A4 fast comparisons == n-1', fast.comparisons === fast.cells - 1,
  `comparisons=${fast.comparisons} n-1=${fast.cells - 1}`);
check('A5 O(n^2) oracle does strictly more work', allPairs.comparisons > 200000,
  `oracle comparisons=${allPairs.comparisons} (${(allPairs.comparisons / fast.comparisons).toFixed(1)}x the fast pass)`);

// A6 -- analytic known answers on hand-computable fixtures
{
  const flat = createField(8, 8, new Array(64).fill(0));
  const fr = computeViewshed(flat, { x: 3, y: 3, height: 0 }, { azBins: 16 });
  check('A6a flat field, eye on the surface -> only one cell per sector clears the strict horizon',
    fr.visibleTerrain === 16, `azBins=16 -> visible=${fr.visibleTerrain} (expected 16, grazing is not "visible")`);
  const ridge = createField(5, 3, [...[0, 0, 10, 0, 0], ...[0, 0, 10, 0, 0], ...[0, 0, 10, 0, 0]]);
  const rr = computeViewshed(ridge, { x: 0, y: 1, height: 0 }, { azBins: 4 });
  const row = [1, 2, 3, 4].map((x) => rr.visible[1 * 5 + x]);
  check('A6b single spike column at x=2 hides x=3,4 along its own row, exactly',
    row.join('') === '1100',
    `row mask=[${row.join('')}] expected [1100]; visibleTerrain=${rr.visibleTerrain}`);
}

// A7 -- uniform-scale invariance: identical verdicts, slopes agree to float noise
{
  // Uniform scene scale s = z -> s*z, observer height -> s*height (grid spacing is
  // held at one cell, which is the unit the engine measures slope in). All slopes
  // are then s * baseline slope, so the verdict must be bit-identical and
  // slope/s must recover the baseline.
  const base = computeViewshed(f128, OBS, { azBins: AZ });
  const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
  let sameVerdict = 0;
  let worstSlope = 0;
  const counts = [];
  for (const s of scales) {
    const r = computeViewshed(scaleField(f128, s), { ...OBS, height: OBS.height * s }, { azBins: AZ });
    counts.push(r.visibleTerrain);
    if (maskDiff(base.visible, r.visible) === 0) sameVerdict++;
    for (let i = 0; i < r.slope.length; i++) {
      const a = base.slope[i];
      const b = r.slope[i] / s;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const rel = Math.abs(a - b) / Math.max(Math.abs(a), 1e-300);
      if (rel > worstSlope) worstSlope = rel;
    }
  }
  check('A7 uniform z-scale 1e-6..1e6 keeps the verdict', sameVerdict === scales.length && counts.every((c) => c === counts[0]),
    `counts=${counts.join(',')} identical=${sameVerdict}/${scales.length}`);
  check('A8 slope/s recovers baseline to <= 1e-9', worstSlope <= 1e-9, `scales=${scales.join(',')} worst rel.err=${worstSlope.toExponential(3)}`);
}

// A9 -- raising the observer can never remove a visible cell
{
  const heights = [0, 1, 2, 4, 8, 16, 32, 64];
  const counts = heights.map((h) => computeViewshed(f128, { ...OBS, height: h }, { azBins: AZ }).visibleTerrain);
  let mono = true;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[i - 1]) mono = false;
  check('A9 visible set is monotone in observer height', mono, `heights=${heights.join(',')} -> visible=${counts.join(',')}`);
}

// A10 -- determinism, including the raw slope channel
{
  const r1 = computeViewshed(f128, OBS, { azBins: AZ });
  const r2 = computeViewshed(f128, OBS, { azBins: AZ });
  let bitwise = r1.slope.length === r2.slope.length;
  for (let i = 0; bitwise && i < r1.slope.length; i++) bitwise = Object.is(r1.slope[i], r2.slope[i]);
  check('A10 repeat run is bit-identical', maskDiff(r1.visible, r2.visible) === 0 && bitwise,
    `maskDiff=${maskDiff(r1.visible, r2.visible)} slopes bit-identical=${bitwise}`);
}

// A11 -- azimuth resolution sweep stays well-formed and finite
{
  const rows = [];
  let ok = true;
  for (const az of [64, 128, 256, 512, 1024]) {
    const r = computeViewshed(f128, OBS, { azBins: az });
    let sum = 0;
    let finite = true;
    for (let i = 0; i < r.visible.length; i++) {
      sum += r.visible[i];
      if (!Number.isFinite(r.slope[i])) finite = false;
    }
    rows.push(`az=${az}:vis=${r.visibleTerrain}`);
    if (sum !== r.visibleTerrain + 1 || !finite) ok = false; // +1 for the observer cell
  }
  check('A11 azBins sweep 64..1024 well-formed, no NaN slope', ok, rows.join(' '));
}

// A12 -- cross-model honesty: report the gap against Bresenham line-of-sight
{
  const br = (await import('../src/core.mjs')).bresenhamViewshed(f128, OBS, OBS.height);
  const diff = maskDiff(fast.visible, br.visible);
  check('A12 Bresenham LOS disagreement is reported, not hidden', diff >= 0,
    `horizon model visible=${fast.visibleTerrain} vs Bresenham LOS=${br.visibleTerrain} (model gap=${diff}/${fast.cells - 1} = ${((diff / (fast.cells - 1)) * 100).toFixed(2)}%)`);
  const ridge = createField(5, 3, [...[0, 0, 10, 0, 0], ...[0, 0, 10, 0, 0], ...[0, 0, 10, 0, 0]]);
  const bm = (await import('../src/core.mjs')).bresenhamViewshed(ridge, { x: 0, y: 1 }, 0);
  const hz = computeViewshed(ridge, { x: 0, y: 1, height: 0 }, { azBins: 4 }).visible;
  const rowHz = [1, 2, 3, 4].map((x) => hz[1 * 5 + x]).join('');
  const rowBm = [1, 2, 3, 4].map((x) => bm.visible[1 * 5 + x]).join('');
  check('A13 both models agree on the unambiguous spike row',
    rowHz === rowBm && rowHz === '1100', `horizon=[${rowHz}] bresenham=[${rowBm}]`);
}

// A14 -- greedy siting: step-1 pick is the true argmax, coverage is monotone in k
{
  const g = greedySiting(f128, { k: 3, stride: 16, height: 12, azBins: 256 });
  let bestGain = -1;
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) {
      const r = computeViewshed(f128, { x, y, height: 12 }, { azBins: 256 });
      let gain = 0;
      for (let i = 0; i < r.visible.length; i++) if (r.visible[i]) gain++;
      if (gain > bestGain) bestGain = gain;
    }
  }
  const sizes = g.steps.map((s) => s.unionSize);
  const mono = sizes.every((v, i) => i === 0 || v >= sizes[i - 1]);
  check('A14 greedy step-1 marginal == brute-force max', g.steps[0].marginalGain === bestGain,
    `greedy=${g.steps[0].marginalGain} bruteMax=${bestGain}`);
  check('A15 union coverage monotone in k', mono && sizes[sizes.length - 1] >= sizes[0],
    `k=3 union sizes=${sizes.join(',')} candidates=${g.candidates}`);
}

// A16 -- throughput sanity on the big grid (measured, not asserted tight)
{
  const o = { x: 102, y: 159, height: 24 };
  const t0 = performance.now();
  const r = computeViewshed(f256, o, { azBins: 1024 });
  const t1 = performance.now();
  check('A16 256x256 exact viewshed completes and is finite', Number.isFinite(r.maxSlope) && r.comparisons === r.cells - 1,
    `cells=${r.cells} visible=${r.visibleTerrain} comparisons=${r.comparisons} maxSlope=${r.maxSlope.toFixed(4)} time=${(t1 - t0).toFixed(2)}ms`);
}


// A17 -- seeded random fixtures: the exactness claim must not depend on one hand-picked
// terrain. Shapes, observer positions, azimuth resolutions and height scales vary;
// spikes, flat fields and a sub-cell obstacle are included on purpose.
{
  let seed = 0x5eed1234;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shapes = [[17, 23], [24, 24], [9, 31], [64, 5], [33, 33], [12, 40]];
  const azList = [7, 16, 64, 257];
  const scales = [1e-9, 1, 1e9];
  let cases = 0;
  let mismatches = 0;
  let firstBad = null;
  for (const [w, h] of shapes) {
    for (const az of azList) {
      for (let rep = 0; rep < 3; rep++) {
        const sc = scales[rep];
        const z = new Float64Array(w * h);
        for (let i = 0; i < z.length; i++) z[i] = rnd() * 100 * sc;
        if (rep === 1) z[Math.floor(rnd() * z.length)] = 1e4 * sc; // single-cell spike
        const f = createField(w, h, z);
        const ox = Math.floor(rnd() * w);
        const oy = Math.floor(rnd() * h);
        const obs = { x: ox, y: oy, height: rnd() * 10 * sc };
        const got = computeViewshed(f, obs, { azBins: az });
        const want = allPairsViewshed(f, obs, { azBins: az });
        cases++;
        const d = maskDiff(got.visible, want.visible);
        if (d !== 0) {
          mismatches++;
          if (!firstBad) firstBad = `${w}x${h} azBins=${az} rep=${rep} scale=${sc} obs=(${ox},${oy}) diff=${d}`;
        }
      }
    }
  }
  // degenerate fixtures: exactly flat, and a one-cell obstacle next to the observer
  for (const [w, h] of [[31, 17], [8, 8]]) {
    const flat = createField(w, h, new Array(w * h).fill(5));
    const obs = { x: Math.floor(w / 2), y: Math.floor(h / 2), height: 3 };
    for (const az of [16, 128]) {
      cases++;
      if (maskDiff(computeViewshed(flat, obs, { azBins: az }).visible, allPairsViewshed(flat, obs, { azBins: az }).visible) !== 0) mismatches++;
      const z = new Float64Array(w * h).fill(1);
      z[obs.y * w + obs.x + 1] = 900;
      const f = createField(w, h, z);
      cases++;
      if (maskDiff(computeViewshed(f, obs, { azBins: az }).visible, allPairsViewshed(f, obs, { azBins: az }).visible) !== 0) mismatches++;
    }
  }
  check('A17 seeded random + degenerate fixtures: fast == O(n^2) oracle', mismatches === 0,
    `${cases} cases (shapes ${shapes.map((s) => s.join('x')).join(',')}, azBins ${azList.join(',')}, scales 1e-9/1/1e9, random spikes, flat fields, one-cell obstacle) mismatches=${mismatches}${firstBad ? ` first=${firstBad}` : ''}`);
}

console.log(`\nRESULT ${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
