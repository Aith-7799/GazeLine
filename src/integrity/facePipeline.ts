/** facePipeline - shared face-landmark hub that fans one FaceLandmarkerResult
 * (from the RealEye tracker's detectFace) out to all integrity modules.
 *
 * The RealEye tracker already runs MediaPipe FaceLandmarker internally, so we
 * reuse its blendshapes + transformationMatrix rather than creating a separate
 * FaceLandmarker instance. We only add lightweight post-processing on top.
 */

import type { FaceLandmarkerResult } from '../app/tracker.js';

export interface FacePipelineFrame {
  /** performance.now() epoch */
  t: number;
  /** The full face detection result from the tracker. */
  result: FaceLandmarkerResult | null;
  /** Whether any face was detected at all. */
  facePresent: boolean;
  /** Video/frame dimensions in CSS px (for normalized-coordinate conversion). */
  frameW: number;
  frameH: number;
}

/** Per-frame info extracted from a FaceLandmarkerResult for downstream modules. */
export interface FaceFrameInfo {
  t: number;
  facePresent: boolean;
  numFaces: number;
  faceConfidence: number;
  faceBox: { x0: number; y0: number; x1: number; y1: number } | null;
  faceBoxNorm: { x0: number; y0: number; x1: number; y1: number } | null;
  noseTip: { x: number; y: number } | null;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** eyeBlinkLeft / eyeBlinkRight blendshape values (0-1). */
  blinkLeft: number;
  blinkRight: number;
  /** Mean luminance of the face ROI (0-255). */
  faceLuminance: number | null;
  /** Left/right face-half luminance ratio (left/right). */
  leftRightLumRatio: number | null;
  /** Frame background luminance (for backlight check). */
  bgLuminance: number | null;
}

/** Listener for processed face frames. */
export type FaceFrameListener = (info: FaceFrameInfo) => void;

const NULL_INFO: FaceFrameInfo = {
  t: 0, facePresent: false, numFaces: 0, faceConfidence: 0,
  faceBox: null, faceBoxNorm: null, noseTip: null,
  yawDeg: 0, pitchDeg: 0, rollDeg: 0,
  blinkLeft: 0, blinkRight: 0,
  faceLuminance: null, leftRightLumRatio: null, bgLuminance: null,
};

/** Convert normalized landmark (0-1) to CSS px given frame dimensions. */
function toPx(v: number, dim: number): number {
  return v * dim;
}

/** Compute luminance from RGBA pixel data (mean of luminance weights). */
function luminanceFromRgba(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number | null {
  let sum = 0, count = 0;
  const sx = Math.max(0, Math.floor(x0));
  const sy = Math.max(0, Math.floor(y0));
  const ex = Math.min(w - 1, Math.ceil(x1));
  const ey = Math.min(h - 1, Math.ceil(y1));
  if (sx >= ex || sy >= ey) return null;
  for (let y = sy; y < ey; y++) {
    for (let x = sx; x < ex; x++) {
      const i = (y * w + x) * 4;
      // Standard luminance weights
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/** Extract the face bounding box from the first detected face's landmarks. */
export function faceBoxFromLandmarks(
  landmarks: { x: number; y: number }[],
  fw: number, fh: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!landmarks || landmarks.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const lm of landmarks) {
    if (lm.x < x0) x0 = lm.x;
    if (lm.y < y0) y0 = lm.y;
    if (lm.x > x1) x1 = lm.x;
    if (lm.y > y1) y1 = lm.y;
  }
  // Map normalized  px
  return {
    x0: toPx(x0, fw),
    y0: toPx(y0, fh),
    x1: toPx(x1, fw),
    y1: toPx(y1, fh),
  };
}

/** Compute yaw/pitch/roll from the facial transformation matrix.
 * MediaPipe's 3x3 transformation matrix maps the face mesh to a canonical
 * frame; we extract Euler angles as an approximation. This is a simplified
 * extraction - for production use a proper head-pose estimator would be better,
 * but it's sufficient for the off-axis / side-look detection we need. */
function poseFromMatrix(mat: number[][] | undefined): { yaw: number; pitch: number; roll: number } {
  if (!mat || mat.length < 3 || mat[0].length < 3) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }
  // The transformation matrix is a 3x3 affine matrix. Extract approximate
  // rotation angles from it. This is a rough approximation.
  const a = mat[0][0], b = mat[0][1], c = mat[1][0], d = mat[1][1];
  void a; void d;
  // pitch: rotation around x-axis (vertical tilt)
  const pitch = Math.asin(Math.max(-1, Math.min(1, -c))) * (180 / Math.PI);
  // yaw: rotation around y-axis (horizontal turn)
  const yaw = Math.asin(Math.max(-1, Math.min(1, b))) * (180 / Math.PI);
  // roll: rotation around z-axis (tilt)
  const roll = Math.atan2(-mat[0][1], mat[0][0]) * (180 / Math.PI);
  return { yaw, pitch, roll };
}

export function detectGlassesGlare(
  data: Uint8ClampedArray, fw: number, fh: number,
  leftEyeBox: { x0: number; y0: number; x1: number; y1: number },
  rightEyeBox: { x0: number; y0: number; x1: number; y1: number },
): { leftGlare: boolean; rightGlare: boolean } {
  function checkGlare(box: { x0: number; y0: number; x1: number; y1: number }): boolean {
    const lm = luminanceFromRgba(data, fw, fh, box.x0, box.y0, box.x1, box.y1);
    if (lm === null) return false;
    // Very bright region (> 200/255) in a small area suggests glare
    return lm > 200;
  }
  return {
    leftGlare: checkGlare(leftEyeBox),
    rightGlare: checkGlare(rightEyeBox),
  };
}

export class FacePipeline {
  private listeners = new Set<FaceFrameListener>();
  /** Frame dimensions last seen. */
  private fw = 640;
  private fh = 480;
  /** Latest extracted info, for modules that poll. */
  private latest: FaceFrameInfo = { ...NULL_INFO, t: 0 };

  /** Push a processed frame to all listeners. */
  push(info: FaceFrameInfo): void {
    this.latest = info;
    for (const l of this.listeners) l(info);
  }

  /** Subscribe to face-frame updates. Returns an unsubscribe function. */
  onFrame(cb: FaceFrameListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Get the latest face-frame info. */
  getLatest(): FaceFrameInfo {
    return this.latest;
  }

  /** Process a raw FaceLandmarkerResult from the tracker into FaceFrameInfo. */
  process({
    t,
    result,
    facePresent,
    frameW,
    frameH,
    optionalFrameData,
  }: {
    t: number;
    result: FaceLandmarkerResult | null;
    facePresent: boolean;
    frameW: number;
    frameH: number;
    optionalFrameData?: ImageData | null;
  }): FaceFrameInfo {
    this.fw = frameW;
    this.fh = frameH;

    if (!result || !facePresent) {
      return {
        ...NULL_INFO,
        t,
        facePresent: false,
        numFaces: 0,
        faceConfidence: 0,
      };
    }

    const allLandmarks = result.allLandmarks;
    const face = allLandmarks?.[0];
    const numFaces = allLandmarks?.length ?? 0;
    const faceConfidence = result.confidence ?? 0;

    // Face bounding box from first face's landmarks
    let faceBoxNorm: { x0: number; y0: number; x1: number; y1: number } | null = null;
    if (face && allLandmarks) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const lm of allLandmarks) {
        if (lm.x < x0) x0 = lm.x;
        if (lm.y < y0) y0 = lm.y;
        if (lm.x > x1) x1 = lm.x;
        if (lm.y > y1) y1 = lm.y;
      }
      faceBoxNorm = { x0, y0, x1, y1 };
    }

    const faceBox = faceBoxNorm
      ? {
          x0: toPx(faceBoxNorm.x0, frameW),
          y0: toPx(faceBoxNorm.y0, frameH),
          x1: toPx(faceBoxNorm.x1, frameW),
          y1: toPx(faceBoxNorm.y1, frameH),
        }
      : null;

    // Nose tip (MediaPipe landmark index 1) - use first face's landmark at index 1
    const noseTip: { x: number; y: number } | null =
      allLandmarks && allLandmarks.length > 1
        ? { x: toPx(allLandmarks[1].x, frameW), y: toPx(allLandmarks[1].y, frameH) }
        : null;

    // Head pose from transformation matrix
    const { yaw, pitch, roll } = poseFromMatrix(result.transformationMatrix);

    // Blendshapes - eye blink values (FaceBlendshapes object, not array)
    const blendshapes = result.blendshapes;
    const blinkLeft = blendshapes?.eyeBlinkLeft ?? 0;
    const blinkRight = blendshapes?.eyeBlinkRight ?? 0;

    // Luminance analysis (needs frame pixel data)
    let faceLuminance: number | null = null;
    let leftRightLumRatio: number | null = null;
    let bgLuminance: number | null = null;
    if (optionalFrameData) {
      const data = optionalFrameData.data;
      if (faceBox) {
        faceLuminance = luminanceFromRgba(
          data, frameW, frameH,
          faceBox.x0, faceBox.y0, faceBox.x1, faceBox.y1,
        );
        // Left/right halves
        const cx = (faceBox.x0 + faceBox.x1) / 2;
        const leftLum = luminanceFromRgba(
          data, frameW, frameH,
          faceBox.x0, faceBox.y0, cx, faceBox.y1,
        );
        const rightLum = luminanceFromRgba(
          data, frameW, frameH,
          cx, faceBox.y0, faceBox.x1, faceBox.y1,
        );
        if (leftLum !== null && rightLum !== null && rightLum > 0) {
          leftRightLumRatio = leftLum / rightLum;
        }
      }
      // Background luminance: sample the top-left corner of the frame (away from face)
      bgLuminance = luminanceFromRgba(data, frameW, frameH, 0, 0, Math.min(50, frameW), Math.min(50, frameH));
    }

    return {
      t,
      facePresent: true,
      numFaces,
      faceConfidence,
      faceBox,
      faceBoxNorm,
      noseTip,
      yawDeg: yaw,
      pitchDeg: pitch,
      rollDeg: roll,
      blinkLeft,
      blinkRight,
      faceLuminance,
      leftRightLumRatio,
      bgLuminance,
    };
  }

  /** Get the current frame dimensions. */
  getFrameSize(): { w: number; h: number } {
    return { w: this.fw, h: this.fh };
  }
}

