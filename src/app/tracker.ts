import {
  WebcamETLight, type CalibrationSample, type GazePoint, type FaceLandmarkerResult,
} from '@realeye-io/webcam-eyetracker-light-open';

export type { FaceLandmarkerResult };
export const CAL_CAPTURE_W = 640;
export const CAL_CAPTURE_H = 480;

export interface PredictResult {
  gaze: GazePoint | null;
  facePresent: boolean;
  faceResult: FaceLandmarkerResult | null;
  frame: ImageData;
}

export class GazeTracker {
  private tracker: WebcamETLight | null = null;
  private video: HTMLVideoElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private delegate: 'GPU' | 'CPU' = 'GPU';
  private stopFrames: (() => void) | null = null;

  onResult: ((r: PredictResult) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;

  get initialized(): boolean { return this.tracker !== null; }
  get calibrated(): boolean { return this.tracker?.isCalibrated() ?? false; }
  get activeDelegate(): 'GPU' | 'CPU' { return this.delegate; }

  async initialize(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
    this.dispose();
    this.video = video;
    const canvas = document.createElement('canvas');
    canvas.width = CAL_CAPTURE_W;
    canvas.height = CAL_CAPTURE_H;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('Camera frame capture is unavailable.');
    for (const delegate of ['GPU', 'CPU'] as const) {
      signal.throwIfAborted();
      // The SDK replays still images during fitting. Use the same independent
      // detection for capture, replay and prediction, even across nonadjacent frames.
      const engine = new WebcamETLight({ delegate, runningMode: 'IMAGE', wasmPath: '/gaze-runtime' });
      try {
        await engine.initialize();
        signal.throwIfAborted();
        this.tracker = engine;
        this.delegate = delegate;
        return;
      } catch (error) {
        engine.dispose();
        if (signal.aborted || delegate === 'CPU') throw error;
        console.warn('[gazeline] Retrying gaze initialization on CPU.', error);
      }
    }
  }

  private grabFrame(): ImageData | null {
    const video = this.video;
    if (!video || !this.ctx || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
    // Only the preview is mirrored. The SDK receives the original camera image
    // both when fitting and predicting, paired with visible CSS pixel coordinates.
    this.ctx.drawImage(video, 0, 0, CAL_CAPTURE_W, CAL_CAPTURE_H);
    return this.ctx.getImageData(0, 0, CAL_CAPTURE_W, CAL_CAPTURE_H);
  }

  async captureCalibrationSample(gazeX: number, gazeY: number): Promise<CalibrationSample | null> {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const image = this.grabFrame();
    if (!image || !this.tracker?.detectFace(image)) return null;
    return { image, gazeX, gazeY };
  }

  calibrate(samples: CalibrationSample[]): void {
    if (!this.tracker) throw new Error('The gaze tracker is still loading.');
    this.tracker.calibrate(samples);
  }

  start(): void {
    if (this.stopFrames || !this.video || !this.tracker) return;
    const video = this.video;
    let frames = 0;
    let fpsAt = performance.now();
    let lastTime = -1;
    const processFrame = () => {
      if (lastTime === video.currentTime) return;
      lastTime = video.currentTime;
      const frame = this.grabFrame();
      if (!frame || !this.tracker) return;
      let faceResult: FaceLandmarkerResult | null = null;
      let facePresent = false;
      let gaze: GazePoint | null = null;
      try {
        const detection = this.tracker.detectFace(frame);
        facePresent = detection !== null;
        if (detection && 'allLandmarks' in detection) faceResult = detection;
        if (detection && this.tracker.isCalibrated()) {
          const point = this.tracker.predictWithDetection(frame, detection);
          if (Number.isFinite(point.x) && Number.isFinite(point.y)) gaze = point;
        }
      } catch {
        // A missing detection or prediction is a gap in the feed.
      }
      const now = performance.now();
      frames++;
      if (now - fpsAt >= 1000) {
        this.onFps?.(Math.round(frames * 1000 / (now - fpsAt)));
        frames = 0;
        fpsAt = now;
      }
      this.onResult?.({ gaze, facePresent, faceResult, frame });
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = () => { id = video.requestVideoFrameCallback(tick); processFrame(); };
      let id = video.requestVideoFrameCallback(tick);
      this.stopFrames = () => video.cancelVideoFrameCallback(id);
    } else {
      const tick = () => { id = requestAnimationFrame(tick); processFrame(); };
      let id = requestAnimationFrame(tick);
      this.stopFrames = () => cancelAnimationFrame(id);
    }
  }

  stop(): void {
    this.stopFrames?.();
    this.stopFrames = null;
  }

  dispose(): void {
    this.stop();
    this.tracker?.dispose();
    this.tracker = null;
    this.video = null;
    this.ctx = null;
  }
}
