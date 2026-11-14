// baseline/naive.mjs -- definitional O(n^2) baseline, written as its own file with
// its own loops. It intentionally does NOT import anything from src/core.mjs, so the
// two implementations cannot drift through a shared helper.
//
// It reads the model exactly as specified in src/core.mjs:
//   visible(C) = slope(C) > max{ slope(Q) : same angular sector, r(Q) < r(C) }
// with slope = (z - zObserver) / r, default azBins = 512, default grazeEps = 0.
//
// The angular sector is part of the MODEL (a shared spec, not a shared constant):
// sector = floor(azimuth / 2pi * azBins) with azimuth in [0, 2pi).
export function baselineAllPairs(field, obs, opts = {}) {
  const azBins = opts.azBins === undefined ? 512 : opts.azBins;
  const grazeEps = opts.grazeEps === undefined ? 0 : opts.grazeEps;
  const turn = Math.PI * 2;
  const { w, h, z } = field;
  const n = w * h;
  const oi = obs.y * w + obs.x;
  const zObs = z[oi] + (obs.height === undefined ? 0 : obs.height);

  const r = new Float64Array(n);
  const sec = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - obs.x;
      const dy = y - obs.y;
      r[i] = Math.sqrt(dx * dx + dy * dy);
      let a = Math.atan2(dy, dx);
      if (a < 0) a += turn;
      let s = Math.floor((a / turn) * azBins);
      if (s >= azBins) s = azBins - 1;
      sec[i] = s;
    }
  }

  const visible = new Uint8Array(n);
  visible[oi] = 1;
  let visibleTerrain = 0;
  let comparisons = 0;
  for (let i = 0; i < n; i++) {
    if (i === oi) continue;
    let best = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === oi || sec[j] !== sec[i] || r[j] >= r[i]) continue;
      comparisons++;
      const s = (z[j] - zObs) / r[j];
      if (s > best) best = s;
    }
    const sI = (z[i] - zObs) / r[i];
    if (sI - best > grazeEps) {
      visible[i] = 1;
      visibleTerrain++;
    }
  }
  return { visible, visibleTerrain, comparisons, azBins, implementation: 'baseline/naive.mjs (own file, no core imports)' };
}
