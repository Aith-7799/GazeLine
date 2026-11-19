/**
 * Regression tests for the no-face deduction path (FaceMonitor  scoring).
 *
 * Requirement: losing the face must produce a deduction in **under 5 seconds**.
 * Guards three bugs that used to break that:
 *  - looking-down face loss emitted a code with no scoring entry and was dropped;
 *  - a fresh session's `categoryLastDeduction` of 0 acted as a phantom 5 s cooldown;
 *  - the one-off FACE_ABSENT_CUMULATIVE penalty opened a rate-limit window that
 *    throttled the discrete FACE_ABSENT event sharing its category.
 */
import { describe, it, expect } from 'vitest';
import { FaceMonitor } from '../src/integrity/faceMonitor.js';
import { DEFAULT_SCORING_CFG, initialScoreState, applyDeduction } from '../src/integrity/types.js';
import type { FaceFrameInfo } from '../src/integrity/facePipeline.js';

const FRAME_MS = 33; // ~30 fps

const absent = (t: number): FaceFrameInfo => ({
  t, facePresent: false, numFaces: 0, faceConfidence: 0,
  faceBox: null, faceBoxNorm: null, noseTip: null,
  yawDeg: 0, pitchDeg: 0, rollDeg: 0,
  blinkLeft: 0, blinkRight: 0,
  faceLuminance: null, leftRightLumRatio: null, bgLuminance: null,
});
const present = (t: number, pitch = 0): FaceFrameInfo => ({
  ...absent(t), facePresent: true, numFaces: 1, faceConfidence: 0.9, pitchDeg: pitch,
});

/** Run the real FaceMonitor  applyDeduction wiring and report every deduction. */
function simulate(opts: { sessionStartMs: number; faceLostAtMs: number; endMs: number; pitch?: number }) {
  const fm = new FaceMonitor();
  const state = initialScoreState(0);
  const deductions: Array<{ code: string; t: number; amount: number }> = [];
  fm.setSessionStart(opts.sessionStartMs);
  fm.onEvent((ev) => {
    const before = state.score;
    const r = applyDeduction(state, ev.code, DEFAULT_SCORING_CFG, ev);
    if (r.deducted) deductions.push({ code: ev.code, t: ev.t, amount: before - state.score });
  });
  for (let t = opts.sessionStartMs; t < opts.endMs; t += FRAME_MS) {
    fm.process(t < opts.faceLostAtMs ? present(t, opts.pitch ?? 0) : absent(t), t);
  }
  const within = (code: string) => deductions.find((d) => d.code === code);
  return {
    deductions,
    first: deductions[0],
    /** ms after the face was lost that a given deduction code first landed */
    latencyOf: (code: string) => {
      const d = within(code);
      return d ? d.t - opts.faceLostAtMs : Infinity;
    },
    score: state.score,
  };
}

describe('no-face deduction arrives in under 5 seconds', () => {
  it('deducts when the face is lost after being present', () => {
    const { first, latencyOf, score } = simulate({ sessionStartMs: 4000, faceLostAtMs: 34000, endMs: 70000 });
    expect(first?.code).toBe('FACE_ABSENT');
    expect(latencyOf('FACE_ABSENT')).toBeLessThan(5000);
    expect(score).toBeLessThan(100);
  });

  it('deducts when the face is lost while looking down', () => {
    const { first, latencyOf, score } = simulate({ sessionStartMs: 4000, faceLostAtMs: 34000, endMs: 70000, pitch: -35 });
    expect(first?.code).toBe('LOOKING_DOWN_FACE_LOST');
    expect(latencyOf('LOOKING_DOWN_FACE_LOST')).toBeLessThan(5000);
    expect(score).toBeLessThan(100);
  });

  it('still lands the discrete FACE_ABSENT under 5s when the cumulative penalty fires first', () => {
    // Face never present: FACE_ABSENT_CUMULATIVE fires almost immediately, and used
    // to open a 5 s rate-limit window that pushed FACE_ABSENT out past 8 s.
    const { first, latencyOf, score } = simulate({ sessionStartMs: 4000, faceLostAtMs: 4000, endMs: 40000 });
    expect(first?.code).toBe('FACE_ABSENT_CUMULATIVE');
    expect(latencyOf('FACE_ABSENT')).toBeLessThan(5000);
    expect(score).toBeLessThan(100);
  });

  it('makes its first deduction early in a session, before 5 s of page lifetime', () => {
    // Guards the phantom cooldown: a fresh categoryLastDeduction of 0 blocked any
    // deduction attempted in the first 5 s after page load.
    const { latencyOf, score } = simulate({ sessionStartMs: 1000, faceLostAtMs: 2000, endMs: 40000 });
    expect(Math.min(latencyOf('FACE_ABSENT'), latencyOf('FACE_ABSENT_CUMULATIVE'))).toBeLessThan(5000);
    expect(score).toBeLessThan(100);
  });

  it('has a scoring entry for every face-loss code the monitor can emit', () => {
    for (const code of ['FACE_ABSENT', 'LOOKING_DOWN_FACE_LOST', 'MULTIPLE_FACES', 'FACE_ABSENT_CUMULATIVE']) {
      expect(DEFAULT_SCORING_CFG.deductions[code]).toBeDefined();
    }
  });
});

