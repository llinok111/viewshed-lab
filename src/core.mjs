// viewshed-lab · core: exact viewshed / horizon engine for regular heightfields.
// Pure ES module. No three.js, no window/document/navigator, no fs, no env.
//
// MODEL (this is the spec, and it is shared by every implementation here):
//   A grid cell is the point (x, y, z[x][y]) with x,y integer cell coords.
//   The observer sits at cell (ox, oy) at height z[ox][oy] + h.
//   Cells are partitioned into `azBins` equal angular sectors around the observer
//   (sector k = azimuth in [k*2pi/azBins, (k+1)*2pi/azBins)).
//   For a target cell C != O in sector k:
//       slope(C)   = (z[C] - zObserver) / r(C),  r = Euclidean grid distance
//       best(C)    = max{ slope(Q) : Q in sector k, r(Q) < r(C), Q != O }
//       visible(C) = slope(C) - best(C) > grazeEps      (strict; grazeEps defaults to 0)
//   The observer cell itself is marked visible (trivially).
//   Cells with equal radius inside one sector never block each other: they are all
//   compared against the strictly-nearer running maximum, then folded in together.
//
// All default thresholds are exact zeros: there is no absolute epsilon in the
// default path, so the verdict is invariant under any uniform xyz scale.

const TAU = Math.PI * 2;

export function createField(w, h, z) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2) {
    throw new Error('createField: w,h must be integers >= 2');
  }
  if (!z || z.length !== w * h) {
    throw new Error(`createField: expected ${w * h} samples, got ${z ? z.length : 0}`);
  }
  return { w, h, z: Float64Array.from(z) };
}

export function fieldStats(field) {
  const { w, h, z } = field;
  const n = w * h;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = z[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { n, min, max, mean: sum / n, relief: max - min };
}

// Scale the height channel to (z - mean) / relief. Slopes then live in units of
// "height relief per cell", which is dimensionless w.r.t. any uniform scene scale.
export function normalizeField(field) {
  const s = fieldStats(field);
  const inv = s.relief > 0 ? 1 / s.relief : 1;
  const z = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) z[i] = (field.z[i] - s.mean) * inv;
  return { field: { w: field.w, h: field.h, z }, offset: s.mean, scale: s.relief, stats: s };
}

export function scaleField(field, k) {
  const z = new Float64Array(field.z.length);
  for (let i = 0; i < z.length; i++) z[i] = field.z[i] * k;
  return { w: field.w, h: field.h, z };
}

export function sectorOf(dx, dy, azBins) {
  let a = Math.atan2(dy, dx);
  if (a < 0) a += TAU;
  const b = Math.floor((a / TAU) * azBins);
  return b >= azBins ? azBins - 1 : b;
}

// O(n log n) exact pass: sort every cell once by (radius, index), then sweep
// outward maintaining the running per-sector maximum slope. Because a cell can
// only be blocked by a strictly nearer cell of the same sector, one sweep is
// enough -- no per-target rescan is needed.
export function computeViewshed(field, obs, opts = {}) {
  const azBins = opts.azBins === undefined ? 512 : opts.azBins;
  const grazeEps = opts.grazeEps === undefined ? 0 : opts.grazeEps;
  if (!Number.isInteger(azBins) || azBins < 1) throw new Error('azBins must be a positive integer');
  const { w, h, z } = field;
  const n = w * h;
  const ox = obs.x;
  const oy = obs.y;
  if (!Number.isInteger(ox) || !Number.isInteger(oy) || ox < 0 || oy < 0 || ox >= w || oy >= h) {
    throw new Error('computeViewshed: observer must be an in-grid integer cell');
  }
  const oi = oy * w + ox;
  const hObs = obs.height === undefined ? 0 : obs.height;
  const zObs = z[oi] + hObs;

  const dist = new Float64Array(n);
  const sector = new Int32Array(n).fill(-1);
  const order = new Int32Array(n - 1);
  let m = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (i === oi) continue;
      const dx = x - ox;
      const dy = y - oy;
      const r = Math.sqrt(dx * dx + dy * dy);
      dist[i] = r;
      sector[i] = sectorOf(dx, dy, azBins);
      order[m++] = i;
    }
  }
  const sorted = Array.from(order).sort((p, q) => (dist[p] - dist[q]) || (p - q));

  const slope = new Float64Array(n);
  const visible = new Uint8Array(n);
  visible[oi] = 1;
  const best = new Float64Array(azBins).fill(-Infinity);
  let comparisons = 0;
  let visibleTerrain = 0;

  let p = 0;
  while (p < sorted.length) {
    const r0 = dist[sorted[p]];
    let q = p;
    while (q < sorted.length && dist[sorted[q]] === r0) q++;
    // 1) every cell of this ring is judged against the strictly-nearer maximum
    for (let t = p; t < q; t++) {
      const i = sorted[t];
      const s = (z[i] - zObs) / r0;
      slope[i] = s;
      comparisons++;
      if (s - best[sector[i]] > grazeEps) {
        visible[i] = 1;
        visibleTerrain++;
      }
    }
    // 2) only then does this ring join the maximum
    for (let t = p; t < q; t++) {
      const i = sorted[t];
      const b = sector[i];
      if (slope[i] > best[b]) best[b] = slope[i];
    }
    p = q;
  }

  let maxSlope = -Infinity;
  let maxSlopeCell = -1;
  for (let i = 0; i < n; i++) {
    if (i !== oi && slope[i] > maxSlope) {
      maxSlope = slope[i];
      maxSlopeCell = i;
    }
  }
  return {
    azBins,
    grazeEps,
    observer: { x: ox, y: oy, cell: oi, z: zObs, height: hObs },
    slope,
    sector,
    distance: dist,
    visible,
    visibleTerrain,
    observerVisible: 1,
    comparisons,
    cells: n,
    maxSlope,
    maxSlopeCell,
  };
}

export function coverageUnion(field, observers, opts = {}) {
  const n = field.w * field.h;
  const covered = new Uint8Array(n);
  const perObserver = [];
  let coveredCount = 0;
  for (const o of observers) {
    const r = computeViewshed(field, o, opts);
    let added = 0;
    for (let i = 0; i < n; i++) {
      if (r.visible[i] && !covered[i]) {
        covered[i] = 1;
        coveredCount++;
        added++;
      }
    }
    perObserver.push({ observer: o, visibleTerrain: r.visibleTerrain, added, comparisons: r.comparisons });
  }
  return { covered, coveredCount, perObserver };
}

// Greedy siting: pick k observers (observer height h) on the candidate lattice
// (every `stride`-th cell) maximising the union of visible terrain. Ties break
// on the lowest candidate index, so the result is deterministic.
export function greedySiting(field, { k = 3, stride = 8, height = 0, azBins = 512, grazeEps = 0 } = {}) {
  const { w, h } = field;
  const cands = [];
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) cands.push(y * w + x);
  }
  const n = w * h;
  const covered = new Uint8Array(n);
  const chosen = [];
  const steps = [];
  for (let step = 0; step < k; step++) {
    let bestCell = -1;
    let bestGain = -1;
    let bestMask = null;
    for (const ci of cands) {
      const cx = ci % w;
      const cy = (ci - cx) / w;
      const r = computeViewshed(field, { x: cx, y: cy, height }, { azBins, grazeEps });
      let gain = 0;
      for (let i = 0; i < n; i++) if (r.visible[i] && !covered[i]) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        bestCell = ci;
        bestMask = r.visible;
      }
    }
    for (let i = 0; i < n; i++) if (bestMask[i]) covered[i] = 1;
    chosen.push(bestCell);
    let total = 0;
    for (let i = 0; i < n; i++) if (covered[i]) total++;
    steps.push({ step, cell: bestCell, x: bestCell % w, y: (bestCell - (bestCell % w)) / w, marginalGain: bestGain, unionSize: total });
  }
  let coveredCount = 0;
  for (let i = 0; i < n; i++) if (covered[i]) coveredCount++;
  return { chosen, steps, covered, coveredCount, candidates: cands.length, stride };
}

// Standard GIS reference with a *different* occlusion model: sample the segment
// observer -> target with a Bresenham-style integer walk and block when any
// intermediate sample rises above the interpolated line of sight. Used only to
// report the model disagreement rate, never to claim equality.
export function bresenhamVisible(field, obs, x, y, obsHeight = 0) {
  const { w, z } = field;
  const oi = obs.y * w + obs.x;
  const zObs = z[oi] + obsHeight;
  let x0 = obs.x;
  let y0 = obs.y;
  const dx = Math.abs(x - x0);
  const dy = Math.abs(y - y0);
  const sx = x0 < x ? 1 : -1;
  const sy = y0 < y ? 1 : -1;
  let err = dx - dy;
  const steps = Math.max(dx, dy);
  if (steps === 0) return true;
  for (let s = 1; s < steps; s++) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    const t = s / steps;
    const losZ = zObs + (z[y * w + x] - zObs) * t;
    const zi = z[y0 * w + x0];
    if (zi > losZ) return false;
  }
  return true;
}

export function bresenhamViewshed(field, obs, obsHeight = 0) {
  const { w, h } = field;
  const n = w * h;
  const visible = new Uint8Array(n);
  let visibleTerrain = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === obs.x && y === obs.y) {
        visible[y * w + x] = 1;
        continue;
      }
      if (bresenhamVisible(field, obs, x, y, obsHeight)) {
        visible[y * w + x] = 1;
        visibleTerrain++;
      }
    }
  }
  return { visible, visibleTerrain };
}

export function maskDiff(a, b) {
  if (a.length !== b.length) throw new Error('maskDiff: length mismatch');
  let diff = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] ? 1 : 0) !== (b[i] ? 1 : 0)) diff++;
  return diff;
}

const ringCache = new Map();
// Same model, same complexity class as the fast sweep, but grouped per sector
// with an explicit sort instead of one global sort. Kept as a cross-check, not
// as the timed baseline (the timed baseline is allPairsViewshed below).
export function sectorFanViewshed(field, obs, opts = {}) {
  const azBins = opts.azBins === undefined ? 512 : opts.azBins;
  const grazeEps = opts.grazeEps === undefined ? 0 : opts.grazeEps;
  const { w, h, z } = field;
  const n = w * h;
  const oi = obs.y * w + obs.x;
  const zObs = z[oi] + (obs.height === undefined ? 0 : obs.height);
  const key = `${w}x${h}x${azBins}`;
  let rings = ringCache.get(key);
  if (!rings) {
    const dist = new Float64Array(n);
    const sector = new Int32Array(n);
    const bins = Array.from({ length: azBins }, () => []);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        dist[i] = Math.sqrt(x * x + y * y);
        sector[i] = -1;
      }
    }
    rings = { dist, bins };
    ringCache.set(key, rings);
  }
  const { dist, bins } = rings;
  for (let b = 0; b < azBins; b++) bins[b].length = 0;
  const sector = new Int32Array(n).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (i === oi) continue;
      const dx = x - obs.x;
      const dy = y - obs.y;
      dist[i] = Math.sqrt(dx * dx + dy * dy);
      const b = sectorOf(dx, dy, azBins);
      sector[i] = b;
      bins[b].push(i);
    }
  }
  const visible = new Uint8Array(n);
  visible[oi] = 1;
  let comparisons = 0;
  let visibleTerrain = 0;
  for (let b = 0; b < azBins; b++) {
    const list = bins[b];
    if (list.length === 0) continue;
    list.sort((p, q) => (dist[p] - dist[q]) || (p - q));
    let best = -Infinity;
    for (const i of list) {
      const s = (z[i] - zObs) / dist[i];
      comparisons++;
      if (s - best > grazeEps) {
        visible[i] = 1;
        visibleTerrain++;
      }
      if (s > best) best = s;
    }
  }
  return { visible, visibleTerrain, comparisons, azBins };
}

export function allPairsViewshed(field, obs, opts = {}) {
  const azBins = opts.azBins === undefined ? 512 : opts.azBins;
  const grazeEps = opts.grazeEps === undefined ? 0 : opts.grazeEps;
  const { w, h, z } = field;
  const n = w * h;
  const oi = obs.y * w + obs.x;
  const zObs = z[oi] + (obs.height === undefined ? 0 : obs.height);
  const dist = new Float64Array(n);
  const sector = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      dist[i] = Math.sqrt((x - obs.x) ** 2 + (y - obs.y) ** 2);
      sector[i] = sectorOf(x - obs.x, y - obs.y, azBins);
    }
  }
  const visible = new Uint8Array(n);
  visible[oi] = 1;
  let comparisons = 0;
  let visibleTerrain = 0;
  for (let i = 0; i < n; i++) {
    if (i === oi) continue;
    let best = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === oi || sector[j] !== sector[i] || dist[j] >= dist[i]) continue;
      comparisons++;
      const s = (z[j] - zObs) / dist[j];
      if (s > best) best = s;
    }
    const sI = (z[i] - zObs) / dist[i];
    if (sI - best > grazeEps) {
      visible[i] = 1;
      visibleTerrain++;
    }
  }
  return { visible, visibleTerrain, comparisons, azBins };
}
