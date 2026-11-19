/**
 * calibration - full-screen 17-point calibration wizard.
 * One target at a time across the grid; the user looks at it and clicks or
 * holds the spacebar/mouse to capture (with a short dwell so the samples are
 * taken while actually fixating). Progress indicator + redo/restart controls.
 */
import { calibrationTargets, type GazeTracker } from './tracker.js';
import type { CalibrationSample } from '@realeye-io/webcam-eyetracker-light-open';

export interface CalibrationRunResult {
  ok: boolean;
  samples: CalibrationSample[];
  cancelled: boolean;
  reason?: string;
}

const SETTLE_MS = 450;   // target shown before capture becomes armed

export function runCalibrationWizard(tracker: GazeTracker): Promise<CalibrationRunResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cal-overlay';
    overlay.innerHTML = `
      <div class="cal-progress">
        <span>Calibration</span>
        <span class="cal-count" id="cal-count">1 / 17</span>
        <span style="flex:1"></span>
        <span style="color:var(--ink2); font-size:12.5px;">Look at each dot, then click it (or hold <span class="mono">space</span> for ~0.6 s)</span>
      </div>
      <div class="cal-area" id="cal-area"></div>
      <div class="cal-hint">Keep your head still and follow the dot with your eyes only.</div>
      <div class="cal-actions">
        <button class="btn" id="cal-restart" type="button">Restart calibration</button>
        <button class="btn btn-ghost" id="cal-cancel" type="button">Cancel</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const area = overlay.querySelector('#cal-area')!;
    const countEl = overlay.querySelector('#cal-count')!;
    let pts = calibrationTargets(window.innerWidth, window.innerHeight);
    let idx = 0;
    let samples: CalibrationSample[] = [];
    let cancelled = false;
    let holdTimer = 0;

    function cleanup() {
      window.removeEventListener('keydown', onSpaceDown);
      window.removeEventListener('keyup', onSpaceUp);
      overlay.remove();
    }

    function targetEl(): HTMLElement {
      const p = pts[idx]!;
      const el = document.createElement('div');
      el.className = 'cal-target';
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.innerHTML = '<div class="cal-target-inner"></div>';
      area.appendChild(el);
      return el;
    }

    async function captureAt(i: number, target: HTMLElement): Promise<void> {
      const p = pts[i]!;
      const sample = await tracker.captureCalibrationSample(p.x, p.y);
      if (sample) {
        samples.push(sample);
        target.classList.add('captured');
        countEl.textContent = `${i + 1} / ${pts.length}`;
      } else {
        // camera hiccup - leave target active so the user can click again
        countEl.textContent = `${i + 1} / ${pts.length} (retry)`;
      }
    }

    async function showTarget() {
      area.querySelectorAll('.cal-target').forEach((el) => el.remove());
      if (idx >= pts.length) { finish(true); return; }
      const p = pts[idx]!;
      if (!p) { finish(true); return; }
      const el = targetEl();
      countEl.textContent = `${idx + 1} / ${pts.length}`;
      el.addEventListener('click', async () => {
        if (el.classList.contains('captured')) return;
        await captureAt(idx, el);
        idx++;
        setTimeout(showTarget, 350);
      });
    }

    function onSpaceDown(ev: KeyboardEvent) {
      if (ev.code !== 'Space' || ev.repeat) return;
      ev.preventDefault();
      holdTimer = window.setTimeout(async () => {
        const el = area.querySelector<HTMLElement>('.cal-target:not(.captured)');
        if (!el) return;
        await captureAt(idx, el);
        idx++;
        setTimeout(showTarget, 350);
      }, 600);
    }
    function onSpaceUp(ev: KeyboardEvent) {
      if (ev.code !== 'Space') return;
      clearTimeout(holdTimer);
    }

    function finish(ok: boolean, reason?: string) {
      cleanup();
      if (cancelled) { resolve({ ok: false, samples: [], cancelled: true }); return; }
      resolve({ ok, samples, cancelled: false, reason });
    }

    overlay.querySelector('#cal-restart')!.addEventListener('click', () => {
      samples = [];
      idx = 0;
      pts = calibrationTargets(window.innerWidth, window.innerHeight);
      void showTarget();
    });
    overlay.querySelector('#cal-cancel')!.addEventListener('click', () => {
      cancelled = true;
      cleanup();
      resolve({ ok: false, samples: [], cancelled: true });
    });
    window.addEventListener('keydown', onSpaceDown);
    window.addEventListener('keyup', onSpaceUp);

    // settle, then start
    setTimeout(showTarget, SETTLE_MS);
  });
}


