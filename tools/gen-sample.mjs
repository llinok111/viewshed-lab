#!/usr/bin/env node
// Deterministic sample generator. Same command twice -> byte-identical files.
//   node tools/gen-sample.mjs
// Writes data/terrain-128.json, data/terrain-256.json, data/expected.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createField, computeViewshed, fieldStats } from '../src/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'data');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Seeded value noise: lattice of random values, bilinear + smoothstep interpolation.
function valueNoise(seed, w, h, cells) {
  const rnd = mulberry32(seed);
  const gw = cells + 1;
  const lattice = new Float64Array(gw * gw);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (x / (w - 1)) * cells;
      const gy = (y / (h - 1)) * cells;
      const x0 = Math.min(Math.floor(gx), cells - 1);
      const y0 = Math.min(Math.floor(gy), cells - 1);
      const tx = smoothstep(gx - x0);
      const ty = smoothstep(gy - y0);
      const a = lattice[y0 * gw + x0];
      const b = lattice[y0 * gw + x0 + 1];
      const c = lattice[(y0 + 1) * gw + x0];
      const d = lattice[(y0 + 1) * gw + x0 + 1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[y * w + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

// Ridged, multi-octave terrain with a deterministic dome so the sample looks like
// a valley surrounded by ridges (a useful viewshed fixture, not a flat plane).
export function makeTerrain(seed, w, h) {
  const octaves = [
    { cells: 2, amp: 1.0, s: seed },
    { cells: 4, amp: 0.5, s: seed + 101 },
    { cells: 8, amp: 0.25, s: seed + 202 },
    { cells: 16, amp: 0.125, s: seed + 303 },
  ];
  const acc = new Float64Array(w * h);
  for (const o of octaves) {
    const n = valueNoise(o.s, w, h, o.cells);
    for (let i = 0; i < acc.length; i++) acc[i] += n[i] * o.amp;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of acc) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const z = new Float64Array(w * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rad = Math.min(w, h) * 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = (acc[i] - min) / (max - min);
      const d = Math.hypot(x - cx, y - cy) / rad;
      const bowl = Math.min(1, Math.max(0, d - 0.15)) ** 2 * 90;
      z[i] = Math.round((v * 120 + bowl) * 1000) / 1000;
    }
  }
  return { w, h, z };
}

function fieldJson(field) {
  const parts = new Array(field.z.length);
  for (let i = 0; i < field.z.length; i++) parts[i] = field.z[i].toFixed(3);
  return `{"w":${field.w},"h":${field.h},"z":[${parts.join(',')}]}`;
}

const DEFAULT_VIEW = { x: 64, y: 64, height: 12, azBins: 512 };

function main() {
  mkdirSync(OUT, { recursive: true });
  const t128 = makeTerrain(20261114, 128, 128);
  const t256 = makeTerrain(20261114, 256, 256);
  const f128 = createField(t128.w, t128.h, t128.z);
  const f256 = createField(t256.w, t256.h, t256.z);
  writeFileSync(join(OUT, 'terrain-128.json'), fieldJson(f128) + '\n');
  writeFileSync(join(OUT, 'terrain-256.json'), fieldJson(f256) + '\n');

  const r = computeViewshed(f128, DEFAULT_VIEW, { azBins: DEFAULT_VIEW.azBins });
  const probes = [
    0, 1, 127, 127 * 128 + 127, 128 * 128 / 2, 40 * 128 + 90, 90 * 128 + 40, 12 * 128 + 110,
  ];
  const expected = {
    note: 'node-computed reference for the in-page self-check; regenerate with node tools/gen-sample.mjs',
    view: DEFAULT_VIEW,
    grid: { w: 128, h: 128 },
    visibleTerrain: r.visibleTerrain,
    comparisons: r.comparisons,
    cells: r.cells,
    maxSlope: r.maxSlope,
    maxSlopeCell: r.maxSlopeCell,
    stats: fieldStats(f128),
    probes: probes.map((i) => ({ cell: i, visible: r.visible[i], slope: r.slope[i], sector: r.sector[i] })),
  };
  writeFileSync(join(OUT, 'expected.json'), JSON.stringify(expected, null, 1) + '\n');
  console.log(`wrote data/terrain-128.json (${f128.w}x${f128.h}), data/terrain-256.json (${f256.w}x${f256.h}), data/expected.json`);
  console.log(`reference viewshed: visible=${r.visibleTerrain}/${r.cells - 1} cells, comparisons=${r.comparisons}, maxSlope=${r.maxSlope.toFixed(6)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
