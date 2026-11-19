/** attentionMonitor - tab, window, fullscreen, clipboard, and display monitoring.
 * Emits TAB_SWITCH, LONG_AWAY, FULLSCREEN_EXIT, PASTE_EVENT, EXTRA_DISPLAY_DETECTED.
 */

import type { IntegrityEvent } from './types.js';

export interface AttentionEventDetails {
  /** Human-readable description of the event. */
  description: string;
  /** For tab/window hidden: duration in ms. */
  durationMs?: number;
  /** For paste: length of clipboard content (not the content itself). */
  pasteLength?: number;
  /** For display: how many screens detected. */
  screenCount?: number;
}

export type AttentionEvent = IntegrityEvent & { details: AttentionEventDetails };

export interface AttentionMonitorConfig {
  tabSwitchDeduction: number;
  tabSwitchDebounceMs: number;
  longAwayThresholdMs: number;
  longAwayDeduction: number;
  fullscreenExitDeduction: number;
  pasteDeduction: number;
  extraDisplayDeduction: number;
  tabHiddenUnreliableWindowMs: number;
}

export const DEFAULT_ATTENTION_CFG: AttentionMonitorConfig = {
  tabSwitchDeduction: 2,
  tabSwitchDebounceMs: 5000,
  longAwayThresholdMs: 10000,
  longAwayDeduction: 3,
  fullscreenExitDeduction: 2,
  pasteDeduction: 1,
  extraDisplayDeduction: 5,
  tabHiddenUnreliableWindowMs: 15000,
};

export class AttentionMonitor {
  private config: AttentionMonitorConfig;
  private _listeners = new Set<(ev: AttentionEvent) => void>();
  private tabHiddenSince = 0;
  private tabWasHidden = false;
  private lastFocusTs = 0;
  private extraDisplayFlagged = false;
  private _extraDisplayChecked = false;

  constructor(config: Partial<AttentionMonitorConfig> = {}) {
    this.config = { ...DEFAULT_ATTENTION_CFG, ...config };
  }

  /** Subscribe to attention events. Returns unsubscribe. */
  onEvent(cb: (ev: AttentionEvent) => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private emit(ev: AttentionEvent): void {
    for (const l of this._listeners) l(ev);
  }

  /** Start listening to DOM events. Call once after session starts. */
  start(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('blur', this._onWindowBlur);
    window.addEventListener('focus', this._onWindowFocus);
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
    document.addEventListener('copy', this._onClipboard);
    document.addEventListener('cut', this._onClipboard);
    document.addEventListener('paste', this._onPaste);
    document.addEventListener('contextmenu', this._onClipboard);
    // Keyboard shortcuts that commonly switch windows (log only, never block)
    document.addEventListener('keydown', this._onKeyDown);
    this._checkExtraDisplay();
  }

  /** Stop listening. Call on session end. */
  stop(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('blur', this._onWindowBlur);
    window.removeEventListener('focus', this._onWindowFocus);
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
    document.removeEventListener('copy', this._onClipboard);
    document.removeEventListener('cut', this._onClipboard);
    document.removeEventListener('paste', this._onPaste);
    document.removeEventListener('contextmenu', this._onClipboard);
    document.removeEventListener('keydown', this._onKeyDown);
  }

  private _onVisibilityChange = (): void => {
    const now = performance.now();
    if (document.hidden) {
      this.tabHiddenSince = now;
      this.tabWasHidden = true;
    } else if (this.tabWasHidden) {
      const duration = now - this.tabHiddenSince;
      this.tabWasHidden = false;
      // Tab switch event
      this.emit({
        code: 'TAB_SWITCH',
        severity: 'warn',
        confidence: 0.9,
        t: now,
        details: {
          description: `Tab was hidden for ${Math.round(duration / 1000)}s`,
          durationMs: duration,
        },
      });
      // Long away check
      if (duration >= this.config.longAwayThresholdMs) {
        this.emit({
          code: 'LONG_AWAY',
          severity: 'critical',
          confidence: 0.85,
          t: now,
          details: {
            description: `Tab hidden for ${Math.round(duration / 1000)}s (long away)`,
            durationMs: duration,
          },
        });
      }
    }
  };

  private _onWindowBlur = (): void => {
    this.lastFocusTs = performance.now();
  };

  private _onWindowFocus = (): void => {
    const now = performance.now();
    const awayMs = now - this.lastFocusTs;
    if (awayMs > 0) {
      // Tab switch when window regains focus
      this.emit({
        code: 'TAB_SWITCH',
        severity: 'warn',
        confidence: 0.8,
        t: now,
        details: {
          description: `Window was inactive for ${Math.round(awayMs / 1000)}s`,
          durationMs: awayMs,
        },
      });
      if (awayMs >= this.config.longAwayThresholdMs) {
        this.emit({
          code: 'LONG_AWAY',
          severity: 'critical',
          confidence: 0.75,
          t: now,
          details: {
            description: `Window inactive for ${Math.round(awayMs / 1000)}s (long away)`,
            durationMs: awayMs,
          },
        });
      }
    }
    this.lastFocusTs = now;
  };

  private _onFullscreenChange = (): void => {
    if (!document.fullscreenElement) {
      const now = performance.now();
      this.emit({
        code: 'FULLSCREEN_EXIT',
        severity: 'warn',
        confidence: 0.85,
        t: now,
        details: {
          description: 'Fullscreen mode exited during the session.',
        },
      });
    }
  };

  private _onClipboard = (): void => {
    const now = performance.now();
    // Log only - never read clipboard content
    this.emit({
      code: 'PASTE_EVENT',
      severity: 'info',
      confidence: 0.7,
      t: now,
      details: {
        description: 'Clipboard operation (copy/cut/paste/context menu) detected on the page.',
        pasteLength: 0, // we do NOT read the content
      },
    });
  };

  private _onPaste = (e: ClipboardEvent): void => {
    const now = performance.now();
    let pasteLength = 0;
    try {
      if (e.clipboardData) {
        const text = e.clipboardData.getData('text');
        pasteLength = text.length;
      }
    } catch { /* ignore */ }
    this.emit({
      code: 'PASTE_EVENT',
      severity: 'info',
      confidence: 0.7,
      t: now,
      details: {
        description: 'Paste event detected on the page.',
        pasteLength,
      },
    });
  };

  private _onKeyDown = (e: KeyboardEvent): void => {
    // Log common window-switching shortcuts (never preventDefault)
    const switchKeys = new Set([
      'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
      'Tab', 'Escape',
    ]);
    if (switchKeys.has(e.key)) {
      // Just log - don't emit for every keystroke, only actual switches are caught
      // by visibilitychange/blur. This is for additional context only.
    }
  };

  /** Check for multiple displays using Window Management API or fallback. */
  private _checkExtraDisplay(): void {
    if (this._extraDisplayChecked) return;
    this._extraDisplayChecked = true;
    const now = performance.now();

    if (typeof (window as any).getScreenDetails === 'function') {
      // Request permission and check
      (window as any).getScreenDetails().then((details: { screenCount: number }) => {
        if (details.screenCount > 1) {
          this.emit({
            code: 'EXTRA_DISPLAY_DETECTED',
            severity: 'critical',
            confidence: 0.9,
            t: now,
            details: {
              description: `${details.screenCount} displays detected - a second screen may be used for reference material.`,
              screenCount: details.screenCount,
            },
          });
        }
      }).catch(() => {
        // Permission denied or unavailable - log but no penalty
        console.warn('[integrity] Screen Details permission denied or unavailable.');
      });
    } else if (window.screen && (window.screen as any).isExtended) {
      (window.screen as any).isExtended.then((extended: boolean) => {
        if (extended) {
          this.emit({
            code: 'EXTRA_DISPLAY_DETECTED',
            severity: 'critical',
            confidence: 0.7,
            t: now,
            details: {
              description: 'Multiple displays detected via screen.isExtended.',
              screenCount: 2,
            },
          });
        }
      }).catch(() => {
        // unavailable
      });
    } else {
      console.warn('[integrity] Display check unavailable - no Window Management API support.');
    }
  }

  /** Check if gaze data around a tab switch should be marked unreliable. */
  getUnreliableWindowMs(): number {
    return this.config.tabHiddenUnreliableWindowMs;
  }

  /** Mark extra-display as already flagged (prevent duplicate). */
  setExtraDisplayFlagged(flagged: boolean): void {
    this.extraDisplayFlagged = flagged;
  }

  /** Whether extra display has already been flagged this session. */
  get extraDisplayAlreadyFlagged(): boolean {
    return this.extraDisplayFlagged;
  }
}


