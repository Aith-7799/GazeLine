/**
 * app - session routing and candidate orchestration (ported from the original
 * single-file GAZELINE app), now wired to:
 *  - webcam-eyetracker-light face/calibration/prediction flow
 *  - gazeBuffer (pushGaze/pushNull, onGaze subscribers)
 *  - readingDetector (250 ms analysis tick over a rolling window)
 *  - BroadcastChannel feed (flags + reading cycles) and Admin live thresholds
 *  - debug plot + test paragraph for tuning the detector
 */
import { buildApp, workspaces, IFRAME_SVGS } from './appHtml.js';
import { GazeTracker, CAL_CAPTURE_W, CAL_CAPTURE_H, type PredictResult } from './tracker.js';
import { runCalibrationWizard } from './calibration.js';
import { visibleGazePoint } from './viewport.js';
import { pushGaze, pushNull, windowSlice, clear as clearBuffer, type BufferEntry } from '../gazeBuffer.js';
import { analyze, updateBaseline, DEFAULT_READING_CFG, type ReadingDetectionConfig, type ReadingDetectionResult, type ReadingRegion } from '../readingDetector.js';
import { startGazeOverlay, stopGazeOverlay, clearGazeOverlay, setGazeOverlayVisible, isGazeOverlayVisible } from './gazeOverlay.js';

/* ================= integrity modules ================= */
import { FacePipeline } from '../integrity/facePipeline.js';
import { SetupGate, DEFAULT_SETUP_CFG, type SetupQualitySummary } from '../integrity/setupGate.js';
import { AttentionMonitor, type AttentionEvent } from '../integrity/attentionMonitor.js';
import { FaceMonitor } from '../integrity/faceMonitor.js';
import { HeadPoseTracker } from '../integrity/headPose.js';
import { BlinkAnalyzer, type BlinkAnalyzerEvent } from '../integrity/blinkAnalyzer.js';
import { DEFAULT_SCORING_CFG, initialScoreState, applyDeduction, type IntegrityEvent } from '../integrity/types.js';
import { bindInterviewDashboard } from './interviewDashboard.js';
import { bindCandidateInterview } from './candidateInterview.js';
import { snapshotScore, type Snapshot } from './interviewReport.js';
import { interviewRequest } from './interviewClient.js';

// CAL_CAPTURE_W/H are imported where needed from tracker

/* ================= helpers ================= */
const $ = (s: string): HTMLElement => document.querySelector(s) as HTMLElement;

/* Build the DOM first - every listener below assumes the app markup exists. */
buildApp();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtClock = (ms: number) => `${pad2(Math.floor(ms / 60000))}:${pad2(Math.floor(ms / 1000) % 60)}`;

const ROLE_LABEL: Record<string, string> = { candidate: 'Candidate', interviewer: 'Interviewer', admin: 'Admin' };
function initialsOf(name: string): string {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean);
  return ((parts[0] ?? '?').charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
}

/* ================= risk tiers (new cutoffs: >=80 LOW, 60-79 MEDIUM, 40-59 HIGH, <40 CRITICAL) ================= */
function tierFor(score: number): string {
  if (score >= 80) return 'LOW';
  if (score >= 60) return 'MEDIUM';
  if (score >= 40) return 'HIGH';
  return 'CRITICAL';
}

/* ================= session / routing ================= */
const SESSION_KEY = 'gazeline.session';
let session: { role: string; name: string } | null = null;
let interviewerToken: string | undefined;
try {
  const raw = localStorage.getItem(SESSION_KEY);
  const parsed = raw ? JSON.parse(raw) : null;
  if (parsed && workspaces.some(w => w.role === parsed.role)) session = parsed;
} catch { session = null; }

const VIEWS: Record<string, HTMLElement> = {
  login: document.getElementById('view-login')!,
  candidate: document.getElementById('view-candidate')!,
  interviewer: document.getElementById('view-interviewer')!,
  admin: document.getElementById('view-admin')!,
};
function show(view: string): void {
  for (const [k, el] of Object.entries(VIEWS)) el.classList.toggle('active', k === view);
  const on = !!session;
  $('#session-chip').classList.toggle('on', on);
  if (session) {
    $('#session-role').textContent = ROLE_LABEL[session.role] ?? session.role;
    $('#session-name').textContent = session.name;
    $('#session-avatar').textContent = initialsOf(session.name);
  }
  window.scrollTo(0, 0);
}

const privacyDialog = document.querySelector<HTMLDialogElement>('#privacy-dialog')!;
$('#open-privacy').addEventListener('click', () => privacyDialog.showModal());

const loginForm = document.querySelector<HTMLFormElement>('#login-form')!;
const loginButton = document.querySelector<HTMLButtonElement>('#login-submit')!;
const usernameInput = document.querySelector<HTMLInputElement>('#login-user')!;
const passwordInput = document.querySelector<HTMLInputElement>('#login-pass')!;
const visibilityButton = $('#toggle-password');
let loginRole: typeof workspaces[number]['role'] = 'candidate';

function setPasswordVisible(visible: boolean): void {
  passwordInput.type = visible ? 'text' : 'password';
  visibilityButton.setAttribute('aria-pressed', String(visible));
}
visibilityButton.addEventListener('click', () => setPasswordVisible(passwordInput.type === 'password'));
for (const radio of loginForm.querySelectorAll<HTMLInputElement>('input[name="role"]')) {
  radio.addEventListener('change', () => {
    const selected = workspaces.find(w => w.role === radio.value)!;
    loginRole = selected.role;
    $('#role-hint').textContent = selected.hint;
    usernameInput.placeholder = `e.g. ${selected.username}`;
    loginButton.textContent = `Sign in as ${loginRole}`;
    $('#login-error').hidden = true;
  });
}
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (loginButton.disabled) return;
  const u = usernameInput.value.trim();
  const p = passwordInput.value;
  const errEl = $('#login-error');
  errEl.hidden = true;
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  try {
    const auth = await interviewRequest<{ token: string; user: { role: string; username: string } }>('/auth/login', undefined, { username: u, password: p });
    if (auth.user.role === 'interviewer') {
      const legacy = await interviewRequest<{ token: string }>('/access', undefined, { username: u, password: p });
      interviewerToken = legacy.token;
    }
    session = { role: auth.user.role, name: auth.user.username };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
    passwordInput.value = '';
    setPasswordVisible(false);
    enterRole();
  } catch (error) {
    errEl.textContent = error instanceof Error ? error.message : 'Sign-in failed.';
    errEl.hidden = false;
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = `Sign in as ${loginRole}`;
  }
});

$('#btn-logout').addEventListener('click', () => {
  if (session?.role === 'candidate') candidateTeardown();
  bcSendBye();
  interviewerToken = undefined;
  interviewerDashboard.reset();
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  show('login');
  usernameInput.focus();
});

function enterRole(): void {
  if (!session) return;
  if (session.role === 'candidate') { show('candidate'); candidateInit(); }
  else if (session.role === 'interviewer') { show('interviewer'); renderFeed(); void interviewerDashboard.refresh(); }
  else show('admin');
}

/* ================= broadcast feed ================= */
const BC_NAME = 'gazeline-feed';
let bc: BroadcastChannel | null = null;
try { bc = new BroadcastChannel(BC_NAME); } catch { bc = null; }
function bcPost(msg: unknown): void {
  try { bc?.postMessage(msg); } catch { /* ignore */ }
}
interface FeedRow {
  id: string; name: string; score: number; tier: string; flags: string[];
  readingCycles: number; readingLik: number; elapsedMs: number;
  micActive: boolean; gazeLive: boolean; ts: number;
  flagLog?: Array<{ text: string; ts: number }>;
}
const feed = new Map<string, FeedRow>();
let mySessionId: string | null = null;
const interviewerDashboard = bindInterviewDashboard(() => interviewerToken);

if (bc) {
  bc.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type: string; payload: any } | null;
    if (!m?.type) return;
    if (m.type === 'cfg') {
      remoteCfg = m.payload;
      if (session?.role === 'admin') syncAdminInputsFromRemote();
      if (session?.role === 'candidate') echoCfg();
    } else if (m.type === 'integrity-cfg') {
      applyIntegrityCfg(m.payload);
    } else if (m.type === 'state') {
      feed.set(m.payload.id, m.payload);
      renderFeed();
    } else if (m.type === 'bye') {
      feed.delete(m.payload.id);
      renderFeed();
    }
  };
}
window.addEventListener('beforeunload', bcSendBye);
function bcSendBye(): void {
  if (mySessionId) bcPost({ type: 'bye', payload: { id: mySessionId } });
}

function renderFeed(): void {
  if (session?.role !== 'interviewer') return;
  const rows = [...feed.values()].sort((a, b) => b.ts - a.ts);
  $('#feed-table').style.display = rows.length ? 'table' : 'none';
  $('#feed-empty').hidden = rows.length > 0;
  $('#feed-count').textContent = `${rows.length} live`;
  const tb = $('#feed-rows');
  tb.innerHTML = rows.map((r) => {
    const flagTxt = r.flags.length
      ? `<span class="flaglist">${r.flags.map((f) => f.replace(/</g, '&lt;')).join('<br>')}</span>`
      : '<span class="flaglist none">-</span>';
    return `<tr>
      <td>${r.name.replace(/</g, '&lt;')}</td>
      <td class="mono mono-dim">${r.id}</td>
      <td class="mono">${fmtClock(r.elapsedMs)}</td>
      <td class="mono">${r.score}</td>
      <td><span class="tier ${r.tier.toLowerCase()}">${r.tier}</span></td>
      <td>${flagTxt}</td>
      <td class="mono">${r.readingCycles} · ${(r.readingLik * 100).toFixed(0)}%</td>
      <td>${r.micActive ? '<span class="voice">Voice</span>' : '<span class="mono-dim">Quiet</span>'}</td>
      <td><span class="live">Live</span></td>
    </tr>`;
  }).join('');
}
setInterval(() => { if (session?.role === 'interviewer') renderFeed(); }, 2000);

const btnOpen = $('#btn-open-candidate');
btnOpen.addEventListener('click', () => { window.open(location.href, '_blank', 'noopener'); });

/* ================= admin: remote thresholds ================= */
let remoteCfg: Partial<ReadingDetectionConfig> | null = null;
const ADMIN_DEFAULTS = {
  minAmpFrac: DEFAULT_READING_CFG.minAmpFrac,
  ampPxFloor: DEFAULT_READING_CFG.ampPxFloor,
  passMsMin: DEFAULT_READING_CFG.passMsMin,
  passMsMax: DEFAULT_READING_CFG.passMsMax,
  requiredPasses: DEFAULT_READING_CFG.requiredPasses,
  requiredCycles: DEFAULT_READING_CFG.requiredCycles,
  windowMs: DEFAULT_READING_CFG.windowMs,
  sameRegionOverlapFrac: DEFAULT_READING_CFG.sameRegionOverlapFrac,
  yBandFracH: DEFAULT_READING_CFG.yBandFracH,
  pointsPerDetection: DEFAULT_READING_CFG.pointsPerDetection,
  cooldownMs: DEFAULT_READING_CFG.cooldownMs,
  lowGazeEnabled: DEFAULT_READING_CFG.lowGazeEnabled,
  sawtoothEnabled: DEFAULT_READING_CFG.sawtoothEnabled ?? true,
  sawtoothWindowMs: DEFAULT_READING_CFG.sawtoothWindowMs,
  sawtoothRequiredCycles: DEFAULT_READING_CFG.sawtoothRequiredCycles,
  sawtoothRiseMsMin: DEFAULT_READING_CFG.sawtoothRiseMsMin,
  sawtoothRiseMsMax: DEFAULT_READING_CFG.sawtoothRiseMsMax,
  sawtoothReturnMsMax: DEFAULT_READING_CFG.sawtoothReturnMsMax,
};
function getCfg(): ReadingDetectionConfig {
  const r = remoteCfg && typeof remoteCfg.minAmpFrac === 'number' &&
    typeof remoteCfg.passMsMin === 'number' && typeof remoteCfg.passMsMax === 'number' &&
    typeof remoteCfg.requiredCycles === 'number' && typeof remoteCfg.windowMs === 'number'
    ? {
        minAmpFrac: remoteCfg.minAmpFrac,
        ampPxFloor: typeof remoteCfg.ampPxFloor === 'number' ? remoteCfg.ampPxFloor : ADMIN_DEFAULTS.ampPxFloor,
        passMsMin: remoteCfg.passMsMin,
        passMsMax: remoteCfg.passMsMax,
        requiredPasses: typeof remoteCfg.requiredPasses === 'number' ? remoteCfg.requiredPasses : ADMIN_DEFAULTS.requiredPasses,
        requiredCycles: remoteCfg.requiredCycles,
        windowMs: remoteCfg.windowMs,
        sameRegionOverlapFrac: typeof remoteCfg.sameRegionOverlapFrac === 'number' ? remoteCfg.sameRegionOverlapFrac : ADMIN_DEFAULTS.sameRegionOverlapFrac,
        yBandFracH: typeof remoteCfg.yBandFracH === 'number' ? remoteCfg.yBandFracH : ADMIN_DEFAULTS.yBandFracH,
        pointsPerDetection: typeof remoteCfg.pointsPerDetection === 'number' ? remoteCfg.pointsPerDetection : ADMIN_DEFAULTS.pointsPerDetection,
        cooldownMs: typeof remoteCfg.cooldownMs === 'number' ? remoteCfg.cooldownMs : ADMIN_DEFAULTS.cooldownMs,
        lowGazeEnabled: typeof remoteCfg.lowGazeEnabled === 'boolean' ? remoteCfg.lowGazeEnabled : ADMIN_DEFAULTS.lowGazeEnabled,
        sawtoothEnabled: typeof remoteCfg.sawtoothEnabled === 'boolean' ? remoteCfg.sawtoothEnabled : ADMIN_DEFAULTS.sawtoothEnabled,
        sawtoothWindowMs: typeof remoteCfg.sawtoothWindowMs === 'number' ? remoteCfg.sawtoothWindowMs : ADMIN_DEFAULTS.sawtoothWindowMs,
        sawtoothRequiredCycles: typeof remoteCfg.sawtoothRequiredCycles === 'number' ? remoteCfg.sawtoothRequiredCycles : ADMIN_DEFAULTS.sawtoothRequiredCycles,
        sawtoothRiseMsMin: typeof remoteCfg.sawtoothRiseMsMin === 'number' ? remoteCfg.sawtoothRiseMsMin : ADMIN_DEFAULTS.sawtoothRiseMsMin,
        sawtoothRiseMsMax: typeof remoteCfg.sawtoothRiseMsMax === 'number' ? remoteCfg.sawtoothRiseMsMax : ADMIN_DEFAULTS.sawtoothRiseMsMax,
        sawtoothReturnMsMax: typeof remoteCfg.sawtoothReturnMsMax === 'number' ? remoteCfg.sawtoothReturnMsMax : ADMIN_DEFAULTS.sawtoothReturnMsMax,
      }
    : ADMIN_DEFAULTS;
  return {
    ...DEFAULT_READING_CFG,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    windowMs: r.windowMs,
    minAmpFrac: r.minAmpFrac,
    ampPxFloor: r.ampPxFloor,
    passMsMin: r.passMsMin,
    passMsMax: r.passMsMax,
    requiredPasses: r.requiredPasses,
    requiredCycles: r.requiredCycles,
    sameRegionOverlapFrac: r.sameRegionOverlapFrac,
    yBandFracH: r.yBandFracH,
    pointsPerDetection: r.pointsPerDetection,
    cooldownMs: r.cooldownMs,
    lowGazeEnabled: r.lowGazeEnabled,
    sawtoothEnabled: r.sawtoothEnabled,
    sawtoothWindowMs: r.sawtoothWindowMs,
    sawtoothRequiredCycles: r.sawtoothRequiredCycles,
    sawtoothRiseMsMin: r.sawtoothRiseMsMin,
    sawtoothRiseMsMax: r.sawtoothRiseMsMax,
    sawtoothReturnMsMax: r.sawtoothReturnMsMax,
  };
}

/* admin inputs (live broadcast) */
function broadcastIntegrityCfg(): void {
  const tabDed = parseFloat(($('#cfg-int-tab') as HTMLInputElement).value) || 2;
  const tabDb = parseFloat(($('#cfg-int-tab-db') as HTMLInputElement).value) || 5;
  const longDed = parseFloat(($('#cfg-int-long') as HTMLInputElement).value) || 3;
  const longTh = parseFloat(($('#cfg-int-longth') as HTMLInputElement).value) || 10;
  const fsDed = parseFloat(($('#cfg-int-fs') as HTMLInputElement).value) || 2;
  const pasteDed = parseFloat(($('#cfg-int-paste') as HTMLInputElement).value) || 1;
  const displayDed = parseFloat(($('#cfg-int-display') as HTMLInputElement).value) || 5;
  const mfDed = parseFloat(($('#cfg-int-mf') as HTMLInputElement).value) || 10;
  const mfCd = parseFloat(($('#cfg-int-mf-cd') as HTMLInputElement).value) || 60;
  const faDed = parseFloat(($('#cfg-int-fa') as HTMLInputElement).value) || 3;
  const faCd = parseFloat(($('#cfg-int-fa-cd') as HTMLInputElement).value) || 5;
  const faTh = parseFloat(($('#cfg-int-fa-th') as HTMLInputElement).value) || 3;
  const faCumDed = parseFloat(($('#cfg-int-fac') as HTMLInputElement).value) || 5;
  const faCumTh = parseFloat(($('#cfg-int-fac-th') as HTMLInputElement).value) || 10;
  const offDed = parseFloat(($('#cfg-int-off') as HTMLInputElement).value) || 2;
  const offCd = parseFloat(($('#cfg-int-off-cd') as HTMLInputElement).value) || 30;
  const sideDed = parseFloat(($('#cfg-int-side') as HTMLInputElement).value) || 4;
  const sideCd = parseFloat(($('#cfg-int-side-cd') as HTMLInputElement).value) || 30;
  const sideTh = parseFloat(($('#cfg-int-side-th') as HTMLInputElement).value) || 4;
  const sideWin = parseFloat(($('#cfg-int-side-win') as HTMLInputElement).value) || 60;
  const downDed = parseFloat(($('#cfg-int-down') as HTMLInputElement).value) || 4;
  const downCd = parseFloat(($('#cfg-int-down-cd') as HTMLInputElement).value) || 30;
  const downTh = parseFloat(($('#cfg-int-down-th') as HTMLInputElement).value) || 4;
  const downWin = parseFloat(($('#cfg-int-down-win') as HTMLInputElement).value) || 60;
  const blinkDed = parseFloat(($('#cfg-int-blink') as HTMLInputElement).value) || 1;
  const blinkDur = parseFloat(($('#cfg-int-blink-dur') as HTMLInputElement).value) || 120;
  const blinkCap = parseFloat(($('#cfg-int-blink-cap') as HTMLInputElement).value) || 5;
  const reviewTh = parseFloat(($('#cfg-int-review') as HTMLInputElement).value) || 3;
  const reviewWin = parseFloat(($('#cfg-int-review-win') as HTMLInputElement).value) || 60;
  const capAtt = parseFloat(($('#cfg-int-cap-att') as HTMLInputElement).value) || 30;
  const capFace = parseFloat(($('#cfg-int-cap-face') as HTMLInputElement).value) || 30;
  const capPose = parseFloat(($('#cfg-int-cap-pose') as HTMLInputElement).value) || 30;
  const sqSizeMin = parseFloat(($('#cfg-sq-size-min') as HTMLInputElement).value) || 25;
  const sqSizeMax = parseFloat(($('#cfg-sq-size-max') as HTMLInputElement).value) || 60;
  const sqAngle = parseFloat(($('#cfg-sq-angle') as HTMLInputElement).value) || 15;
  const sqLumMin = parseFloat(($('#cfg-sq-lum-min') as HTMLInputElement).value) || 40;

  const payload: any = {
    type: 'integrity-cfg',
    payload: {
      tabSwitchDeduction: tabDed, tabSwitchDebounceMs: tabDb * 1000,
      longAwayDeduction: longDed, longAwayThresholdMs: longTh * 1000,
      fullscreenExitDeduction: fsDed,
      pasteDeduction: pasteDed,
      extraDisplayDeduction: displayDed,
      multipleFacesDeduction: mfDed, multipleFacesCooldownMs: mfCd * 1000,
      faceAbsentDeduction: faDed, faceAbsentCooldownMs: faCd * 1000, faceAbsentThresholdMs: faTh * 1000,
      faceAbsentCumulativeDeduction: faCumDed, faceAbsentCumulativeThresholdFrac: faCumTh / 100,
      sustainedOffAxisDeduction: offDed, sustainedOffAxisCooldownMs: offCd * 1000,
      repeatedSideLooksDeduction: sideDed, repeatedSideLooksCooldownMs: sideCd * 1000,
      repeatedSideLooksThreshold: sideTh, repeatedSideLooksWindowMs: sideWin * 1000,
      lookingDownRepeatedlyDeduction: downDed, lookingDownRepeatedlyCooldownMs: downCd * 1000,
      lookingDownRepeatedlyThreshold: downTh, lookingDownRepeatedlyWindowMs: downWin * 1000,
      blinkRateDropPersistentDeduction: blinkDed, blinkRateDropPersistentDurationMs: blinkDur * 1000,
      blinkCategoryCap: blinkCap,
      reviewThresholdCategories: reviewTh, reviewWindowMs: reviewWin * 1000,
      categoryCaps: { attention: capAtt, face: capFace, pose: capPose, blink: blinkCap },
      setup: { faceSizeMinFrac: sqSizeMin / 100, faceSizeMaxFrac: sqSizeMax / 100, maxHeadAngleDeg: sqAngle, luminanceMin: sqLumMin },
    },
  };
  bcPost(payload);
  // Update readout
  $('#int-tab-out').textContent = tabDed.toFixed(0);
  $('#int-tab-db-out').textContent = (tabDb).toFixed(1);
  $('#int-longout').textContent = longDed.toFixed(0);
  $('#int-longth-out').textContent = (longTh).toFixed(1);
  $('#int-fs-out').textContent = fsDed.toFixed(0);
  $('#int-paste-out').textContent = pasteDed.toFixed(0);
  $('#int-display-out').textContent = displayDed.toFixed(0);
  $('#int-mf-out').textContent = mfDed.toFixed(0);
  $('#int-mf-cd-out').textContent = (mfCd).toFixed(1);
  $('#int-fa-out').textContent = faDed.toFixed(0);
  $('#int-fa-cd-out').textContent = (faCd).toFixed(1);
  $('#int-fa-th-out').textContent = (faTh).toFixed(1);
  $('#int-fac-out').textContent = faCumDed.toFixed(0);
  $('#int-fac-th-out').textContent = faCumTh.toFixed(0);
  $('#int-off-out').textContent = offDed.toFixed(0);
  $('#int-off-cd-out').textContent = (offCd).toFixed(1);
  $('#int-side-out').textContent = sideDed.toFixed(0);
  $('#int-side-cd-out').textContent = (sideCd).toFixed(1);
  $('#int-side-th-out').textContent = sideTh.toFixed(0);
  $('#int-side-win-out').textContent = (sideWin).toFixed(1);
  $('#int-down-out').textContent = downDed.toFixed(0);
  $('#int-down-cd-out').textContent = (downCd).toFixed(1);
  $('#int-down-th-out').textContent = downTh.toFixed(0);
  $('#int-down-win-out').textContent = (downWin).toFixed(1);
  $('#int-blink-out').textContent = blinkDed.toFixed(0);
  $('#int-blink-dur-out').textContent = (blinkDur).toFixed(1);
  $('#int-blink-cap-out').textContent = blinkCap.toFixed(0);
  $('#int-review-out').textContent = reviewTh.toFixed(0);
  $('#int-review-win-out').textContent = (reviewWin).toFixed(1);
  $('#int-cap-att-out').textContent = capAtt.toFixed(0);
  $('#int-cap-face-out').textContent = capFace.toFixed(0);
  $('#int-cap-pose-out').textContent = capPose.toFixed(0);
  $('#int-cap-blink-out').textContent = blinkCap.toFixed(0);
  $('#sq-size-min-out').textContent = (sqSizeMin).toFixed(0);
  $('#sq-size-max-out').textContent = (sqSizeMax).toFixed(0);
  $('#sq-angle-out').textContent = sqAngle.toFixed(0);
  $('#sq-lum-min-out').textContent = sqLumMin.toFixed(0);
}

function broadcastCfg(): void {
  let amp = parseFloat(($('#cfg-amp') as HTMLInputElement).value);
  let pmin = parseFloat(($('#cfg-pmin') as HTMLInputElement).value);
  let pmax = parseFloat(($('#cfg-pmax') as HTMLInputElement).value);
  let cyc = parseInt(($('#cfg-cyc') as HTMLInputElement).value, 10);
  let passes = parseInt(($('#cfg-passes') as HTMLInputElement).value, 10);
  const win = parseFloat(($('#cfg-win') as HTMLInputElement).value);
  let pxFloor = parseFloat(($('#cfg-pxf') as HTMLInputElement).value);
  let overlap = parseFloat(($('#cfg-overlap') as HTMLInputElement).value);
  let yband = parseFloat(($('#cfg-yband') as HTMLInputElement).value);
  const ptsRaw = parseInt(($('#cfg-pts') as HTMLInputElement).value, 10);
  let cd = parseFloat(($('#cfg-cd') as HTMLInputElement).value);
  const lowGaze = ($('#cfg-lowgaze') as HTMLInputElement).checked;
  const sawEnabled = ($('#cfg-saw') as HTMLInputElement).checked;
  const sawWin = parseFloat(($('#cfg-saw-win') as HTMLInputElement).value);
  const sawCyc = parseInt(($('#cfg-saw-cyc') as HTMLInputElement).value, 10);
  const sawRiseMin = parseFloat(($('#cfg-saw-rise-min') as HTMLInputElement).value);
  const sawRiseMax = parseFloat(($('#cfg-saw-rise-max') as HTMLInputElement).value);
  const sawRetMax = parseFloat(($('#cfg-saw-ret-max') as HTMLInputElement).value);
  if ([amp, pmin, pmax, cyc, passes, win, pxFloor, overlap, yband, ptsRaw, cd, sawWin, sawCyc, sawRiseMin, sawRiseMax, sawRetMax].some(Number.isNaN)) return;
  pmin = clamp(pmin, 0.3, Math.max(0.3, pmax - 0.1));
  amp = clamp(amp, 0.05, 0.9);
  pxFloor = Math.max(40, pxFloor);
  overlap = clamp(overlap, 0.1, 0.99);
  yband = clamp(yband, 0.05, 0.5);
  cyc = Math.max(1, Math.min(8, cyc));
  passes = Math.max(1, Math.min(8, passes));
  const pts = Math.max(1, ptsRaw);
  cd = Math.max(1000, cd);
  const payload: any = {
    minAmpFrac: amp, ampPxFloor: pxFloor,
    passMsMin: pmin * 1000, passMsMax: pmax * 1000,
    requiredPasses: passes, requiredCycles: cyc, windowMs: win * 1000,
    sameRegionOverlapFrac: overlap, yBandFracH: yband,
    pointsPerDetection: pts, cooldownMs: cd,
    lowGazeEnabled: lowGaze,
    sawtoothEnabled: sawEnabled,
    sawtoothWindowMs: sawWin * 1000,
    sawtoothRequiredCycles: sawCyc,
    sawtoothRiseMsMin: sawRiseMin * 1000,
    sawtoothRiseMsMax: sawRiseMax * 1000,
    sawtoothReturnMsMax: sawRetMax * 1000,
  };
  bcPost({ type: 'cfg', payload });
  remoteCfg = payload;
  $('#amp-out').textContent = amp.toFixed(2);
  $('#pxf-out').textContent = String(pxFloor);
  $('#pmin-out').textContent = `${pmin.toFixed(1)} s`;
  $('#pmax-out').textContent = `${pmax.toFixed(1)} s`;
  $('#cyc-out').textContent = String(cyc);
  $('#passes-out').textContent = String(passes);
  $('#win-out').textContent = `${win.toFixed(1)} s`;
  $('#overlap-out').textContent = `${overlap.toFixed(2)}`;
  $('#yband-out').textContent = `${yband.toFixed(2)}`;
  $('#pts-out').textContent = String(pts);
  $('#cd-out').textContent = `${cd / 1000} s`;
  $('#lowgaze-out').textContent = lowGaze ? 'on' : 'off';
  $('#saw-out').textContent = sawEnabled ? 'on' : 'off';
  $('#saw-win-out').textContent = `${sawWin.toFixed(1)} s`;
  $('#saw-cyc-out').textContent = String(sawCyc);
  $('#saw-rise-min-out').textContent = `${sawRiseMin.toFixed(1)} s`;
  $('#saw-rise-max-out').textContent = `${sawRiseMax.toFixed(1)} s`;
  $('#saw-ret-max-out').textContent = `${sawRetMax.toFixed(1)} s`;
  $('#cfg-readout').textContent =
    `active: amp ≥ ${amp.toFixed(2)} (${amp * 100 | 0}% width / ≥ ${pxFloor} px) · ` +
    `pass ${pmin.toFixed(1)}-${pmax.toFixed(1)} s · passes ≥ ${passes} · cycles ≥ ${cyc} · window ${win.toFixed(1)} s · ` +
    `overlap ${overlap.toFixed(2)} · y-band ${yband.toFixed(2)} · ${lowGaze ? 'low-gaze on' : 'low-gaze off'} · sawtooth ${sawEnabled ? 'on' : 'off'} (${sawWin.toFixed(0)}s window, ${sawCyc} cycles)`;
}
function syncAdminInputsFromRemote(): void {
  const r = remoteCfg;
  if (!r) return;
  if (typeof r.minAmpFrac === 'number') ($('#cfg-amp') as HTMLInputElement).value = String(r.minAmpFrac);
  if (typeof r.ampPxFloor === 'number') ($('#cfg-pxf') as HTMLInputElement).value = String(r.ampPxFloor);
  if (typeof r.passMsMin === 'number') ($('#cfg-pmin') as HTMLInputElement).value = String(r.passMsMin / 1000);
  if (typeof r.passMsMax === 'number') ($('#cfg-pmax') as HTMLInputElement).value = String(r.passMsMax / 1000);
  if (typeof r.requiredCycles === 'number') ($('#cfg-cyc') as HTMLInputElement).value = String(r.requiredCycles);
  if (typeof r.requiredPasses === 'number') ($('#cfg-passes') as HTMLInputElement).value = String(r.requiredPasses);
  if (typeof r.windowMs === 'number') ($('#cfg-win') as HTMLInputElement).value = String(r.windowMs / 1000);
  if (typeof r.sameRegionOverlapFrac === 'number') ($('#cfg-overlap') as HTMLInputElement).value = String(r.sameRegionOverlapFrac);
  if (typeof r.yBandFracH === 'number') ($('#cfg-yband') as HTMLInputElement).value = String(r.yBandFracH);
  if (typeof r.pointsPerDetection === 'number') ($('#cfg-pts') as HTMLInputElement).value = String(r.pointsPerDetection);
  if (typeof r.cooldownMs === 'number') ($('#cfg-cd') as HTMLInputElement).value = String(r.cooldownMs / 1000);
  if (typeof r.lowGazeEnabled === 'boolean') ($('#cfg-lowgaze') as HTMLInputElement).checked = r.lowGazeEnabled;
  if (typeof r.sawtoothEnabled === 'boolean') ($('#cfg-saw') as HTMLInputElement).checked = r.sawtoothEnabled;
  if (typeof r.sawtoothWindowMs === 'number') ($('#cfg-saw-win') as HTMLInputElement).value = String(r.sawtoothWindowMs / 1000);
  if (typeof r.sawtoothRequiredCycles === 'number') ($('#cfg-saw-cyc') as HTMLInputElement).value = String(r.sawtoothRequiredCycles);
  if (typeof r.sawtoothRiseMsMin === 'number') ($('#cfg-saw-rise-min') as HTMLInputElement).value = String(r.sawtoothRiseMsMin / 1000);
  if (typeof r.sawtoothRiseMsMax === 'number') ($('#cfg-saw-rise-max') as HTMLInputElement).value = String(r.sawtoothRiseMsMax / 1000);
  if (typeof r.sawtoothReturnMsMax === 'number') ($('#cfg-saw-ret-max') as HTMLInputElement).value = String(r.sawtoothReturnMsMax / 1000);
}
for (const id of ['cfg-amp', 'cfg-pxf', 'cfg-pmin', 'cfg-pmax', 'cfg-cyc', 'cfg-passes', 'cfg-win', 'cfg-overlap', 'cfg-yband', 'cfg-pts', 'cfg-cd', 'cfg-saw', 'cfg-saw-win', 'cfg-saw-cyc', 'cfg-saw-rise-min', 'cfg-saw-rise-max', 'cfg-saw-ret-max']) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  el?.addEventListener('input', broadcastCfg);
  el?.addEventListener('change', broadcastCfg);
}
($('#cfg-lowgaze') as HTMLInputElement | null)?.addEventListener('change', broadcastCfg);
($('#cfg-saw') as HTMLInputElement | null)?.addEventListener('change', broadcastCfg);

// Integrity signal config inputs
for (const id of ['cfg-int-tab', 'cfg-int-tab-db', 'cfg-int-long', 'cfg-int-longth', 'cfg-int-fs', 'cfg-int-paste', 'cfg-int-display', 'cfg-int-mf', 'cfg-int-mf-cd', 'cfg-int-fa', 'cfg-int-fa-cd', 'cfg-int-fa-th', 'cfg-int-fac', 'cfg-int-fac-th', 'cfg-int-off', 'cfg-int-off-cd', 'cfg-int-side', 'cfg-int-side-cd', 'cfg-int-side-th', 'cfg-int-side-win', 'cfg-int-down', 'cfg-int-down-cd', 'cfg-int-down-th', 'cfg-int-down-win', 'cfg-int-blink', 'cfg-int-blink-dur', 'cfg-int-blink-cap', 'cfg-int-review', 'cfg-int-review-win', 'cfg-int-cap-att', 'cfg-int-cap-face', 'cfg-int-cap-pose', 'cfg-int-cap-blink', 'cfg-sq-size-min', 'cfg-sq-size-max', 'cfg-sq-angle', 'cfg-sq-lum-min']) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  el?.addEventListener('input', broadcastIntegrityCfg);
  el?.addEventListener('change', broadcastIntegrityCfg);
}

function applyIntegrityCfg(cfg: any): void {
  if (!cfg) return;
  const d = cfg.deductions;
  if (d) {
    if (typeof d.TAB_SWITCH?.amount === 'number') DEFAULT_SCORING_CFG.deductions.TAB_SWITCH.amount = d.TAB_SWITCH.amount;
    if (typeof d.TAB_SWITCH?.debounceMs === 'number') DEFAULT_SCORING_CFG.deductions.TAB_SWITCH.debounceMs = d.TAB_SWITCH.debounceMs;
    if (typeof d.LONG_AWAY?.amount === 'number') DEFAULT_SCORING_CFG.deductions.LONG_AWAY.amount = d.LONG_AWAY.amount;
    if (typeof d.FULLSCREEN_EXIT?.amount === 'number') DEFAULT_SCORING_CFG.deductions.FULLSCREEN_EXIT.amount = d.FULLSCREEN_EXIT.amount;
    if (typeof d.PASTE_EVENT?.amount === 'number') DEFAULT_SCORING_CFG.deductions.PASTE_EVENT.amount = d.PASTE_EVENT.amount;
    if (typeof d.EXTRA_DISPLAY_DETECTED?.amount === 'number') DEFAULT_SCORING_CFG.deductions.EXTRA_DISPLAY_DETECTED.amount = d.EXTRA_DISPLAY_DETECTED.amount;
    if (typeof d.MULTIPLE_FACES?.amount === 'number') DEFAULT_SCORING_CFG.deductions.MULTIPLE_FACES.amount = d.MULTIPLE_FACES.amount;
    if (typeof d.MULTIPLE_FACES?.cooldownMs === 'number') DEFAULT_SCORING_CFG.deductions.MULTIPLE_FACES.cooldownMs = d.MULTIPLE_FACES.cooldownMs;
    if (typeof d.FACE_ABSENT?.amount === 'number') DEFAULT_SCORING_CFG.deductions.FACE_ABSENT.amount = d.FACE_ABSENT.amount;
    if (typeof d.FACE_ABSENT?.cooldownMs === 'number') DEFAULT_SCORING_CFG.deductions.FACE_ABSENT.cooldownMs = d.FACE_ABSENT.cooldownMs;
    if (typeof d.FACE_ABSENT?.cooldownMs === 'number') DEFAULT_SCORING_CFG.deductions.FACE_ABSENT.cooldownMs = d.FACE_ABSENT.cooldownMs;
    if (typeof d.SUSTAINED_OFFAXIS?.amount === 'number') DEFAULT_SCORING_CFG.deductions.SUSTAINED_OFFAXIS.amount = d.SUSTAINED_OFFAXIS.amount;
    if (typeof d.REPEATED_SIDE_LOOKS?.amount === 'number') DEFAULT_SCORING_CFG.deductions.REPEATED_SIDE_LOOKS.amount = d.REPEATED_SIDE_LOOKS.amount;
    if (typeof d.LOOKING_DOWN_REPEATEDLY?.amount === 'number') DEFAULT_SCORING_CFG.deductions.LOOKING_DOWN_REPEATEDLY.amount = d.LOOKING_DOWN_REPEATEDLY.amount;
    if (typeof d.BLINK_RATE_DROP_PERSISTENT?.amount === 'number') DEFAULT_SCORING_CFG.deductions.BLINK_RATE_DROP_PERSISTENT.amount = d.BLINK_RATE_DROP_PERSISTENT.amount;
  }
  if (cfg.categoryCaps) {
    if (typeof cfg.categoryCaps.attention === 'number') DEFAULT_SCORING_CFG.categoryCaps.attention = cfg.categoryCaps.attention;
    if (typeof cfg.categoryCaps.face === 'number') DEFAULT_SCORING_CFG.categoryCaps.face = cfg.categoryCaps.face;
    if (typeof cfg.categoryCaps.pose === 'number') DEFAULT_SCORING_CFG.categoryCaps.pose = cfg.categoryCaps.pose;
    if (typeof cfg.categoryCaps.blink === 'number') DEFAULT_SCORING_CFG.categoryCaps.blink = cfg.categoryCaps.blink;
  }
  if (typeof cfg.reviewThresholdCategories === 'number') DEFAULT_SCORING_CFG.reviewThresholdCategories = cfg.reviewThresholdCategories;
  if (typeof cfg.reviewWindowMs === 'number') DEFAULT_SCORING_CFG.reviewWindowMs = cfg.reviewWindowMs;
  if (cfg.setup) {
    if (typeof cfg.setup.faceSizeMinFrac === 'number') DEFAULT_SETUP_CFG.faceSizeMinFrac = cfg.setup.faceSizeMinFrac;
    if (typeof cfg.setup.faceSizeMaxFrac === 'number') DEFAULT_SETUP_CFG.faceSizeMaxFrac = cfg.setup.faceSizeMaxFrac;
    if (typeof cfg.setup.maxHeadAngleDeg === 'number') DEFAULT_SETUP_CFG.maxHeadAngleDeg = cfg.setup.maxHeadAngleDeg;
    if (typeof cfg.setup.luminanceMin === 'number') DEFAULT_SETUP_CFG.luminanceMin = cfg.setup.luminanceMin;
  }
}

function echoCfg(): void {
  const c = getCfg();
  $('#cfg-echo').textContent = `${(c.passMsMin / 1000).toFixed(1)}-${(c.passMsMax / 1000).toFixed(1)} s`;
  $('#cfg-echo-amp').textContent = `${(c.minAmpFrac * 100).toFixed(0)}%`;
  $('#cfg-echo-pxf').textContent = String(c.ampPxFloor);
  $('#cfg-echo-rep').textContent = String(c.requiredPasses);
  $('#cfg-echo-cyc').textContent = String(c.requiredCycles);
  $('#cfg-echo-cd').textContent = `${c.cooldownMs / 1000} s`;
  $('#cfg-echo-pts').textContent = String(c.pointsPerDetection);
  $('#cfg-echo-lowgaze').textContent = c.lowGazeEnabled ? 'on' : 'off';
}

/* ================= candidate state ================= */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const candidate: any = {
  streaming: false,
  startedAt: 0,
  score: 100,
  tier: 'LOW',
  warnShown: false,
  flags: { READING_PATTERN_DETECTED: false, NO_FACE_DETECTED: false },
  micDb: -100,
  micActive: false,
  reading: { flag: false, passes: 0, cycles: 0, likelihood: 0, reason: '', nullRatio: 0, result: null as ReadingDetectionResult | null, region: null as ReadingRegion | null, lowGaze: false },
  tracking: false,
  calibrating: false,
  calibrated: false,
  faceLostAt: 0,
  faceSeenAt: 0,
  baselineAmplitude: 0 as number,
  lowGazeFlagShown: false,
  // ---- integrity state ----
  scoreState: initialScoreState(performance.now(), DEFAULT_SCORING_CFG.accommodations),
  setupQuality: null as SetupQualitySummary | null,
  setupOverride: false,
  accommodations: { ...DEFAULT_SCORING_CFG.accommodations },
  extraDisplayFlagged: false,
  facePresentPercent: 100,
  setupGate: new SetupGate(),
  attentionMonitor: new AttentionMonitor(),
  faceMonitor: new FaceMonitor(),
  headPose: new HeadPoseTracker(),
  blinkAnalyzer: new BlinkAnalyzer(),
  facePipeline: new FacePipeline(),
  blinkRateDropActive: false,
  // ---- live flag log (candidate-side, broadcast to the interviewer feed) ----
  flagLog: [] as Array<{ text: string; ts: number }>,
  scoreFlashAt: 0,
  lastDeductionAt: 0,
};
const candidateInterview = bindCandidateInterview({
  isCandidate: () => session?.role === 'candidate',
  captureSnapshot: (): Snapshot => snapshotScore(
    candidate.scoreState, performance.now(), candidate.calibrated, candidate.scoreState.reviewFlagged,
  ),
  stopCapture: () => {
    stopCandidateDevices();
    candidateInterview.setCapturing(false);
  },
});

const tracker = new GazeTracker();
let mediaStream: MediaStream | null = null;
let micRaf = 0;
let tickTimer = 0;
let captureSession: AbortController | null = null;
let cameraFps = 0;
let gazeLive = false;
let analysisTimer = 0;

const NO_FACE_MS = 3500;
const ANALYSIS_TICK_MS = 250; // spec: analyze every ~250 ms

/* ================= candidate init + consent gate ================= */
function candidateInit(): void {
  candidateInterview.enter();
  const secure = window.isSecureContext;
  $('#ctx-state').textContent = secure ? 'Yes' : 'Not available - serve over https or localhost';
  $('#gate-ask').style.display = '';
  $('#gate-denied').style.display = 'none';
  $('#gate-live').style.display = 'none';
}
function setDeny(err: unknown): void {
  $('#gate-ask').style.display = 'none';
  $('#gate-live').style.display = 'none';
  ($('#gate-denied') as HTMLElement).style.display = '';
  let msg: string;
  if (!err) {
    msg = 'This page is not in a secure context. getUserMedia requires https:// or http://localhost - run npm run dev.';
  } else if (err instanceof DOMException) {
    msg = err.name === 'NotAllowedError'
      ? 'Permission denied: camera and/or microphone access was blocked. Both are required - the session will not start in a degraded mode. Allow access in the browser site settings and retry.'
      : err.name === 'NotFoundError'
        ? 'No camera or microphone found on this device. Both are required to start a monitored session.'
        : err.name === 'NotReadableError'
          ? 'Camera/microphone is already in use by another application and could not be opened.'
          : `Could not acquire camera + microphone (${err.name}). Both permissions are required.`;
  } else {
    msg = 'Could not acquire camera + microphone. Both permissions are required; no degraded monitoring mode is available.';
  }
  $('#deny-stage').textContent = 'Device access';
  $('#deny-help').textContent = 'Check camera and microphone access in your browser, then try again.';
  $('#deny-reason').textContent = msg;
}

async function requestStart(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) { setDeny(null); return; }
  if (captureSession || !candidateInterview.canStart()) return;
  const owner = new AbortController();
  captureSession = owner;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (owner.signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    mediaStream = stream;
  } catch (error) {
    if (owner.signal.aborted) return;
    captureSession = null;
    setDeny(error);
    return;
  }
  ($('#gate-ask') as HTMLElement).style.display = 'none';
  ($('#gate-denied') as HTMLElement).style.display = 'none';
  ($('#gate-live') as HTMLElement).style.display = '';
  candidate.startedAt = Date.now();
  candidate.streaming = true;
  candidateInterview.setCapturing(true);
  mySessionId = `S-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  clearBuffer();

  /* camera preview */
  const shell = document.querySelector('.vid-shell')!;
  const video = document.createElement('video');
  video.srcObject = mediaStream;
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.id = 'preview-video';
  shell.insertBefore(video, shell.firstChild);
  $('#face-badge').textContent = 'Loading gaze trackerâ€¦';
  $('#setup-sub').textContent = 'Loading gaze trackerâ€¦';
  ($('#btn-start-cal') as HTMLButtonElement).disabled = true;
  try {
    await video.play();
    owner.signal.throwIfAborted();
    await tracker.initialize(video, owner.signal);
  } catch (error) {
    if (owner.signal.aborted) return;
    stopCandidateDevices();
    candidateInterview.setCapturing(false);
    $('#gate-ask').style.display = 'none';
    $('#gate-denied').style.display = '';
    $('#deny-stage').textContent = 'Gaze tracker';
    $('#deny-reason').textContent = 'The gaze tracker could not start.';
    $('#deny-help').textContent = 'Check your connection and try again to reload the face model.';
    console.error('[gazeline] Gaze initialization failed', error);
    return;
  }
  if (owner.signal.aborted) return;
  $('#gaze-delegate').textContent = tracker.activeDelegate;
  $('#gaze-calstate').textContent = 'not calibrated - run the wizard';

  tracker.onFps = fps => { cameraFps = fps; $('#gaze-fps').textContent = `${fps} fps`; };
  tracker.onResult = onTrackerResult;
  tracker.start();

  startMicMeter();
  startTimers();

  /* ---- integrity module setup ---- */
  candidate.setupGate.reset();
  candidate.faceMonitor.reset();
  candidate.headPose.reset();
  candidate.blinkAnalyzer.reset();
  candidate.scoreState = initialScoreState(performance.now(), candidate.accommodations);
  candidate.facePresentPercent = 100;
  candidate.blinkRateDropActive = false;
  candidate.extraDisplayFlagged = false;

  candidate.faceMonitor.setSessionStart(performance.now());
  candidate.blinkAnalyzer.startBaseline(performance.now());
  candidate.headPose.startCalibration(performance.now());

  // Start DOM event listeners for attention monitor
  candidate.attentionMonitor.start();

  startGazeOverlay();
}

candidate.attentionMonitor.onEvent((ev: AttentionEvent) => {
  handleIntegrityEvent(ev);
  if (ev.code === 'TAB_SWITCH' || ev.code === 'LONG_AWAY') {
    markGazeUnreliable(candidate.attentionMonitor.getUnreliableWindowMs());
  }
});
candidate.faceMonitor.onEvent(handleIntegrityEvent);
candidate.headPose.onEvent(handleIntegrityEvent);
candidate.blinkAnalyzer.onEvent((ev: BlinkAnalyzerEvent) => {
  handleIntegrityEvent(ev);
  if (ev.code === 'BLINK_RATE_DROP') candidate.blinkRateDropActive = true;
  if (ev.code === 'BLINK_REGULARITY_ANOMALY') logFlagText(`${ev.code} (supporting evidence)`);
});

$('#btn-start-cal').addEventListener('click', startCalibration);
$('#btn-recal').addEventListener('click', startCalibration);
$('#btn-toggle-cursor').addEventListener('click', () => {
  setGazeOverlayVisible(!isGazeOverlayVisible());
  $('#btn-toggle-cursor').textContent = isGazeOverlayVisible() ? 'Hide' : 'Show';
});
$('#btn-testmode').addEventListener('click', toggleTestMode);
$('#btn-enable').addEventListener('click', () => { void requestStart(); });
$('#btn-retry').addEventListener('click', () => { void requestStart(); });

/* ================= calibration orchestration ================= */
async function startCalibration(): Promise<void> {
  const owner = captureSession;
  if (!owner || candidate.calibrating || !tracker.initialized || !candidate.streaming) return;
  const button = $('#btn-start-cal') as HTMLButtonElement;
  if (!candidate.setupGate.done) {
    if (!candidate.setupGate.allRequiredPass() && !candidate.setupOverride) {
      candidate.setupOverride = true;
      $('#setup-sub').textContent = 'Check your framing and lighting, or continue with this setup.';
      button.textContent = 'Continue to calibration';
      return;
    }
    candidate.setupQuality = candidate.setupGate.complete();
  }
  candidate.calibrating = true;
  gazeLive = false;
  const previousVisibility = isGazeOverlayVisible();
  setGazeOverlayVisible(false);
  clearBuffer();
  button.disabled = true;
  const status = candidate.tracking ? $('#track-sub') : $('#setup-sub');
  status.textContent = 'Calibratingâ€¦';
  try {
    const samples = await runCalibrationWizard(tracker, owner.signal);
    if (owner.signal.aborted) return;
    if (!samples) {
      status.textContent = 'Calibration cancelled.';
      setGazeOverlayVisible(previousVisibility);
      return;
    }
    tracker.calibrate(samples);
    candidate.calibrated = true;
    candidate.tracking = true;
    candidate.blinkAnalyzer.startBaseline(performance.now());
    candidate.headPose.startCalibration(performance.now());
    candidate.faceMonitor.setSessionStart(performance.now());
    $('#setup-panel').style.display = 'none';
    $('#tracking-panel').style.display = '';
    $('#track-sub').textContent = 'Waiting for a gaze estimateâ€¦';
    $('#gaze-calstate').textContent = `Calibrated with ${samples.length} points`;
    setGazeOverlayVisible(true);
    $('#btn-toggle-cursor').textContent = 'Hide';
  } catch (error) {
    if (owner.signal.aborted) return;
    candidate.calibrated = tracker.calibrated;
    candidate.tracking = tracker.calibrated;
    $('#setup-panel').style.display = candidate.tracking ? 'none' : '';
    $('#tracking-panel').style.display = candidate.tracking ? '' : 'none';
    (candidate.tracking ? $('#track-sub') : $('#setup-sub')).textContent = 'Could not fit the gaze model. Centre your face and retry calibration.';
    $('#gaze-calstate').textContent = candidate.tracking ? 'Previous calibration in use' : 'Calibration needed';
    setGazeOverlayVisible(candidate.tracking && previousVisibility);
    console.error('[gazeline] Calibration failed', error);
  } finally {
    if (!owner.signal.aborted) {
      candidate.calibrating = false;
      button.disabled = false;
    }
  }
}

function onTrackerResult(r: PredictResult): void {
  const now = performance.now();
  if (r.facePresent) {
    candidate.faceSeenAt = now;
    candidate.faceLostAt = 0;
  } else if (!candidate.faceLostAt) {
    candidate.faceLostAt = now;
  }
  $('#gaze-face-2').textContent = r.facePresent ? 'present' : 'lost';

  const inSetup = !candidate.tracking && !candidate.calibrating;
  const faceInfo = candidate.facePipeline.process({
    t: now, result: r.faceResult, facePresent: r.facePresent,
    frameW: CAL_CAPTURE_W, frameH: CAL_CAPTURE_H,
    optionalFrameData: inSetup ? r.frame : null,
  });
  if (inSetup) {
    candidate.setupGate.feed(faceInfo, CAL_CAPTURE_W, CAL_CAPTURE_H, cameraFps);
    const button = $('#btn-start-cal') as HTMLButtonElement;
    // Keep retry/cancel feedback visible until face availability changes.
    if (button.disabled === r.facePresent || $('#face-badge').textContent === 'Loading gaze trackerâ€¦') {
      button.disabled = !r.facePresent;
      $('#setup-sub').textContent = r.facePresent ? 'Ready' : 'Waiting for a faceâ€¦';
    }
  }
  const badge = $('#face-badge');
  badge.textContent = r.facePresent ? 'Face detected' : 'No face';
  badge.classList.toggle('ok', r.facePresent);
  badge.classList.toggle('bad', !r.facePresent);
  candidate.faceMonitor.process(faceInfo, now);
  candidate.blinkAnalyzer.setContext(r.facePresent, !!candidate.setupQuality && !candidate.setupQuality.lightingOk, false);
  if (r.faceResult) {
    candidate.headPose.process(faceInfo, now);
    candidate.blinkAnalyzer.process(faceInfo, now);
  }

  if (!candidate.tracking || candidate.calibrating) return;
  gazeLive = r.gaze !== null;
  if (r.gaze) {
    pushGaze(r.gaze.x, r.gaze.y, now);
    const { x, y } = visibleGazePoint(r.gaze);
    $('#gaze-readout-xy').textContent = `${x.toFixed(0)} / ${y.toFixed(0)} px`;
    $('#track-sub').textContent = 'Receiving gaze estimates';
  } else {
    pushNull(now);
    clearGazeOverlay();
    $('#gaze-readout-xy').textContent = 'â€”';
    $('#track-sub').textContent = r.facePresent ? 'Waiting for a gaze estimateâ€¦' : 'Bring your face back into view.';
  }
}

/* ================= mic meter ================= */
let audioCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;
function startMicMeter(): void {
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(mediaStream!);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.75;
    src.connect(micAnalyser);
    const buf = new Float32Array(micAnalyser.fftSize);
    const meterEl = $('#meter-fill');
    const loop = () => {
      if (!micAnalyser) return;
      micAnalyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]!; sum += v * v; }
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-8);
      candidate.micDb = db;
      candidate.micActive = db > -50;
      const pct = clamp((db + 90) / 70 * 100, 0, 100);
      meterEl.style.width = `${pct.toFixed(1)}%`;
      $('#meter').setAttribute('aria-valuenow', pct.toFixed(0));
      $('#mic-readout').textContent = `${db.toFixed(0)} dBFS · ${candidate.micActive ? 'voice activity' : 'silence'}`;
      micRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    $('#mic-readout').textContent = 'mic analysis unavailable';
  }
}

/* ================= integrity event handling ================= */

function handleIntegrityEvent(ev: IntegrityEvent): void {
  if (!candidate.streaming) return;
  const cfg = DEFAULT_SCORING_CFG;
  const result = applyDeduction(candidate.scoreState, ev.code, cfg, ev);
  if (result.deducted) {
    candidate.score = candidate.scoreState.score;
    candidate.tier = tierFor(candidate.score);
    candidate.scoreFlashAt = performance.now();
    renderScore();
    // Extract amount from reason string like "TAB_SWITCH (-2)"
    const match = result.reason.match(/\((\-)(\d+)\)/);
    const amount = match ? parseInt(match[2], 10) : 0;
    animateScoreDrop(-amount);
    logFlagText(result.reason);
    // Broadcast updated state
    bcPostState();
  }
}

function logFlagText(text: string): void {
  candidate.flagLog.push({ text, ts: performance.now() });
  updateFlagLogUI();
}

function markGazeUnreliable(windowMs: number): void {
  // Mark samples in the gaze buffer as unreliable for the reading detector.
  // The reading detector already ignores null-heavy windows via the nullRatio guard.
  // For now, log it for the interviewer report.
  logFlagText(`Gaze data marked unreliable for ${Math.round(windowMs / 1000)}s around tab switch`);
}

function bcPostState(): void {
  if (!candidate.streaming || !mySessionId) return;
  const activeFlags: string[] = [];
  if (candidate.flags.READING_PATTERN_DETECTED) {
    const regionMode = candidate.reading.result?.region?.mode ?? 'reading';
    const lowGaze = candidate.reading.lowGaze && getCfg().lowGazeEnabled;
    let label = `Reading pattern detected (-${getCfg().pointsPerDetection}) - ${lowGaze ? 'compact' : regionMode}`;
    if (lowGaze) label += ' (READING_LOW_GAZE)';
    if (candidate.blinkRateDropActive) label += ' + blink-rate drop support';
    activeFlags.push(label);
  }
  if (candidate.flags.NO_FACE_DETECTED) activeFlags.push('NO_FACE_DETECTED');
  if (candidate.scoreState.reviewFlagged) activeFlags.push('FLAG_FOR_REVIEW');
  // Add integrity flags
  for (const entry of candidate.scoreState.flagLog.slice(-20)) {
    if (!activeFlags.some((f) => f.includes(entry.code))) {
      activeFlags.push(entry.code);
    }
  }
  bcPost({
    type: 'state',
    payload: {
      id: mySessionId,
      name: session?.name,
      score: candidate.score,
      tier: candidate.tier,
      flags: activeFlags,
      flagLog: candidate.flagLog.slice(-20),
      readingCycles: candidate.reading.cycles,
      readingLik: candidate.reading.likelihood,
      elapsedMs: Date.now() - candidate.startedAt,
      micActive: candidate.micActive,
      gazeLive,
      ts: Date.now(),
      accommodations: candidate.accommodations,
      setupQuality: candidate.setupQuality?.overall ?? 'poor',
      facePresentPercent: Math.round(candidate.facePresentPercent),
    },
  });
}

/* ================= analysis loop: reading detector + flags ================= */
function analyzeReading(): ReadingDetectionResult {
  const cfg = getCfg();
  const win: BufferEntry[] = windowSlice(cfg.windowMs);
  // determine if candidate is speaking while looking at camera (guarded by mic + gaze)
  // We can only check this after we have a fresh result, so we compute it in the tick.
  return analyze(win, cfg, { speakingAtCamera: false, baselineAmplitude: candidate.baselineAmplitude ?? undefined });
}

function startTimers(): void {
  analysisTimer = window.setInterval(() => {
    if (!candidate.streaming) return;
    const res = analyzeReading();
    candidate.reading = {
      flag: res.flag, passes: res.passCount, cycles: res.cycles, likelihood: res.likelihood,
      reason: res.reason, nullRatio: res.nullRatio, result: res,
      region: res.region ?? null, lowGaze: res.lowGaze,
    };

    // Re-run speaking-at-camera guard with fresh result
    const speakingAtCamera =
      candidate.micActive &&
      candidate.tracking &&
      candidate.calibrated &&
      res.points.some((p) =>
        p.x > window.innerWidth * 0.35 && p.x < window.innerWidth * 0.65 &&
        p.y < window.innerHeight * 0.25
      );
    if (speakingAtCamera) {
      // suppress reading flag for this tick
      candidate.reading.flag = false;
      candidate.reading.reason = 'speaking while looking at camera - reading suppressed this window';
    }
    // Update baseline during warmup (only before first deduction)
    if (candidate.score >= 100 && candidate.calibrated) {
      candidate.baselineAmplitude = res.points.length ?
        (updateBaseline(windowSlice(getCfg().windowMs), getCfg()) ?? candidate.baselineAmplitude) :
        candidate.baselineAmplitude;
    }

    // Reading flag state for this tick (after speaking guard may have suppressed it)
    const flagThisTick = candidate.reading.flag && candidate.tracking;
    const prevFlag = lastFlagState;
    candidate.flags.READING_PATTERN_DETECTED = flagThisTick;
    lastFlagState = flagThisTick;

    // Cooldown-aware deduction: READING_DETECTED rises
    if (flagThisTick && !prevFlag) {
      const now = performance.now();
      const readingCfg = getCfg();
      const lowGaze = res.lowGaze && readingCfg.lowGazeEnabled;

      // Deduct the moment a reading pattern is caught - including the very first
      // one. There is no warning-only grace episode; only the cooldown throttles it.
      const lastReadingDeduction = candidate.scoreState.categoryLastDeduction['reading'] ?? -Infinity;
      const onCooldown = (now - lastReadingDeduction) < readingCfg.cooldownMs;
      let deductedNow = false;
      if (!onCooldown) {
        // Add blink-rate boost if active
        let confidenceBoost = 0;
        if (candidate.blinkRateDropActive) {
          confidenceBoost = 0.2;
          logFlagText('Reading detection supported by blink-rate drop (+20% confidence)');
        }

        const cat = 'reading';
        const cap = 30;
        const currentTotal = candidate.scoreState.categoryTotals[cat] ?? 0;
        const remaining = cap - currentTotal;
        if (remaining > 0) {
          const amount = Math.min(readingCfg.pointsPerDetection, remaining);
          candidate.scoreState.score = Math.max(0, candidate.scoreState.score - amount);
          candidate.scoreState.categoryTotals[cat] = (candidate.scoreState.categoryTotals[cat] ?? 0) + amount;
          candidate.scoreState.categoryLastDeduction[cat] = now;
          candidate.scoreState.flagLog.push({
            code: 'READING_DETECTED',
            text: `READING_DETECTED (-${amount})${confidenceBoost > 0 ? ' (blink-boosted)' : ''}${lowGaze ? ' (low-gaze)' : ''}`,
            ts: now,
            category: cat,
            amount,
          });
          candidate.score = candidate.scoreState.score;
          candidate.tier = tierFor(candidate.score);
          candidate.scoreFlashAt = now;
          animateScoreDrop(-amount);
          const regionMode = res.region?.mode ?? 'reading';
          let flagText = `Reading pattern detected (-${amount})`;
          if (lowGaze) flagText += ` - READING_LOW_GAZE (compact/${regionMode})`;
          else flagText += ` - ${regionMode}`;
          if (confidenceBoost > 0) flagText += ' [blink-rate drop support]';
          logFlagText(flagText);
          candidate.blinkRateDropActive = false;
          deductedNow = true;
          bcPostState();
        }
      }

      // Warn on every episode, but only claim a deduction when one was actually applied.
      if (!candidate.warnShown) {
        candidate.warnShown = true;
        showReadingWarn('first');
      } else if (deductedNow) {
        showReadingWarn('repeat');
      }
      candidate.lastDeductionAt = now;
    }

    // Decay blink-rate-drop active flag when reading stops
    if (!flagThisTick) {
      candidate.blinkRateDropActive = false;
    }

    // Decay low-gaze flag if reading stops being low-gaze
    if (!res.lowGaze && candidate.lowGazeFlagShown) {
      // keep the historical flag in the log, but the live flag state reflects current
    }

    candidate.flags.NO_FACE_DETECTED =
      candidate.tracking && candidate.faceSeenAt !== 0 && candidate.faceLostAt !== 0 &&
      (performance.now() - candidate.faceLostAt) > NO_FACE_MS;

    // Score from central scoring state
    candidate.score = candidate.scoreState.score;
    candidate.tier = tierFor(candidate.score);

    // Update face-present percentage
    candidate.facePresentPercent = candidate.faceMonitor.getFacePresentPercent(performance.now());

    renderScore();
    updateReadingUI(res);

    // Build flag list string for broadcast + UI
    const activeFlags: string[] = [];
    if (candidate.flags.READING_PATTERN_DETECTED) {
      const regionMode = res.region?.mode ?? 'reading';
      const lowGaze = res.lowGaze && getCfg().lowGazeEnabled;
      let label = `Reading pattern detected (-${getCfg().pointsPerDetection}) - ${lowGaze ? 'compact' : regionMode}`;
      if (lowGaze) label += ' (READING_LOW_GAZE)';
      activeFlags.push(label);
    }
    if (candidate.flags.NO_FACE_DETECTED) activeFlags.push('NO_FACE_DETECTED');

    if (candidate.streaming) {
      bcPost({
        type: 'state',
        payload: {
          id: mySessionId,
          name: session?.name,
          score: candidate.score, tier: candidate.tier,
          flags: activeFlags,
          flagLog: candidate.flagLog.slice(-20),
          readingCycles: candidate.reading.cycles,
          readingLik: candidate.reading.likelihood,
          elapsedMs: Date.now() - candidate.startedAt,
          micActive: candidate.micActive,
          gazeLive,
          ts: Date.now(),
        },
      });
    }
  }, ANALYSIS_TICK_MS);
  tickTimer = window.setInterval(() => {
    if (candidate.streaming) $('#session-clock').textContent = fmtClock(Date.now() - candidate.startedAt);
  }, 1000);

  // score flash animation loop (runs once per flash, but kept as a recurring check)
  window.setInterval(() => {
    if (candidate.streaming && candidate.scoreFlashAt && performance.now() - candidate.scoreFlashAt < 1200) {
      // already handled by animateScoreDrop; nothing to do here, but keep the hook
    }
  }, 100);
}

let lastFlagState = false;

function showReadingWarn(kind: 'first' | 'repeat'): void {
  const box = $('#reading-warn');
  const msg = $('#reading-warn-msg');
  if (kind === 'first') {
    msg.innerHTML = '<b>Warning:</b> your gaze pattern suggests you may be reading something on screen. This is flagged for the interviewer. Repeated episodes will permanently reduce your trust score (-' +
      getCfg().pointsPerDetection + ' per episode' + (getCfg().cooldownMs > 0 ? ' after a ' + (getCfg().cooldownMs / 1000) + 's cooldown' : '') + ').';
  } else {
    msg.innerHTML = `<b>Repeated reading detected:</b> trust score permanently reduced by ${getCfg().pointsPerDetection} points (total deduction this session: <span class="mono">-${100 - candidate.scoreState.score}</span>).`;
  }
  box.style.display = '';
}

// Paint the trust score + tier badge. Nothing used to write these, so the candidate
// panel sat at 100 / LOW for the whole session even while deductions were applied.
function renderScore(): void {
  const v = document.getElementById('score-val');
  if (v) v.textContent = String(candidate.score);
  const badge = document.getElementById('tier-badge');
  if (badge) {
    badge.textContent = candidate.tier;
    badge.className = `tier ${candidate.tier.toLowerCase()}`;
  }
}

// Score flash animation: brief red pulse + floating delta
function animateScoreDrop(delta: number): void {
  const el = $('#score-val') as HTMLElement;
  el.classList.add('score-drop');
  const label = document.createElement('span');
  label.className = 'score-delta';
  label.textContent = delta < 0 ? `-${Math.abs(delta)}` : `+${delta}`;
  label.style.color = 'var(--risk-high)';
  el.after(label);
  setTimeout(() => {
    el.classList.remove('score-drop');
    const f = el.nextElementSibling;
    if (f?.classList?.contains('score-delta')) f.remove();
  }, 1200);
}

function updateFlagLogUI(): void {
  const logEl = $('#read-flag-log');
  if (!logEl) return;
  logEl.innerHTML = candidate.scoreState.flagLog
    .slice(-10)
    .map((f: { ts: number; text: string }) => {
      const dt = f.ts - candidate.startedAt;
      const ts = dt > 0 ? fmtClock(dt) : '-';
      return `<div class="flag-log-row"><span class="flag-log-ts">${ts}</span><span class="flag-log-text">${f.text}</span></div>`;
    })
    .join('');
}

function updateReadingUI(res: ReadingDetectionResult): void {
  const row = $('#flag-reading');
  row.classList.toggle('on', candidate.flags.READING_PATTERN_DETECTED);
  $('#flag-reading-state').textContent = candidate.flags.READING_PATTERN_DETECTED
    ? 'Flagged' : candidate.reading.passes > 0 ? `${candidate.reading.passes} passes` : 'Clear';
  const likFill = $('#read-lik-fill');
  likFill.style.width = `${(candidate.reading.likelihood * 100).toFixed(0)}%`;
  row.classList.add('has-lik');

  const noFace = candidate.flags.NO_FACE_DETECTED;
  $('#flag-noface').classList.toggle('on', noFace);
  $('#flag-noface-state').textContent = noFace ? 'Flagged' : 'Clear';

  const v = $('#read-verdict');
  if (candidate.flags.READING_PATTERN_DETECTED) {
    v.textContent = 'READING FLAGGED';
    v.style.color = 'var(--risk-high)';
  } else if (!candidate.calibrated) {
    v.textContent = 'needs calibration';
    v.style.color = '';
  } else {
    v.textContent = 'no reading pattern';
    v.style.color = '';
  }
  $('#read-cycles').textContent = `${res.passCount} of ${getCfg().requiredPasses} passes · ${res.cycles} cycles`;
  $('#read-region-mode').textContent = res.region?.mode ?? '-';
  $('#read-lowgaze').textContent = res.lowGaze ? 'yes' : 'no';
  $('#penalty-val').textContent = candidate.scoreState.score < 100 ? `-${100 - candidate.scoreState.score} pts from ${candidate.scoreState.flagLog.length} event(s)` : candidate.warnShown ? 'warning shown' : '-';

  // Live flag log
  const logEl = $('#read-flag-log');
  if (logEl) {
    logEl.innerHTML = candidate.flagLog
      .slice(-10)
      .map((f: { ts: number; text: string }) => {
        const dt = f.ts - candidate.startedAt;
        const ts = dt > 0 ? fmtClock(dt) : '-';
        return `<div class="flag-log-row"><span class="flag-log-ts">${ts}</span><span class="flag-log-text">${f.text}</span></div>`;
      })
      .join('');
  }
  $('#read-lik').textContent =
    `${(candidate.reading.likelihood * 100).toFixed(0)}% · null ${Math.round(res.nullRatio * 100)}%`;
  const log = $('#read-log');
  log.textContent =
    `window: ${(getCfg().windowMs / 1000).toFixed(1)}s · amp ≥ ${(getCfg().minAmpFrac * 100).toFixed(0)}% width · ` +
    `pass ${(getCfg().passMsMin / 1000).toFixed(1)}-${(getCfg().passMsMax / 1000).toFixed(1)}s · ` +
    `passes ≥ ${getCfg().requiredPasses} (cycles ≥ ${getCfg().requiredCycles})\n` +
    `${res.reason}\n` +
    `samples: ${res.validSamples} valid / ${res.totalSamples} total (null ${Math.round(res.nullRatio * 100)}%)\n` +
    `verdict: ${candidate.flags.READING_PATTERN_DETECTED ? 'READING_PATTERN_DETECTED' : 'not flagged'}`;
  log.classList.toggle('alert', candidate.flags.READING_PATTERN_DETECTED);

  drawPlot(res);
}

/* ================= debug plot ================= */
function drawPlot(res: ReadingDetectionResult): void {
  const canvas = document.getElementById('gaze-plot') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const Wpx = canvas.width, Hpx = canvas.height;
  ctx.clearRect(0, 0, Wpx, Hpx);
  if (!res.points.length) return;
  const xs = res.points;
  const t0 = xs[0]!.t, t1 = xs[xs.length - 1]!.t || 1;
  const mapX = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * (Wpx - 10) + 5;
  const mapY = (x: number, winW: number) => 5 + (1 - clamp(x / winW, 0, 1)) * (Hpx - 10);
  const winW = getCfg().viewportWidth;

  /* grid */
  ctx.strokeStyle = '#1d2a36';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const fy of [0.25, 0.5, 0.75]) {
    const y = 5 + fy * (Hpx - 10);
    ctx.moveTo(5, y); ctx.lineTo(Wpx - 5, y);
  }
  ctx.stroke();

  /* detected region shading (wide vs compact) */
  if (res.region) {
    // Region is in gaze-space (x/y), plot is timex. Shade as vertical band on the y-axis.
    const ry0 = 5 + (1 - clamp(res.region.xMin / winW, 0, 1)) * (Hpx - 10);
    const ry1 = 5 + (1 - clamp(res.region.xMax / winW, 0, 1)) * (Hpx - 10);
    ctx.fillStyle = res.region.mode === 'wide'
      ? 'rgba(59,130,246,0.11)'
      : 'rgba(168,85,247,0.13)';
    ctx.fillRect(5, Math.min(ry0, ry1), Wpx - 10, Math.abs(ry1 - ry0));
    // y-band
    const yTop = 5 + (1 - clamp((res.region.yMean + getCfg().yBandFracH * getCfg().viewportHeight / 2) / winW, 0, 1)) * (Hpx - 10);
    const yBot = 5 + (1 - clamp((res.region.yMean - getCfg().yBandFracH * getCfg().viewportHeight / 2) / winW, 0, 1)) * (Hpx - 10);
    ctx.fillStyle = 'rgba(168,85,247,0.06)';
    ctx.fillRect(5, Math.min(yTop, yBot), Wpx - 10, Math.abs(yBot - yTop));
  }

  /* passing runs shading */
  for (const run of res.runs) {
    const a = xs[run.i0], b = xs[run.i1];
    if (!a || !b) continue;
    ctx.fillStyle = run.inChain
      ? 'rgba(239,68,68,0.16)'
      : run.kind === 1 ? 'rgba(52,211,153,0.14)' : 'rgba(251,191,36,0.14)';
    const x0 = mapX(run.t0), x1 = mapX(run.t1);
    ctx.fillRect(Math.min(x0, x1), 4, Math.abs(x1 - x0), Hpx - 8);
  }

  /* x trace */
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const px = mapX(xs[i]!.t);
    const py = mapY(xs[i]!.x, winW);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  /* null spans */
  ctx.fillStyle = 'rgba(127,147,163,0.25)';
  const win = windowSlice(getCfg().windowMs);
  const winW2 = getCfg().viewportWidth;
  void winW2;
  let iN = 0;
  const buf2 = win;
  const tOff = xs.length ? buf2.findIndex((e) => e.t === xs[0]!.t) : 0;
  void tOff;
  for (const e of buf2) {
    if ('nullPredict' in e) {
      const px = mapX(e.t);
      ctx.fillRect(px - 1, 4, 2, Hpx - 8);
    }
    iN++;
    void iN;
  }
  $('#plot-sub').textContent = `${res.runs.filter((r) => r.kind === 1).length} passes · ${res.runs.filter((r) => r.kind === -1).length} returns · ${res.cycles} cycles`;
}

/* ================= test mode ================= */
let testParaEl: HTMLElement | null = null;
void testParaEl;
const TEST_TEXT =
  'The reading-pattern detector watches how your gaze travels across the screen. As you read this paragraph, ' +
  'your eyes move left to right along each line, then flick back to the left edge to start the next one. ' +
  'The detector smooths the gaze trace, splits it into monotonic runs, and chains those runs into read cycles. ' +
  'Two read passes inside the analysis window raise the reading flag. When you stop reading and look around ' +
  'freely - at the camera, the ceiling, a colleague coming through the door - the pattern should disappear. ' +
  'This paragraph exists so you can tune the thresholds in the Admin view against your own gaze behavior.';

function toggleTestMode(): void {
  const existing = document.getElementById('test-para');
  if (existing) {
    existing.remove();
    testParaEl = null;
    $('#btn-testmode').textContent = 'Show test paragraph';
    return;
  }
  const host = document.querySelector('.stage')!;
  const box = document.createElement('section');
  box.className = 'panel';
  box.id = 'test-para';
  box.innerHTML = `
    <div class="panel-head"><h3 class="panel-title">Test mode - read this paragraph</h3><span class="panel-sub">watch the debug plot classify your line reads</span></div>
    <div class="panel-body"><div class="test-para">${TEST_TEXT.split(' ').map((w) => `<span class="pw">${w}</span>`).join(' ')}</div>
    <p class="text-hint">Read it a few lines, then look away and confirm the likelihood decays back to zero. False positives - fast full-screen sweeps, a single glance away - should not raise the flag (see the unit tests).</p></div>`;
  host.appendChild(box);
  testParaEl = box;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#btn-testmode').textContent = 'Hide test paragraph';
  fixSvgRef();
}
function fixSvgRef(): void { void IFRAME_SVGS.shield; }

/* ================= teardown ================= */
function stopCandidateDevices(): void {
  captureSession?.abort();
  captureSession = null;
  candidate.streaming = false;
  candidate.tracking = false;
  candidate.calibrating = false;
  candidate.calibrated = false;
  candidate.setupOverride = false;
  candidate.faceSeenAt = candidate.faceLostAt = 0;
  gazeLive = false;
  cameraFps = 0;
  window.clearInterval(tickTimer);
  window.clearInterval(analysisTimer);
  tickTimer = analysisTimer = 0;
  if (micRaf) { cancelAnimationFrame(micRaf); micRaf = 0; }
  candidate.attentionMonitor.stop();
  tracker.dispose();
  stopGazeOverlay();
  if (micAnalyser) { try { micAnalyser.disconnect(); } catch { /* ignore */ } micAnalyser = null; }
  if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  const vid = document.getElementById('preview-video');
  vid?.remove();
  clearBuffer();
  $('#gate-live').style.display = 'none';
  $('#gate-ask').style.display = '';
  $('#setup-panel').style.display = '';
  $('#tracking-panel').style.display = 'none';
  $('#btn-start-cal').textContent = 'Start calibration';
  $('#gaze-readout-xy').textContent = 'â€”';
  $('#gaze-fps').textContent = 'â€”';
}

function candidateTeardown(): void {
  stopCandidateDevices();
  Object.keys(candidate.flags).forEach((k) => (candidate.flags as Record<string, boolean>)[k] = false);
  candidate.scoreState = initialScoreState(performance.now(), candidate.accommodations);
  candidate.score = 100;
  candidate.tier = 'LOW';
  renderScore();
  candidate.setupQuality = null;
  candidate.setupOverride = false;
  candidate.facePresentPercent = 100;
  candidate.blinkRateDropActive = false;
  candidate.extraDisplayFlagged = false;
  candidate.reading = { flag: false, passes: 0, cycles: 0, likelihood: 0, reason: '', nullRatio: 0, result: null as ReadingDetectionResult | null, region: null as ReadingRegion | null, lowGaze: false };
  candidate.warnShown = false;
  candidate.lastDeductionAt = 0;
  candidate.flagLog = [];
  candidate.scoreFlashAt = 0;
  candidate.scoreFlashDelta = 0;
  candidate.baselineAmplitude = 0;
  candidate.lowGazeFlagShown = false;
  lastFlagState = false;
  ($('#reading-warn') as HTMLElement).style.display = 'none';
  $('#penalty-val').textContent = '-';
  $('#read-lik-fill').style.width = '0%';
  $('#session-clock').textContent = '00:00';
  $('#gate-denied').style.display = 'none';
}

/* ================= mobile detection ================= */
if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && window.innerWidth < 900) {
  document.body.classList.add('is-mobile');
}

void CAL_CAPTURE_W;
void CAL_CAPTURE_H;

/* ================= boot ================= */
show('login');
if (session) enterRole();

