/**
 * appHtml - builds the full GAZELINE DOM (ported from the original single-file
 * index.html) into #app. Queryable ids are unchanged where possible.
 */
export const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const IFRAME_SVGS = {
  shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 4v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V7z"/><path d="M9.2 12l2 2 3.6-4"/></svg>',
  cam: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="13" height="14" rx="2"/><path d="M15.5 10.5l5-3v9l5-3z" transform="translate(-3 0)"/></svg>',
  info: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
};

export const workspaces = [
  { role: 'candidate', label: 'Candidate', username: 'cand.demo', hint: 'Join an interview or practice with your camera.' },
  { role: 'interviewer', label: 'Interviewer', username: 'int.demo', hint: 'Create invitations and review your session reports.' },
  { role: 'admin', label: 'Admin', username: 'admin.demo', hint: 'Adjust how the reading and attention detectors work.' },
] as const;

const glyphs = {
  person: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20v-1.3a7 7 0 0 1 14 0V20"/>',
  eye: '<path d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.7"/>',
  lock: '<rect x="5.5" y="10" width="13" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  files: '<rect x="7" y="6" width="12" height="15" rx="2"/><path d="M5 17H4V3h12M10 11h6m-6 4h4"/>',
  ticket: '<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 7v2m0 2v2m0 2v2"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4"/>',
  sliders: '<path d="M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};
const icon = (name: keyof typeof glyphs) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`;
const accountRows = workspaces.map(w => `<tr><td>${w.label}</td><td class="mono">${w.username}</td></tr>`).join('');

export function buildApp(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
<header class="app-header">
  <div class="brand">
    <img src="/favicon.svg" width="38" height="38" alt="">
    <span class="logo-word">GazeLine</span>
  </div>
  <button class="header-help" id="open-privacy" type="button" aria-haspopup="dialog">${IFRAME_SVGS.shield}<span>Privacy &amp; devices</span></button>
  <div class="session-chip" id="session-chip">
    <div class="avatar" id="session-avatar" aria-hidden="true"></div>
    <div class="who"><div class="name" id="session-name"></div><div class="role" id="session-role"></div></div>
    <button class="btn btn-ghost" id="btn-logout" type="button">Sign out</button>
  </div>
</header>

<main class="stage">
  <!-- LOGIN -->
  <section class="view" id="view-login" aria-labelledby="workspace-title">
    <div class="login-spread">
      <div class="workspace-cover">
        <img class="cover-art" src="/optics/lens.webp" width="896" height="896" alt="" fetchpriority="high">
        <i class="cover-reticle" aria-hidden="true"></i>
        <div class="cover-copy">
          <h1 id="workspace-title">Interview<br><em>workspace.</em></h1>
          <p class="cover-caption">${IFRAME_SVGS.shield} Camera and audio stay on your device.</p>
        </div>
      </div>
      <div class="login-sheet">
        <h2>Sign in</h2>
        <p id="role-hint" class="login-intro">${workspaces[0].hint}</p>
        <form id="login-form">
          <fieldset class="role-picker">
            <legend>Workspace role</legend>
            <div class="role-tabs">${workspaces.map((w, index) => `
              <label class="role-option"><input type="radio" name="role" value="${w.role}"${index === 0 ? ' checked' : ''}>
                <span>${w.label}</span></label>`).join('')}
            </div>
          </fieldset>
          <label class="field login-field"><span>Username</span>
            <span class="field-control">${icon('person')}<input type="text" id="login-user" name="username" placeholder="e.g. cand.demo" autocomplete="username" autocapitalize="none" spellcheck="false" required></span>
          </label>
          <div class="field login-field"><label for="login-pass">Password</label>
            <div class="field-control">${icon('lock')}<input type="password" id="login-pass" name="password" placeholder="Enter your password" autocomplete="current-password" required>
              <button class="visibility-button" id="toggle-password" type="button" aria-label="Show password" aria-pressed="false">${icon('eye')}</button>
            </div>
          </div>
          <div class="note-block red" id="login-error" role="alert" hidden></div>
          <button class="btn btn-primary" type="submit" id="login-submit">Sign in as candidate</button>
        </form>
        <details class="demo-guide">
          <summary>Demo usernames</summary>
          <table class="data"><thead><tr><th>Role</th><th>Username</th></tr></thead><tbody>${accountRows}</tbody></table>
        </details>
      </div>
    </div>
  </section>

  <!-- CANDIDATE -->
  <section class="view" id="view-candidate" aria-label="Candidate">
    <header class="workspace-heading">
      <h1 class="page-title">Your session</h1>
      <p class="page-lede">Join with an invitation to share a report, or go straight to device setup for local practice.</p>
    </header>
    <div class="mobile-banner">${icon('monitor')}<span>Use a laptop or desktop for more accurate gaze calibration.</span></div>

    <section class="panel invite-panel" aria-labelledby="candidate-interview-label">
      <div class="panel-head"><h2 class="panel-title" id="candidate-interview-label">${icon('ticket')} Interview invitation</h2></div>
      <div class="panel-body">
        <form id="join-interview" class="interview-form">
          <label class="field"><span>Join code</span><input type="text" id="join-code" maxlength="24" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" required></label>
          <label class="field"><span>Your name for the report</span><input type="text" id="join-name" maxlength="80" placeholder="Full name" autocomplete="name" required></label>
          <button class="btn btn-primary" type="submit">Join interview</button>
        </form>
        <div id="joined-interview" hidden>
          <strong id="joined-title"></strong><span class="joined-name" id="joined-name"></span>
          <button id="finish-interview" class="btn btn-primary" type="button">Finish interview</button>
        </div>
        <p class="text-hint" id="candidate-save-status" role="status"></p>
        <button class="btn" type="button" id="retry-interview" hidden>Retry connection</button>
      </div>
    </section>

    <div class="panel" id="gate-ask">
      <div class="panel-head"><h2 class="panel-title">${icon('monitor')} Device setup</h2></div>
      <div class="panel-body">
        <p class="setup-intro">Allow both devices to check your camera framing and microphone level, then calibrate your gaze.</p>
        <dl class="privacy-facts">
          <div><dt>On your device</dt><dd>Camera frames, audio and gaze coordinates. The microphone measures volume only.</dd></div>
          <div><dt>In a joined report</dt><dd>Your name, session times, calibration status, score and timestamped deductions.</dd></div>
        </dl>
        <button class="btn btn-primary" id="btn-enable" type="button">Allow camera and microphone</button>
        <p class="text-hint">Secure connection <span class="mono" id="ctx-state">Checking…</span></p>
      </div>
    </div>

    <div class="panel" id="gate-denied" style="display:none;">
      <div class="panel-head"><h3 class="panel-title">Monitoring unavailable</h3><span class="panel-sub" id="deny-stage">Device access</span></div>
      <div class="panel-body">
        <div class="note-block red" id="deny-reason" role="alert"></div>
        <p class="text-hint" id="deny-help">Enable camera and microphone access in your browser’s site settings, then try again.</p>
        <button class="btn" id="btn-retry" type="button" style="margin-top:12px;">Try again</button>
      </div>
    </div>

    <div id="gate-live" style="display:none;">
      <div class="gate-grid">
        <div>
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Live monitor</h3><span class="panel-sub" id="session-clock">00:00</span></div>
            <div class="panel-body">
              <div class="vid-shell">
                <span class="vid-tag">Local preview</span>
                <span class="face-badge" id="face-badge">checking.</span>
              </div>

              <!-- setup step -->
              <div class="panel" style="margin-top:16px;" id="setup-panel">
                <div class="panel-head"><h3 class="panel-title">Setup</h3><span class="panel-sub" id="setup-sub">waiting for face.</span></div>
                <div class="panel-body">
                  <p class="text-hint" style="margin-top:0;">Sit centred in the webcam at your normal distance, face well lit. Calibration starts only once a face is detected in the preview.</p>
                  <button class="btn btn-primary" id="btn-start-cal" type="button" disabled>Start calibration</button>
                  <p class="text-hint">
                    Gaze accuracy after calibration is about <b>120 CSS px</b> - this is a
                    region-level estimate, not a pixel-perfect pointer. The gaze cursor reflects that scale.
                  </p>
                </div>
              </div>

              <!-- tracking controls -->
              <div class="panel" style="margin-top:16px; display:none;" id="tracking-panel">
                <div class="panel-head"><h3 class="panel-title">Tracking</h3><span class="panel-sub" id="track-sub">-</span></div>
                <div class="panel-body">
                  <div class="cfg-row"><span class="cfg-label">Gaze cursor + trail</span>
                    <button class="btn" id="btn-toggle-cursor" type="button">Hide</button></div>
                  <div class="cfg-row"><span class="cfg-label">Recalibrate (redoes the 17-point wizard)</span>
                    <button class="btn" id="btn-recal" type="button">Recalibrate</button></div>
                  <div class="cfg-row"><span class="cfg-label">Test mode - read a paragraph on screen to verify detection</span>
                    <button class="btn" id="btn-testmode" type="button">Show test paragraph</button></div>
                </div>
              </div>

              <div style="margin-top:16px;">
                <div class="kv"><span class="k">Microphone level</span><span class="v" id="mic-readout">-</span></div>
                <div class="meter" id="meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="margin-top:8px;"><div class="meter-fill" id="meter-fill"></div></div>
              </div>
            </div>
          </div>

          <!-- gaze readout -->
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Gaze readout</h3><span class="panel-sub">live</span></div>
            <div class="panel-body" style="padding-top:6px;">
              <div class="kv"><span class="k">Gaze x / y</span><span class="v" id="gaze-readout-xy">-</span></div>
              <div class="kv"><span class="k">Sampling rate</span><span class="v" id="gaze-fps">-</span></div>
              <div class="kv"><span class="k">Face</span><span class="v" id="gaze-face-2">-</span></div>
              <div class="kv"><span class="k">Delegate</span><span class="v" id="gaze-delegate">-</span></div>
              <div class="kv"><span class="k">Calibration</span><span class="v" id="gaze-calstate">-</span></div>
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Trust score</h3><span class="panel-sub">Demo heuristic</span></div>
            <div class="panel-body">
              <div class="score-line">
                <span class="score-big" id="score-val" aria-label="Trust score">100</span>
                <span class="tier low" id="tier-badge">LOW</span>
              </div><p class="text-hint">The score starts at 100. Recorded deductions lower it for the rest of the session. Review the timeline for context.</p>
              <div style="margin-top:18px;">
                <div class="note-block red" id="reading-warn" role="alert" style="display:none; margin-bottom:8px;">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 4v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V7z"/><path d="M9.2 12l2 2 3.6-4"/></svg>
                  <div id="reading-warn-msg"></div>
                </div>
                <div class="flag-row" id="flag-reading">
                  <span class="dot" aria-hidden="true"></span>
                  <span class="flag-name">Reading pattern</span>
                  <span class="flag-state" id="flag-reading-state">Clear</span>
                  <span class="flag-hint">Repeated left-to-right gaze passes followed by a quick return.</span>
                  <div class="read-lik" aria-label="Reading likelihood"><div class="read-lik-fill" id="read-lik-fill"></div></div>
                </div>
                <div class="flag-row" id="flag-noface">
                  <span class="dot" aria-hidden="true"></span>
                  <span class="flag-name">Face absent</span>
                  <span class="flag-state" id="flag-noface-state">Clear</span>
                  <span class="flag-hint">Tracker finds no face in frame for more than 3.5 s</span>
                </div>
                <div class="panel" style="margin-top:14px; border-left: 3px solid var(--risk-medium);" id="flag-log-panel">
                  <div class="panel-head"><h3 class="panel-title">Reading deduction log</h3><span class="panel-sub" id="flag-log-count">0 events</span></div>
                  <div class="panel-body">
                    <div id="read-flag-log" class="flag-log"><span class="text-hint">No reading deductions yet.</span></div>
                  </div>
                </div>
              </div>
              <p class="text-hint">Reading detection requires calibration and a live face: windows are skipped when more than 30% of the samples in them are missing predictions.</p>
              <div class="kv" style="margin-top:10px;"><span class="k">Repeat-offense deduction</span><span class="v" id="penalty-val">-</span></div>
            </div>
          </div>

          <!-- reading telemetry -->
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Reading detection</h3><span class="panel-sub">8 s rolling window</span></div>
            <div class="panel-body">
              <div class="kv"><span class="k">Verdict</span><span class="v" id="read-verdict">-</span></div>
              <div class="kv"><span class="k">Read passes (left-to-right sweeps)</span><span class="v" id="read-cycles">0</span></div>
              <div class="kv"><span class="k">Likelihood</span><span class="v" id="read-lik">0%</span></div>
              <div class="kv"><span class="k">Region mode</span><span class="v" id="read-region-mode">-</span></div>
              <div class="kv"><span class="k">Low-gaze</span><span class="v" id="read-lowgaze">-</span></div>
              <div class="sweep-log" id="read-log" style="margin-top:12px;">waiting for gaze samples.</div>
              <p class="text-hint">Heuristic: a <b>read pass</b> is a left-to-right drift covering at least
                <span class="mono" id="cfg-echo-amp">12%</span> of viewport width (or at least <span class="mono" id="cfg-echo-pxf">150</span> px, whichever is larger) over
                <span class="mono" id="cfg-echo">0.7-3.0 s</span>, followed by a quick right-to-left return;
                <span class="mono" id="cfg-echo-rep">2</span> read passes flag (and deduct -5 per episode                 <span class="mono" id="cfg-echo-cd">0 s</span>, points
                <span class="mono" id="cfg-echo-pts">5</span>, low-gaze <span class="mono" id="cfg-echo-lowgaze">on</span>,
                <span class="mono" id="cfg-echo-cyc">3</span> cycles readout). The pass does not have to be a straight line - a small retrace (&lt; 90 px) is treated as a wobble and keeps the pass open. Thresholds are set in the Admin view and apply live.
                Detection works at line/region level - eye-tracker error is ~120 px, far wider than a word.
                Two modes are supported: <b>wide</b> (full-screen text / teleprompter) and <b>compact</b> (phone / small window).
                When gaze is pinned near the bottom edge with small x oscillations, a <b>READING_LOW_GAZE</b> sub-flag may fire.</p>
            </div>
          </div>

          <!-- debug panel -->
          <div class="panel" id="debug-panel">
            <div class="panel-head"><h3 class="panel-title">Debug: gaze x over time</h3><span class="panel-sub" id="plot-sub">tracking only</span></div>
            <div class="panel-body">
              <canvas class="gaze-plot" id="gaze-plot" width="900" height="190"></canvas>
              <div class="plot-legend">
                <span><i style="background:#22d3ee;"></i>x position</span>
                <span><i style="background:#34d399;"></i>read pass</span>
                <span><i style="background:#fbbf24;"></i>return sweep</span>
                <span><i style="background:#ef4444;"></i>cycle chain</span>
                <span>y axis: 0 = left edge · 1 = right edge of viewport</span>
              </div>
              <p class="text-hint">Read the test paragraph or look around naturally and watch which spans get classified. Amplitude below the expected ~120 px error is ignored.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- INTERVIEWER -->
  <section class="view" id="view-interviewer" aria-label="Interviewer">
    <header class="workspace-heading">
      <h1 class="page-title">Interview sessions</h1>
      <p class="page-lede">Invite a candidate, follow their progress, and review the saved report.</p>
    </header>
    <section class="panel create-panel" aria-labelledby="create-label">
      <div class="panel-head"><h2 class="panel-title" id="create-label">${icon('ticket')} New invitation</h2></div>
      <div class="panel-body">
      <form id="create-interview" class="interview-form">
        <label class="field"><span>Interview title</span><input id="interview-title" type="text" maxlength="120" placeholder="e.g. Frontend engineering interview" required></label>
        <button class="btn btn-primary" type="submit">Create interview</button>
      </form>
      <p class="text-hint" id="interviewer-feedback" role="status"></p>
    </div></section>
    <section class="panel" aria-labelledby="saved-label">
      <div class="panel-head"><h2 class="panel-title" id="saved-label">${icon('files')} Interviews and reports</h2><button class="btn btn-ghost" id="refresh-interviews" type="button">Refresh</button></div>
      <div class="table-scroll"><table class="data" id="interviews-table" hidden>
        <thead><tr><th>Interview</th><th>Candidate</th><th>Status</th><th>Join code / score</th><th>Actions</th></tr></thead>
        <tbody id="interviews-list"></tbody>
      </table></div>
      <p id="interviews-empty" class="list-message" role="status">Loading interviews…</p>
    </section>
    <section class="panel" id="interview-report" aria-labelledby="report-title" hidden>
      <div class="panel-head"><h3 class="panel-title" id="report-title" tabindex="-1"></h3>
        <div class="report-actions"><button class="btn" id="download-report" type="button">Download JSON</button>
          <button class="btn" id="print-report" type="button">Print / save PDF</button>
          <button class="btn btn-ghost" id="dismiss-report" type="button">Close report</button></div></div>
      <div class="panel-body" id="report-body"></div>
    </section>
    <div class="panel">
      <div class="panel-head"><h2 class="panel-title">${icon('monitor')} Live monitor</h2><span class="panel-sub count-label" id="feed-count">0 live</span></div>
      <div class="panel-body" style="padding:0;">
        <div class="table-scroll">
          <table class="data" id="feed-table" style="display:none; min-width:760px;">
            <thead><tr><th>Candidate</th><th>Session</th><th>Elapsed</th><th>Trust</th><th>Tier</th><th>Active flags</th><th>Reading cycles</th><th>Mic</th><th>Status</th></tr></thead>
            <tbody id="feed-rows"></tbody>
          </table>
        </div>
        <div class="empty-state" id="feed-empty">
          <h4>No live sessions</h4>
          <p>Sessions appear here when a candidate enables monitoring in another tab of this browser.</p>
          <button class="btn" id="btn-open-candidate" type="button">Open a candidate session</button>
        </div>
      </div>
    </div>
  </section>

  <!-- ADMIN -->
  <section class="view" id="view-admin" aria-label="Admin">
    <header class="workspace-heading">
      <h1 class="page-title">Detection settings</h1>
      <p class="page-lede">Threshold changes reach candidate tabs in this browser. Reload to restore the defaults.</p>
    </header>
    <div class="grid-2">
      <div>
        <div class="panel">
          <div class="panel-head"><h2 class="panel-title">${icon('sliders')} Detection thresholds</h2></div>
          <div class="panel-body settings-body">
            <details class="settings-group" open><summary>Reading patterns</summary>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-amp">Min pass amplitude - gaze must travel at least <span class="mono" id="amp-out">0.12</span> of screen width</label>
              <input type="range" class="range" id="cfg-amp" min="0.05" max="0.90" step="0.01" value="0.12">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-pxf">Absolute px floor - ignore sweeps smaller than <span class="mono" id="pxf-out">150</span> px (tracker error about 120 px)</label>
              <input type="number" id="cfg-pxf" min="40" max="600" step="10" value="150" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-overlap">Same-region overlap - passes in the same region if x-ranges overlap by at least <span class="mono" id="overlap-out">0.60</span></label>
              <input type="number" id="cfg-overlap" min="0.10" max="0.99" step="0.01" value="0.60" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-yband">Y-band - passes within <span class="mono" id="yband-out">0.20</span> of viewport height are same region</label>
              <input type="number" id="cfg-yband" min="0.05" max="0.50" step="0.01" value="0.20" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-pmin">Pass duration min - <span class="mono" id="pmin-out">0.7 s</span></label>
              <input type="number" id="cfg-pmin" min="0.3" max="3" step="0.1" value="0.7">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-pmax">Pass duration max - <span class="mono" id="pmax-out">3.0 s</span></label>
              <input type="number" id="cfg-pmax" min="0.5" max="8" step="0.1" value="3.0">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-passes">Required read passes - <span class="mono" id="passes-out">2</span> left-to-right sweeps flag &amp; deduct</label>
              <input type="number" id="cfg-passes" min="1" max="8" step="1" value="2">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-cyc">Required cycles - <span class="mono" id="cyc-out">2</span> pass → return → pass (readout only)</label>
              <input type="number" id="cfg-cyc" min="1" max="8" step="1" value="2">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-pts">Points per detection - deduct <span class="mono" id="pts-out">5</span> each trigger</label>
              <input type="number" id="cfg-pts" min="1" max="20" step="1" value="5" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-cd">Cooldown · <span class="mono" id="cd-out">0.0 s</span> before the next deduction</label>
              <input type="number" id="cfg-cd" min="0" max="60" step="0.5" value="0" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-win">Window length - <span class="mono" id="win-out">8.0 s</span></label>
              <input type="number" id="cfg-win" min="4" max="10" step="0.5" value="8">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-lowgaze">Low-gaze / phone sub-flag - <span class="mono" id="lowgaze-out">on</span></label>
              <input type="checkbox" id="cfg-lowgaze" style="max-width:24px;" checked>
            </div>
            </details>
            <details class="settings-group"><summary>Slow reading patterns</summary>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw">Enable sawtooth detector - <span class="mono" id="saw-out">on</span></label>
              <input type="checkbox" id="cfg-saw" style="max-width:24px;" checked>
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw-win">Sawtooth window - <span class="mono" id="saw-win-out">30.0 s</span></label>
              <input type="number" id="cfg-saw-win" min="20" max="45" step="1" value="30" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw-cyc">Sawtooth required cycles - <span class="mono" id="saw-cyc-out">3</span></label>
              <input type="number" id="cfg-saw-cyc" min="1" max="8" step="1" value="3" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw-rise-min">Sawtooth min rise duration - <span class="mono" id="saw-rise-min-out">2.0 s</span></label>
              <input type="number" id="cfg-saw-rise-min" min="1" max="10" step="0.5" value="2" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw-rise-max">Sawtooth max rise duration - <span class="mono" id="saw-rise-max-out">15.0 s</span></label>
              <input type="number" id="cfg-saw-rise-max" min="5" max="30" step="1" value="15" style="max-width:120px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-saw-ret-max">Sawtooth return max duration - <span class="mono" id="saw-ret-max-out">0.8 s</span></label>
              <input type="number" id="cfg-saw-ret-max" min="0.2" max="2" step="0.1" value="0.8" style="max-width:120px;">
            </div>
            </details>
            <details class="settings-group"><summary>Attention, face and pose signals</summary>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-tab-label">
              <span class="cfg-label" id="cfg-int-tab-label">TAB_SWITCH deduction - <span class="mono" id="int-tab-out">2</span> pts, <span class="mono" id="int-tab-db-out">5.0</span>s debounce</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-tab" min="0" max="10" step="1" value="2"></label>
              <label class="setting-value"><span>Debounce (s)</span><input type="number" id="cfg-int-tab-db" min="0" max="30" step="0.5" value="5"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-long-label">
              <span class="cfg-label" id="cfg-int-long-label">LONG_AWAY deduction - <span class="mono" id="int-longout">3</span> pts (tab hidden > <span class="mono" id="int-longth-out">10.0</span>s)</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-long" min="0" max="10" step="1" value="3"></label>
              <label class="setting-value"><span>Time away (s)</span><input type="number" id="cfg-int-longth" min="1" max="60" step="1" value="10"></label>
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-fs">FULLSCREEN_EXIT deduction - <span class="mono" id="int-fs-out">2</span> pts</label>
              <input type="number" id="cfg-int-fs" min="0" max="10" step="1" value="2" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-paste">PASTE_EVENT deduction - <span class="mono" id="int-paste-out">1</span> pts</label>
              <input type="number" id="cfg-int-paste" min="0" max="5" step="1" value="1" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-display">EXTRA_DISPLAY_DETECTED deduction - <span class="mono" id="int-display-out">5</span> pts (once/session)</label>
              <input type="number" id="cfg-int-display" min="0" max="10" step="1" value="5" style="max-width:80px;">
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-mf-label" style="border-top:1px solid var(--edge); padding-top:10px;">
              <span class="cfg-label" id="cfg-int-mf-label">MULTIPLE_FACES deduction - <span class="mono" id="int-mf-out">10</span> pts, <span class="mono" id="int-mf-cd-out">60.0</span>s cooldown</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-mf" min="0" max="20" step="1" value="10"></label>
              <label class="setting-value"><span>Cooldown (s)</span><input type="number" id="cfg-int-mf-cd" min="0" max="120" step="1" value="60"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-fa-label">
              <span class="cfg-label" id="cfg-int-fa-label">FACE_ABSENT deduction - <span class="mono" id="int-fa-out">3</span> pts, <span class="mono" id="int-fa-cd-out">5.0</span>s cooldown (absent > <span class="mono" id="int-fa-th-out">3.0</span>s)</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-fa" min="0" max="10" step="1" value="3"></label>
              <label class="setting-value"><span>Cooldown (s)</span><input type="number" id="cfg-int-fa-cd" min="0" max="30" step="0.5" value="5"></label>
              <label class="setting-value"><span>Time absent (s)</span><input type="number" id="cfg-int-fa-th" min="1" max="10" step="0.5" value="3"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-fac-label">
              <span class="cfg-label" id="cfg-int-fac-label">FACE_ABSENT cumulative - <span class="mono" id="int-fac-out">5</span> pts if absent > <span class="mono" id="int-fac-th-out">10</span>% of session</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-fac" min="0" max="10" step="1" value="5"></label>
              <label class="setting-value"><span>Session (%)</span><input type="number" id="cfg-int-fac-th" min="1" max="50" step="1" value="10"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-off-label" style="border-top:1px solid var(--edge); padding-top:10px;">
              <span class="cfg-label" id="cfg-int-off-label">SUSTAINED_OFFAXIS deduction - <span class="mono" id="int-off-out">2</span> pts, <span class="mono" id="int-off-cd-out">30.0</span>s cooldown</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-off" min="0" max="10" step="1" value="2"></label>
              <label class="setting-value"><span>Cooldown (s)</span><input type="number" id="cfg-int-off-cd" min="0" max="120" step="1" value="30"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-side-label">
              <span class="cfg-label" id="cfg-int-side-label">REPEATED_SIDE_LOOKS deduction - <span class="mono" id="int-side-out">4</span> pts, <span class="mono" id="int-side-cd-out">30.0</span>s cooldown (<span class="mono" id="int-side-th-out">4</span> looks / <span class="mono" id="int-side-win-out">60.0</span>s)</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-side" min="0" max="10" step="1" value="4"></label>
              <label class="setting-value"><span>Cooldown (s)</span><input type="number" id="cfg-int-side-cd" min="0" max="120" step="1" value="30"></label>
              <label class="setting-value"><span>Looks</span><input type="number" id="cfg-int-side-th" min="1" max="10" step="1" value="4"></label>
              <label class="setting-value"><span>Window (s)</span><input type="number" id="cfg-int-side-win" min="10" max="120" step="5" value="60"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-down-label">
              <span class="cfg-label" id="cfg-int-down-label">LOOKING_DOWN_REPEATEDLY deduction - <span class="mono" id="int-down-out">4</span> pts, <span class="mono" id="int-down-cd-out">30.0</span>s cooldown (<span class="mono" id="int-down-th-out">4</span> looks / <span class="mono" id="int-down-win-out">60.0</span>s)</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-down" min="0" max="10" step="1" value="4"></label>
              <label class="setting-value"><span>Cooldown (s)</span><input type="number" id="cfg-int-down-cd" min="0" max="120" step="1" value="30"></label>
              <label class="setting-value"><span>Looks</span><input type="number" id="cfg-int-down-th" min="1" max="10" step="1" value="4"></label>
              <label class="setting-value"><span>Window (s)</span><input type="number" id="cfg-int-down-win" min="10" max="120" step="5" value="60"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-blink-label" style="border-top:1px solid var(--edge); padding-top:10px;">
              <span class="cfg-label" id="cfg-int-blink-label">BLINK_RATE_DROP persistent - <span class="mono" id="int-blink-out">1</span> pts after <span class="mono" id="int-blink-dur-out">120.0</span>s, cap <span class="mono" id="int-blink-cap-out">5</span> pts</span>
              <label class="setting-value"><span>Points</span><input type="number" id="cfg-int-blink" min="0" max="5" step="1" value="1"></label>
              <label class="setting-value"><span>Duration (s)</span><input type="number" id="cfg-int-blink-dur" min="30" max="300" step="5" value="120"></label>
              <label class="setting-value"><span>Limit (pts)</span><input type="number" id="cfg-int-blink-cap" min="0" max="20" step="1" value="5"></label>
            </div>
            <div class="cfg-row multi-setting" role="group" aria-labelledby="cfg-int-review-label">
              <span class="cfg-label" id="cfg-int-review-label">Review threshold - flag for review when <span class="mono" id="int-review-out">3</span> categories fire in <span class="mono" id="int-review-win-out">60.0</span>s</span>
              <label class="setting-value"><span>Categories</span><input type="number" id="cfg-int-review" min="2" max="5" step="1" value="3"></label>
              <label class="setting-value"><span>Window (s)</span><input type="number" id="cfg-int-review-win" min="10" max="300" step="5" value="60"></label>
            </div>
            </details>
            <details class="settings-group"><summary>Deduction limits</summary>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-cap-att">Attention cap - max <span class="mono" id="int-cap-att-out">30</span> pts</label>
              <input type="number" id="cfg-int-cap-att" min="0" max="100" step="1" value="30" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-cap-face">Face cap - max <span class="mono" id="int-cap-face-out">30</span> pts</label>
              <input type="number" id="cfg-int-cap-face" min="0" max="100" step="1" value="30" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-cap-pose">Pose cap - max <span class="mono" id="int-cap-pose-out">30</span> pts</label>
              <input type="number" id="cfg-int-cap-pose" min="0" max="100" step="1" value="30" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-int-cap-blink">Blink cap - max <span class="mono" id="int-cap-blink-out">5</span> pts</label>
              <input type="number" id="cfg-int-cap-blink" min="0" max="20" step="1" value="5" style="max-width:80px;">
            </div>
            </details>
            <details class="settings-group"><summary>Setup quality</summary>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-sq-size-min">Face size min - <span class="mono" id="sq-size-min-out">25</span>% of frame height</label>
              <input type="number" id="cfg-sq-size-min" min="10" max="50" step="1" value="25" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-sq-size-max">Face size max - <span class="mono" id="sq-size-max-out">60</span>% of frame height</label>
              <input type="number" id="cfg-sq-size-max" min="30" max="80" step="1" value="60" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-sq-angle">Max head angle - <span class="mono" id="sq-angle-out">15</span>° yaw/pitch</label>
              <input type="number" id="cfg-sq-angle" min="5" max="45" step="1" value="15" style="max-width:80px;">
            </div>
            <div class="cfg-row">
              <label class="cfg-label" for="cfg-sq-lum-min">Min face luminance - <span class="mono" id="sq-lum-min-out">40</span> / 255</label>
              <input type="number" id="cfg-sq-lum-min" min="0" max="150" step="5" value="40" style="max-width:80px;">
            </div>
            </details>
            <p class="cfg-readout" id="cfg-readout"></p>
            <p class="text-hint">Default mode: <b>compact</b> reading (small-region) - the detector no longer assumes full-width sweeps. Lower the px floor to catch smaller sweeps but keep it above the ~120 px tracker error. The low-gaze toggle enables the READING_LOW_GAZE sub-flag when gaze is pinned near the bottom edge. <b>Sawtooth detector</b> handles slow reading (4-12s per line) with sudden return sweeps - it runs alongside the fast-pass detector and picks the one that finds more cycles.</p>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2 class="panel-title">Demo accounts</h2></div>
          <div class="panel-body" style="padding:0;">
            <div class="table-scroll"><table class="data"><thead><tr><th>Role</th><th>Username</th></tr></thead><tbody>${accountRows}</tbody></table></div>
          </div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><h2 class="panel-title">Audio analysis formula</h2><span class="panel-sub">Reference</span></div>
          <div class="panel-body">
            <pre class="formula">0.55 × AASIST
+ 0.25 × SpeakerDist
+ 0.20 × TimingFlatline</pre>
            <p class="text-hint">Proposed weighting for server-side audio models. The live monitor shows browser-based signals.</p>
            <div class="kv"><span class="k">AASIST</span><span class="v mono-dim">audio anti-spoofing score - server ML</span></div>
            <div class="kv"><span class="k">SpeakerDist</span><span class="v mono-dim">embedding distance vs enrolled voice - server ML</span></div>
            <div class="kv"><span class="k">TimingFlatline</span><span class="v mono-dim">variance collapse in response latencies - server</span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2 class="panel-title">Workspace details</h2></div>
          <div class="panel-body">
            <div class="kv"><span class="k">Accounts</span><span class="v mono-dim">Demo roles · shared interviewer account</span></div>
            <div class="kv"><span class="k">Transport</span><span class="v mono-dim">Session API · same-browser live telemetry</span></div>
            <div class="kv"><span class="k">Persistence</span><span class="v mono-dim">SQLite interview reports · in-memory thresholds</span></div>
            <div class="kv"><span class="k">Media</span><span class="v mono-dim">Never recorded or uploaded</span></div>
            <div class="kv"><span class="k">Verdicts</span><span class="v mono-dim">Advisory signals, not automated accusations</span></div>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>

<footer class="app-foot">
  <span>${icon('monitor')} Laptop or desktop recommended for gaze calibration</span>
  <a href="https://github.com/RealEye-io/webcam-eyetracker-light-open">Eye tracking by RealEye</a>
</footer>
<dialog id="privacy-dialog" aria-labelledby="privacy-title">
  <div class="dialog-head"><h2 id="privacy-title">Privacy &amp; devices</h2><form method="dialog"><button class="btn" autofocus>Close</button></form></div>
  <dl class="privacy-facts">
    <div><dt>Device access</dt><dd>Your browser asks for camera and microphone permission when you start setup. Gaze calibration works best on a laptop or desktop using HTTPS or localhost.</dd></div>
    <div><dt>Local processing</dt><dd>Your camera preview, microphone level and gaze estimates stay on your device. You can practice without joining an interview.</dd></div>
    <div><dt>Shared reports</dt><dd>Joining an invitation shares your report name, session times, calibration status, score and timestamped deductions with your interviewer for review.</dd></div>
  </dl>
</dialog>
`;
}


