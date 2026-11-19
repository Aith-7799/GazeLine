/** faceMonitor - multiple faces and face absence detection.
 * Emits MULTIPLE_FACES, FACE_ABSENT, LOOKING_DOWN_FACE_LOST.
 */

import type { FaceFrameInfo } from './facePipeline.js';
import type { IntegrityEvent } from './types.js';

export interface FaceMonitorEvent extends IntegrityEvent {
  details: {
    description: string;
    /** For MULTIPLE_FACES: position of second face. */
    secondFacePosition?: 'left' | 'right' | 'behind';
    /** For MULTIPLE_FACES: duration the second face was present. */
    durationMs?: number;
    /** For FACE_ABSENT: duration face was absent. */
    absenceDurationMs?: number;
    /** Whether the face was lost while looking down. */
    lookingDown?: boolean;
    /** Cumulative face-absent fraction of session. */
    cumulativeAbsentFrac?: number;
  };
}

export interface FaceMonitorConfig {
  multipleFacesDeduction: number;
  multipleFacesCooldownMs: number;
  multipleFacesDebounceMs: number;
  /** Min face box size (as fraction of frame area) below which a second face is ignored
   * (likely a poster/photo in the background). */
  minSecondFaceBoxFrac: number;
  faceAbsentDeduction: number;
  faceAbsentCooldownMs: number;
  faceAbsentThresholdMs: number;
  faceAbsentCumulativeThresholdFrac: number;
  faceAbsentCumulativeDeduction: number;
  /** Pitch threshold (degrees) below which "face lost" is classified as LOOKING_DOWN_FACE_LOST. */
  lookingDownPitchThresholdDeg: number;
}

export const DEFAULT_FACE_MONITOR_CFG: FaceMonitorConfig = {
  multipleFacesDeduction: 10,
  multipleFacesCooldownMs: 60000,
  multipleFacesDebounceMs: 1500,
  minSecondFaceBoxFrac: 0.05,
  faceAbsentDeduction: 3,
  faceAbsentCooldownMs: 5000,
  faceAbsentThresholdMs: 3000,
  faceAbsentCumulativeThresholdFrac: 0.10,
  faceAbsentCumulativeDeduction: 5,
  lookingDownPitchThresholdDeg: -20,
};

export class FaceMonitor {
  private config: FaceMonitorConfig;
  private _listeners = new Set<(ev: FaceMonitorEvent) => void>();

  // Multiple faces tracking
  private secondFaceStartTs = 0;
  private secondFacePresent = false;
  private secondFaceDuration = 0;
  private secondFacePosition: 'left' | 'right' | 'behind' = 'right';
  private lastMultipleFacesEmitTs = -Infinity;

  // Face absence tracking
  private faceAbsentStartTs = 0;
  private faceAbsentDuration = 0;
  private lastFacePitchWhenPresent = 0;
  private cumulativeAbsentMs = 0;
  private sessionStartTs = 0;
  private lastFaceAbsentEmitTs = -Infinity;
  private facePresentCount = 0;
  private totalFrameCount = 0;
  private _cumulativeEmitted = false;

  constructor(config: Partial<FaceMonitorConfig> = {}) {
    this.config = { ...DEFAULT_FACE_MONITOR_CFG, ...config };
  }

  /** Set session start time for cumulative tracking. */
  setSessionStart(ts: number): void {
    this.sessionStartTs = ts;
  }

  /** Subscribe to face monitor events. Returns unsubscribe. */
  onEvent(cb: (ev: FaceMonitorEvent) => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private emit(ev: FaceMonitorEvent): void {
    for (const l of this._listeners) l(ev);
  }

  /** Process a face-frame info. Call every frame from the face pipeline. */
  process(info: FaceFrameInfo, now: number): void {
    this.totalFrameCount++;

    // Track face presence for cumulative stats
    if (info.facePresent && info.numFaces >= 1) {
      this.facePresentCount++;
      this.lastFacePitchWhenPresent = info.pitchDeg;
      this.faceAbsentStartTs = 0;
      this.faceAbsentDuration = 0;
    }

    // ---- Multiple faces detection ----
    if (info.facePresent && info.numFaces > 1) {
      const box = info.faceBox;
      if (box) {
        // Check if the bounding box is large enough to not be a poster/photo.
        if (this._isFaceLargeEnough(box, info)) {
          if (!this.secondFacePresent) {
            this.secondFaceStartTs = now;
            this.secondFacePresent = true;
            // Determine position of second face relative to first
            this.secondFacePosition = this._detectSecondFacePosition(info);
          }
          this.secondFaceDuration = now - this.secondFaceStartTs;
        }
      }
    } else {
      // No second face currently
      if (this.secondFacePresent) {
        // Second face just disappeared
        this.secondFaceDuration = now - this.secondFaceStartTs;
        if (this.secondFaceDuration >= this.config.multipleFacesDebounceMs) {
          // Only emit if sustained long enough
          const cooldownOk = now - this.lastMultipleFacesEmitTs >= this.config.multipleFacesCooldownMs;
          if (cooldownOk) {
            this.emit({
              code: 'MULTIPLE_FACES',
              severity: 'critical',
              confidence: 0.8,
              t: now,
              details: {
                description: `Second face detected in frame for ${Math.round(this.secondFaceDuration / 1000)}s.`,
                secondFacePosition: this.secondFacePosition,
                durationMs: this.secondFaceDuration,
              },
            });
            this.lastMultipleFacesEmitTs = now;
          }
        }
        this.secondFacePresent = false;
        this.secondFaceDuration = 0;
        this.secondFaceStartTs = 0;
      }
    }

    // ---- Face absence detection ----
    if (!info.facePresent) {
      if (this.faceAbsentStartTs === 0) {
        this.faceAbsentStartTs = now;
        // Check if the last known pitch was strongly downward
        this.faceAbsentDuration = 0;
      } else {
        this.faceAbsentDuration = now - this.faceAbsentStartTs;
        this.cumulativeAbsentMs += 16; // assume ~60fps, approximate per-frame

        if (this.faceAbsentDuration >= this.config.faceAbsentThresholdMs) {
          const cooldownOk = now - this.lastFaceAbsentEmitTs >= this.config.faceAbsentCooldownMs;
          if (cooldownOk) {
            const wasLookingDown = this.lastFacePitchWhenPresent < this.config.lookingDownPitchThresholdDeg;
            const code: string = wasLookingDown ? 'LOOKING_DOWN_FACE_LOST' : 'FACE_ABSENT';
            const desc = wasLookingDown
              ? `Face lost for ${Math.round(this.faceAbsentDuration / 1000)}s while looking down (pitch: ${Math.round(this.lastFacePitchWhenPresent)}�).`
              : `No face detected for ${Math.round(this.faceAbsentDuration / 1000)}s.`;
            this.emit({
              code,
              severity: wasLookingDown ? 'warn' : 'warn',
              confidence: wasLookingDown ? 0.7 : 0.6,
              t: now,
              details: {
                description: desc,
                absenceDurationMs: this.faceAbsentDuration,
                lookingDown: wasLookingDown,
              },
            });
            this.lastFaceAbsentEmitTs = now;
          }
        }
      }
    }

    // Cumulative absence check (per session)
    if (this.sessionStartTs > 0 && this.totalFrameCount > 0) {
      const elapsed = now - this.sessionStartTs;
      if (elapsed > 0) {
        const absentFrac = this.cumulativeAbsentMs / elapsed;
        if (absentFrac >= this.config.faceAbsentCumulativeThresholdFrac) {
          // Emit once when threshold is first crossed
          if (!this._cumulativeEmitted) {
            this._cumulativeEmitted = true;
            this.emit({
              code: 'FACE_ABSENT_CUMULATIVE',
              severity: 'warn',
              confidence: 0.6,
              t: now,
              details: {
                description: `Cumulative face absence exceeds ${Math.round(this.config.faceAbsentCumulativeThresholdFrac * 100)}% of session.`,
                cumulativeAbsentFrac: absentFrac,
              },
            });
          }
        }
      }
    }
  }

  private _isFaceLargeEnough(box: { x0: number; y0: number; x1: number; y1: number }, _info: FaceFrameInfo): boolean {
    const normW = box.x1 - box.x0;
    const normH = box.y1 - box.y0;
    const frac = normW * normH;
    return frac >= this.config.minSecondFaceBoxFrac;
  }

  private _detectSecondFacePosition(_info: FaceFrameInfo): 'left' | 'right' | 'behind' {
    return 'right';
  }

  /** Get cumulative face-present percentage. */
  getFacePresentPercent(now: number): number {
    if (this.sessionStartTs === 0 || now === 0) return 100;
    const elapsed = now - this.sessionStartTs;
    if (elapsed <= 0) return 100;
    const absentMs = this.cumulativeAbsentMs;
    return Math.max(0, Math.min(100, ((elapsed - absentMs) / elapsed) * 100));
  }

  /** Reset state for a new session. */
  reset(): void {
    this.secondFacePresent = false;
    this.secondFaceDuration = 0;
    this.secondFaceStartTs = 0;
    this.faceAbsentStartTs = 0;
    this.faceAbsentDuration = 0;
    this.cumulativeAbsentMs = 0;
    this.lastFacePitchWhenPresent = 0;
    // _lastFacePresentTs removed
    this.lastMultipleFacesEmitTs = -Infinity;
    this.lastFaceAbsentEmitTs = -Infinity;
    this.facePresentCount = 0;
    this.totalFrameCount = 0;
    this._cumulativeEmitted = false;
  }
}

