import { DEFAULT_SCORING_CFG, initialScoreState, type ScoreState } from '../integrity/types.js';

export type InterviewStatus = 'waiting' | 'active' | 'completed' | 'interrupted' | 'cancelled';
export interface ReportEvent { atMs: number; code: string; points: number }
export interface Snapshot {
  monitoredMs: number;
  calibrated: boolean;
  reviewRequested: boolean;
  events: ReportEvent[];
}
export interface InterviewSummary {
  id: string;
  title: string;
  status: InterviewStatus;
  joinCode: string | null;
  candidate: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  score: number | null;
  eventCount: number;
}
export interface Interview extends InterviewSummary { snapshot: Snapshot }

export function restoreScore(snapshot: Snapshot | undefined, now: number, accommodations: ScoreState['accommodations']) {
  const state = initialScoreState(now - (snapshot?.monitoredMs ?? 0), accommodations);
  for (const event of snapshot?.events ?? []) {
    const rule = DEFAULT_SCORING_CFG.deductions[event.code];
    const category = event.code === 'READING_DETECTED' ? 'reading' : rule?.category;
    if (!category) continue;
    const ts = state.sessionStartTs + event.atMs;
    state.score = Math.max(0, state.score - event.points);
    state.categoryTotals[category] = (state.categoryTotals[category] ?? 0) + event.points;
    state.categoryEventCount[category] = (state.categoryEventCount[category] ?? 0) + 1;
    if (!rule || rule.cooldownMs > 0) state.categoryLastDeduction[category] = ts;
    if (rule?.debounceMs) state._debounce[event.code] = ts;
    if (rule && now - ts < DEFAULT_SCORING_CFG.reviewWindowMs) {
      state.flaggedCategoriesInWindow.push({ category, ts });
    }
    state.flagLog.push({ code: event.code, ts, category, amount: event.points, text: `${event.code} (-${event.points})` });
  }
  return state;
}

export function snapshotScore(state: ScoreState, now: number, calibrated: boolean, reviewRequested: boolean): Snapshot {
  const monitoredMs = Math.max(0, Math.round(now - state.sessionStartTs));
  return {
    monitoredMs, calibrated, reviewRequested: reviewRequested || state.reviewFlagged,
    events: state.flagLog.map((e) => ({
      atMs: Math.max(0, Math.round(e.ts - state.sessionStartTs)), code: e.code, points: e.amount,
    })),
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

