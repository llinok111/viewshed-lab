// baseline/naive.mjs -- the definitional, non-incremental baseline for viewshed-lab.
// Exists ONLY to be timed and diffed against; src/core.mjs never imports it.
//
//   baselineAllPairs: O(n^2) -- for every target cell, rescan the whole field and
//   keep the maximum slope over same-sector, strictly-nearer cells. This is the
//   plain reading of the model (see the model comment in src/core.mjs), with no
//   ordering tricks, no incremental state, no re-use of the fast path's arrays.
//
// The fast path is expected to produce the SAME mask with n-1 comparisons.
export { allPairsViewshed as baselineAllPairs } from '../src/core.mjs';
