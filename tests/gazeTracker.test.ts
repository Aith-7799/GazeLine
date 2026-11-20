import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GazeTracker, type FaceLandmarkerResult } from '../src/app/tracker.js';
import { FacePipeline } from '../src/integrity/facePipeline.js';

const engine = vi.hoisted(() => ({
  initialize: vi.fn(), dispose: vi.fn(), isCalibrated: vi.fn(),
  detectFace: vi.fn(), predictWithDetection: vi.fn(), calibrate: vi.fn(),
}));
vi.mock('@realeye-io/webcam-eyetracker-light-open', () => ({
  WebcamETLight: vi.fn(() => engine),
}));

describe('camera samples and gaze predictions', () => {
  const frame = { width: 640, height: 480 } as ImageData;
  const detection = { allLandmarks: [{ x: 0.3, y: 0.2 }, { x: 0.6, y: 0.7 }], confidence: 0.9 } as FaceLandmarkerResult;
  const video = {
    videoWidth: 640, readyState: 2, currentTime: 1,
    requestVideoFrameCallback: vi.fn(), cancelVideoFrameCallback: vi.fn(),
  };
  let tracker: GazeTracker;

  beforeEach(async () => {
    vi.clearAllMocks();
    engine.detectFace.mockReturnValue(detection);
    engine.isCalibrated.mockReturnValue(true);
    video.currentTime = 1;
    const ctx = { drawImage: vi.fn(), getImageData: () => frame };
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => fn(0));
    tracker = new GazeTracker();
    await tracker.initialize(video as unknown as HTMLVideoElement, new AbortController().signal);
  });
  afterEach(() => { tracker.dispose(); vi.unstubAllGlobals(); });

  it('validates the actual calibration image before pairing it with the target centre', async () => {
    engine.detectFace.mockReturnValueOnce(null);
    expect(await tracker.captureCalibrationSample(45, 82)).toBeNull();
    expect(await tracker.captureCalibrationSample(45, 82)).toEqual({ image: frame, gazeX: 45, gazeY: 82 });
    expect(engine.detectFace).toHaveBeenCalledWith(frame);
  });

  it('reuses a detection for prediction and resumes after a missing or non-finite estimate', () => {
    const results = vi.fn();
    tracker.onResult = results;
    tracker.start();
    const tick = () => { video.currentTime++; video.requestVideoFrameCallback.mock.lastCall![0](); };
    engine.detectFace.mockReturnValueOnce(null);
    tick();
    expect(results.mock.lastCall![0].gaze).toBeNull();
    expect(engine.predictWithDetection).not.toHaveBeenCalled();
    engine.predictWithDetection.mockReturnValueOnce({ x: NaN, y: 81 });
    tick();
    expect(results.mock.lastCall![0].gaze).toBeNull();
    engine.predictWithDetection.mockReturnValueOnce({ x: 418, y: 252 });
    tick();
    expect(results.mock.lastCall![0].gaze).toEqual({ x: 418, y: 252 });
    expect(engine.predictWithDetection).toHaveBeenCalledWith(frame, detection);
  });

  it('counts a single detected face without counting its landmarks as people', () => {
    const info = new FacePipeline().process({ t: 0, result: detection, facePresent: true, frameW: 640, frameH: 480 });
    expect(info.numFaces).toBe(1);
    expect(info.faceBoxNorm).toEqual({ x0: .3, y0: .2, x1: .6, y1: .7 });
  });
});
