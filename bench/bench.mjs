#!/usr/bin/env node
// bench/bench.mjs -- cold start + >=5 warm repetitions (median/p95/stddev) for the
// exact viewshed sweep, plus the definitional O(n^2) oracle on a smaller grid.
// Writes bench/result.json. Every field is measured in this process.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allPairsViewshed, computeViewshed, createField } from '../src/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-sample.mjs')], { cwd: ROOT, stdio: 'ignore' });

function load(grid) {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', `terrain-${grid}.json`), 'utf8'));
  return createField(j.w, j.h, j.z);
}
const f128 = load(128);
const f256 = load(256);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1);
  const sd = Math.sqrt(variance);
  const p95 = s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return { n, min: s[0], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, p95, max: s[n - 1], mean, stddev: sd, relStddev: mean > 0 ? sd / mean : 0 };
}

// ---- headline: 256x256, azBins=1024 -----------------------------------------
const OBS256 = { x: 102, y: 159, height: 24 };
const AZ256 = 1024;
const cold0 = performance.now();
const coldRun = computeViewshed(f256, OBS256, { azBins: AZ256 });
const coldStartMs = performance.now() - cold0;

const warm = [];
for (let i = 0; i < 7; i++) {
  const t0 = performance.now();
  const r = computeViewshed(f256, OBS256, { azBins: AZ256 });
  warm.push(performance.now() - t0);
  if (maskDiffSafe(r, coldRun) !== 0) throw new Error('warm run diverged from cold run');
}
function maskDiffSafe(a, b) {
  let d = 0;
  for (let i = 0; i < a.visible.length; i++) if (a.visible[i] !== b.visible[i]) d++;
  return d;
}
const warmStats = stats(warm);

// ---- paired baseline on 128x128 (all-pairs definitional oracle) -------------
const OBS128 = { x: 51, y: 79, height: 12 };
const AZ128 = 512;
const fast128 = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  computeViewshed(f128, OBS128, { azBins: AZ128 });
  fast128.push(performance.now() - t0);
}
const base128 = [];
let baseComparisons = 0;
let baseDiff = 0;
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const r = allPairsViewshed(f128, OBS128, { azBins: AZ128 });
  base128.push(performance.now() - t0);
  baseComparisons = r.comparisons;
  baseDiff = maskDiffSafe(r, computeViewshed(f128, OBS128, { azBins: AZ128 }));
}
const fast128Stats = stats(fast128);
const base128Stats = stats(base128);

const result = {
  generatedBy: 'bench/bench.mjs',
  node: process.version,
  coldStart: { label: 'first computeViewshed call in this process', ms: round4(coldStartMs) },
  headline: {
    grid: '256x256',
    cells: f256.w * f256.h,
    azBins: AZ256,
    observer: OBS256,
    visibleTerrain: coldRun.visibleTerrain,
    comparisons: coldRun.comparisons,
    maxSlope: round6(coldRun.maxSlope),
    warmMs: round4(warmStats.median),
    warmStats: roundStats(warmStats),
    cellsPerMs: round2((f256.w * f256.h) / warmStats.median),
  },
  baseline: {
    label: 'definitional O(n^2) all-pairs scan (src/core.mjs allPairsViewshed)',
    grid: '128x128',
    cells: f128.w * f128.h,
    azBins: AZ128,
    comparisons: baseComparisons,
    ms: round4(base128Stats.median),
    msStats: roundStats(base128Stats),
    maskDiffVsFast: baseDiff,
  },
  paired128: {
    fastMs: round4(fast128Stats.median),
    fastStats: roundStats(fast128Stats),
    speedupVsAllPairs: round2(base128Stats.median / fast128Stats.median),
    comparisonRatio: round1(baseComparisons / (f128.w * f128.h - 1)),
  },
  interpret: {
    warmMsBeyondCold: 'warm medians exclude the first call; the cold-start number is reported separately',
    relStddevNote: 'relStddev above 0.10 is explained in README under known limitations',
  },
};
function round4(v) { return Math.round(v * 1e4) / 1e4; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }
function roundStats(s) {
  return {
    n: s.n,
    min: round4(s.min),
    median: round4(s.median),
    p95: round4(s.p95),
    max: round4(s.max),
    mean: round4(s.mean),
    stddev: round4(s.stddev),
    relStddev: round2(s.relStddev),
  };
}

writeFileSync(join(ROOT, 'bench', 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
