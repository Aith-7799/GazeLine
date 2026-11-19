/**
 * tracker - thin wrapper around @realeye-io/webcam-eyetracker-light-open that
 * mirrors the pattern from the library's README / apps/demo_app.
 *
 * Also exposes the raw FaceLandmarkerResult (blendshapes + transformationMatrix)
 * so integrity modules can reuse one face pipeline.
 */
import {
  WebcamETLight,
  getRecommendedPattern,
  getCalibrationPointsInPixels,
  type CalibrationSample,
  type GazePoint,
  type FaceLandmarkerResult,
} from '@realeye-io/webcam-eyetracker-light-open';

export type { FaceLandmarkerResult };

const CAL_W = 640;  // capture resolution - the lib resizes eye crops internally
const CAL_H = 480;

export const CAL_CAPTURE_W = CAL_W;
export const CAL_CAPTURE_H = CAL_H;

export interface PredictResult {
  gaze: GazePoint | null;
  facePresent: boolean;
  faceResult: FaceLandmarkerResult | null;
}

export class GazeTracker {
  private tracker: WebcamETLight | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private delegate: 'GPU' | 'CPU' = 'GPU';
  private rafId = 0;
  private running = false;

  onResult: ((r: PredictResult) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;

  get initialized(): boolean {
    return this.tracker !== null && this.tracker.isReady();
  }
  get calibrated(): boolean {
    return this.tracker !== null && this.tracker.isCalibrated();
  }
  get activeDelegate(): 'GPU' | 'CPU' {
    return this.delegate;
  }

  async ensureVideo(mediaStream: MediaStream): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.srcObject = mediaStream;
    v.muted = true;
    v.playsInline = true;
    await new Promise<void>((res) => {
      v.onloadedmetadata = () => res();
    });
    await v.play();
    this.video = v;
    return v;
  }

  /** Initialize with GPU, fall back to CPU on failure (README's guidance). */
  async initialize(): Promise<void> {
    this.disposeTracker();
    const t = new WebcamETLight({ delegate: 'GPU' });
    try {
      await t.initialize();
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[gazeline] GPU init failed, retrying with CPU:', err);
      this.disposeTracker();
      const cpu = new WebcamETLight({ delegate: 'CPU' });
      await cpu.initialize();
      this.tracker = cpu;
      this.delegate = 'CPU';
      return;
    }
    this.tracker = t;
  }

  private ensureCanvas() {
    if (this.canvas) return;
    const c = document.createElement('canvas');
    c.width = CAL_W;
    c.height = CAL_H;
    this.canvas = c;
    this.ctx = c.getContext('2d', { willReadFrequently: true });
  }

  /** Draw the current video frame and return it as ImageData. */
  private grabFrame(): ImageData | null {
    if (!this.video || !this.video.videoWidth) return null;
    this.ensureCanvas();
    if (!this.ctx) return null;
    // mirror to match the displayed (scaleX(-1)) preview so predicted x maps to screen x
    this.ctx.save();
    this.ctx.setTransform(-1, 0, 0, 1, CAL_W, 0);
    this.ctx.drawImage(this.video, 0, 0, CAL_W, CAL_H);
    this.ctx.restore();
    return this.ctx.getImageData(0, 0, CAL_W, CAL_H);
  }

  /** Synchronous face check used by the setup step. */
  facePresent(): boolean {
    if (!this.tracker) return false;
    const frame = this.grabFrame();
    if (!frame) return false;
    return this.tracker.detectFace(frame) !== null;
  }

  /**
   * Capture one calibration sample: wait ~1 frame, grab the webcam image while
   * the user is looking at the on-screen target, and pair it with the target's
   * screen coordinates.
   */
  async captureCalibrationSample(gazeX: number, gazeY: number): Promise<CalibrationSample | null> {
    const frame = await new Promise<ImageData | null>((res) => {
      requestAnimationFrame(() => res(this.grabFrame()));
    });
    if (!frame) return null;
    return { image: frame, gazeX, gazeY };
  }

  /** Fit the ridge-regression model (demo-app flow: collect samples  calibrate). */
  calibrate(samples: CalibrationSample[]): void {
    if (!this.tracker) throw new Error('tracker not initialized');
    this.tracker.calibrate(samples);
  }

  /** Start the rAF prediction loop: every frame  predict  onResult. */
  start(): void {
    if (this.running || !this.tracker) return;
    this.running = true;
    let frames = 0;
    let fpsT = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      const frame = this.grabFrame();
      if (!frame || !this.tracker) return;
      let gaze: GazePoint | null = null;
      let facePresent = false;
      let faceResult: FaceLandmarkerResult | null = null;
      try {
        const det = this.tracker.detectFace(frame);
        facePresent = det !== null;
        // detectFace returns FaceDetectionResult | FaceLandmarkerResult | null
        // We want the FaceLandmarkerResult if available (has blendshapes + landmarks)
        if (det && 'allLandmarks' in det) {
          faceResult = det as FaceLandmarkerResult;
        }
        if (this.tracker.isCalibrated() && det) {
          gaze = this.tracker.predictWithDetection(frame, det);
        }
      } catch (e) {
        // prediction hiccups (face mid-blink etc.) are normal; treat as null
        gaze = null;
      }
      const now = performance.now();
      frames++;
      if (now - fpsT >= 1000) {
        this.onFps?.(Math.round((frames * 1000) / (now - fpsT)));
        frames = 0;
        fpsT = now;
      }
      this.onResult?.({ gaze, facePresent, faceResult });
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
  }

  private disposeTracker(): void {
    if (this.tracker) {
      try { this.tracker.dispose(); } catch { /* already disposed */ }
      this.tracker = null;
    }
  }

  /** Cleans up model/WASM resources (README: call dispose() on sign-out). */
  dispose(): void {
    this.stop();
    this.disposeTracker();
    this.canvas = null;
    this.ctx = null;
    if (this.video) {
      try { this.video.pause(); } catch { /* ignore */ }
      this.video.srcObject = null;
      this.video = null;
    }
  }
}

/** Recommended 17-point pattern, converted to screen pixels. */
export function calibrationTargets(w: number, h: number): { x: number; y: number }[] {
  return getCalibrationPointsInPixels(getRecommendedPattern(), w, h);
}

