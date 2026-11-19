import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeAudioFeatures } from './audioAnalysis.mjs';

const base = '/api/interviews';
const authBase = '/api/auth';
const emptySnapshot = { monitoredMs: 0, calibrated: false, reviewRequested: false, events: [] };
const eventCodes = new Set([
  'READING_DETECTED', 'TAB_SWITCH', 'LONG_AWAY', 'FULLSCREEN_EXIT', 'PASTE_EVENT',
  'EXTRA_DISPLAY_DETECTED', 'MULTIPLE_FACES', 'FACE_ABSENT', 'LOOKING_DOWN_FACE_LOST',
  'FACE_ABSENT_CUMULATIVE', 'SUSTAINED_OFFAXIS', 'REPEATED_SIDE_LOOKS',
  'LOOKING_DOWN_REPEATEDLY', 'BLINK_RATE_DROP_PERSISTENT',
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireValue(condition, status, message) {
  if (!condition) throw new ApiError(status, message);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const passwordHash = (value, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(value, salt, 32).toString('hex')}`;
function passwordMatches(value, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(value, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function shortText(value, limit, label) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit,
    400, `Enter a ${label} of up to ${limit} characters.`);
  return value.trim();
}

async function readJson(req) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Send a JSON request.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    requireValue(length <= 128 * 1024, 413, 'This update is too large.');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* validated below */ }
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 400, 'Invalid JSON object.');
  return data;
}

// Only this projection reaches disk. Detector details, sensor samples and free-form
// client event text are deliberately outside the report format.
function parseSnapshot(data) {
  requireValue(data && Number.isSafeInteger(data.monitoredMs) && data.monitoredMs >= 0 &&
    typeof data.calibrated === 'boolean' && typeof data.reviewRequested === 'boolean' &&
    Array.isArray(data.events) && data.events.length <= 1000, 400, 'Invalid monitoring summary.');
  let lastOffset = 0;
  const events = data.events.map((e) => {
    requireValue(e && eventCodes.has(e.code) && Number.isSafeInteger(e.atMs) &&
      e.atMs >= lastOffset && e.atMs <= data.monitoredMs &&
      Number.isFinite(e.points) && e.points > 0 && e.points <= 100, 400, 'Invalid timeline event.');
    lastOffset = e.atMs;
    return { atMs: e.atMs, code: e.code, points: e.points };
  });
  return { monitoredMs: data.monitoredMs, calibrated: data.calibrated, reviewRequested: data.reviewRequested, events };
}

function snapshotExtends(next, previous) {
  return next.monitoredMs >= previous.monitoredMs && (!previous.calibrated || next.calibrated) &&
    (!previous.reviewRequested || next.reviewRequested) && next.events.length >= previous.events.length &&
    previous.events.every((e, i) => {
      const n = next.events[i];
      return n.code === e.code && n.points === e.points && n.atMs === e.atMs;
    });
}

function present(row, detail = true) {
  const snapshot = JSON.parse(row.snapshot);
  const score = snapshot.monitoredMs > 0 ? Math.max(0, 100 - snapshot.events.reduce((n, e) => n + e.points, 0)) : null;
  return {
    id: row.id, title: row.title, status: row.status,
    joinCode: row.status === 'waiting' ? row.join_code : null, candidate: row.candidate,
    createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, updatedAt: row.updated_at,
    score, eventCount: snapshot.events.length, ...(detail ? { snapshot } : {}),
  };
}

export function createInterviewApi({ filename, interviewerPassword = process.env.GAZELINE_INTERVIEWER_PASSWORD }) {
  if (!interviewerPassword) throw new Error('GAZELINE_INTERVIEWER_PASSWORD must be configured.');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE, candidate TEXT,
      writer_hash TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
      ended_at INTEGER, updated_at INTEGER NOT NULL, snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS interviews_by_creation ON interviews(created_at DESC);
    CREATE TABLE IF NOT EXISTS interviewer_access (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, category TEXT NOT NULL, time_limit_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_questions (interview_id TEXT NOT NULL, question_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(interview_id, question_id));
    CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL, question_id TEXT, candidate TEXT, answer_text TEXT, audio_path TEXT, timing_ms INTEGER, analysis TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consent_events (id TEXT PRIMARY KEY, interview_id TEXT, candidate TEXT, camera INTEGER NOT NULL, microphone INTEGER NOT NULL, recording INTEGER NOT NULL, policy_version TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const byId = db.prepare('SELECT * FROM interviews WHERE id = ?');
  const hostAccess = db.prepare('SELECT 1 FROM interviewer_access WHERE token_hash = ? AND expires_at > ?');
  const sessionUser = db.prepare('SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?');
  const seed = (username, password, role) => {
    if (password && !db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(randomBytes(16).toString('hex'), username, passwordHash(password), role, Date.now());
    }
  };
  seed('int.demo', interviewerPassword, 'interviewer');
  seed('cand.demo', process.env.GAZELINE_CANDIDATE_PASSWORD, 'candidate');
  seed('admin.demo', process.env.GAZELINE_ADMIN_PASSWORD, 'admin');
  // Each read/check/write uses one transaction, including when two Node processes share the file.
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function dispatch(method, path, body, token) {
    const now = Date.now();
    const hash = token ? digest(token) : '';
    const host = () => requireValue(hash && hostAccess.get(hash, now), 401, 'Sign in as the interviewer to access saved interviews.');
    const user = () => {
      const row = sessionUser.get(hash, now);
      requireValue(row, 401, 'Your account session has expired. Sign in again.');
      return row;
    };
    if (path === '/login' && method === 'POST') {
      const account = db.prepare('SELECT * FROM users WHERE username=?').get(shortText(body.username, 80, 'username'));
      requireValue(account && passwordMatches(String(body.password || ''), account.password_hash), 401, 'Check your username and password.');
      const access = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO user_sessions VALUES (?,?,?)').run(digest(access), account.id, now + 7 * 86400000);
      return { token: access, user: { id: account.id, username: account.username, role: account.role } };
    }
    if (path === '/session' && method === 'GET') return user() && { username: user().username, role: user().role };
    if (path === '/logout' && method === 'POST') { db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(hash); return {}; }
    if (path === '/questions' && method === 'GET') { user(); return db.prepare('SELECT * FROM questions ORDER BY created_at DESC').all(); }
    if (path === '/questions' && method === 'POST') {
      const account = user(); requireValue(account.role === 'interviewer' || account.role === 'admin', 403, 'Interviewer access required.');
      const q = { id: randomBytes(16).toString('hex'), prompt: shortText(body.prompt, 2000, 'question'), category: shortText(body.category || 'general', 80, 'category'), time_limit_seconds: Math.min(3600, Math.max(10, Number(body.timeLimitSeconds) || 120)) };
      db.prepare('INSERT INTO questions VALUES (?,?,?,?,?)').run(q.id, q.prompt, q.category, q.time_limit_seconds, now); return q;
    }
    if (path === '/audio/analyze' && method === 'POST') { user(); return analyzeAudioFeatures(body); }
    const answerMatch = /^\/([0-9a-f-]{36})\/answers$/.exec(path);
    if (answerMatch && method === 'POST') {
      const account = user(); requireValue(account.role === 'candidate', 403, 'Candidate access required.');
      const answer = { id: randomBytes(16).toString('hex'), interview_id: answerMatch[1], question_id: body.questionId || null, candidate: shortText(body.candidate || account.username, 80, 'candidate name'), answer_text: typeof body.answerText === 'string' ? body.answerText.slice(0, 12000) : '', audio_path: null, timing_ms: Number.isSafeInteger(body.timingMs) ? body.timingMs : null, analysis: JSON.stringify(body.analysis || { status: 'pending' }), created_at: now };
      db.prepare('INSERT INTO answers VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(answer)); return answer;
    }
    const consentMatch = /^\/([0-9a-f-]{36})\/consent$/.exec(path);
    if (consentMatch && method === 'POST') {
      const account = user(); requireValue(account.role === 'candidate', 403, 'Candidate access required.');
      const consent = { id: randomBytes(16).toString('hex'), interview_id: consentMatch[1], candidate: account.username, camera: body.camera === true ? 1 : 0, microphone: body.microphone === true ? 1 : 0, recording: body.recording === true ? 1 : 0, policy_version: shortText(body.policyVersion || '2026-01', 40, 'policy version'), created_at: now };
      db.prepare('INSERT INTO consent_events VALUES (?,?,?,?,?,?,?)').run(...Object.values(consent)); return consent;
    }
    const reportMatch = /^\/([0-9a-f-]{36})\/report$/.exec(path);
    if (reportMatch && method === 'GET') { host(); const interview = byId.get(reportMatch[1]); requireValue(interview, 404, 'Interview not found.'); return { interview: present(interview), questions: db.prepare('SELECT q.*, iq.position FROM questions q JOIN interview_questions iq ON iq.question_id=q.id WHERE iq.interview_id=? ORDER BY iq.position').all(reportMatch[1]), answers: db.prepare('SELECT * FROM answers WHERE interview_id=? ORDER BY created_at').all(reportMatch[1]), consents: db.prepare('SELECT * FROM consent_events WHERE interview_id=? ORDER BY created_at').all(reportMatch[1]) }; }
    if (path === '/access' && method === 'POST') {
      requireValue(body.username === 'int.demo' && body.password === interviewerPassword, 401, 'Check the interviewer username and password.');
      const access = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM interviewer_access WHERE expires_at <= ?').run(now);
      db.prepare('INSERT INTO interviewer_access VALUES (?, ?)').run(digest(access), now + 7 * 86400000);
      return { token: access };
    }
    if (path === '/access' && method === 'DELETE') {
      db.prepare('DELETE FROM interviewer_access WHERE token_hash = ?').run(hash);
      return {};
    }
    if (path === '' && method === 'GET') {
      host();
      return db.prepare('SELECT * FROM interviews ORDER BY created_at DESC, id').all().map((row) => present(row, false));
    }
    if (path === '' && method === 'POST') {
      host();
      const title = shortText(body.title, 120, 'title');
      requireValue(typeof body.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.id), 400, 'Invalid interview ID.');
      const existing = byId.get(body.id);
      if (existing) {
        requireValue(existing.title === title, 409, 'This interview ID is already in use.');
        return present(existing);
      }
      let code;
      do { code = randomBytes(6).toString('hex').toUpperCase(); }
      while (db.prepare('SELECT 1 FROM interviews WHERE join_code = ?').get(code));
      db.prepare(`INSERT INTO interviews (id,title,join_code,status,created_at,updated_at,snapshot)
        VALUES (?,?,?,'waiting',?,?,?)`).run(body.id, title, code, now, now, JSON.stringify(emptySnapshot));
      return present(byId.get(body.id));
    }
    if (method === 'POST' && path === '/join') {
      requireValue(hash, 401, 'A candidate session key is required.');
      const code = shortText(body.code, 24, 'join code').replace(/[\s-]/g, '').toUpperCase();
      const name = shortText(body.name, 80, 'candidate name');
      const row = db.prepare('SELECT * FROM interviews WHERE join_code = ?').get(code);
      requireValue(row, 404, 'This join code was not found.');
      if (row.writer_hash === hash) return present(row); // retry after a lost response
      requireValue(row.status === 'waiting', 409, 'This interview has already been joined or closed.');
      db.prepare("UPDATE interviews SET status='active', candidate=?, writer_hash=?, started_at=?, updated_at=? WHERE id=?")
        .run(name, hash, now, now, row.id);
      return present(byId.get(row.id));
    }
    const match = /^\/([0-9a-f-]{36})(?:\/(checkpoint|finish|close))?$/.exec(path);
    requireValue(match, 404, 'Unknown interviews endpoint.');
    const [, id, action] = match;
    const row = byId.get(id);
    requireValue(row, 404, 'Interview not found.');
    if (!action && method === 'GET') {
      if (!hash || row.writer_hash !== hash) host();
      return present(row);
    }
    if (action === 'close' && method === 'POST') {
      host();
      if (row.status === 'active' || row.status === 'waiting') {
        db.prepare('UPDATE interviews SET status=?, ended_at=?, updated_at=? WHERE id=?')
          .run(row.status === 'waiting' ? 'cancelled' : 'interrupted', now, now, id);
      }
      return present(byId.get(id));
    }
    requireValue(method === 'POST' && (action === 'checkpoint' || action === 'finish'), 405, 'Unsupported operation.');
    requireValue(hash && row.writer_hash === hash, 403, 'This candidate session cannot update the interview.');
    if (row.status !== 'active') return present(row); // final reports are immutable, retries return their result
    const previous = JSON.parse(row.snapshot);
    const incoming = parseSnapshot(body.snapshot);
    const newer = snapshotExtends(incoming, previous);
    requireValue(newer || snapshotExtends(previous, incoming), 409, 'Another tab has saved a different timeline. Reload to recover it.');
    const snapshot = newer ? incoming : previous;
    const finished = action === 'finish';
    db.prepare('UPDATE interviews SET snapshot=?, status=?, ended_at=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(snapshot), finished ? 'completed' : 'active', finished ? now : null, now, id);
    return present(byId.get(id));
  }

  async function middleware(req, res, next) {
    const pathname = (req.url || '/').split('?')[0];
    const apiBase = pathname === base || pathname.startsWith(base + '/') ? base :
      (pathname === authBase || pathname.startsWith(authBase + '/') ? authBase : null);
    if (!apiBase) return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.headers.origin) {
        requireValue(new URL(req.headers.origin).host === req.headers.host, 403, 'Use the same origin as the app.');
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const method = req.method;
      const body = method === 'POST' ? await readJson(req) : {};
      const run = () => dispatch(method, pathname.slice(apiBase.length), body, token);
      const result = method === 'GET' ? run() : transaction(run);
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof ApiError ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof ApiError ? error.message : 'Could not access the interview database.' }));
    }
  }
  return { middleware, dispatch, close: () => db.close() };
}

export function interviewApiPlugin() {
  function install(server) {
    const filename = resolve(process.env.GAZELINE_DB_PATH || '.gazeline/interviews.sqlite');
    const api = createInterviewApi({ filename });
    server.middlewares.use(api.middleware);
    server.httpServer?.once('close', api.close);
  }
  return { name: 'gazeline-interviews', configureServer: install, configurePreviewServer: install };
}

