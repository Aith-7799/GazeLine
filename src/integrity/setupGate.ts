/** setupGate - "Check your setup" step that runs between camera permission and
 * calibration. Emits setup-check events and a final setup-quality summary. */

import type { FaceFrameInfo } from './facePipeline.js';
export interface SetupCheckItem {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'pending';
  tip: string;
  detail?: string;
}

export interface SetupQualitySummary {
  ts: number;
  faceDetected: boolean;
  exactlyOneFace: boolean;
  faceSizeOk: boolean;
  faceCentered: boolean;
  headFrontal: boolean;
  lightingOk: boolean;
  eyesVisible: boolean;
  cameraSteady: boolean;
  resolutionOk: boolean;
  fpsOk: boolean;
  overall: 'good' | 'fair' | 'poor';
  faceBoxHeightFrac: number | null;
  noseCenterFrac: number | null;
  yawDeg: number | null;
  pitchDeg: number | null;
  faceLuminance: number | null;
  leftRightRatio: number | null;
  facePresentFraction: number;
  numSamples: number;
}

export interface SetupGateConfig {
  /** Face bounding box height as fraction of frame height: acceptable range. */
  faceSizeMinFrac: number;
  faceSizeMaxFrac: number;
  /** Nose tip within central fraction of frame width/height. */
  centerFrac: number;
  /** Max yaw/pitch deviation from frontal (degrees). */
  maxHeadAngleDeg: number;
  /** Acceptable mean face luminance range (0-255). */
  luminanceMin: number;
  luminanceMax: number;
  /** Max left/right face-half luminance ratio deviation from 1.0. */
  maxLuminanceRatioDev: number;
  /** Backlight: face luminance must be at least this fraction of background. */
  minFaceToBgRatio: number;
  /** Max frame-to-frame nose position variance over the stability window (px). */
  maxPositionVariancePx: number;
  /** Stability window duration (ms). */
  stabilityWindowMs: number;
  /** Minimum face-box height fraction for "too small / too far" warning. */
  tooSmallFrac: number;
  /** Minimum face-box height fraction for "too large / too close" warning. */
  tooLargeFrac: number;
  /** Minimum frame width for resolution check. */
  minFrameW: number;
  /** Minimum frame height for resolution check. */
  minFrameH: number;
  /** Minimum fps for FPS check. */
  minFps: number;
}

export const DEFAULT_SETUP_CFG: SetupGateConfig = {
  faceSizeMinFrac: 0.25,
  faceSizeMaxFrac: 0.60,
  centerFrac: 0.40,
  maxHeadAngleDeg: 15,
  luminanceMin: 40,
  luminanceMax: 200,
  maxLuminanceRatioDev: 0.40,
  minFaceToBgRatio: 0.5,
  maxPositionVariancePx: 30,
  stabilityWindowMs: 2000,
  tooSmallFrac: 0.20,
  tooLargeFrac: 0.65,
  minFrameW: 640,
  minFrameH: 480,
  minFps: 15,
};

export class SetupGate {
  private config: SetupGateConfig;
  private items: SetupCheckItem[] = [];
  private faceInfos: FaceFrameInfo[] = [];
  private fps = 0;
  private frameW = 0;
  private frameH = 0;
  private facePresentCount = 0;
  private totalCount = 0;
  private _ready = false;
  private _done = false;
  private requiredPass: Set<string> = new Set(['faceDetected', 'faceSizeOk', 'lightingOk', 'eyesVisible']);

  constructor(config: Partial<SetupGateConfig> = {}) {
    this.config = { ...DEFAULT_SETUP_CFG, ...config };
    this.items = [
      { id: 'faceDetected', label: 'Face detected', status: 'pending', tip: 'Position your face in front of the camera so it is fully visible.' },
      { id: 'exactlyOneFace', label: 'One face in frame', status: 'pending', tip: 'Make sure you are the only person in front of the camera.' },
      { id: 'faceSizeOk', label: 'Face size', status: 'pending', tip: 'Move closer or farther so your face fills about a quarter to half of the frame height.' },
      { id: 'faceCentered', label: 'Face centered', status: 'pending', tip: 'Center your face in the camera frame.' },
      { id: 'headFrontal', label: 'Head angle', status: 'pending', tip: 'Face the camera directly - avoid strong head turns or tilts.' },
      { id: 'lightingOk', label: 'Lighting', status: 'pending', tip: 'Face a window or lamp. Avoid strong backlight or side light.' },
      { id: 'eyesVisible', label: 'Eyes visible', status: 'pending', tip: 'Keep your eyes fully visible - adjust glasses if they reflect the light source.' },
      { id: 'cameraSteady', label: 'Camera steady', status: 'pending', tip: 'Keep your head and the camera still during setup.' },
      { id: 'resolutionOk', label: 'Camera resolution', status: 'pending', tip: 'Use a camera with at least 640x480 resolution.' },
      { id: 'fpsOk', label: 'Frame rate', status: 'pending', tip: 'Use a camera or connection that delivers at least 15 fps.' },
    ];
  }

  /** Feed a new face-frame info into the gate. */
  feed(info: FaceFrameInfo, frameW: number, frameH: number, fps: number): void {
    if (this._done) return;
    this.faceInfos.push(info);
    if (this.faceInfos.length > 200) this.faceInfos.shift();
    this.frameW = frameW;
    this.frameH = frameH;
    this.fps = fps;
    this.totalCount++;
    if (info.facePresent) this.facePresentCount++;
    this._updateItems();
  }

  /** Feed a frame where no face was detected (e.g. during warmup). */
  feedEmpty(t: number, frameW: number, frameH: number, fps: number): void {
    if (this._done) return;
    this.feed({
      t,
      facePresent: false,
      numFaces: 0,
      faceConfidence: 0,
      faceBox: null,
      faceBoxNorm: null,
      noseTip: null,
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      blinkLeft: 0,
      blinkRight: 0,
      faceLuminance: null,
      leftRightLumRatio: null,
      bgLuminance: null,
    }, frameW, frameH, fps);
  }

  private _updateItems(): void {
    const last = this.faceInfos[this.faceInfos.length - 1];
    const fh = this.frameH || 480;
    const fw = this.frameW || 640;

    // Face detected
    const faceDetected = last.facePresent;
    this._setItem('faceDetected', faceDetected ? 'pass' : 'fail',
      faceDetected ? '' : 'Allow the camera to see your face. Position yourself in front of it.',
      faceDetected ? undefined : 'No face detected in the last frame.');

    // Exactly one face
    const oneFace = last.facePresent && last.numFaces === 1;
    this._setItem('exactlyOneFace', oneFace ? 'pass' : (last.facePresent && last.numFaces > 1 ? 'fail' : 'pending'),
      oneFace ? '' : (last.numFaces > 1 ? 'Only one person should be in front of the camera.' : ''),
      last.numFaces !== 1 ? `Detected ${last.numFaces} face(s).` : undefined);

    // Face size
    const faceSizeOk = this._checkFaceSize(last, fh);
    this._setItem('faceSizeOk', faceSizeOk ? 'pass' : 'fail',
      faceSizeOk ? '' : this._faceSizeTip(last, fh),
      faceSizeOk ? undefined : this._faceSizeDetail(last, fh));

    // Face centered
    const faceCentered = this._checkFaceCenter(last, fw, fh);
    this._setItem('faceCentered', faceCentered ? 'pass' : 'warn',
      faceCentered ? '' : 'Center your face in the frame.',
      faceCentered ? undefined : `Nose at ${last.noseTip ? ((last.noseTip.x / fw) * 100).toFixed(0) : '-'}% horizontal, ${last.noseTip ? ((last.noseTip.y / fh) * 100).toFixed(0) : '-'}% vertical.`);

    // Head frontal
    const headFrontal = this._checkHeadFrontal(last);
    this._setItem('headFrontal', headFrontal ? 'pass' : 'warn',
      headFrontal ? '' : 'Turn your head to face the camera more directly.',
      headFrontal ? undefined : `Yaw: ${Math.round(last.yawDeg)}�, Pitch: ${Math.round(last.pitchDeg)}�`);

    // Lighting
    const lightingOk = this._checkLighting(last);
    this._setItem('lightingOk', lightingOk ? 'pass' : 'fail',
      lightingOk ? '' : this._lightingTip(last),
      lightingOk ? undefined : this._lightingDetail(last));

    // Eyes visible
    const eyesVisible = this._checkEyesVisible(last);
    this._setItem('eyesVisible', eyesVisible ? 'pass' : 'fail',
      eyesVisible ? '' : 'Make sure both eyes are visible and not occluded by hair, hands, or glasses glare.',
      eyesVisible ? undefined : this._eyesDetail(last));

    // Camera steady
    const cameraSteady = this._checkCameraSteady();
    this._setItem('cameraSteady', cameraSteady ? 'pass' : 'warn',
      cameraSteady ? '' : 'Keep your head and the camera still.',
      cameraSteady ? undefined : undefined);

    // Resolution
    const resolutionOk = fw >= this.config.minFrameW && fh >= this.config.minFrameH;
    this._setItem('resolutionOk', resolutionOk ? 'pass' : 'warn',
      resolutionOk ? '' : `Camera resolution is ${fw}x${fh}, below the ${this.config.minFrameW}x${this.config.minFrameH} recommendation.`,
      resolutionOk ? undefined : `Resolution: ${fw}x${fh}`);

    // FPS
    const fpsOk = this.fps >= this.config.minFps;
    this._setItem('fpsOk', fpsOk ? 'pass' : 'warn',
      fpsOk ? '' : `Frame rate is ${this.fps} fps, below the ${this.config.minFps} fps recommendation.`,
      fpsOk ? undefined : `FPS: ${this.fps}`);
  }

  private _checkFaceSize(info: FaceFrameInfo, fh: number): boolean {
    if (!info.faceBox) return false;
    const boxH = info.faceBox.y1 - info.faceBox.y0;
    const frac = boxH / fh;
    return frac >= this.config.faceSizeMinFrac && frac <= this.config.faceSizeMaxFrac;
  }

  private _faceSizeTip(info: FaceFrameInfo, fh: number): string {
    if (!info.faceBox) return 'Position your face in front of the camera.';
    const frac = (info.faceBox.y1 - info.faceBox.y0) / fh;
    if (frac < this.config.tooSmallFrac) return 'Move closer to the camera - your face is too small in the frame.';
    if (frac > this.config.tooLargeFrac) return 'Move farther from the camera - your face is too close and fills too much of the frame.';
    return 'Adjust your distance so your face fills about a quarter to half of the frame height.';
  }

  private _faceSizeDetail(info: FaceFrameInfo, fh: number): string {
    if (!info.faceBox) return 'No face box.';
    const frac = ((info.faceBox.y1 - info.faceBox.y0) / fh * 100).toFixed(1);
    return `Face box height: ${frac}% of frame height (target: ${this.config.faceSizeMinFrac * 100}-${this.config.faceSizeMaxFrac * 100}%).`;
  }

  private _checkFaceCenter(info: FaceFrameInfo, fw: number, fh: number): boolean {
    if (!info.noseTip) return false;
    const hFrac = info.noseTip.x / fw;
    const vFrac = info.noseTip.y / fh;
    const halfRange = this.config.centerFrac / 2;
    return hFrac >= 0.5 - halfRange && hFrac <= 0.5 + halfRange &&
      vFrac >= 0.5 - halfRange && vFrac <= 0.5 + halfRange;
  }

  private _checkHeadFrontal(info: FaceFrameInfo): boolean {
    return Math.abs(info.yawDeg) <= this.config.maxHeadAngleDeg && Math.abs(info.pitchDeg) <= this.config.maxHeadAngleDeg;
  }

  private _checkLighting(info: FaceFrameInfo): boolean {
    if (info.faceLuminance === null) return false;
    if (info.faceLuminance < this.config.luminanceMin || info.faceLuminance > this.config.luminanceMax) return false;
    if (info.leftRightLumRatio !== null) {
      const dev = Math.abs(info.leftRightLumRatio - 1);
      if (dev > this.config.maxLuminanceRatioDev) return false;
    }
    if (info.bgLuminance !== null && info.faceLuminance < info.bgLuminance * this.config.minFaceToBgRatio) return false;
    return true;
  }

  private _lightingTip(info: FaceFrameInfo): string {
    if (info.faceLuminance !== null && info.faceLuminance < this.config.luminanceMin) return 'It is too dark. Face a window or lamp to light your face evenly.';
    if (info.faceLuminance !== null && info.faceLuminance > this.config.luminanceMax) return 'It is too bright. Move away from direct light or reduce the light source.';
    if (info.leftRightLumRatio !== null && Math.abs(info.leftRightLumRatio - 1) > this.config.maxLuminanceRatioDev) return 'There is strong side lighting. Move so the light is in front of you.';
    if (info.bgLuminance !== null && info.faceLuminance !== null && info.faceLuminance < info.bgLuminance * this.config.minFaceToBgRatio) return 'There appears to be strong backlight. Face the light source instead of having it behind you.';
    return 'Improve your lighting - face a window or lamp, and avoid strong side or back light.';
  }

  private _lightingDetail(info: FaceFrameInfo): string | undefined {
    if (info.faceLuminance !== null) return `Face luminance: ${Math.round(info.faceLuminance)} / 255`;
    return undefined;
  }

  private _checkEyesVisible(info: FaceFrameInfo): boolean {
    // Both eye blink values low = eyes open and visible
    const eyesOpen = info.blinkLeft < 0.3 && info.blinkRight < 0.3;
    if (!eyesOpen) return false;
    return true;
  }

  private _eyesDetail(info: FaceFrameInfo): string | undefined {
    return `Left eye: ${info.blinkLeft.toFixed(2)}, Right eye: ${info.blinkRight.toFixed(2)} (values near 0 = open)`;
  }

  private _checkCameraSteady(): boolean {
    if (this.faceInfos.length < 2) return false;
    const window = this.faceInfos.filter(
      (f) => f.t > this.faceInfos[this.faceInfos.length - 1].t - this.config.stabilityWindowMs,
    );
    if (window.length < 5) return false;
    const nosePositions = window
      .filter((f) => f.noseTip)
      .map((f) => f.noseTip!);
    if (nosePositions.length < 3) return true;
    let sumX = 0, sumY = 0;
    for (const p of nosePositions) { sumX += p.x; sumY += p.y; }
    const meanX = sumX / nosePositions.length;
    const meanY = sumY / nosePositions.length;
    let variance = 0;
    for (const p of nosePositions) {
      variance += (p.x - meanX) ** 2 + (p.y - meanY) ** 2;
    }
    variance /= nosePositions.length;
    return Math.sqrt(variance) < this.config.maxPositionVariancePx;
  }

  private _setItem(
    id: string,
    status: SetupCheckItem['status'],
    tip: string,
    detail?: string,
  ): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    // Don't downgrade from pass to pending
    if (item.status === 'pass' && status === 'pending') return;
    // Don't upgrade automatically - once failed, stays until passing
    if (item.status === 'fail' && status !== 'pass') {
      item.tip = tip;
      if (detail !== undefined) item.detail = detail;
      return;
    }
    item.status = status;
    item.tip = tip;
    if (detail !== undefined) item.detail = detail;
  }

  /** All required checks pass. */
  get ready(): boolean {
    return this._ready;
  }

  /** Whether the setup has been completed (even if overridden). */
  get done(): boolean {
    return this._done;
  }

  /** Get the current checklist items. */
  getItems(): SetupCheckItem[] {
    return [...this.items];
  }

  /** Check whether all required items pass. */
  allRequiredPass(): boolean {
    for (const id of this.requiredPass) {
      const item = this.items.find((i) => i.id === id);
      if (!item || item.status !== 'pass') return false;
    }
    return true;
  }

  /** Marks setup as done (after calibration starts or override). Stores the summary. */
  complete(): SetupQualitySummary {
    this._done = true;
    this._ready = this.allRequiredPass();
    const last = this.faceInfos[this.faceInfos.length - 1];
    const fh = this.frameH || 480;
    const fw = this.frameW || 640;
    const faceBoxH = last.faceBox ? (last.faceBox.y1 - last.faceBox.y0) / fh : null;
    const noseHFrac = last.noseTip ? last.noseTip.x / fw : null;
    const facePresentFrac = this.totalCount > 0 ? this.facePresentCount / this.totalCount : 0;
    const overall: 'good' | 'fair' | 'poor' =
      this._ready ? 'good' : (facePresentFrac > 0.5 ? 'fair' : 'poor');
    return {
      ts: performance.now(),
      faceDetected: last.facePresent,
      exactlyOneFace: last.facePresent && last.numFaces === 1,
      faceSizeOk: this._checkFaceSize(last, fh),
      faceCentered: this._checkFaceCenter(last, fw, fh),
      headFrontal: this._checkHeadFrontal(last),
      lightingOk: this._checkLighting(last),
      eyesVisible: this._checkEyesVisible(last),
      cameraSteady: this._checkCameraSteady(),
      resolutionOk: fw >= this.config.minFrameW && fh >= this.config.minFrameH,
      fpsOk: this.fps >= this.config.minFps,
      overall,
      faceBoxHeightFrac: faceBoxH,
      noseCenterFrac: noseHFrac,
      yawDeg: last.yawDeg,
      pitchDeg: last.pitchDeg,
      faceLuminance: last.faceLuminance,
      leftRightRatio: last.leftRightLumRatio,
      facePresentFraction: facePresentFrac,
      numSamples: this.faceInfos.length,
    };
  }

  /** Reset for re-use. */
  reset(): void {
    this._ready = false;
    this._done = false;
    this.faceInfos = [];
    this.facePresentCount = 0;
    this.totalCount = 0;
    for (const item of this.items) {
      item.status = 'pending';
      item.detail = undefined;
    }
  }
}

