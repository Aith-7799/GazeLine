import { getCalibrationPoints, getRecommendedPattern, type CalibrationSample } from '@realeye-io/webcam-eyetracker-light-open';
import type { GazeTracker } from './tracker.js';
import { visibleViewport } from './viewport.js';

const points = getCalibrationPoints(getRecommendedPattern());
const settleMs = 450;
const instructions = 'Keep your head still. Look at the dot, then click it or hold Space.';

export function runCalibrationWizard(
  tracker: Pick<GazeTracker, 'captureCalibrationSample'>,
  signal: AbortSignal,
): Promise<CalibrationSample[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'cal-overlay';
    dialog.setAttribute('aria-labelledby', 'cal-title');
    dialog.setAttribute('aria-describedby', 'cal-hint');
    dialog.innerHTML = `
      <header class="cal-progress">
        <strong id="cal-title">Gaze calibration</strong>
        <span class="cal-count" id="cal-count" aria-live="polite"></span>
      </header>
      <div class="cal-area"></div>
      <footer class="cal-footer">
        <span class="cal-hint" id="cal-hint" role="status"></span>
        <div class="cal-actions">
          <button class="btn" id="cal-restart" type="button">Restart</button>
          <button class="btn btn-ghost" id="cal-cancel" type="button">Cancel</button>
        </div>
      </footer>`;
    const area = dialog.querySelector<HTMLElement>('.cal-area')!;
    const count = dialog.querySelector<HTMLElement>('#cal-count')!;
    const hint = dialog.querySelector<HTMLElement>('#cal-hint')!;
    const samples: CalibrationSample[] = [];
    let target: HTMLButtonElement | null = null;
    let viewport = visibleViewport();
    let readyAt = 0;
    let busy = false;
    let timer = 0;
    let holdTimer = 0;

    function showTarget(message = instructions) {
      window.clearTimeout(timer);
      window.clearTimeout(holdTimer);
      busy = false;
      const point = points[samples.length];
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'cal-target';
      dot.setAttribute('aria-label', `Capture point ${samples.length + 1}`);
      dot.style.left = `${point.x * 100}%`;
      dot.style.top = `${point.y * 100}%`;
      dot.addEventListener('click', requestCapture);
      target = dot;
      area.replaceChildren(dot);
      count.textContent = `Point ${samples.length + 1} of ${points.length}`;
      hint.textContent = message;
      dot.focus({ preventScroll: true });
      readyAt = performance.now() + settleMs;
    }

    function requestCapture() {
      if (!target || busy) return;
      busy = true;
      const dot = target;
      window.clearTimeout(holdTimer);
      timer = window.setTimeout(async () => {
        const box = dot.getBoundingClientRect();
        let sample: CalibrationSample | null = null;
        try {
          sample = await tracker.captureCalibrationSample(box.left + box.width / 2, box.top + box.height / 2);
        } catch {
          // The camera can lose a frame between detection and capture.
        }
        if (target !== dot) return;
        if (!sample) {
          busy = false;
          hint.textContent = 'Centre your face, look at the same dot and try again.';
          return;
        }
        samples.push(sample);
        if (samples.length === points.length) { finish(samples); return; }
        showTarget();
      }, Math.max(0, readyAt - performance.now()));
    }

    function updateViewport() {
      const next = visibleViewport();
      const changed = next.width !== viewport.width || next.height !== viewport.height ||
        next.top !== viewport.top || next.left !== viewport.left;
      Object.assign(dialog.style, {
        left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px`,
      });
      viewport = next;
      if (changed && target) {
        const hadSamples = samples.length > 0;
        samples.length = 0;
        showTarget(hadSamples ? 'Screen size changed. Start again at this dot.' : instructions);
      }
    }

    function finish(result: CalibrationSample[] | null) {
      target = null;
      window.clearTimeout(timer);
      window.clearTimeout(holdTimer);
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      signal.removeEventListener('abort', cancel);
      dialog.close();
      dialog.remove();
      resolve(result);
    }
    function cancel() { finish(null); }

    dialog.addEventListener('keydown', ev => {
      if (ev.code !== 'Space' || ev.target !== target) return;
      ev.preventDefault();
      if (!ev.repeat) holdTimer = window.setTimeout(requestCapture, 600);
    });
    dialog.addEventListener('keyup', ev => {
      if (ev.code === 'Space' && ev.target === target) {
        ev.preventDefault();
        window.clearTimeout(holdTimer);
      }
    });
    dialog.addEventListener('focusout', () => window.clearTimeout(holdTimer));
    dialog.addEventListener('cancel', ev => { ev.preventDefault(); cancel(); });
    dialog.querySelector('#cal-cancel')!.addEventListener('click', cancel);
    dialog.querySelector('#cal-restart')!.addEventListener('click', () => { samples.length = 0; showTarget(); });
    signal.addEventListener('abort', cancel, { once: true });
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    document.body.appendChild(dialog);
    dialog.showModal();
    updateViewport();
    showTarget();
  });
}
