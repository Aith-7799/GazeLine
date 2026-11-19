/** blinkAnalyzer - blink detection from eyeBlinkLeft/eyeBlinkRight blendshapes
 * (or eye aspect ratio from landmarks if blendshapes unavailable).
 *
 * Emits BLINK_RATE_DROP, BLINK_REGULARITY_ANOMALY.
 * Acts as a corroborating multiplier on reading detection (confidence boost).
 */

import type { FaceFrameInfo } from './facePipeline.js';
import type { IntegrityEvent } from './types.js';

export interface BlinkAnalyzerEvent extends IntegrityEvent {
  details: {
    description: string;
    /** Current blink rate (blinks/min). */
    currentRate?: number;
    /** Baseline blink rate. */
    baselineRate?: number;
    /** Ratio of current to baseline. */
    rateRatio?: number;
    /** For regularity anomaly: inter-blink interval stats. */
    ibiMean?: number;
    ibiStd?: number;
  };
}

export interface BlinkAnalyzerConfig {
  /** Blink detection threshold: both eyes above this value = eye closed. */
  blinkThreshold: number;
  /** Blink closure threshold: eyes below this = open again (hysteresis). */
  blinkOpenThreshold: number;
  /** Minimum blink duration (ms). */
  minBlinkDurationMs: number;
  /** Maximum blink duration (ms). */
  maxBlinkDurationMs: number;
  /** Minimum gap between blinks (ms) to count as separate. */
  minInterBlinkGapMs: number;
  /** Rolling window for blink rate calculation (ms). */
  rateWindowMs: number;
  /** Baseline capture window after setup (ms). */
  baselineWindowMs: number;
  /** Rate ratio below which BLINK_RATE_DROP fires. */
  rateDropRatio: number;
  /** Duration (ms) that rate must stay below threshold to trigger. */
  rateDropDurationMs: number;
  /** Duration (ms) of persistent drop before small deduction. */
  rateDropPersistentDurationMs: number;
  rateDropPersistentDeduction: number;
  /** Inter-blink interval std-dev threshold for regularity anomaly. */
  regularityIbiStdMax: number;
  /** Minimum number of blinks to assess regularity. */
  regularityMinBlinks: number;
  /** Duration over which to assess regularity. */
  regularityWindowMs: number;
}

export const DEFAULT_BLINK_CFG: BlinkAnalyzerConfig = {
  blinkThreshold: 0.5,
  blinkOpenThreshold: 0.3,
  minBlinkDurationMs: 80,
  maxBlinkDurationMs: 500,
  minInterBlinkGapMs: 100,
  rateWindowMs: 60000,
  baselineWindowMs: 75000, // 60-90s
  rateDropRatio: 0.5,
  rateDropDurationMs: 30000,
  rateDropPersistentDurationMs: 120000,
  rateDropPersistentDeduction: 1,
  regularityIbiStdMax: 500, // ms - low variance = unnatural regularity
  regularityMinBlinks: 10,
  regularityWindowMs: 120000,
};

export class BlinkAnalyzer {
  private config: BlinkAnalyzerConfig;
  private _listeners = new Set<(ev: BlinkAnalyzerEvent) => void>();

  // Blink state machine
  private blinkStartTs = 0;
  private blinkInProgress = false;
  private lastBlinkEndTs = 0;
  private blinkCount = 0;

  // Blink timestamps for rate calculation
  private blinkTimestamps: number[] = [];

  // Baseline
  private baselineStartTs = 0;
  private baselineBlinkCount = 0;
  private baselineCaptured = false;
  private baselineRate = 0;

  // Rate drop tracking
  private rateDropStartTs = 0;
  private rateDropPersistentStartTs = 0;
  private _rateDropActive = false;
  private _rateDropPersistentEmitted = false;

  // Regularity tracking
  private regularityCheckStartTs = 0;
  private _regularityAnomalyEmitted = false;

  // External: whether face is present (to discount signal)
  private _lightingPoor = false;
  private _glassesGlareHigh = false;

  constructor(config: Partial<BlinkAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_BLINK_CFG, ...config };
  }

  /** Subscribe to blink events. Returns unsubscribe. */
  onEvent(cb: (ev: BlinkAnalyzerEvent) => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private emit(ev: BlinkAnalyzerEvent): void {
    for (const l of this._listeners) l(ev);
  }

  /** Start baseline capture. Call when setup is complete. */
  startBaseline(now: number): void {
    this.baselineStartTs = now;
    this.baselineBlinkCount = 0;
    this.baselineCaptured = false;
    this.baselineRate = 0;
    this._rateDropActive = false;
    this._rateDropPersistentEmitted = false;
    this._regularityAnomalyEmitted = false;
    // ibiTimestamps removed
    this.regularityCheckStartTs = 0;
  }

  /** Set external discount factors. */
  setContext(_facePresent: boolean, lightingPoor: boolean, glassesGlareHigh: boolean): void {
    this._lightingPoor = lightingPoor;
    this._glassesGlareHigh = glassesGlareHigh;
  }

  /** Process a face-frame info. Call every frame. */
  process(info: FaceFrameInfo, now: number): void {
    if (!info.facePresent) {
      // Face lost - discount blink signal
      return;
    }
    if (this._lightingPoor || this._glassesGlareHigh) {
      // Poor conditions - discount
      return;
    }

    // Use blendshape values (both eyes)
    const eyeClosed = info.blinkLeft > this.config.blinkThreshold &&
      info.blinkRight > this.config.blinkThreshold;
    const eyeOpen = info.blinkLeft < this.config.blinkOpenThreshold &&
      info.blinkRight < this.config.blinkOpenThreshold;

    // Blink state machine with hysteresis
    if (!this.blinkInProgress && eyeClosed) {
      // Start of a blink
      this.blinkStartTs = now;
      this.blinkInProgress = true;
    } else if (this.blinkInProgress && eyeOpen) {
      // End of a blink
      const duration = now - this.blinkStartTs;
      if (duration >= this.config.minBlinkDurationMs &&
          duration <= this.config.maxBlinkDurationMs) {
        // Valid blink
        const gap = this.blinkStartTs - this.lastBlinkEndTs;
        if (gap >= this.config.minInterBlinkGapMs || this.lastBlinkEndTs === 0) {
          this._recordBlink(now);
        }
      }
      this.blinkInProgress = false;
      this.lastBlinkEndTs = now;
    }

    // ---- Baseline capture ----
    if (!this.baselineCaptured && this.baselineStartTs > 0) {
      if (now - this.baselineStartTs >= this.config.baselineWindowMs) {
        // Baseline window complete
        const baselineDurationMin = this.config.baselineWindowMs / 60000;
        this.baselineRate = this.baselineBlinkCount / baselineDurationMin;
        this.baselineCaptured = true;
      }
    }

    // ---- Rate drop detection ----
    if (this.baselineCaptured && this.baselineRate > 0) {
      const currentRate = this._currentRate(now);
      if (currentRate > 0) {
        const ratio = currentRate / this.baselineRate;
        if (ratio < this.config.rateDropRatio) {
          if (!this._rateDropActive) {
            this.rateDropStartTs = now;
            this._rateDropActive = true;
            this._rateDropPersistentEmitted = false;
          }
          const dropDuration = now - this.rateDropStartTs;
          if (dropDuration >= this.config.rateDropDurationMs) {
            this.emit({
              code: 'BLINK_RATE_DROP',
              severity: 'info',
              confidence: 0.4,
              t: now,
              details: {
                description: `Blink rate dropped to ${currentRate.toFixed(0)}/min (baseline: ${this.baselineRate.toFixed(0)}/min, ratio: ${(ratio * 100).toFixed(0)}%).`,
                currentRate,
                baselineRate: this.baselineRate,
                rateRatio: ratio,
              },
            });
            // Persistent drop - small deduction after extended period
            if (!this._rateDropPersistentEmitted) {
              if (this.rateDropPersistentStartTs === 0) {
                this.rateDropPersistentStartTs = now;
              }
              if (now - this.rateDropPersistentStartTs >= this.config.rateDropPersistentDurationMs) {
                this._rateDropPersistentEmitted = true;
                this.emit({
                  code: 'BLINK_RATE_DROP_PERSISTENT',
                  severity: 'warn',
                  confidence: 0.3,
                  t: now,
                  details: {
                    description: `Blink rate has been low for >2 minutes with no other explanation.`,
                    currentRate,
                    baselineRate: this.baselineRate,
                    rateRatio: ratio,
                  },
                });
              }
            }
          }
        } else {
          this._rateDropActive = false;
          this.rateDropStartTs = 0;
          this.rateDropPersistentStartTs = 0;
        }
      }
    }

    // ---- Regularity analysis ----
    if (this.blinkTimestamps.length >= this.config.regularityMinBlinks) {          if (this.regularityCheckStartTs === 0) {
            this.regularityCheckStartTs = this.blinkTimestamps[0] ?? 0;
      }
      const windowStart = this.regularityCheckStartTs;
      if (now - windowStart >= this.config.regularityWindowMs) {
        const ibis: number[] = [];
        for (let i = 1; i < this.blinkTimestamps.length; i++) {
          ibis.push(this.blinkTimestamps[i] - this.blinkTimestamps[i - 1]);
        }
        if (ibis.length >= 3) {
          const mean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
          const variance = ibis.reduce((a, b) => a + (b - mean) ** 2, 0) / ibis.length;
          const std = Math.sqrt(variance);
          if (std < this.config.regularityIbiStdMax && !this._regularityAnomalyEmitted) {
            this._regularityAnomalyEmitted = true;
            this.emit({
              code: 'BLINK_REGULARITY_ANOMALY',
              severity: 'info',
              confidence: 0.3,
              t: now,
              details: {
                description: `Unnaturally regular blinking detected (${ibis.length} blinks, IBI std: ${std.toFixed(0)}ms, mean: ${mean.toFixed(0)}ms).`,
                ibiMean: mean,
                ibiStd: std,
              },
            });
          }
        }
      }
      // Reset for next check
      this.regularityCheckStartTs = now;
    }
  }

  /** Whether BLINK_RATE_DROP is currently active (for reading confidence boost). */
  get rateDropActive(): boolean {
    return this._rateDropActive;
  }

  /** Get the current blink rate (blinks/min over rolling window). */
  getCurrentRate(now: number): number {
    return this._currentRate(now);
  }

  /** Get the baseline blink rate. */
  getBaselineRate(): number {
    return this.baselineRate;
  }

  /** Whether baseline has been captured. */
  get baselineReady(): boolean {
    return this.baselineCaptured;
  }

  private _recordBlink(now: number): void {
    this.blinkCount++;
    this.blinkTimestamps.push(now);
    this.lastBlinkEndTs = now;
    if (this.baselineStartTs > 0 && now - this.baselineStartTs < this.config.baselineWindowMs) {
      this.baselineBlinkCount++;
    }
    // Keep only blinks in the rate window
    const windowStart = now - this.config.rateWindowMs;
    while (this.blinkTimestamps.length > 0 && this.blinkTimestamps[0] < windowStart) {
      this.blinkTimestamps.shift();
    }
  }

  private _currentRate(now: number): number {
    const windowStart = now - this.config.rateWindowMs;
    const recentBlinks = this.blinkTimestamps.filter((t) => t >= windowStart);
    const durationMin = this.config.rateWindowMs / 60000;
    return durationMin > 0 ? recentBlinks.length / durationMin : 0;
  }

  /** Reset for a new session. */
  reset(): void {
    this.blinkStartTs = 0;
    this.blinkInProgress = false;
    this.lastBlinkEndTs = 0;
    this.blinkCount = 0;
    this.blinkTimestamps = [];
    this.baselineStartTs = 0;
    this.baselineBlinkCount = 0;
    this.baselineCaptured = false;
    this.baselineRate = 0;
    this._rateDropActive = false;
    this._rateDropPersistentEmitted = false;
    this.rateDropStartTs = 0;
    this.rateDropPersistentStartTs = 0;
    this.regularityCheckStartTs = 0;
    this._regularityAnomalyEmitted = false;
  }
}

