import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewApi } from './interviews.mjs';

async function start() {
  const api = createInterviewApi({ filename: ':memory:', interviewerPassword: 'test-pass' });
  return { api, close: api.close };
}

test('interview session lifecycle persists checkpoints and final report', async () => {
  const app = await start();
  try {
    const login = app.api.dispatch('POST', '/access', { username: 'int.demo', password: 'test-pass' });
    const token = login.token;
    const created = app.api.dispatch('POST', '', { id: crypto.randomUUID(), title: 'Technical screen' }, token);
    const candidateKey = 'a'.repeat(64);
    const joined = app.api.dispatch('POST', '/join', { code: created.joinCode, name: 'Candidate One' }, candidateKey);
    assert.equal(joined.status, 'active');
    const snapshot = { monitoredMs: 12000, calibrated: true, reviewRequested: false,
      events: [{ atMs: 9000, code: 'TAB_SWITCH', points: 2 }] };
    const checkpoint = app.api.dispatch('POST', '/' + joined.id + '/checkpoint', { snapshot }, candidateKey);
    assert.equal(checkpoint.eventCount, 1);
    const finished = app.api.dispatch('POST', '/' + joined.id + '/finish', { snapshot }, candidateKey);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.score, 98);
    const report = app.api.dispatch('GET', '/' + joined.id, {}, token);
    assert.equal(report.snapshot.events[0].code, 'TAB_SWITCH');
  } finally {
    await app.close();
  }
});

