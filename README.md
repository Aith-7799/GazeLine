# GAZELINE

Interview-integrity monitoring prototype - webcam eye-tracking, microphone level meter,
reading-pattern detection, and a 3-role console (Candidate / Interviewer / Admin), all client-side.

## Stack & run

Vite + TypeScript (vanilla, no framework). Eye tracking by
[`@realeye-io/webcam-eyetracker-light-open`](https://github.com/RealEye-io/webcam-eyetracker-light-open)
(MediaPipe + custom ridge regression). Models and the WASM runtime load from CDN by default -
no local model files are needed.

```bash
npm install
npm run dev        # http://localhost:5173 - secure context, getUserMedia works
npm run test       # vitest unit tests (synthetic gaze traces)
npm run typecheck  # tsc --noEmit
npm run build      # production bundle
```

## Demo accounts

| Role | Username | Password |
|---|---|---|
Set the local passwords in a .env file using .env.example. Passwords are intentionally excluded from source control.

## Candidate flow

1. **Sign in** (Candidate role)  **consent gate**: camera + mic permissions; nothing monitoring-related starts before both are granted.
2. **Setup**: live preview + face-detected badge. *Start calibration* is disabled until a face is seen.
3. **Calibration wizard**: full-screen overlay, one target at a time across the 17-point grid (`getRecommendedPattern()`  `getCalibrationPointsInPixels(...)`), progress `7/17`, click or hold-space to capture, redo/restart any time. `calibrate(samples)` needs � 5 samples; the wizard collects all 17.
4. **Tracking**: live gaze cursor + fading trail (toggleable), readout panel (x/y, fps, face-lost indicator, GPU/CPU delegate), *Recalibrate* button. GPU init falls back to CPU automatically.

## Reading-pattern detection

Subscribes through the gaze buffer (`src/gazeBuffer.ts` exposes `onGaze(cb)`; also `pushGaze`, `pushNull`,
`windowSlice`), analyzed every 250 ms over a rolling configurable window (default 8 s, buffer keeps ~10 s):

- **Read pass**: leftright drift in smoothed gaze x, covering � `minAmpFrac` (default **12%**) of viewport width, lasting **0.7-3 s**, small y change. The pass does *not* have to be a straight line - real gaze-x traces wiggle, so a retrace smaller than `passReversalPx` (default **90 px**) is treated as a wobble and keeps the pass open, and the net/total travel ratio (`passMonoMin`, default **0.45**) only has to show a net direction.
- **Return sweep**: quick rightleft movement after a pass (a *line break*).
- **Cycle**: pass  return  pass starting near the previous pass's end y. Consecutive cycles chain (`p,r,p,r,p` = 2).
- **Flag** `READING_PATTERN_DETECTED` at � N **read passes** (default **2**) in the window - the flag is what deducts 5 points.
- **Likelihood meter**: read-passes/required ratio shown live while passes build (never only on/off).
- **Null guard**: windows where > 30% of samples had no prediction (face lost) are ignored entirely.
- **Region-level**: covers � amplitude threshold � the tracker's ~120 px error; sub-error sweeps are ignored.

## Tuning it

- **Admin view** (any admin tab): editable thresholds - min pass amplitude, pass duration range, required read passes, required cycles, window length - broadcast live over the existing `BroadcastChannel` to candidate tabs.
- **Debug panel**: candidate view plots smoothed gaze-x over time, shading read passes (green), return sweeps (amber), and the flagged cycle chain (red).
- **Test mode** (*Tracking* panel  *Show test paragraph*): read the on-screen paragraph to see cycles build; look around naturally and watch the likelihood decay without flagging.

## Architecture

```
src/
  gazeBuffer.ts          # rolling ~10s buffer, onGaze() subscription, null-sample tracking
  readingDetector.ts     # PURE detector - smoothing, run classification, cycle chaining
  app/
    main.ts              # entry
    app.ts               # session routing, candidate orchestration, analysis loop, broadcast
    tracker.ts           # WebcamETLight wrapper (init GPUCPU, calibrate, rAF predict loop)
    calibration.ts       # 17-point wizard overlay
    gazeOverlay.ts       # smoothed cursor + SVG trail, show/hide
    appHtml.ts           # view DOM (login / candidate / interviewer / admin)
    styles.css           # dark ops-console theme
tests/readingDetector.test.ts  # synthetic-trace unit tests
```

The detector is pure (no DOM), so `tests/readingDetector.test.ts` verifies with synthetic gaze traces:
a reading sawtooth with noise ( flags), random wandering ( stays clear), a single glance away
( stays clear), plus fast full-screen sweeps ( too fast, cleared), likelihood ramp, and the
null-ratio guard.

## Privacy

Everything runs in the browser: no video, audio, or gaze data is uploaded anywhere. The
Interviewer console is fed by `BroadcastChannel` between tabs of the same browser only.
Gaze accuracy is ~120 CSS px after 17-point calibration - the cursor is region-level, not pixel-perfect.
Desktop only (warning banner on mobile, where accuracy is significantly reduced).

## License notes

Gazeline application code: prototype, all processing client-side.

**Eye tracker**: this project depends on
[`@realeye-io/webcam-eyetracker-light-open`](https://github.com/RealEye-io/webcam-eyetracker-light-open),
which is **dual-licensed AGPL-3.0 or later / commercial** (c 2025-2026 RealEye sp. z o.o., created by
Damian Sromek). Under the commercial option, use without a license fee is permitted only if you
qualify for the **no-fee commercial path**: a company whose qualifying valuation, acquisition value,
or trailing-twelve-month revenue does not exceed **USD $1,000,000** (including Affiliates), or a
university/academic/nonprofit research project funded under **USD $1,000,000**. Above these
thresholds, use the paid commercial license path described in the library's
`LICENSE-COMMERCIAL.md`. Application code that links the library is subject to AGPL-3.0 terms unless
you enter the commercial path; see the library's README and `THIRD_PARTY_NOTICES.md` (MediaPipe
models/WASM are third-party components with their own notices).

