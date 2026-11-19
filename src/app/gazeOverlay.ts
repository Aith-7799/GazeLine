/**
 * gazeOverlay - fixed-position gaze cursor and fading trail on top of the page.
 * Accuracy note: ~120 CSS px after 17-point calibration, so the cursor is a
 * region indicator, not pixel-perfect.
 */
import { onGaze, type GazeSample } from '../gazeBuffer.js';

const TRAIL_LEN = 30;
const EMA_ALPHA = 0.3; // light smoothing

let cursorEl: HTMLDivElement | null = null;
let trailSvg: SVGSVGElement | null = null;
let shown = false;
let unsub: (() => void) | null = null;
let emaX = 0, emaY = 0, haveEma = false;
const trail: GazeSample[] = [];

function ensureEls(): void {
  if (cursorEl && trailSvg) return;
  cursorEl = document.createElement('div');
  cursorEl.id = 'gaze-cursor';
  document.body.appendChild(cursorEl);

  trailSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  trailSvg.id = 'gaze-trail';
  document.body.appendChild(trailSvg);
}

export function setGazeOverlayVisible(on: boolean): void {
  ensureEls();
  shown = on;
  if (!cursorEl || !trailSvg) return;
  cursorEl.style.display = on ? 'block' : 'none';
  trailSvg.style.display = on ? 'block' : 'none';
  if (!on) {
    if (trailSvg) trailSvg.innerHTML = '';
    trail.length = 0;
  }
}

export function isGazeOverlayVisible(): boolean {
  return shown;
}

export function startGazeOverlay(): void {
  ensureEls();
  if (unsub) return;
  unsub = onGaze((s) => {
    if (!haveEma) { emaX = s.x; emaY = s.y; haveEma = true; }
    emaX = emaX + EMA_ALPHA * (s.x - emaX);
    emaY = emaY + EMA_ALPHA * (s.y - emaY);

    if (!shown || !cursorEl || !trailSvg) return;
    cursorEl.style.transform = `translate(${emaX.toFixed(1)}px, ${emaY.toFixed(1)}px)`;

    trail.push({ x: s.x, y: s.y, t: s.t });
    while (trail.length > TRAIL_LEN) trail.shift();
    let svg = '';
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i]!;
      const age = (trail.length - i) / TRAIL_LEN; // 1 = newest
      const r = 2 + age * 3;
      const o = 0.05 + age * 0.3;
      svg += `<circle cx="${p.x.toFixed(0)}" cy="${p.y.toFixed(0)}" r="${r.toFixed(1)}" opacity="${o.toFixed(2)}" style="fill:rgba(34,211,238,${o.toFixed(2)})"/>`;
    }
    trailSvg.innerHTML = svg;
  });
}

export function stopGazeOverlay(): void {
  unsub?.();
  unsub = null;
  haveEma = false;
  trail.length = 0;
  if (cursorEl) cursorEl.style.display = 'none';
  if (trailSvg) { trailSvg.innerHTML = ''; trailSvg.style.display = 'none'; }
}

