import { el, errorText, InterviewApiError, interviewRequest } from './interviewClient.js';
import { type Interview, type Snapshot } from './interviewReport.js';

interface Ticket {
  key: string; code: string; name: string; id?: string; pending?: Snapshot; finish?: boolean;
}
const storageKey = 'gazeline.interview.v1';
const inviteCode = () => new URLSearchParams(location.hash.slice(1)).get('join') ?? '';

export function bindCandidateInterview(options: {
  isCandidate: () => boolean;
  captureSnapshot: () => Snapshot | undefined;
  stopCapture: () => void;
}) {
  let ticket: Ticket | null = null;
  let current: Interview | null = null;
  let saving: Ticket | null = null;
  let capturing = false;
  let retryNeeded = false;
  const codeInput = el<HTMLInputElement>('join-code');
  const nameInput = el<HTMLInputElement>('join-name');
  const status = el('candidate-save-status');
  const joinForm = el<HTMLFormElement>('join-interview');

  function remember() {
    if (ticket) sessionStorage.setItem(storageKey, JSON.stringify(ticket));
    else sessionStorage.removeItem(storageKey);
  }

  function canStart() {
    return !capturing && !ticket?.finish && (ticket ? current?.status === 'active' : !codeInput.value.trim());
  }

  function draw() {
    joinForm.hidden = !!ticket || capturing;
    el('joined-interview').hidden = !current;
    el('joined-title').textContent = current?.title ?? '';
    el('joined-name').textContent = current?.candidate ?? '';
    el<HTMLButtonElement>('finish-interview').disabled = !!ticket?.finish;
    el('retry-interview').hidden = !retryNeeded;
    el<HTMLButtonElement>('btn-enable').disabled = !canStart();
    el<HTMLButtonElement>('btn-retry').disabled = !canStart();
  }

  function resetTicket() {
    ticket = null;
    current = null;
    retryNeeded = false;
    remember();
    draw();
  }

  function cacheCapture() {
    if (!ticket || !current || ticket.finish) return;
    const snapshot = options.captureSnapshot();
    if (snapshot) {
      ticket.pending = snapshot;
      // A tab reload can recover even an update that never reached the server.
      remember();
    }
  }

  async function sync(keepalive = false) {
    const t = ticket;
    if (!t || !options.isCandidate()) return;
    try {
      cacheCapture();
      if (saving === t && !keepalive) return;
      saving = t;
      const pending = t.pending;
      const finishing = !!t.finish;
      let record: Interview;
      if (!t.id) {
        record = await interviewRequest<Interview>('/join', t.key, { code: t.code, name: t.name });
      } else if (pending) {
        const action = finishing ? 'finish' : 'checkpoint';
        record = await interviewRequest<Interview>(`/${t.id}/${action}`, t.key, { snapshot: pending }, keepalive);
      } else {
        record = await interviewRequest<Interview>('/' + t.id, t.key);
      }
      if (ticket !== t || !options.isCandidate()) return;
      retryNeeded = false;
      if (record.status !== 'active') {
        options.stopCapture();
        resetTicket();
        codeInput.value = '';
        if (inviteCode()) history.replaceState(null, '', location.pathname + location.search);
        status.textContent = record.status === 'completed'
          ? 'Interview finished. Your interviewer can open the saved report.'
          : 'The interviewer closed this session. Its last saved progress is available for review.';
        draw();
        return;
      }
      t.id = record.id;
      if (t.pending === pending && !t.finish) delete t.pending;
      if (!current || record.updatedAt >= current.updatedAt) current = record;
      remember();
      status.textContent = t.finish ? 'Saving final report.' : capturing
        ? 'Progress saved at ' + new Date(record.updatedAt).toLocaleTimeString() + '.'
        : 'Interview joined. Enable your camera and microphone to start or resume monitoring.';
      // Finish may have been selected while a checkpoint was in flight.
      if (t.finish && !finishing) {
        saving = null;
        void sync();
        return;
      }
    } catch (error) {
      if (t !== ticket || !options.isCandidate()) return;
      if (error instanceof InterviewApiError && (error.status === 404 || error.status === 403 || (!t.id && error.status >= 400 && error.status < 500))) {
        options.stopCapture();
        resetTicket();
      } else if (error instanceof InterviewApiError && error.status === 409 && t.id) {
        // Concurrent tabs can diverge. Stop this writer and reload the canonical checkpoint.
        options.stopCapture();
        delete t.pending;
        delete t.finish;
        current = null;
        remember();
        retryNeeded = true;
      } else {
        retryNeeded = true;
      }
      status.textContent = errorText(error) + (t.finish && ticket ? ' Your final update is pending in this tab.' : '');
    } finally {
      if (saving === t) saving = null;
      draw();
    }
  }

  function enter() {
    current = null;
    ticket = null;
    retryNeeded = false;
    capturing = false;
    codeInput.value = inviteCode();
    nameInput.value = '';
    status.textContent = '';
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Ticket;
        if (typeof saved.code === 'string' && typeof saved.name === 'string' && /^[0-9a-f]{64}$/.test(saved.key)) ticket = saved;
      }
    } catch { /* local practice remains available */ }
    draw();
    if (ticket) { status.textContent = 'Recovering saved interview.'; void sync(); }
  }

  joinForm.onsubmit = ev => {
    ev.preventDefault();
    if (ticket || capturing) return;
    const code = codeInput.value.trim(), name = nameInput.value.trim();
    if (!code || !name) { status.textContent = 'Enter your join code and name.'; return; }
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
    ticket = { key, code, name };
    try { remember(); }
    catch { ticket = null; status.textContent = 'Enable tab storage to join and recover the interview.'; return; }
    status.textContent = 'Joining interview.';
    draw();
    void sync();
  };
  codeInput.oninput = draw;
  el('retry-interview').onclick = () => void sync();
  el('finish-interview').onclick = () => {
    if (!ticket || !current || ticket.finish) return;
    ticket.pending = options.captureSnapshot() ?? ticket.pending ?? current.snapshot;
    ticket.finish = true;
    options.stopCapture();
    status.textContent = 'Saving final report.';
    draw();
    // sync also persists the ticket on acknowledgement. Keep a retry locally before sending.
    try { remember(); } catch { /* the in-memory copy can still be submitted */ }
    void sync();
  };
  window.setInterval(() => { if (ticket && options.isCandidate()) void sync(); }, 5000);
  window.addEventListener('online', () => { if (ticket) void sync(); });
  window.addEventListener('pagehide', () => { if (ticket) void sync(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && ticket) void sync(); });
  return {
    enter, sync, canStart,
    baseline: () => current?.snapshot,
    setCapturing(value: boolean) { capturing = value; draw(); },
  };
}

