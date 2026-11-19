import { esc } from './appHtml.js';
import { el, errorText, interviewRequest } from './interviewClient.js';
import { formatDuration, type Interview, type InterviewSummary } from './interviewReport.js';

const labels = { waiting: 'Awaiting candidate', active: 'In progress', completed: 'Completed', interrupted: 'Closed early', cancelled: 'Cancelled' };
const formatDate = (value: number | null) => value === null ? '-' : new Date(value).toLocaleString();
const prettyCode = (code: string) => code.match(/.{1,4}/g)!.join('-');
const scoreText = (score: number | null) => score === null ? 'No monitoring data' : `${score} / 100`;
const button = (action: string, label: string) => `<button class="btn" type="button" data-action="${action}">${label}</button>`;

function renderRow(s: InterviewSummary) {
  const waiting = s.status === 'waiting';
  const detail = waiting ? prettyCode(s.joinCode!) : s.status === 'cancelled' ? '-' : scoreText(s.score);
  const actions = waiting ? button('invite', 'Copy invite') + button('close', 'Cancel interview')
    : s.status === 'active' ? button('report', 'View progress') + button('close', 'Close early')
    : s.status === 'cancelled' ? '' : button('report', 'Open report');
  return `<tr data-id="${esc(s.id)}"><td><strong>${esc(s.title)}</strong><br><small>${esc(formatDate(s.createdAt))}</small></td>
    <td>${esc(s.candidate ?? '-')}</td><td>${labels[s.status]}</td><td class="mono">${esc(detail)}</td>
    <td><div class="interview-row-actions">${actions}</div></td></tr>`;
}

function renderReport(s: Interview) {
  el('report-title').textContent = s.title;
  const summary = s.snapshot;
  const facts = [
    ['Candidate', s.candidate ?? '-'], ['Status', labels[s.status]], ['Score', scoreText(s.score)],
    ['Started', formatDate(s.startedAt)], ['Ended', formatDate(s.endedAt)],
    ['Time monitored', formatDuration(summary.monitoredMs)], ['Deductions', String(s.eventCount)],
    ['Gaze calibration', summary.calibrated ? 'Completed' : 'Not completed'],
    ['Last saved', formatDate(s.updatedAt)],
  ];
  if (s.startedAt && s.endedAt) facts.push(['Interview duration', formatDuration(s.endedAt - s.startedAt)]);
  let note = 'Signals are estimates for interviewer review.';
  if (s.status === 'active') note = 'This interview is in progress. Times and deductions reflect the latest saved update.';
  if (s.status === 'interrupted') note = 'The interviewer closed this session using the last saved update.';
  if (summary.reviewRequested) note += ' The monitor requested a review of signals across multiple categories.';
  const rows = summary.events.map(e => `<tr><td class="mono">${formatDuration(e.atMs)}</td>
    <td>${esc(e.code.toLowerCase().replace(/_/g, ' '))}</td><td class="mono">-${e.points}</td></tr>`).join('');
  el('report-body').innerHTML = `<dl class="report-facts">${facts.map(([key, value]) =>
    `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
    <h4>Deduction timeline</h4>${rows ? `<div class="table-scroll"><table class="data"><thead><tr><th>Time monitored</th><th>Signal</th><th>Points</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p>${summary.monitoredMs ? 'No deductions were recorded.' : 'No monitoring data was captured.'}</p>`}
    <p class="text-hint">${esc(note)}</p>`;
  el('interview-report').hidden = false;
}

function downloadReport(s: Interview) {
  const report = {
    version: 1, interviewId: s.id, title: s.title, candidate: s.candidate, status: s.status,
    createdAt: new Date(s.createdAt).toISOString(), startedAt: s.startedAt && new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt && new Date(s.endedAt).toISOString(), savedAt: new Date(s.updatedAt).toISOString(),
    score: s.score, ...s.snapshot,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `interview-${s.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bindInterviewDashboard(getToken: () => string | undefined) {
  const feedback = el('interviewer-feedback');
  let list: InterviewSummary[] = [];
  let selected: Interview | null = null;
  let selectionId: string | null = null;
  let loadVersion = 0;
  let createAttempt: { title: string; id: string } | null = null;
  let tableHtml = '';

  function reset() {
    loadVersion++;
    list = [];
    tableHtml = '';
    createAttempt = null;
    selected = null;
    selectionId = null;
    feedback.textContent = '';
    el('interview-report').hidden = true;
    el('interviews-table').hidden = true;
    el('interviews-list').replaceChildren();
    el('interviews-empty').hidden = false;
    el('interviews-empty').textContent = 'Loading interviews.';
  }

  async function showReport(id: string, focus = false) {
    const token = getToken();
    if (!token) return;
    selectionId = id;
    const report = await interviewRequest<Interview>('/' + id, token);
    if (getToken() !== token || selectionId !== id || (selected?.id === id && selected.updatedAt > report.updatedAt)) return;
    selected = report;
    renderReport(report);
    if (focus) el('report-title').focus();
  }

  async function refresh() {
    const token = getToken();
    if (!token) return;
    const version = ++loadVersion;
    try {
      const data = await interviewRequest<InterviewSummary[]>('', token);
      if (getToken() !== token || version !== loadVersion) return;
      list = data;
      const html = data.map(renderRow).join('');
      if (html !== tableHtml) { el('interviews-list').innerHTML = html; tableHtml = html; }
      el('interviews-table').hidden = data.length === 0;
      el('interviews-empty').hidden = data.length > 0;
      el('interviews-empty').textContent = 'Your first interview will appear here.';
      const current = data.find(row => row.id === selectionId);
      if (selected && current && current.updatedAt > selected.updatedAt) await showReport(current.id);
    } catch (error) {
      if (version === loadVersion && getToken() === token) {
        el('interviews-empty').hidden = false;
        el('interviews-empty').textContent = errorText(error);
      }
    }
  }

  el<HTMLFormElement>('create-interview').onsubmit = async ev => {
    ev.preventDefault();
    const input = el<HTMLInputElement>('interview-title');
    const submit = el('create-interview').querySelector('button')!;
    const title = input.value.trim();
    const token = getToken();
    if (!title || !token || submit.disabled) return;
    submit.disabled = true;
    try {
      if (createAttempt?.title !== title) createAttempt = { title, id: crypto.randomUUID() };
      const created = await interviewRequest<Interview>('', token, createAttempt);
      if (getToken() !== token) return;
      createAttempt = null;
      input.value = '';
      feedback.textContent = `Interview created. Share join code ${prettyCode(created.joinCode!)} with the candidate.`;
      await refresh();
    } catch (error) { if (token === getToken()) feedback.textContent = errorText(error); }
    finally { submit.disabled = false; }
  };

  el('interviews-list').onclick = async ev => {
    const target = (ev.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const s = target && list.find(r => r.id === target.closest('tr')?.dataset.id);
    const token = getToken();
    if (!s || !target || !token) return;
    try {
      if (target.dataset.action === 'report') { await showReport(s.id, true); return; }
      if (target.dataset.action === 'invite' && s.joinCode) {
        const link = new URL(location.pathname, location.origin);
        link.hash = 'join=' + s.joinCode;
        try { await navigator.clipboard.writeText(link.href); feedback.textContent = 'Invitation link copied.'; }
        catch { feedback.textContent = 'Invitation link � ' + link.href; }
        return;
      }
      const message = s.status === 'waiting' ? 'Cancel this invitation?' : 'Close this interview early and keep its last saved progress?';
      if (!window.confirm(message)) return;
      target.disabled = true;
      await interviewRequest('/' + s.id + '/close', token, {});
      if (token !== getToken()) return;
      feedback.textContent = s.status === 'waiting' ? 'Invitation cancelled.' : 'Interview closed. Its report is ready.';
      await refresh();
    } catch (error) { if (token === getToken()) feedback.textContent = errorText(error); }
    finally { target.disabled = false; }
  };
  el('download-report').onclick = () => { if (selected) downloadReport(selected); };
  el('print-report').onclick = () => window.print();
  el('dismiss-report').onclick = () => { selected = null; selectionId = null; el('interview-report').hidden = true; };
  el('refresh-interviews').onclick = () => void refresh();
  window.setInterval(() => { if (getToken() && !document.hidden) void refresh(); }, 5000);
  return { refresh, reset };
}

