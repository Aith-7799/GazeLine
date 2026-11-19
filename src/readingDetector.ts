/**
 * readingDetector - reading-pattern detection over the gaze sample buffer.
 *
 * A "read pass" is a mostly-monotonic leftright drift of the smoothed gaze x
 * that covers at least `minAmpFrac` of the viewport width, lasts `passMsMin`-
 * `passMsMax`, with small y change. Reading is typically followed by a quick
 * rightleft return sweep ("line break") and then another pass at a nearby y.
 * A passreturnpass triple is one cycle (one line read); the flag fires at
 * `requiredCycles` cycles within the buffer window. While cycles build up a
 * likelihood in [0, 1] is reported so the indicator is not just on/off.
 *
 * Pure functions only - src/app/app.ts feeds real gaze samples in, tests feed
 * synthetic traces in (tests/readingDetector.test.ts).
 */

export interface ReadingDetectionConfig {
  /** viewport width in CSS px - amplitudes are expressed as fractions of it */
  viewportWidth: number;
  /** viewport height in CSS px - y-band is expressed as a fraction of it */
  viewportHeight: number;
  /** buffer window length in ms */
  windowMs: number;
  /** fraction of viewport width a read pass must cover (default 0.12 - small-region aware) */
  minAmpFrac: number;
  /** absolute px floor for a sweep - tracker error is ~120px, so anything smaller is noise */
  ampPxFloor: number;
  /** pass duration band, ms (default 700-3000: slow, not a single fast jump) */
  passMsMin: number;
  passMsMax: number;
  /** max |net y drift| within one pass, as fraction of viewport WIDTH (kept width-based for legacy parity) */
  maxYDriftFrac: number;
  /** a return sweep must finish within this ms after a pass ends */
  maxReturnMs: number;
  /** max return duration that still counts as a line break */
  returnMsMax: number;
  /** max |y offset| between consecutive passes of a cycle chain, fraction of viewport HEIGHT */
  maxYOffsetFracH: number;
  /** max gap between a return end and the next pass start, ms */
  maxPassGapMs: number;
  /** same-region overlap fraction (0..1) - passes whose x-ranges overlap by >= this are in the same region */
  sameRegionOverlapFrac: number;
  /** y band fraction of viewport height - passes within this y band are treated as one reading region */
  yBandFracH: number;
  /** read passes required to flag (default 2). A "read pass" is one leftright
      sweep - the green bands in the debug plot. Reading is flagged as soon as
      this many passes are seen in the window. */
  requiredPasses: number;
  /** cycles required to flag (default 3) - kept for the cycle-chain readout */
  requiredCycles: number;
  /** backward travel (px) that ends a read pass. A retrace smaller than this is
      treated as a wobble and keeps the pass open, so a pass does not have to be a
      straight line (real gaze traces wiggle). */
  passReversalPx: number;
  /** minimum net/absolute travel ratio for a read pass: 1 = perfectly straight,
      a wavy pass walks further than it nets, so ~0.45 tolerates the wobble */
  passMonoMin: number;
  /** window ignored when more than this fraction of samples were null predictions */
  maxNullRatio: number;
  /** minimum valid (non-null) samples before anything is analyzed */
  minValidSamples: number;
  /** during the first `baselineWarmupMs` after calibration, record normal x variance and
      require reading sweeps to exceed it by `baselineAmpMul` (guards false positives) */
  baselineWarmupMs: number;
  /** multiplier on baseline x-amplitude a sweep must exceed to be accepted */
  baselineAmpMul: number;
  /** if true, count compact reading cycles even when gaze is pinned near the bottom edge */
  lowGazeEnabled: boolean;
  /** px from the bottom edge that counts as "pinned low" */
  lowGazePxFromBottom: number;
  /** deduction points each time the flag triggers */
  pointsPerDetection: number;
  /** cooldown ms after a deduction before the next one can fire on the same session (0 = no cooldown) */
  cooldownMs: number;
  /** default mode label shown when a flag fires */
  defaultModeLabel: string;

  // ---- sawtooth detector (slow rise + sudden drop) ----
  /** sawtooth window length in ms (default 30s, range 20-45s) */
  sawtoothWindowMs: number;
  /** smoothing window for slope estimation (default 7 samples) */
  sawtoothSmoothWin: number;
  /** minimum drop amplitude for a full return: max(frac * viewportWidth, pxFloor) */
  sawtoothReturnAmpFrac: number;
  /** absolute px floor for a full return drop */
  sawtoothReturnAmpPxFloor: number;
  /** max duration of a full return drop, ms (default 800ms) */
  sawtoothReturnMsMax: number;
  /** velocity threshold for detecting a drop: multiplier of viewportWidth px/s (default -1.5, negative = leftward) */
  sawtoothDropVelocityPxPerS: number;
  /** merge return detections within this ms of each other into one return */
  sawtoothReturnMergeMs: number;
  /** minimum dip amplitude for a PARTIAL return (counts 0.5 cycle): max(frac * viewportWidth, pxFloor) */
  sawtoothPartialAmpFrac: number;
  /** absolute px floor for a partial return dip */
  sawtoothPartialAmpPxFloor: number;
  /** minimum rise duration, ms (default 2000ms) */
  sawtoothRiseMsMin: number;
  /** maximum rise duration, ms (default 15000ms) */
  sawtoothRiseMsMax: number;
  /** minimum net rightward displacement for a rise: max(frac * viewportWidth, pxFloor) */
  sawtoothRiseAmpFrac: number;
  /** absolute px floor for a rise displacement */
  sawtoothRiseAmpPxFloor: number;
  /** max mean slope for a valid rise, in viewport-widths per second (default 0.4) */
  sawtoothRiseMaxSlopeFracPerS: number;
  /** minimum fraction of consecutive smoothed samples that are non-decreasing (default 0.55 - wavy rises allowed) */
  sawtoothRiseMonoFrac: number;
  /** max backward correction within a rise, px (wavy rises need headroom) */
  sawtoothRiseMaxBackwardPx: number;
  /** asymmetry: rise duration must be at least this many times the return duration */
  sawtoothAsymmetryMin: number;
  /** edge saturation threshold: within this frac of viewport edge counts as "pinned" */
  sawtoothEdgeSatFrac: number;
  /** min duration of continuous edge saturation to count as "saturated" (ms, default 300) */
  sawtoothEdgeSatMs: number;
  /** staircase score weight (0-1): supporting evidence from plateau-then-step patterns */
  sawtoothStaircaseWeight: number;
  /** coefficient of variation max for rise durations (default 0.7) - rhythm consistency */
  sawtoothCvMax: number;
  /** cycles (rise+return) required to flag. 2.5 = 3 cycles or 2 full + 1 partial. */
  sawtoothRequiredCycles: number;
  /** if true, run the sawtooth detector alongside the fast-pass detector */
  sawtoothEnabled: boolean;
}

export const DEFAULT_READING_CFG: ReadingDetectionConfig = {
  viewportWidth: 1280,
  viewportHeight: 900,
  windowMs: 8000,
  minAmpFrac: 0.12,
  ampPxFloor: 150,
  passMsMin: 700,
  passMsMax: 3000,
  maxYDriftFrac: 0.10,
  maxReturnMs: 2500,
  returnMsMax: 900,
  maxYOffsetFracH: 0.20,
  maxPassGapMs: 800,
  sameRegionOverlapFrac: 0.60,
  yBandFracH: 0.20,
  requiredPasses: 2,
  requiredCycles: 3,
  passReversalPx: 90,
  passMonoMin: 0.45,

  // ---- sawtooth detector (slow rise + sudden drop) ----
  sawtoothWindowMs: 30_000,
  sawtoothSmoothWin: 7,
  sawtoothReturnAmpFrac: 0.15,
  sawtoothReturnAmpPxFloor: 150,
  sawtoothReturnMsMax: 800,
  sawtoothDropVelocityPxPerS: -1.5,
  sawtoothReturnMergeMs: 500,
  sawtoothPartialAmpFrac: 0.08,
  sawtoothPartialAmpPxFloor: 100,
  sawtoothRiseMsMin: 2000,
  sawtoothRiseMsMax: 15_000,
  sawtoothRiseAmpFrac: 0.12,
  sawtoothRiseAmpPxFloor: 150,
  sawtoothRiseMaxSlopeFracPerS: 0.4,
  sawtoothRiseMonoFrac: 0.55,
  sawtoothRiseMaxBackwardPx: 30,
  sawtoothAsymmetryMin: 4,
  sawtoothEdgeSatFrac: 0.03,
  sawtoothEdgeSatMs: 300,
  sawtoothStaircaseWeight: 0.3,
  sawtoothCvMax: 0.7,
  sawtoothRequiredCycles: 3,
  sawtoothEnabled: true,

  maxNullRatio: 0.30,
  minValidSamples: 10,
  baselineWarmupMs: 30_000,
  baselineAmpMul: 2.0,
  lowGazeEnabled: true,
  lowGazePxFromBottom: 120,
  pointsPerDetection: 5,
  cooldownMs: 0,
  defaultModeLabel: 'reading',
};

export interface RunSegment {
  /** index into the smoothed point list */
  i0: number;
  i1: number;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** +1 read pass, -1 return sweep */
  kind: 1 | -1;
  /** true if the run participates in the best cycle chain (debug plot marks) */
  inChain: boolean;
  /** region id assigned during chaining (for debug shading) */
  regionId: number;
}

export interface ReadingDetectionResult {
  /** READING_PATTERN_DETECTED */
  flag: boolean;
  /** 0..1 reading likelihood while passes are still building up */
  likelihood: number;
  /** read passes (leftright sweeps) detected in the window - the flag gate */
  passCount: number;
  /** number of passreturnpass cycles detected in the window */
  cycles: number;
  nullRatio: number;
  validSamples: number;
  totalSamples: number;
  /** smoothed points over the window (for the debug plot) */
  points: GazePt[];
  /** classified runs (for the debug plot marks) */
  runs: RunSegment[];
  reason: string;
  /** widest detected reading region (x-range + y-band), or null */
  region: ReadingRegion | null;
  /** true when cycles were counted from low/bottom-edge gaze (phone case) */
  lowGaze: boolean;
  // ---- sawtooth-specific fields ----
  /** sawtooth mode detected: 'sawtooth' | 'fast-pass' | null */
  mode: 'sawtooth' | 'fast-pass' | null;
  /** sawtooth returns detected (for debug plot marks) */
  returns: SawtoothReturn[];
  /** sawtooth rises detected (for debug plot marks) */
  rises: SawtoothRise[];
}

export interface ReadingRegion {
  /** leftmost x of any pass in the region */
  xMin: number;
  /** rightmost x of any pass in the region */
  xMax: number;
  /** mean y of pass endpoints in the region */
  yMean: number;
  /** number of cycles attributed to this region */
  cycles: number;
  /** 'wide' if region spans > 50% of viewport, else 'compact' */
  mode: 'wide' | 'compact';
}

export interface GazePt { t: number; x: number; y: number }

/** Sawtooth return sweep - a sudden leftward drop. */
export interface SawtoothReturn {
  /** index into the smoothed points */
  i0: number;
  i1: number;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  /** displacement in px (negative = leftward) */
  dx: number;
  /** true if this is a full return, false if partial */
  full: boolean;
  /** cycle weight: 1 for full, 0.5 for partial */
  weight: number;
}

/** Sawtooth slow rise between two returns (or window boundary and a return). */
export interface SawtoothRise {
  /** index into the smoothed points */
  i0: number;
  i1: number;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  /** net displacement in px (positive = rightward) */
  dx: number;
  /** duration in ms */
  dur: number;
  /** mean slope in px/s */
  slopePxPerS: number;
  /** fraction of consecutive sample pairs that are non-decreasing */
  monoFrac: number;
  /** staircase score: count of plateau-then-step patterns (supporting evidence) */
  staircaseScore: number;
  /** true if the rise ends at the right edge (saturated) */
  saturatedRight: boolean;
}

/** Short moving average over a sliding window - kills jitter, keeps line geometry. */
export function smoothPoints(samples: GazePt[], win: number): GazePt[] {
  if (win < 1) win = 1;
  const out: GazePt[] = [];
  if (samples.length < win) return out;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumX += s.x;
    sumY += s.y;
    if (i >= win) {
      const old = samples[i - win]!;
      sumX -= old.x;
      sumY -= old.y;
    }
    if (i >= win - 1) {
      const mid = samples[Math.floor((i - win + 1 + i) / 2)]!;
      out.push({ t: mid.t, x: sumX / win, y: sumY / win });
    }
  }
  return out;
}

const SMOOTH_WIN = 8;      // ~8 samples � 130 ms at rAF rate - short, not sluggish
const FLAT_PX = 3;         // smaller x moves are treated as pauses inside a run

function classifyRun(
  pts: GazePt[], i0: number, i1: number, kind: 1 | -1, cfg: ReadingDetectionConfig,
): RunSegment | null {
  const a = pts[i0]!, b = pts[i1]!;
  const dx = b.x - a.x;
  const dur = b.t - a.t;
  const W = cfg.viewportWidth;
  const ampFloor = Math.max(cfg.minAmpFrac * W, cfg.ampPxFloor);

  if (kind === 1) {
    // read pass: leftright, wide enough (frac OR absolute floor), slow,
    // small y change
    if (dx < ampFloor) return null;
    if (dur < cfg.passMsMin || dur > cfg.passMsMax) return null;
    if (Math.abs(b.y - a.y) > cfg.maxYDriftFrac * W) return null;
  } else {
    // return sweep: rightleft, token amplitude (also floored), small y change.
    // NOTE: no duration rejection here - a moving-average-smoothed trace smears
    // a fast 200 ms sweep across the surrounding ~300 ms pauses, so smoothed
    // spans overstate the sweep time; the chain check constrains timing instead.
    if (dx > -Math.max(0.2 * ampFloor, 40)) return null;
    if (Math.abs(b.y - a.y) > cfg.maxYDriftFrac * W * 2) return null;
  }

  // monotonicity: net |dx| vs total |dx| walked along the run. Real gaze traces
  // wiggle, so a wavy pass walks further than it nets - the threshold only has to
  // reject traces with no net direction at all.
  let abs = 0;
  for (let i = i0; i < i1; i++) abs += Math.abs(pts[i + 1]!.x - pts[i]!.x);
  if (Math.abs(dx) / Math.max(abs, 1) < cfg.passMonoMin) return null;

  return { i0, i1, t0: a.t, t1: b.t, x0: a.x, x1: b.x, y0: a.y, y1: b.y, kind, inChain: false, regionId: -1 };
}

/**
 * Split the smoothed trace into directional runs and classify each as a pass,
 * a return or neither.
 *
 * A run is tracked from its extreme rather than from the previous sample: the run
 * stays open while the gaze keeps travelling (or retraces less than
 * `passReversalPx`), and only closes when it retraces more than that past its
 * running extreme. Small wobbles therefore stay inside one run, so a wavy
 * leftright sweep (see the gaze-x plot) is still one read pass instead of a
 * shower of 5-px fragments. Runs share their boundary index (the turn point).
 */
export function findRuns(pts: GazePt[], cfg: ReadingDetectionConfig): RunSegment[] {
  const runs: RunSegment[] = [];
  if (pts.length < 3) return runs;

  const reversalPx = Math.max(FLAT_PX, cfg.passReversalPx);

  // indices where the direction of travel actually changes (ignoring pauses and wobbles)
  const breaks: number[] = [];
  let dir: 0 | 1 | -1 = 0;
  let extremeX = pts[0]!.x;
  let extremeIdx = 0;
  let movedIdx = 0; // last sample that travelled in the current direction
  for (let i = 1; i < pts.length; i++) {
    const x = pts[i]!.x;
    if (dir === 0) {
      if (Math.abs(x - extremeX) <= FLAT_PX) continue; // pause before the first move
      dir = x > extremeX ? 1 : -1;
      extremeX = x; extremeIdx = i; movedIdx = i;
      continue;
    }
    const along = (x - extremeX) * dir;
    if (along >= 0) {
      // still travelling (or flat) in the current direction: extend the run
      if (along > 0) { extremeX = x; extremeIdx = i; }
      movedIdx = i;
    } else if (-along > reversalPx) {
      // a real turn: close the run at its extreme, start the next one there
      breaks.push(extremeIdx);
      dir = dir === 1 ? -1 : 1;
      extremeX = x; extremeIdx = i; movedIdx = i;
    }
    // else: a small retrace - wobble, keep the run open
  }
  breaks.push(movedIdx); // final boundary: end of the last moving run

  // run k spans [breaks[k-1] .. breaks[k]] (first run starts at 0)
  const bounds = [0, ...breaks];
  for (let k = 1; k < bounds.length; k++) {
    const a = bounds[k - 1]!, b = bounds[k]!;
    if (b <= a) continue;
    // direction of this run: sign of net dx across it
    const net = pts[b]!.x - pts[a]!.x;
    if (net === 0) continue;
    const kind = net > 0 ? 1 : -1;
    const seg = classifyRun(pts, a, b, kind, cfg);
    if (seg) runs.push(seg);
  }
  return runs;
}

/**
 * Build reading regions from pass runs. Two passes belong to the same region if
 * their x-ranges overlap by at least `sameRegionOverlapFrac` and their y positions
 * sit within `yBandFracH` of viewport height. Regions are used to count cycles
 * locally - a compact phone-reading session and a wide-screen teleprompter session
 * both feed the same cycle counter.
 *
 * Also returns the widest region (for debug shading) and whether any region sat at
 * the bottom edge (low-gaze / phone case).
 */
export function buildRegions(
  passRuns: RunSegment[],
  cfg: ReadingDetectionConfig,
): { regions: ReadingRegion[]; lowGaze: boolean } {
  const VH = cfg.viewportHeight;
  const regions: ReadingRegion[] = [];
  let lowGaze = false;

  for (const p of passRuns) {
    let home = regions.find(r => {
      const overlap = Math.max(0, Math.min(p.x1, r.xMax) - Math.max(p.x0, r.xMin));
      const minSpan = Math.min(p.x1 - p.x0, r.xMax - r.xMin);
      if (minSpan <= 0) return false;
      if (overlap / minSpan < cfg.sameRegionOverlapFrac) return false;
      if (Math.abs(p.y0 - r.yMean) > cfg.yBandFracH * VH &&
          Math.abs(p.y1 - r.yMean) > cfg.yBandFracH * VH) return false;
      return true;
    });
    if (!home) {
      home = {
        xMin: p.x0, xMax: p.x1,
        yMean: (p.y0 + p.y1) / 2,
        cycles: 0,
        mode: (p.x1 - p.x0) > 0.5 * cfg.viewportWidth ? 'wide' : 'compact',
      };
      regions.push(home);
    } else {
      home.xMin = Math.min(home.xMin, p.x0);
      home.xMax = Math.max(home.xMax, p.x1);
      home.yMean = (home.yMean + (p.y0 + p.y1) / 2) / 2;
    }
    // Update mode based on the full region span, not just this pass
    const span = home.xMax - home.xMin;
    home.mode = span > 0.5 * cfg.viewportWidth ? 'wide' : 'compact';
    // low-gaze: pass endpoint y within `lowGazePxFromBottom` of viewport bottom
    if (cfg.lowGazeEnabled && (VH - p.y1) < cfg.lowGazePxFromBottom) lowGaze = true;
  }
  return { regions, lowGaze };
}

/**
 * Chain runs into passreturnpass cycles within regions. One cycle = one line read:
 * a pass, a qualifying quick return, then another pass (same region) whose start-y sits
 * within maxYOffsetFracH of the previous pass's end-y. Consecutive cycles
 * share a boundary: pass,return,pass,return,pass counts as 2 cycles.
 * Returns the best chain's cycle count, marks those runs inChain, assigns region ids,
 * and reports whether the winning region was low-gaze.
 */
export function chainCycles(runs: RunSegment[], cfg: ReadingDetectionConfig): { cycles: number; lowGaze: boolean; region: ReadingRegion | null } {
  const VH = cfg.viewportHeight;
  // pass runs only, in time order
  const passRuns: RunSegment[] = runs.filter(r => r.kind === 1);
  const { regions, lowGaze } = buildRegions(passRuns, cfg);

  // attach a region id to each pass (and via chain, to returns that sit between two passes)
  let best = 0;
  let bestLo = -1, bestHi = -1;
  let bestRegion: ReadingRegion | null = null;
  let bestLowGaze = false;

  for (let lo = 0; lo < runs.length; lo++) {
    if (runs[lo]!.kind !== 1) continue;
    const startPass = runs[lo]!;
    const startRegion = regions.find(r => {
      const overlap = Math.max(0, Math.min(startPass.x1, r.xMax) - Math.max(startPass.x0, r.xMin));
      const minSpan = Math.min(startPass.x1 - startPass.x0, r.xMax - r.xMin);
      if (minSpan <= 0) return false;
      return overlap / minSpan >= cfg.sameRegionOverlapFrac;
    });
    if (!startRegion) continue;

    let p = startPass;
    let cycles = 0;
    let k = lo;
    for (;;) {
      const r = runs[k + 1];
      const p2 = runs[k + 2];
      if (!r || r.kind !== -1) break;
      if (r.t1 - p.t1 > cfg.maxReturnMs) break;
      if (!p2 || p2.kind !== 1) break;
      if (p2.t0 - r.t1 > cfg.maxPassGapMs) break;
      // same-region check: p2 belongs to the same region as the chain's region
      const p2Region = regions.find(rg => {
        const overlap = Math.max(0, Math.min(p2.x1, rg.xMax) - Math.max(p2.x0, rg.xMin));
        const minSpan = Math.min(p2.x1 - p2.x0, rg.xMax - rg.xMin);
        if (minSpan <= 0) return false;
        return overlap / minSpan >= cfg.sameRegionOverlapFrac;
      });
      if (!p2Region || p2Region !== startRegion) break;
      // y proximity within the band
      if (Math.abs(p2.y0 - p.y1) > cfg.maxYOffsetFracH * VH) break;
      cycles++;
      p = p2;
      k += 2;
    }
    if (cycles > best) {
      best = cycles;
      bestLo = lo;
      bestHi = k;
      bestRegion = startRegion;
      bestLowGaze = lowGaze && (VH - startPass.y1) < cfg.lowGazePxFromBottom;
    }
    lo += Math.max(k - lo, 1);
  }

  if (bestLo >= 0) {
    for (let k = bestLo; k <= Math.min(bestHi, runs.length - 1); k++) {
      runs[k]!.inChain = true;
      if (runs[k]!.kind === 1) {
        const rg = regions.find(r => {
          const overlap = Math.max(0, Math.min(runs[k]!.x1, r.xMax) - Math.max(runs[k]!.x0, r.xMin));
          const minSpan = Math.min(runs[k]!.x1 - runs[k]!.x0, r.xMax - r.xMin);
          return minSpan > 0 && overlap / minSpan >= cfg.sameRegionOverlapFrac;
        });
        runs[k]!.regionId = rg ? regions.indexOf(rg) : -1;
      }
    }
  } else {
    // still tag pass runs with region ids for debug shading even when no cycle chain wins
    for (const r of runs) {
      if (r.kind !== 1) continue;
      const rg = regions.find(rg => {
        const overlap = Math.max(0, Math.min(r.x1, rg.xMax) - Math.max(r.x0, rg.xMin));
        const minSpan = Math.min(r.x1 - r.x0, rg.xMax - rg.xMin);
        return minSpan > 0 && overlap / minSpan >= cfg.sameRegionOverlapFrac;
      });
      r.regionId = rg ? regions.indexOf(rg) : -1;
    }
  }

  return {
    cycles: best,
    lowGaze: bestLowGaze,
    region: bestRegion,
  };
}

/**
 * Detect sudden leftward drops (returns) in the smoothed trace.
 * Uses velocity-based detection: a drop faster than `dropVelocityThreshold` px/s,
 * with cumulative displacement >= returnAmpFloor within `returnMsMax`.
 * Merges detections within `mergeMs` of each other.
 * Also finds partial returns (smaller dips) that count as 0.5 cycle.
 */
export function detectSawtoothReturns(
  pts: GazePt[],
  cfg: ReadingDetectionConfig,
): SawtoothReturn[] {
  const W = cfg.viewportWidth;
  const returnAmpFloor = Math.max(cfg.sawtoothReturnAmpFrac * W, cfg.sawtoothReturnAmpPxFloor);
  const partialAmpFloor = Math.max(cfg.sawtoothPartialAmpFrac * W, cfg.sawtoothPartialAmpPxFloor);
  const returnMsMax = cfg.sawtoothReturnMsMax;
  const mergeMs = cfg.sawtoothReturnMergeMs;
  const dropVel = cfg.sawtoothDropVelocityPxPerS * W; // px/s, negative

  // sliding window: for each point, look back up to returnMsMax to find the best drop
  const returns: SawtoothReturn[] = [];
  const iWindow = Math.max(2, Math.ceil(returnMsMax / 25)); // ~25ms per sample

  let i = 0;
  while (i < pts.length) {
    // find the peak (max x) in the lookback window before i
    const lookbackStart = Math.max(0, i - iWindow);
    let peakIdx = lookbackStart;
    for (let j = lookbackStart; j < i; j++) {
      if (pts[j]!.x > pts[peakIdx]!.x) peakIdx = j;
    }
    const peak = pts[peakIdx]!;
    const cur = pts[i]!;
    const dt = cur.t - peak.t;
    if (dt > returnMsMax || dt <= 0) { i++; continue; }

    const dx = cur.x - peak.x; // negative for drops
    const velocity = dx / (dt / 1000); // px/s

    // Full return: fast drop with enough displacement
    if (dx <= -returnAmpFloor && velocity <= dropVel) {
      returns.push({
        i0: peakIdx, i1: i, t0: peak.t, t1: cur.t,
        x0: peak.x, x1: cur.x, dx,
        full: true, weight: 1,
      });
      i += Math.ceil(mergeMs / 25); // skip ahead to avoid double-counting
      continue;
    }

    // Partial return: smaller dip but still leftward, followed by continued rising
    if (dx <= -partialAmpFloor && velocity <= dropVel * 0.5) {
      // check that after this dip, x rises again (not just continued dropping)
      const afterIdx = Math.min(i + iWindow, pts.length - 1);
      const after = pts[afterIdx]!;
      if (after.x > cur.x + partialAmpFloor * 0.3) {
        returns.push({
          i0: peakIdx, i1: i, t0: peak.t, t1: cur.t,
          x0: peak.x, x1: cur.x, dx,
          full: false, weight: 0.5,
        });
      }
      i += Math.ceil(mergeMs / 25);
      continue;
    }
    i++;
  }

  // merge returns within mergeMs of each other
  if (returns.length <= 1) return returns;
  const merged: SawtoothReturn[] = [];
  for (const r of returns) {
    const last = merged[merged.length - 1];
    if (last && r.t0 - last.t1 <= mergeMs && last.full === r.full) {
      // keep the one with larger displacement
      if (Math.abs(r.dx) > Math.abs(last.dx)) {
        last.i1 = r.i1; last.t1 = r.t1; last.x1 = r.x1; last.dx = r.dx;
      }
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Detect slow rises between consecutive returns (or window boundaries).
 * A valid rise must satisfy duration, amplitude, slope, monotonicity, and asymmetry checks.
 * Handles edge saturation: if x is pinned near viewport edges, treat as "saturated" and
 * use the clamped extremes for displacement calculation.
 */
export function detectSawtoothRises(
  pts: GazePt[],
  returns: SawtoothReturn[],
  cfg: ReadingDetectionConfig,
): SawtoothRise[] {
  const W = cfg.viewportWidth;
  const riseAmpFloor = Math.max(cfg.sawtoothRiseAmpFrac * W, cfg.sawtoothRiseAmpPxFloor);
  const riseMsMin = cfg.sawtoothRiseMsMin;
  const riseMsMax = cfg.sawtoothRiseMsMax;
  const maxSlope = cfg.sawtoothRiseMaxSlopeFracPerS * W; // px/s
  const monoFrac = cfg.sawtoothRiseMonoFrac;
  const maxBackwardPx = cfg.sawtoothRiseMaxBackwardPx;
  const asymmetryMin = cfg.sawtoothAsymmetryMin;
  const edgeSatFrac = cfg.sawtoothEdgeSatFrac;
  const edgeSatMs = cfg.sawtoothEdgeSatMs;
  void asymmetryMin;
  const edgeThreshold = edgeSatFrac * W;
  const smoothWin = cfg.sawtoothSmoothWin;
  const smoothPts = smoothPoints(pts, smoothWin);

  // build boundaries: window start, each return end, window end
  const boundaries: Array<{ t: number; x: number; idx: number; isReturn: boolean; ret?: SawtoothReturn }> = [
    { t: pts[0]!.t, x: pts[0]!.x, idx: 0, isReturn: false },
  ];
  for (const r of returns) {
    // find the smoothed index closest to the return end
    let idx = 0;
    let bestDt = Infinity;
    for (let j = 0; j < smoothPts.length; j++) {
      const dt = Math.abs(smoothPts[j]!.t - r.t1);
      if (dt < bestDt) { bestDt = dt; idx = j; }
    }
    boundaries.push({ t: smoothPts[idx]!.t, x: smoothPts[idx]!.x, idx, isReturn: true, ret: r });
  }
  boundaries.push({ t: pts[pts.length - 1]!.t, x: pts[pts.length - 1]!.x, idx: smoothPts.length - 1, isReturn: false });

  const rises: SawtoothRise[] = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const start = boundaries[b]!;
    const end = boundaries[b + 1]!;
    if (end.idx <= start.idx + 1) continue;


    // extract the rise segment from smoothPts
    const seg = smoothPts.slice(start.idx, end.idx + 1);
    if (seg.length < 3) continue;

    const dur = end.t - start.t;
    if (dur < riseMsMin || dur > riseMsMax) continue;

    // displacement: use clamped extremes for edge saturation
    let x0 = seg[0]!.x, x1 = seg[seg.length - 1]!.x;
    let saturatedRight = false;
    // left-edge saturation tracked but unused for now

    // check for right-edge saturation at end
    if (W - x1 < edgeThreshold) {
      // find how long x stayed near the right edge
      let satStart = seg.length - 1;
      while (satStart > 0 && W - seg[satStart]!.x < edgeThreshold) satStart--;
      const satDur = seg[seg.length - 1]!.t - seg[satStart]!.t;
      if (satDur >= edgeSatMs) {
        saturatedRight = true;
        x1 = W; // use viewport edge as the true value
      }
    }
    // check for left-edge saturation at start
    if (x0 < edgeThreshold) {
      let satEnd = 0;
      while (satEnd < seg.length - 1 && seg[satEnd]!.x < edgeThreshold) satEnd++;
      const satDur = seg[satEnd]!.t - seg[0]!.t;
      if (satDur >= edgeSatMs) {
        // saturatedLeft = true; // left-edge saturation, unused for now
        x0 = 0;
      }
    }

    const dx = x1 - x0;
    if (dx < riseAmpFloor) continue;

    // mean slope
    const slopePxPerS = dx / (dur / 1000);
    if (slopePxPerS > maxSlope) continue;

    // monotonicity: fraction of consecutive pairs that are non-decreasing
    let nonDecreasing = 0;
    let validPairs = 0;
    let totalBackward = 0;
    for (let i = 0; i < seg.length - 1; i++) {
      const delta = seg[i + 1]!.x - seg[i]!.x;
      validPairs++;
      if (delta >= -maxBackwardPx) {
        nonDecreasing++;
      } else {
        totalBackward += Math.abs(delta);
      }
    }
    const actualMonoFrac = validPairs > 0 ? nonDecreasing / validPairs : 0;
    if (actualMonoFrac < monoFrac) continue;
    // also check total backward correction isn't too large (wavy rises allowed)
    if (totalBackward > riseAmpFloor * 0.5) continue;

    // staircase score: count plateau-then-step patterns
    let staircaseScore = 0;
    let inPlateau = false;
    let plateauStart = 0;
    for (let i = 1; i < seg.length; i++) {
      const delta = seg[i]!.x - seg[i - 1]!.x;
      if (Math.abs(delta) <= maxBackwardPx) {
        if (!inPlateau) { inPlateau = true; plateauStart = i - 1; }
      } else if (inPlateau && delta > 0) {
        const plateauDur = seg[i - 1]!.t - seg[plateauStart]!.t;
        if (plateauDur >= 200 && plateauDur <= 1000 && delta > 20) {
          staircaseScore++;
        }
        inPlateau = false;
      } else {
        inPlateau = false;
      }
    }

    rises.push({
      i0: start.idx, i1: end.idx,
      t0: start.t, t1: end.t,
      x0, x1, dx, dur,
      slopePxPerS,
      monoFrac: actualMonoFrac,
      staircaseScore,
      saturatedRight,
    });
  }

  return rises;
}

/**
 * Count sawtooth cycles: each valid rise + its following return = 1 cycle.
 * Partial returns count as 0.5. Apply rhythm consistency (CV of rise durations)
 * and asymmetry checks.
 */
export function countSawtoothCycles(
  rises: SawtoothRise[],
  returns: SawtoothReturn[],
  cfg: ReadingDetectionConfig,
): { cycles: number; weightedCycles: number; cvOk: boolean } {
  if (rises.length === 0 || returns.length === 0) {
    return { cycles: 0, weightedCycles: 0, cvOk: true };
  }

  // match each rise to the return that follows it
  let weightedCycles = 0;
  const paired: Array<{ rise: SawtoothRise; ret: SawtoothReturn }> = [];
  let retIdx = 0;

  for (const rise of rises) {
    // find the first return that starts after this rise ends
    while (retIdx < returns.length && returns[retIdx]!.t0 < rise.t1) retIdx++;
    if (retIdx >= returns.length) break;
    const ret = returns[retIdx]!;
    const retDur = Math.max(ret.t1 - ret.t0, 1);
    const asymmetry = rise.dur / retDur;
    if (asymmetry < cfg.sawtoothAsymmetryMin) continue;
    paired.push({ rise, ret });
    weightedCycles += ret.weight;
    retIdx++;
  }

  // rhythm consistency: CV of rise durations
  const durations = paired.map(p => p.rise.dur);
  const cvOk = durations.length >= 2
    ? (() => {
        const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
        if (mean === 0) return false;
        const variance = durations.reduce((a, b) => a + (b - mean) ** 2, 0) / durations.length;
        const std = Math.sqrt(variance);
        return std / mean <= cfg.sawtoothCvMax;
      })()
    : true;

  return {
    cycles: paired.length,
    weightedCycles,
    cvOk,
  };
}

/**
 * Main entry: analyze a buffer window (GazeSample | NullSample entries) and
 * decide whether a reading pattern is present.
 *
 * Runs BOTH the legacy fast-pass detector AND the new sawtooth detector, then
 * picks the one that finds read passes - the flag fires at `requiredPasses`
 * (default 2) read passes in the window.
 *
 * New in this pass:
 *  - amplitude floor (frac of viewport OR absolute px, whichever is larger)
 *  - region-aware cycle chaining (wide vs compact)
 *  - low-gaze / phone-edge detection
 *  - baseline amplitude guard (first 30s after warmup)
 *  - speak-while-looking-at-camera guard: we do NOT have a mic-derived signal here,
 *    so the guard is exposed as a hook the app layer can call when it knows the
 *    candidate is speaking AND looking near the camera. When that hook fires for a
 *    window, reading is suppressed for that window.
 */
export function analyze(
  buffer: ReadonlyArray<{ t: number; x?: number; y?: number; nullPredict?: boolean }>,
  cfg: ReadingDetectionConfig,
  options?: AnalyzeOptions,
): ReadingDetectionResult {
  const total = buffer.length;
  let nulls = 0;
  const valid: GazePt[] = [];
  for (const e of buffer) {
    if (e.nullPredict === true) { nulls++; continue; }
    if (typeof e.x === 'number' && typeof e.y === 'number') {
      valid.push({ t: e.t, x: e.x, y: e.y });
    }
  }
  const nullRatio = total ? nulls / total : 0;
  const base: ReadingDetectionResult = {
    flag: false, likelihood: 0, passCount: 0, cycles: 0,
    nullRatio, validSamples: valid.length, totalSamples: total,
    points: [], runs: [], reason: '',
    region: null, lowGaze: false,
    mode: null, returns: [], rises: [],
  };
  if (valid.length < cfg.minValidSamples) {
    base.reason = `insufficient valid samples (${valid.length}/${cfg.minValidSamples})`;
    return base;
  }
  if (nullRatio > cfg.maxNullRatio) {
    base.reason = `face missing in ${Math.round(nullRatio * 100)}% of window - ignored`;
    return base;
  }

  // speak-while-looking guard: if the app tells us the candidate was speaking AND
  // looking at the camera for this window, suppress reading detection for it.
  if (options?.speakingAtCamera) {
    base.reason = 'speaking while looking at camera - reading suppressed this window';
    return base;
  }

  const pts = smoothPoints(valid, SMOOTH_WIN);
  if (pts.length < 3) { base.reason = 'not enough smoothed points'; return base; }

  const baseline = options?.baselineAmplitude;
  const effectiveBaselineFloor = baseline != null ? baseline * cfg.baselineAmpMul : 0;

  // ---- LEGACY FAST-PASS DETECTOR (0.7-3s passes, pass->return->pass cycles) ----
  // pts is already smoothed once; use it directly (no double-smoothing)
  const runs = findRuns(pts, cfg);
  const filteredRuns: RunSegment[] = runs.map(r => {
    if (r.kind === 1) {
      const amp = r.x1 - r.x0;
      if (amp < effectiveBaselineFloor) return null as any;
    }
    return r;
  }).filter((r): r is RunSegment => r !== null);
  const chain = chainCycles(filteredRuns, cfg);

  // ---- SAWTOOTH DETECTOR (slow rise 2-15s + sudden drop <0.8s) ----
  // Only run if enabled in config
  const sawtoothReturns: SawtoothReturn[] = [];
  const sawtoothRises: SawtoothRise[] = [];
  const sawtoothCycleCount = { cycles: 0, weightedCycles: 0, cvOk: true };
  let sawtoothPts: typeof pts = pts; // used when sawtooth mode is active
  if (cfg.sawtoothEnabled) {
    sawtoothPts = smoothPoints(valid, cfg.sawtoothSmoothWin);
    const rawReturns = detectSawtoothReturns(sawtoothPts, cfg);
    const rawRises = detectSawtoothRises(sawtoothPts, rawReturns, cfg);
    const rawCycleCount = countSawtoothCycles(rawRises, rawReturns, cfg);
    sawtoothReturns.push(...rawReturns);
    sawtoothRises.push(...rawRises);
    Object.assign(sawtoothCycleCount, rawCycleCount);
  }

  // ---- PICK THE BEST DETECTOR ----
  // A "read pass" is one leftright sweep: in fast-pass mode the classified pass
  // runs, in sawtooth mode the valid slow rises. The flag fires as soon as
  // `requiredPasses` of them are seen in the window (default 2).
  const fastPassCount = filteredRuns.filter((r) => r.kind === 1).length;
  const sawPassCount = sawtoothRises.length;
  const sawtoothWeighted = sawtoothCycleCount.weightedCycles;
  const fastFlag = fastPassCount >= cfg.requiredPasses;
  const sawFlag = cfg.sawtoothEnabled
    && sawPassCount >= cfg.requiredPasses
    && sawtoothCycleCount.cvOk;

  // The fast-pass detector has better region tracking (wide vs compact), so prefer
  // it when it already flags. Sawtooth is the fallback for slow reading the
  // fast-pass detector cannot see (e.g., 4-12s rises).
  const useSawtooth = !fastFlag && sawFlag;

  if (useSawtooth) {
    base.points = sawtoothPts;
    base.runs = []; // no fast-pass runs in sawtooth mode
    base.mode = 'sawtooth';
    base.returns = sawtoothReturns;
    base.rises = sawtoothRises;
    base.passCount = sawPassCount;
    base.cycles = sawtoothCycleCount.cycles;
    base.likelihood = Math.min(1, Math.max(
      sawPassCount / cfg.requiredPasses,
      sawtoothWeighted / cfg.sawtoothRequiredCycles,
    ));
    base.flag = sawFlag;
    base.reason = base.flag
      ? `sawtooth: ${sawPassCount} read rises/passes + ${sawtoothReturns.length} returns (${sawtoothWeighted.toFixed(1)} weighted cycles) in ${Math.round(cfg.sawtoothWindowMs / 1000)}s window`
      : sawPassCount > 0
        ? `${sawPassCount} of ${cfg.requiredPasses} required read passes (${sawtoothCycleCount.cycles} rises)`
        : sawtoothReturns.length
          ? `${sawtoothReturns.length} returns detected, no valid rises`
          : 'no sawtooth pattern';
    // region from rises: use the widest rise's x-range
    if (sawtoothRises.length > 0) {
      const bestRise = sawtoothRises.reduce((a, b) => (b.dx > a.dx ? b : a));
      base.region = {
        xMin: Math.min(bestRise.x0, bestRise.x1),
        xMax: Math.max(bestRise.x0, bestRise.x1),
        yMean: 300, // sawtooth doesn't track y-band; placeholder
        cycles: sawtoothCycleCount.cycles,
        mode: (bestRise.x1 - bestRise.x0) > 0.5 * cfg.viewportWidth ? 'wide' : 'compact',
      };
    }
    base.lowGaze = false; // sawtooth doesn't do low-gaze yet
  } else {
    // legacy fast-pass result
    base.points = pts;
    base.runs = filteredRuns;
    base.mode = 'fast-pass';
    base.returns = [];
    base.rises = [];
    base.passCount = fastPassCount;
    base.cycles = chain.cycles;
    base.region = chain.region;
    base.lowGaze = chain.lowGaze;
    base.likelihood = Math.min(1, fastPassCount / cfg.requiredPasses);
    base.flag = fastFlag;
    base.reason = base.flag
      ? `fast-pass: ${fastPassCount} read passes (${chain.cycles} cycles) in ${Math.round(cfg.windowMs / 1000)}s window${chain.lowGaze ? ' (low-gaze/phone)' : ''}`
      : fastPassCount > 0
        ? `${fastPassCount} of ${cfg.requiredPasses} required read passes (${chain.cycles} cycles)`
        : filteredRuns.length
          ? `${filteredRuns.length} runs classified, no read pass`
          : 'no reading pattern';
  }

  return base;
}

/** Options passed into analyze() by the app layer. */
export interface AnalyzeOptions {
  /** If true, the candidate was speaking and looking at the camera in this window. */
  speakingAtCamera?: boolean;
  /** Largest single-pass x amplitude seen during the baseline warmup (CSS px). */
  baselineAmplitude?: number;
}

/**
 * Update a running baseline amplitude from a fresh window of valid samples.
 * Called by the app layer during the first `baselineWarmupMs` after calibration.
 * Returns the largest single monotonic-run x amplitude seen so far, or null if
 * there wasn't enough signal to establish a baseline.
 */
export function updateBaseline(
  buffer: ReadonlyArray<{ t: number; x?: number; y?: number; nullPredict?: boolean }>,
  cfg: ReadingDetectionConfig,
): number | null {
  const valid: GazePt[] = [];
  for (const e of buffer) {
    if (e.nullPredict === true) continue;
    if (typeof e.x === 'number' && typeof e.y === 'number') {
      valid.push({ t: e.t, x: e.x, y: e.y });
    }
  }
  if (valid.length < cfg.minValidSamples) return null;
  const pts = smoothPoints(valid, SMOOTH_WIN);
  if (pts.length < 3) return null;
  const runs = findRuns(pts, cfg);
  let maxAmp = 0;
  for (const r of runs) {
    if (r.kind !== 1) continue;
    const amp = r.x1 - r.x0;
    if (amp > maxAmp) maxAmp = amp;
  }
  return maxAmp > cfg.ampPxFloor ? maxAmp : null;
}

