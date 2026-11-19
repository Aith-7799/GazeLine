/** headPose - head pose tracking from facial transformation matrices.
 * Emits SUSTAINED_OFFAXIS, REPEATED_SIDE_LOOKS, LOOKING_DOWN_REPEATEDLY.
 * Calibrates a neutral pose from the first 15s after setup.
 */

import type { FaceFrameInfo } from './facePipeline.js';
import type { IntegrityEvent } from './types.js';

export interface HeadPoseEvent extends IntegrityEvent {
  details: {
    description: string;
    /** For side looks: which side. */
    side?: 'left' | 'right';
    /** Current yaw/pitch relative to neutral. */
    yawFromNeutral?: number;
    pitchFromNeutral?: number;
    /** Number of looks in the current window. */
    lookCount?: number;
  };
}

export interface HeadPoseConfig {
  /** Max yaw deviation from neutral (degrees) for "off-axis". */
  offAxisYawThresholdDeg: number;
  /** Duration beyond which off-axis is "sustained". */
  sustainedOffAxisThresholdMs: number;
  sustainedOffAxisDeduction: number;
  sustainedOffAxisCooldownMs: number;
  /** Number of off-axis turns to the same side within the look-window to trigger. */
  repeatedSideLooksThreshold: number;
  /** Window (ms) for counting repeated side looks. */
  repeatedSideLooksWindowMs: number;
  repeatedSideLooksDeduction: number;
  repeatedSideLooksCooldownMs: number;
  /** Pitch threshold (degrees below neutral) for "looking down". */
  lookingDownPitchThresholdDeg: number;
  /** Number of downward looks within the look-window to trigger. */
  lookingDownRepeatedlyThreshold: number;
  lookingDownRepeatedlyDeduction: number;
  lookingDownRepeatedlyCooldownMs: number;
  /** Duration of neutral calibration window after setup. */
  neutralCalibWindowMs: number;
  /** Smothing factor for pose angles (0-1, higher = more smoothing). */
  poseSmoothing: number;
}

export const DEFAULT_HEAD_POSE_CFG: HeadPoseConfig = {
  offAxisYawThresholdDeg: 20,
  sustainedOffAxisThresholdMs: 2000,
  sustainedOffAxisDeduction: 2,
  sustainedOffAxisCooldownMs: 30000,
  repeatedSideLooksThreshold: 4,
  repeatedSideLooksWindowMs: 60000,
  repeatedSideLooksDeduction: 4,
  repeatedSideLooksCooldownMs: 30000,
  lookingDownPitchThresholdDeg: -20,
  lookingDownRepeatedlyThreshold: 4,
  lookingDownRepeatedlyDeduction: 4,
  lookingDownRepeatedlyCooldownMs: 30000,
  neutralCalibWindowMs: 15000,
  poseSmoothing: 0.3,
};

export class HeadPoseTracker {
  private config: HeadPoseConfig;
  private _listeners = new Set<(ev: HeadPoseEvent) => void>();

  // Smoothed angles
  private smoothedYaw = 0;
  private smoothedPitch = 0;
  private smoothedRoll = 0;

  // Neutral calibration
  private neutralYaw = 0;
  private neutralPitch = 0;
  private calibStartTs = 0;
  private calibrated = false;
  private calibSamples: { yaw: number; pitch: number }[] = [];

  // Tracking state
  private offAxisStartTs = 0;
  private lastOffAxisEmitTs = 0;

  // Side look tracking
  private sideLookTimestamps: number[] = [];
  private sideLookDirections: ('left' | 'right')[] = [];
  private lastSideLookEmitTs = 0;

  // Downward look tracking
  private downLookTimestamps: number[] = [];
  private lastDownLookEmitTs = 0;

  // Debug: yaw/pitch history for plotting
  private yawHistory: { t: number; yaw: number }[] = [];
  private pitchHistory: { t: number; pitch: number }[] = [];

  constructor(config: Partial<HeadPoseConfig> = {}) {
    this.config = { ...DEFAULT_HEAD_POSE_CFG, ...config };
  }

  /** Subscribe to head pose events. Returns unsubscribe. */
  onEvent(cb: (ev: HeadPoseEvent) => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private emit(ev: HeadPoseEvent): void {
    for (const l of this._listeners) l(ev);
  }

  /** Start neutral calibration. Call when setup is complete / calibration begins. */
  startCalibration(now: number): void {
    this.calibStartTs = now;
    this.calibrated = false;
    this.calibSamples = [];
    this.neutralYaw = 0;
    this.neutralPitch = 0;
  }

  /** Process a face-frame info. Call every frame. */
  process(info: FaceFrameInfo, now: number): void {
    if (!info.facePresent || !info.faceBox) {
      // No face - keep last smoothed values, don't update history
      return;
    }

    // Smooth the angles
    this.smoothedYaw = this.smoothedYaw + this.config.poseSmoothing * (info.yawDeg - this.smoothedYaw);
    this.smoothedPitch = this.smoothedPitch + this.config.poseSmoothing * (info.pitchDeg - this.smoothedPitch);
    // Roll not used for detection, but keep for completeness
    this.smoothedRoll = this.smoothedRoll + this.config.poseSmoothing * (info.rollDeg - this.smoothedRoll);

    // Calibration phase: collect samples
    if (!this.calibrated && this.calibStartTs > 0) {
      if (now - this.calibStartTs < this.config.neutralCalibWindowMs) {
        this.calibSamples.push({ yaw: this.smoothedYaw, pitch: this.smoothedPitch });
        // Use median of first 15s as neutral
        if (this.calibSamples.length >= 30) { // roughly 30 samples in 15s at 2fps
          this.neutralYaw = this._median(this.calibSamples.map((s) => s.yaw));
          this.neutralPitch = this._median(this.calibSamples.map((s) => s.pitch));
          this.calibrated = true;
        }
      } else {
        // Calibration window expired - use whatever we have
        if (this.calibSamples.length > 0) {
          this.neutralYaw = this._median(this.calibSamples.map((s) => s.yaw));
          this.neutralPitch = this._median(this.calibSamples.map((s) => s.pitch));
        }
        this.calibrated = true;
      }
    }

    if (!this.calibrated) return;

    const yawFromNeutral = this.smoothedYaw - this.neutralYaw;
    const pitchFromNeutral = this.smoothedPitch - this.neutralPitch;

    // Store history for debug plot
    this.yawHistory.push({ t: now, yaw: yawFromNeutral });
    this.pitchHistory.push({ t: now, pitch: pitchFromNeutral });
    // Keep last 5 minutes
    const cutoff = now - 300000;
    while (this.yawHistory.length > 0 && this.yawHistory[0].t < cutoff) this.yawHistory.shift();
    while (this.pitchHistory.length > 0 && this.pitchHistory[0].t < cutoff) this.pitchHistory.shift();

    // ---- SUSTAINED_OFFAXIS ----
    if (Math.abs(yawFromNeutral) > this.config.offAxisYawThresholdDeg) {
      if (this.offAxisStartTs === 0) {
        this.offAxisStartTs = now;
      }
      const offAxisDuration = now - this.offAxisStartTs;
      if (offAxisDuration >= this.config.sustainedOffAxisThresholdMs) {
        const cooldownOk = now - this.lastOffAxisEmitTs >= this.config.sustainedOffAxisCooldownMs;
        if (cooldownOk) {
          const side = yawFromNeutral > 0 ? 'right' : 'left';
          this.emit({
            code: 'SUSTAINED_OFFAXIS',
            severity: 'warn',
            confidence: 0.75,
            t: now,
            details: {
              description: `Head turned ${side} and held off-axis for ${Math.round(offAxisDuration / 1000)}s (yaw: ${Math.round(yawFromNeutral)}� from neutral).`,
              yawFromNeutral,
              side,
            },
          });
          this.lastOffAxisEmitTs = now;
        }
      }
    } else {
      this.offAxisStartTs = 0;
    }

    // ---- REPEATED_SIDE_LOOKS ----
    if (Math.abs(yawFromNeutral) > this.config.offAxisYawThresholdDeg) {
      const nowTs = now;
      // Check if this is a new look (was previously within threshold)
      const prevYaw = this.yawHistory.length >= 2 ? this.yawHistory[this.yawHistory.length - 2].yaw : 0;
      if (Math.abs(prevYaw) <= this.config.offAxisYawThresholdDeg) {
        // Just crossed threshold - new look
        const side: 'left' | 'right' = yawFromNeutral > 0 ? 'right' : 'left';
        this.sideLookTimestamps.push(nowTs);
        this.sideLookDirections.push(side);
        // Keep only looks within the window
        const windowStart = nowTs - this.config.repeatedSideLooksWindowMs;
        while (this.sideLookTimestamps.length > 0 && this.sideLookTimestamps[0] < windowStart) {
          this.sideLookTimestamps.shift();
          this.sideLookDirections.shift();
        }
        // Check for threshold
        const recentSideLooks = this.sideLookTimestamps.length;
        if (recentSideLooks >= this.config.repeatedSideLooksThreshold) {
          const cooldownOk = now - this.lastSideLookEmitTs >= this.config.repeatedSideLooksCooldownMs;
          if (cooldownOk) {
            // Determine dominant side
            const leftCount = this.sideLookDirections.filter((d) => d === 'left').length;
            const rightCount = this.sideLookDirections.filter((d) => d === 'right').length;
            const dominantSide: 'left' | 'right' = leftCount >= rightCount ? 'left' : 'right';
            this.emit({
              code: 'REPEATED_SIDE_LOOKS',
              severity: 'critical',
              confidence: 0.8,
              t: now,
              details: {
                description: `${recentSideLooks} off-axis turns toward the ${dominantSide} within ${Math.round(this.config.repeatedSideLooksWindowMs / 1000)}s.`,
                side: dominantSide,
                yawFromNeutral,
                lookCount: recentSideLooks,
              },
            });
            this.lastSideLookEmitTs = now;
            // Reset after firing to avoid repeated triggers
            this.sideLookTimestamps = [];
            this.sideLookDirections = [];
          }
        }
      }
    }

    // ---- LOOKING_DOWN_REPEATEDLY ----
    if (pitchFromNeutral < this.config.lookingDownPitchThresholdDeg) {
      const prevPitch = this.pitchHistory.length >= 2 ? this.pitchHistory[this.pitchHistory.length - 2].pitch : 0;
      if (prevPitch >= this.config.lookingDownPitchThresholdDeg) {
        // Just crossed threshold - new downward look
        this.downLookTimestamps.push(now);
        // Keep only looks within the window
        const windowStart = now - this.config.repeatedSideLooksWindowMs;
        while (this.downLookTimestamps.length > 0 && this.downLookTimestamps[0] < windowStart) {
          this.downLookTimestamps.shift();
        }
        const recentDownLooks = this.downLookTimestamps.length;
        if (recentDownLooks >= this.config.lookingDownRepeatedlyThreshold) {
          const cooldownOk = now - this.lastDownLookEmitTs >= this.config.lookingDownRepeatedlyCooldownMs;
          if (cooldownOk) {
            this.emit({
              code: 'LOOKING_DOWN_REPEATEDLY',
              severity: 'critical',
              confidence: 0.8,
              t: now,
              details: {
                description: `${recentDownLooks} downward head movements within ${Math.round(this.config.repeatedSideLooksWindowMs / 1000)}s (pitch: ${Math.round(pitchFromNeutral)}� from neutral).`,
                pitchFromNeutral,
                lookCount: recentDownLooks,
              },
            });
            this.lastDownLookEmitTs = now;
            this.downLookTimestamps = [];
          }
        }
      }
    }
  }

  /** Get the yaw/pitch history for the debug plot. */
  getHistory(): { yaw: Array<{ t: number; yaw: number }>; pitch: Array<{ t: number; pitch: number }> } {
    return {
      yaw: [...this.yawHistory],
      pitch: [...this.pitchHistory],
    };
  }

  /** Get current smoothed yaw/pitch relative to neutral. */
  getCurrentPose(): { yawFromNeutral: number; pitchFromNeutral: number; calibrated: boolean } {
    return {
      yawFromNeutral: this.smoothedYaw - this.neutralYaw,
      pitchFromNeutral: this.smoothedPitch - this.neutralPitch,
      calibrated: this.calibrated,
    };
  }

  /** Reset for a new session. */
  reset(): void {
    this.smoothedYaw = 0;
    this.smoothedPitch = 0;
    this.smoothedRoll = 0;
    this.neutralYaw = 0;
    this.neutralPitch = 0;
    this.calibSamples = [];
    this.calibrated = false;
    this.calibStartTs = 0;
    this.offAxisStartTs = 0;
    this.lastOffAxisEmitTs = 0;
    this.sideLookTimestamps = [];
    this.sideLookDirections = [];
    this.lastSideLookEmitTs = 0;
    this.downLookTimestamps = [];
    this.lastDownLookEmitTs = 0;
    this.yawHistory = [];
    this.pitchHistory = [];
  }

  private _median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}

