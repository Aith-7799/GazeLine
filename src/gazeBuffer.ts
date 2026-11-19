/**
 * gazeBuffer - the shared feed that everything downstream reads.
 *
 * The eye-tracker rAF loop (src/app/tracker.ts) pushes every predict() outcome here:
 * good predictions as samples, null predictions as explicit "null unions" so that
 * consumers can compute the null-sample ratio (detector ignores windows where the
 * face was missing more than ~30% of the time).
 *
 * Kept dependency-free so the reading detector unit tests can drive it directly.
 */

export interface GazeSample {
  /** CSS px in viewport coordinates */
  x: number;
  /** CSS px in viewport coordinates */
  y: number;
  /** performance.now() epoch for the frame */
  t: number;
}

export interface NullSample {
  /** epoch of the frame where the face was not detected */
  t: number;
  /** null marker - a real sample would hold x/y */
  nullPredict: true;
}

export type BufferEntry = GazeSample | NullSample;

export function isNullEntry(e: BufferEntry): e is NullSample {
  return (e as NullSample).nullPredict === true;
}

const WINDOW_MS = 10_000; // keep ~10 s of history

type GazeListener = (s: GazeSample) => void;

const entries: BufferEntry[] = [];
const listeners = new Set<GazeListener>();

export function onGaze(cb: GazeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function pushGaze(x: number, y: number, t: number = performance.now()): void {
  entries.push({ x, y, t });
  trim();
  for (const l of listeners) l({ x, y, t });
}

export function pushNull(t: number = performance.now()): void {
  entries.push({ t, nullPredict: true });
  trim();
}

function trim(): void {
  if (entries.length === 0) return;
  const cutoff = entries[entries.length - 1]!.t - WINDOW_MS;
  let drop = 0;
  while (drop < entries.length && entries[drop]!.t < cutoff) drop++;
  if (drop > 0) entries.splice(0, drop);
}

/** Entries (predictions and nulls) from the last `windowMs`, newest last. */
export function windowSlice(windowMs: number): BufferEntry[] {
  if (entries.length === 0) return [];
  const cutoff = entries[entries.length - 1]!.t - windowMs;
  let i = 0;
  while (i < entries.length && entries[i]!.t < cutoff) i++;
  return entries.slice(i);
}

export function size(): number {
  return entries.length;
}

export function clear(): void {
  entries.length = 0;
}

/** Wipe subscriptions too - used when signing out of a session. */
export function reset(): void {
  entries.length = 0;
  listeners.clear();
}

