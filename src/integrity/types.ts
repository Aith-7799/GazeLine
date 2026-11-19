/** Shared types for all integrity signal modules. */

/** A single event emitted by an integrity signal module. */
export interface IntegrityEvent {
  /** Unique signal code, e.g. TAB_SWITCH, MULTIPLE_FACES */
  code: string;
  /** How severe: info = no deduction, warn = small, critical = large */
  severity: 'info' | 'warn' | 'critical';
  /** 0-1 confidence that this event is real (not a false positive) */
  confidence: number;
  /** performance.now() epoch */
  t: number;
  /** Free-form details for the interviewer report */
  details: Record<string, unknown>;
}

/** Scoring configuration for one deduction code. */
export interface DeductionConfig {
  amount: number;
  cooldownMs: number;
  category: string;
  debounceMs?: number;
  maxTotal?: number;
}

/** Top-level scoring config: deductions, caps, review rules, accommodations. */
export interface ScoringConfig {
  deductions: Record<string, DeductionConfig>;
  categoryCaps: Record<string, number>;
  reviewThresholdCategories: number;
  reviewWindowMs: number;
  accommodations: {
    eyeCondition: boolean;
    assistivePerson: boolean;
    secondMonitorRequired: boolean;
  };
}

/** Default scoring configuration matching the spec. */
export const DEFAULT_SCORING_CFG: ScoringConfig = {
  deductions: {
    TAB_SWITCH: { amount: 2, cooldownMs: 5000, category: 'attention', debounceMs: 5000 },
    LONG_AWAY: { amount: 3, cooldownMs: 5000, category: 'attention' },
    FULLSCREEN_EXIT: { amount: 2, cooldownMs: 5000, category: 'attention' },
    PASTE_EVENT: { amount: 1, cooldownMs: 2000, category: 'attention' },
    EXTRA_DISPLAY_DETECTED: { amount: 5, cooldownMs: 0, category: 'attention', maxTotal: 5 },
    MULTIPLE_FACES: { amount: 10, cooldownMs: 60000, category: 'face' },
    FACE_ABSENT: { amount: 3, cooldownMs: 5000, category: 'face' },
    // faceMonitor emits this instead of FACE_ABSENT when the last seen pitch was
    // strongly downward. Without an entry here the event was silently dropped.
    LOOKING_DOWN_FACE_LOST: { amount: 3, cooldownMs: 5000, category: 'face' },
    FACE_ABSENT_CUMULATIVE: { amount: 5, cooldownMs: 0, category: 'face' },
    SUSTAINED_OFFAXIS: { amount: 2, cooldownMs: 30000, category: 'pose' },
    REPEATED_SIDE_LOOKS: { amount: 4, cooldownMs: 30000, category: 'pose' },
    LOOKING_DOWN_REPEATEDLY: { amount: 4, cooldownMs: 30000, category: 'pose' },
    BLINK_RATE_DROP_PERSISTENT: { amount: 1, cooldownMs: 60000, category: 'blink' },
  },
  categoryCaps: {
    attention: 30,
    face: 30,
    pose: 30,
    blink: 5,
  },
  reviewThresholdCategories: 3,
  reviewWindowMs: 60000,
  accommodations: {
    eyeCondition: false,
    assistivePerson: false,
    secondMonitorRequired: false,
  },
};

/** Mutable scoring state for one session. */
export interface ScoreState {
  score: number;
  flagLog: Array<{ code: string; text: string; ts: number; category: string; amount: number }>;
  categoryTotals: Record<string, number>;
  categoryLastDeduction: Record<string, number>;
  categoryEventCount: Record<string, number>;
  flaggedCategoriesInWindow: Array<{ category: string; ts: number }>;
  reviewFlagged: boolean;
  accommodations: ScoringConfig['accommodations'];
  sessionStartTs: number;
  // internal: debounce tracking (not serialized)
  _debounce: Record<string, number>;
}

/** Create a fresh ScoreState. */
export function initialScoreState(
  now: number,
  accommodations: ScoringConfig['accommodations'] = DEFAULT_SCORING_CFG.accommodations,
): ScoreState {
  return {
    score: 100,
    flagLog: [],
    categoryTotals: { attention: 0, face: 0, pose: 0, blink: 0 },
    // -Infinity = "no deduction yet". Using 0 here meant a fresh session looked like
    // it had already deducted at t=0, so early events were swallowed by the cooldown.
    categoryLastDeduction: { attention: -Infinity, face: -Infinity, pose: -Infinity, blink: -Infinity },
    categoryEventCount: { attention: 0, face: 0, pose: 0, blink: 0 },
    flaggedCategoriesInWindow: [],
    reviewFlagged: false,
    accommodations,
    sessionStartTs: now,
    _debounce: {},
  };
}

/** Try to apply a deduction for an event. Returns { deducted, reason }. */
export function applyDeduction(
  state: ScoreState,
  code: string,
  cfg: ScoringConfig,
  event: IntegrityEvent,
): { deducted: boolean; reason: string } {
  const dCfg = cfg.deductions[code];
  if (!dCfg) return { deducted: false, reason: `unknown code ${code}` };

  // Accommodation overrides
  if (state.accommodations.eyeCondition && ['BLINK_RATE_DROP_PERSISTENT'].includes(code)) {
    return { deducted: false, reason: 'accommodation: eye condition' };
  }
  if (state.accommodations.assistivePerson && ['MULTIPLE_FACES'].includes(code)) {
    return { deducted: false, reason: 'accommodation: assistive person' };
  }
  if (state.accommodations.secondMonitorRequired && [
    'EXTRA_DISPLAY_DETECTED', 'SUSTAINED_OFFAXIS', 'REPEATED_SIDE_LOOKS',
  ].includes(code)) {
    return { deducted: false, reason: 'accommodation: second monitor required' };
  }

  const now = event.t;
  const cat = dCfg.category;
  const lastDed = state.categoryLastDeduction[cat] ?? -Infinity;
  if (now - lastDed < dCfg.cooldownMs) {
    return { deducted: false, reason: `cooldown (${cat})` };
  }

  // Per-code debounce
  if (dCfg.debounceMs) {
    const existing = state._debounce[code];
    if (existing && now - existing < dCfg.debounceMs) {
      return { deducted: false, reason: `debounce (${code})` };
    }
    state._debounce[code] = now;
  }

  // Per-category cap
  const catCap = cfg.categoryCaps[cat] ?? Infinity;
  const currentTotal = state.categoryTotals[cat] ?? 0;
  const remaining = catCap - currentTotal;
  if (remaining <= 0) return { deducted: false, reason: `category cap reached (${cat})` };
  const amount = Math.min(dCfg.amount, remaining);
  if (amount <= 0) return { deducted: false, reason: `category cap reached (${cat})` };

  state.score = Math.max(0, state.score - amount);
  state.categoryTotals[cat] = (state.categoryTotals[cat] ?? 0) + amount;
  // A code with no cooldown of its own is a one-off summary (FACE_ABSENT_CUMULATIVE,
  // EXTRA_DISPLAY_DETECTED). It must not open a rate-limit window that then throttles
  // the discrete events sharing its category.
  if (dCfg.cooldownMs > 0) state.categoryLastDeduction[cat] = now;
  state.categoryEventCount[cat] = (state.categoryEventCount[cat] ?? 0) + 1;
  state.flagLog.push({ code, text: `${code} (-${amount})`, ts: now, category: cat, amount });

  // Review-flag logic: 3+ categories fire within reviewWindowMs
  state.flaggedCategoriesInWindow = state.flaggedCategoriesInWindow.filter(
    (f) => now - f.ts < cfg.reviewWindowMs,
  );
  if (!state.flaggedCategoriesInWindow.some((f) => f.category === cat)) {
    state.flaggedCategoriesInWindow.push({ category: cat, ts: now });
  }
  const uniqueCats = new Set(state.flaggedCategoriesInWindow.map((f) => f.category));
  state.reviewFlagged = uniqueCats.size >= cfg.reviewThresholdCategories;

  return { deducted: true, reason: `${code} (-${amount})` };
}

/** Reset score state for a new session. */
export function resetScoreState(state: ScoreState): void {
  state.score = 100;
  state.flagLog = [];
  state.categoryTotals = { attention: 0, face: 0, pose: 0, blink: 0 };
  state.categoryLastDeduction = { attention: -Infinity, face: -Infinity, pose: -Infinity, blink: -Infinity };
  state.categoryEventCount = { attention: 0, face: 0, pose: 0, blink: 0 };
  state.flaggedCategoriesInWindow = [];
  state.reviewFlagged = false;
  state.sessionStartTs = performance.now();
  state._debounce = {};
}

