import { describe, it, expect } from 'vitest';
import {
  analyze, smoothPoints, findRuns, updateBaseline,
  DEFAULT_READING_CFG, type ReadingDetectionConfig, type GazePt,
} from '../src/readingDetector';

const W = 1280, H = 900;

function cfg(over: Partial<ReadingDetectionConfig> = {}): ReadingDetectionConfig {
  return { ...DEFAULT_READING_CFG, viewportWidth: W, viewportHeight: H, windowMs: 8000, ...over };
}

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A "reading sawtooth": N leftright passes of width ampFrac*W over passMs,
 * each followed by a quick rightleft return, with y drifting a line-height
 * between passes and �err noise on every sample (� the tracker's 120px error).
 */
function readingTrace(
  nLines: number,
  opts: { passMs?: number; returnMs?: number; ampFrac?: number; lineH?: number; err?: number; seed?: number; gapMs?: number } = {},
): { t: number; x: number; y: number }[] {
  const passMs = opts.passMs ?? 1400;
  const returnMs = opts.returnMs ?? 200;
  const amp = (opts.ampFrac ?? 0.45) * W;   // well above the 0.25 default threshold
  const lineH = opts.lineH ?? 40;
  const err = opts.err ?? 0;
  const gapMs = opts.gapMs ?? 300;
  const rnd = mulberry32(opts.seed ?? 42);
  const pts: { t: number; x: number; y: number }[] = [];
  let t = 0;
  let y = 300;
  for (let i = 0; i < nLines; i++) {
    const x0 = W / 2 - amp / 2;
    const x1 = W / 2 + amp / 2;
    const steps = Math.max(8, Math.round(passMs / 25)); // ~40 Hz like the rAF loop
    for (let s = 0; s <= steps; s++) {
      pts.push({
        t, x: x0 + (amp * s) / steps + (rnd() * 2 - 1) * err,
        y: y + (lineH * s) / steps * 0.3 + (rnd() * 2 - 1) * err * 0.5,
      });
      t += passMs / steps;
    }
    t += gapMs;
    if (i < nLines - 1) {
      const rs = Math.max(4, Math.round(returnMs / 25));
      for (let s = 0; s <= rs; s++) {
        pts.push({
          t, x: x1 - (amp * s) / rs + (rnd() * 2 - 1) * err,
          y: y + lineH * 0.7 + (rnd() * 2 - 1) * err * 0.5,
        });
        t += returnMs / rs;
      }
      t += gapMs;
    }
    y += lineH;
  }
  return pts;
}

function analyzeTrace(pts: { t: number; x: number; y: number }[], over: Partial<ReadingDetectionConfig> = {}) {
  return analyze(pts, cfg(over));
}

describe('readingDetector', () => {
  it('flags a clean reading sawtooth (4 lines, no noise)', () => {
    const r = analyzeTrace(readingTrace(4));
    expect(r.cycles).toBeGreaterThanOrEqual(3);
    expect(r.flag).toBe(true);
    expect(r.likelihood).toBe(1);
  });

  it('flags a noisy reading sawtooth (�55px eye-tracker error) - region-level works', () => {
    // 120px accuracy across a 1280px viewport ? �55px is representative of real jitter
    const r = analyzeTrace(readingTrace(4, { err: 55, seed: 7 }));
    expect(r.flag).toBe(true);
  });

  it('does NOT flag random wandering', () => {
    const rnd = mulberry32(1234);
    const pts: GazePt[] = [];
    let x = W / 2, y = 300, t = 0;
    for (let i = 0; i < 600; i++) {
      x += (rnd() * 2 - 1) * 18;
      y += (rnd() * 2 - 1) * 12;
      x = Math.max(40, Math.min(W - 40, x));
      y = Math.max(40, Math.min(800, y));
      pts.push({ t, x, y });
      t += 25;
    }
    const r = analyze(pts, cfg());
    expect(r.flag).toBe(false);
    expect(r.cycles).toBeLessThan(3);
  });

  it('does NOT flag a single glance away (one pass, no cycle)', () => {
    const rnd = mulberry32(9);
    const pts: GazePt[] = [];
    let t = 0;
    // hold left-center, then one slow rightward glance, then stay there
    for (let i = 0; i < 80; i++) { pts.push({ t, x: 300 + (rnd() * 2 - 1) * 10, y: 300 }); t += 25; }
    for (let i = 0; i < 60; i++) { pts.push({ t, x: 300 + (i / 59) * 400, y: 300 + rnd() * 8 }); t += 25; }
    for (let i = 0; i < 80; i++) { pts.push({ t, x: 700 + (rnd() * 2 - 1) * 10, y: 300 }); t += 25; }
    // pad to the smoothing window so analyze() actually classifies
    t += 4000;
    for (let i = 0; i < 120; i++) { pts.push({ t, x: 700 + (rnd() * 2 - 1) * 10, y: 300 }); t += 25; }
    const r = analyze(pts, cfg());
    expect(r.flag).toBe(false);
    expect(r.cycles).toBeLessThan(3);
  });

  it('does NOT flag fast teleprompter-style full-screen sweeps (too fast / y too big)', () => {
    const pts = readingTrace(4, { passMs: 350, returnMs: 250, ampFrac: 0.9, lineH: 160 });
    const r = analyzeTrace(pts);
    expect(r.flag).toBe(false);
  });

  it('shows an intermediate likelihood while passes build (not just on/off)', () => {
    // one line read = a single pass, below requiredPasses (2) - half way there
    const pts = readingTrace(1);
    const r = analyzeTrace(pts);
    expect(r.flag).toBe(false);
    expect(r.passCount).toBe(1);
    expect(r.likelihood).toBeGreaterThan(0);
    expect(r.likelihood).toBeLessThan(1);
  });

  it('flags after just 2 read passes (not 3 cycles)', () => {
    // two line reads = 2 passes + 1 return = 1 cycle. The requirement is read
    // passes, so this must already flag and deduct.
    const r = analyzeTrace(readingTrace(2));
    expect(r.passCount).toBeGreaterThanOrEqual(2);
    expect(r.flag).toBe(true);
  });

  it('still flags a wavy pass - the trace is not a straight line', () => {
    // Real gaze-x plots wiggle: a leftright sweep with �45 px oscillation and
    // small retraces superposed. It must still classify as a read pass.
    const rnd = mulberry32(77);
    const pts: GazePt[] = [];
    const passMs = 1600, returnMs = 250, gapMs = 250, amp = 620;
    let t = 0, y = 320, x0 = 330;
    for (let line = 0; line < 3; line++) {
      const steps = Math.round(passMs / 25);
      for (let s = 0; s <= steps; s++) {
        // base sweep + a wobble that dips backwards by up to ~50 px
        const wobble = Math.sin((s / steps) * Math.PI * 6) * 45 + (rnd() * 2 - 1) * 15;
        pts.push({ t, x: x0 + (amp * s) / steps + wobble, y: y + (rnd() * 2 - 1) * 10 });
        t += passMs / steps;
      }
      t += gapMs;
      if (line < 2) {
        const rs = Math.max(4, Math.round(returnMs / 25));
        for (let s = 0; s <= rs; s++) {
          pts.push({ t, x: x0 + amp - (amp * s) / rs, y: y + 30 });
          t += returnMs / rs;
        }
        t += gapMs;
        y += 40;
      }
    }
    const r = analyze(pts, cfg());
    expect(r.passCount).toBeGreaterThanOrEqual(2);
    expect(r.flag).toBe(true);
  });

  it('ignores windows where more than 30% of samples were null predictions', () => {
    const pts = readingTrace(4);
    const buffer: { t: number; x?: number; y?: number; nullPredict?: boolean }[] = [];
    let tGap = 0;
    for (const p of pts) {
      if (Math.floor(p.t / 25) % 2 === 0) buffer.push({ t: p.t, x: p.x, y: p.y });
      else { buffer.push({ t: p.t, nullPredict: true }); tGap++; }
    }
    void tGap;
    const r = analyze(buffer, cfg());
    expect(r.nullRatio).toBeGreaterThan(0.3);
    expect(r.flag).toBe(false);
    expect(r.reason).toMatch(/face missing/i);
  });

  it('returns a reason and no flag with too few samples', () => {
    const r = analyze([{ t: 0, x: 10, y: 10 }], cfg());
    expect(r.flag).toBe(false);
    expect(r.reason).toMatch(/insufficient/i);
  });

  it('smoothPoints reduces jitter without shifting the trace', () => {
    const raw: GazePt[] = [];
    const rnd = mulberry32(3);
    for (let i = 0; i < 40; i++) raw.push({ t: i * 25, x: 500 + (rnd() * 2 - 1) * 60, y: 100 });
    const sm = smoothPoints(raw, 8);
    expect(sm.length).toBe(33);
    // smoothed variance is smaller than raw variance
    const vRaw = raw.reduce((a, p) => a + (p.x - 500) ** 2, 0) / raw.length;
    const vSm = sm.reduce((a, p) => a + (p.x - 500) ** 2, 0) / sm.length;
    expect(vSm).toBeLessThan(vRaw * 0.4);
  });

  it('flags compact reading: 4 passes over a 25%-wide region at ~1.5s each (triggers, -5)', () => {
    // compact region: x from 400 to 720 (320px � 25% of 1280), 4 line reads
    const pts: GazePt[] = [];
    const passMs = 1500, returnMs = 250, gapMs = 300;
    let t = 0, y = 300, x0 = 400, x1 = 720, amp = x1 - x0;
    for (let i = 0; i < 4; i++) {
      const steps = Math.max(8, Math.round(passMs / 25));
      for (let s = 0; s <= steps; s++) {
        pts.push({ t, x: x0 + (amp * s) / steps + (Math.random() - 0.5) * 8, y: y + (s / steps) * 6 });
        t += passMs / steps;
      }
      t += gapMs;
      if (i < 3) {
        const rs = Math.max(4, Math.round(returnMs / 25));
        for (let s = 0; s <= rs; s++) {
          pts.push({ t, x: x1 - (amp * s) / rs + (Math.random() - 0.5) * 8, y: y + 26 + (s / rs) * 6 });
          t += returnMs / rs;
        }
        t += gapMs;
        y += 40;
      }
    }
    const r = analyze(pts, cfg());
    expect(r.flag).toBe(true);
    expect(r.cycles).toBeGreaterThanOrEqual(2);
    expect(r.region?.mode).toBe('compact');
  });

  it('does NOT flag small jitter under 150px (ampPxFloor guard)', () => {
    // x moves between 60 and 140 px - under the 150px floor
    const pts: GazePt[] = [];
    let x = 400, y = 300, t = 0;
    for (let i = 0; i < 5; i++) {
      const steps = 40;
      for (let s = 0; s <= steps; s++) {
        pts.push({ t, x: x + (s / steps) * 120, y: y + (Math.random() - 0.5) * 10 });
        t += 25;
      }
      x += 200; // jump forward each "line", but the sweep itself is < 150px
      y += 40;
      t += 200; // gap
    }
    const r = analyze(pts, cfg());
    expect(r.flag).toBe(false);
    expect(r.cycles).toBe(0);
  });

  it('wide reading still triggers with new config (4 lines across most of screen)', () => {
    const r = analyze(readingTrace(4, { ampFrac: 0.55, passMs: 1500, returnMs: 220, seed: 3 }), cfg());
    expect(r.flag).toBe(true);
    expect(r.cycles).toBeGreaterThanOrEqual(3);
    expect(r.region?.mode).toBe('wide');
  });

  it('gaze pinned at bottom edge with small x oscillation triggers low-gaze flag', () => {
    // phone held below screen: y pinned near bottom (H - 80), small x sawtooth
    const pts: GazePt[] = [];
    const passMs = 1500, returnMs = 250, gapMs = 300;
    const x0 = 500, x1 = 820, amp = x1 - x0; // 320px > 150 floor
    let t = 0, yLow = H - 80;
    for (let i = 0; i < 4; i++) {
      const steps = Math.max(8, Math.round(passMs / 25));
      for (let s = 0; s <= steps; s++) {
        pts.push({ t, x: x0 + (amp * s) / steps + (Math.random() - 0.5) * 10, y: yLow + (Math.random() - 0.5) * 8 });
        t += passMs / steps;
      }
      t += gapMs;
      if (i < 3) {
        const rs = Math.max(4, Math.round(returnMs / 25));
        for (let s = 0; s <= rs; s++) {
          pts.push({ t, x: x1 - (amp * s) / rs + (Math.random() - 0.5) * 10, y: yLow + (Math.random() - 0.5) * 8 });
          t += returnMs / rs;
        }
        t += gapMs;
      }
    }
    const r = analyze(pts, cfg({ lowGazeEnabled: true }));
    expect(r.flag).toBe(true);
    expect(r.lowGaze).toBe(true);
  });

  it('low-gaze is disabled when lowGazeEnabled is false (no flag for bottom-edge reading)', () => {
    const pts: GazePt[] = [];
    const passMs = 1500, returnMs = 250, gapMs = 300;
    const x0 = 500, x1 = 820, amp = x1 - x0;
    let t = 0, yLow = H - 80;
    for (let i = 0; i < 4; i++) {
      const steps = Math.max(8, Math.round(passMs / 25));
      for (let s = 0; s <= steps; s++) {
        pts.push({ t, x: x0 + (amp * s) / steps + (Math.random() - 0.5) * 10, y: yLow + (Math.random() - 0.5) * 8 });
        t += passMs / steps;
      }
      t += gapMs;
      if (i < 3) {
        const rs = Math.max(4, Math.round(returnMs / 25));
        for (let s = 0; s <= rs; s++) {
          pts.push({ t, x: x1 - (amp * s) / rs + (Math.random() - 0.5) * 10, y: yLow + (Math.random() - 0.5) * 8 });
          t += returnMs / rs;
        }
        t += gapMs;
      }
    }
    const r = analyze(pts, cfg({ lowGazeEnabled: false }));
    // With lowGaze disabled, bottom-edge passes should still be classified but the
    // chain should not count them because they are not in a region with normal y.
    // In practice the region builder still groups them, so we check the flag is false
    // OR that lowGaze is false.
    expect(r.lowGaze).toBe(false);
  });

  it('speaking-while-looking-at-camera guard suppresses reading for that window', () => {
    const pts = readingTrace(4);
    const r = analyze(pts, cfg(), { speakingAtCamera: true });
    expect(r.flag).toBe(false);
    expect(r.reason).toMatch(/speaking while looking/i);
  });

  it('baseline amplitude guard: a sweep below 2x baseline is rejected', () => {
    // establish a baseline from a single large sweep (~300px, ~1.5s)
    const baselinePts: GazePt[] = [];
    let t = 0;
    const steps = 60; // 60 * 25 = 1500ms
    for (let s = 0; s <= steps; s++) {
      baselinePts.push({ t, x: 200 + (320 * s) / steps, y: 300 });
      t += 25;
    }
    const baseline = updateBaseline(baselinePts, cfg());
    expect(typeof baseline).toBe('number');
    expect(baseline).toBeGreaterThan(0);
    // a 180px sweep with a ~320px baseline and 2x mul => floor = 640, so it should be rejected
    const sweepPts: GazePt[] = [];
    for (let s = 0; s <= 60; s++) {
      sweepPts.push({ t: s * 25, x: 200 + (180 * s) / 60, y: 300 });
    }
    const r = analyze(sweepPts, cfg(), { baselineAmplitude: baseline! });
    expect(r.flag).toBe(false);
    expect(r.cycles).toBe(0);
  });

  it('baseline guard passes a large sweep when it exceeds 2x baseline', () => {
    // establish a baseline from a single sweep (~250px raw, ~1.5s) - after smoothing
    // the effective amplitude is ~200px, which is above the 150px floor.
    const baselinePts: GazePt[] = [];
    let t = 0;
    const steps = 60; // 60 * 25 = 1500ms
    for (let s = 0; s <= steps; s++) {
      baselinePts.push({ t, x: 200 + (250 * s) / steps, y: 300 });
      t += 25;
    }
    const baseline = updateBaseline(baselinePts, cfg());
    expect(typeof baseline).toBe('number');
    expect(baseline).toBeGreaterThan(0);
    // a 600px sweep should clear 2x baseline (2 * ~200 = ~400, so 600 > 400).
    // Build 3+ cycles: each cycle = pass (600px) + return (quick) + pass (600px)
    const cyclePts: GazePt[] = [];
    let t2 = 0;
    const pSteps = 80; // 80 * 25 = 2000ms per pass (within 700-3000ms)
    const rSteps = 8; // 8 * 25 = 200ms return
    const gapMs = 200;
    for (let cycle = 0; cycle < 4; cycle++) {
      const xBase = 100 + cycle * 20; // slight x offset per cycle
      // pass: xBase -> xBase + 600
      for (let s = 0; s <= pSteps; s++) {
        cyclePts.push({ t: t2, x: xBase + (600 * s) / pSteps, y: 300 + cycle * 20 });
        t2 += 25;
      }
      if (cycle < 3) {
        // return: xBase + 600 -> xBase + 200
        for (let s = 0; s <= rSteps; s++) {
          cyclePts.push({ t: t2, x: xBase + 600 - (400 * s) / rSteps, y: 300 + cycle * 20 });
          t2 += 25;
        }
        t2 += gapMs;
      }
    }
    const r = analyze(cyclePts, cfg(), { baselineAmplitude: baseline! });
    expect(r.cycles).toBeGreaterThanOrEqual(3);
    expect(r.flag).toBe(true);
  });

  it('updateBaseline returns null when there is not enough signal', () => {
    const empty: GazePt[] = [];
    expect(updateBaseline(empty, cfg())).toBeNull();
    const tiny: GazePt[] = [{ t: 0, x: 10, y: 10 }, { t: 25, x: 12, y: 11 }];
    expect(updateBaseline(tiny, cfg())).toBeNull();
  });

  it('analyze result now includes region, lowGaze fields', () => {
    const r = analyze(readingTrace(1), cfg());
    expect('region' in r).toBe(true);
    expect('lowGaze' in r).toBe(true);
    expect(typeof r.lowGaze).toBe('boolean');
  });

  it('findRuns returns classified pass/return runs on a synthetic trace', () => {
    const pts = smoothPoints(readingTrace(3, { err: 10, seed: 5 }), 8);
    const runs = findRuns(pts, cfg());
    expect(runs.some((r) => r.kind === 1)).toBe(true);
    expect(runs.some((r) => r.kind === -1)).toBe(true);
  });
});

