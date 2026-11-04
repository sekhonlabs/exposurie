// Tests for the conversation that is still happening.
//
// THE BUG THESE PIN. exposurie runs inside a coding agent session, and that
// session writes its transcript into the directory exposurie reads. So on a
// real machine draining 165 Codex sessions, batch after batch came back as
// "mostly expected duplication from the active setup task and its parallel
// analysis sessions". The tool was reading its own operation, the subagents it
// spawned multiplied it, and it got worse the more thoroughly the user did what
// the tool asked. It cost quota and it put setup chatter in the brain.
//
// The rule is broader than the bug and that is deliberate: do not read a
// conversation that is still being had. Half a conversation loses the half that
// explains why, and nothing here needs a per-client special case to hold.
//
// DEFERRED, NEVER DROPPED — so the last test is that nothing goes missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { stillBeingWritten, liveSessionIds, IN_FLIGHT_MS } from '../src/extract/live.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

const NOW = 1_800_000_000_000;
const local = (path, ageMs) => ({ path, local: true, sortAt: NOW - ageMs });

// ------------------------------------------------------------------- the unit
test('the session running exposurie is named by its client and held back', () => {
  // Verified on a real machine: Claude Code sets CLAUDE_CODE_SESSION_ID and its
  // transcript is <that id>.jsonl. Backdated an hour here, so it is the ID
  // doing the work and not the clock.
  const env = { CLAUDE_CODE_SESSION_ID: '7c091435-cafa-45bc-b928-d1d4193c38e4' };
  const cand = local('/p/7c091435-cafa-45bc-b928-d1d4193c38e4.jsonl', 3600_000);
  assert.match(stillBeingWritten(cand, { now: NOW, env }), /this session/);
});

test('a transcript still being appended to is held back, whatever it is called', () => {
  // This is what covers Codex, Cursor, subagents, and any client we have not
  // met — none of which tell us a session id.
  assert.equal(stillBeingWritten(local('/p/rollout-x.jsonl', 5_000), { now: NOW, env: {} }), 'still being written');
  assert.equal(stillBeingWritten(local('/p/anon.jsonl', IN_FLIGHT_MS - 1), { now: NOW, env: {} }), 'still being written');
});

test('a conversation that has ended is ordinary material', () => {
  assert.equal(stillBeingWritten(local('/p/a.jsonl', IN_FLIGHT_MS + 1), { now: NOW, env: {} }), null);
  assert.equal(stillBeingWritten(local('/p/a.jsonl', 86_400_000), { now: NOW, env: {} }), null);
});

test('a chat out of an export is never in flight — it finished elsewhere', () => {
  const fromExport = { path: 'chat-1', local: false, sortAt: NOW };
  assert.equal(stillBeingWritten(fromExport, { now: NOW, env: {} }), null);
});

test('an unconfirmed client contributes no id rather than a guessed one', () => {
  // A guessed variable name produces a filter that matches nothing while
  // looking like protection — the shape of bug this codebase keeps finding.
  assert.deepEqual(liveSessionIds({}), []);
  assert.deepEqual(liveSessionIds({ CODEX_SESSION_ID: 'x' }), []);
  assert.deepEqual(liveSessionIds({ CLAUDE_CODE_SESSION_ID: 'abc' }), ['abc']);
});

test('a reason is returned, not a boolean, because a deferral gets said out loud', () => {
  const why = stillBeingWritten(local('/p/a.jsonl', 1_000), { now: NOW, env: {} });
  assert.equal(typeof why, 'string');
  assert.ok(why.length > 5);
});

// -------------------------------------------------------------- end to end
const t = (n) => new Date(Date.UTC(2026, 7, 25, 10, n)).toISOString();
const line = (role, text) => ({
  type: role === 'user' ? 'user' : 'assistant',
  cwd: 'C:/work/thing',
  sessionId: 's1',
  timestamp: t(1),
  message: { role, content: [{ type: 'text', text }] },
});

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-live-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  return h;
}

function run(h, args, extraEnv = {}) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), ...extraEnv } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function transcript(h, name, texts) {
  const dir = join(h, '.claude', 'projects', 'thing');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(
    p,
    texts.map((x, i) => JSON.stringify(line(i % 2 ? 'assistant' : 'user', x))).join('\n') + '\n',
    'utf8',
  );
  return p;
}

const settle = (p) => {
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  return p;
};

function stagedText(h) {
  const d = join(h, 'brain', '.exposurie', 'staged');
  if (!existsSync(d)) return null;
  const dirs = readdirSync(d).sort();
  if (!dirs.length) return null;
  const f = join(d, dirs[dirs.length - 1], 'conversations.md');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

test('REGRESSION: a sync does not read the conversation it is running inside', () => {
  const h = home();
  run(h, ['scaffold']);
  // Freshly written: this is the session happening right now.
  transcript(h, 'live-one', ['LIVE-SETUP-CHATTER', 'ok']);

  const r = run(h, ['sync']);
  assert.match(r.out, /still going|Nothing finished/, 'the deferral was never mentioned');
  assert.ok(
    !(stagedText(h) || '').includes('LIVE-SETUP-CHATTER'),
    'the tool staged the conversation that was still happening',
  );
});

test('the same conversation is staged once it has ended — deferred, not dropped', () => {
  const h = home();
  run(h, ['scaffold']);
  const p = transcript(h, 'live-two', ['REAL-DECISION-TEXT', 'ok']);
  run(h, ['sync']);

  settle(p);
  run(h, ['sync']);
  assert.match(stagedText(h) || '', /REAL-DECISION-TEXT/, 'material was lost rather than deferred');
});

test('the live session is held even when its file looks old, by id', () => {
  const h = home();
  run(h, ['scaffold']);
  const p = settle(transcript(h, 'abc-123', ['ID-MATCHED-CHATTER', 'ok']));
  assert.ok(p);

  const r = run(h, ['sync'], { CLAUDE_CODE_SESSION_ID: 'abc-123' });
  assert.ok(
    !(stagedText(h) || '').includes('ID-MATCHED-CHATTER'),
    'the running session was staged despite the client naming it',
  );
  assert.match(r.out, /still going|Nothing finished/);
});

test('a deferral is never silent — the manifest says what was held and why', () => {
  const h = home();
  run(h, ['scaffold']);
  settle(transcript(h, 'done', ['FINISHED-WORK', 'ok']));
  transcript(h, 'ongoing', ['STILL-TALKING', 'ok']);

  const r = run(h, ['sync']);
  assert.match(r.out, /still going/, 'the summary hid a deferral');

  const dirs = readdirSync(join(h, 'brain', '.exposurie', 'staged')).sort();
  const manifest = readFileSync(join(h, 'brain', '.exposurie', 'staged', dirs.at(-1), 'MANIFEST.md'), 'utf8');
  assert.match(manifest, /Still going/, 'the manifest never named the held conversation');
  assert.match(manifest, /ongoing\.jsonl/, 'the held file was not named');
  assert.match(stagedText(h) || '', /FINISHED-WORK/, 'the finished conversation should still be staged');
});
