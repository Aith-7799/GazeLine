import { onGaze } from '../gazeBuffer.js';
import { visibleGazePoint } from './viewport.js';

let cursor: HTMLDivElement | null = null;
let trail: SVGSVGElement | null = null;
let enabled = false;
let unsubscribe: (() => void) | null = null;
let smoothed: { x: number; y: number } | null = null;

/** Hide stale estimates on face loss and restart smoothing on reacquisition. */
export function clearGazeOverlay(): void {
  if (!smoothed) return;
  smoothed = null;
  if (cursor && trail) {
    cursor.style.display = trail.style.display = 'none';
    trail.replaceChildren();
  }
}

export function setGazeOverlayVisible(on: boolean): void {
  enabled = on;
  if (!on) clearGazeOverlay();
}

export function isGazeOverlayVisible(): boolean { return enabled; }

export function startGazeOverlay(): void {
  if (unsubscribe) return;
  cursor = document.createElement('div');
  cursor.id = 'gaze-cursor';
  trail = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  trail.id = 'gaze-trail';
  cursor.setAttribute('aria-hidden', 'true');
  trail.setAttribute('aria-hidden', 'true');
  document.body.append(trail, cursor);
  unsubscribe = onGaze(sample => {
    if (!enabled || !cursor || !trail) return;
    const { x, y } = visibleGazePoint(sample);
    smoothed = smoothed ? { x: smoothed.x + .3 * (x - smoothed.x), y: smoothed.y + .3 * (y - smoothed.y) } : { x, y };
    cursor.style.transform = `translate(${smoothed.x}px, ${smoothed.y}px)`;
    cursor.style.display = trail.style.display = 'block';
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '3');
    trail.appendChild(dot);
    if (trail.childElementCount > 30) trail.firstElementChild!.remove();
  });
}

export function stopGazeOverlay(): void {
  unsubscribe?.();
  unsubscribe = null;
  enabled = false;
  smoothed = null;
  cursor?.remove();
  trail?.remove();
  cursor = null;
  trail = null;
}
