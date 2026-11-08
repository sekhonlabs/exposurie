// Tests for sync — the half of the product that decides what a brain is made of.
//
// The fixtures here are synthetic but shaped from a real 128 MB corpus: the
// line types, the roles, and above all the four ways text arrives wearing a
// `user` role that no person typed. Getting that wrong does not crash anything.
// It quietly builds someone a brain out of directory listings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-sync-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  return h;
}

function run(h, args, { nodeArgs = [], env = {} } = {}) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), ...env } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [...nodeArgs, BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const t = (n) => new Date(Date.UTC(2026, 7, 20, 10, n)).toISOString();

const user = (text, extra = {}) => ({
  type: 'user', cwd: 'C:/work/thing', sessionId: 's1', timestamp: t(1),
  message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
});
const agent = (text) => ({
  type: 'assistant', cwd: 'C:/work/thing', sessionId: 's1', timestamp: t(2),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** Write a transcript into a fake client tree. */
function transcript(h, project, name, lines) {
  const dir = join(h, '.claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return settled(p);
}

/**
 * Backdate a fixture's mtime so it models a conversation that has ENDED.
 *
 * sync defers anything still being written — the session running the command,
 * the subagents it spawned, a half-flushed transcript — because reading half a
 * conversation loses the half that explains why. A fixture written and synced
 * in the same millisecond is, correctly, one of those.
 *
 * So this is not a workaround for the gate. It is what makes the fixture mean
 * what the test says it means: a conversation somebody already finished.
 */
function settled(p) {
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  return p;
}

const staged = (h, file = 'conversations.md') => {
  const d = join(h, 'brain', '.exposurie', 'staged');
  if (!existsSync(d)) return null;
  const dirs = readdirSync(d).sort();
  if (!dirs.length) return null;
  return readFileSync(join(d, dirs[dirs.length - 1], file), 'utf8');
};

// ------------------------------------------------------------ the whole point
test('text wearing a user role that no person typed never reaches the brain', () => {
  // Measured on a real corpus: injected context outweighed the human's own
  // words 9 to 1 — 1.50 MB against 0.17 MB. A reader that trusts role:"user"
  // builds a brain mostly out of environment blocks and harness boilerplate,
  // and it looks like it is working the whole time.
  const h = home();
  transcript(h, 'thing', 'a', [
    { type: 'mode', mode: 'default' },
    user('INJECTED-BASE-DIRECTORY-LISTING', { isMeta: true }),
    user('<command-name>/clear</command-name>'),
    user('[Request interrupted by user]'),
    user('SUBAGENT-CHATTER', { isSidechain: true }),
    {
      type: 'user', cwd: 'C:/work/thing', sessionId: 's1', timestamp: t(3),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL-OUTPUT-BLOB' }] },
    },
    user('REAL-THING-I-TYPED: use postgres, mysql lost us a week in June'),
    {
      type: 'assistant', cwd: 'C:/work/thing', sessionId: 's1', timestamp: t(4),
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'PRIVATE-REASONING' },
          { type: 'tool_use', name: 'Read', input: { file: 'TOOL-CALL-DETAIL' } },
          { type: 'text', text: 'REAL-REPLY: agreed, postgres.' },
        ],
      },
    },
  ]);

  run(h, ['scaffold']);
  run(h, ['sync']);
  const out = staged(h);
  assert.ok(out, 'nothing was staged');

  assert.match(out, /REAL-THING-I-TYPED/);
  assert.match(out, /REAL-REPLY/);
  for (const impostor of [
    'INJECTED-BASE-DIRECTORY-LISTING',
    'command-name',
    'Request interrupted',
    'SUBAGENT-CHATTER',
    'TOOL-OUTPUT-BLOB',
    'PRIVATE-REASONING',
    'TOOL-CALL-DETAIL',
  ]) {
    assert.ok(!out.includes(impostor), `"${impostor}" reached the brain`);
  }
});

test('promptSource is not used to decide who typed something', () => {
  // It looks like the perfect signal and is not: on a real corpus only 65 of
  // 800 human turns carried "typed", because the desktop app routes prompts
  // through the SDK path. Trusting it would discard most of a person's life.
  const h = home();
  transcript(h, 'thing', 'a', [
    user('TYPED-ON-DESKTOP', { promptSource: 'sdk', entrypoint: 'claude-desktop' }),
    agent('ok'),
  ]);
  run(h, ['scaffold']);
  run(h, ['sync']);
  assert.match(staged(h), /TYPED-ON-DESKTOP/);
});

// ------------------------------------------------------------------- the gate
test('an excluded conversation is never loaded, not merely dropped later', () => {
  // Exclusion after the read is an apology, not a control: the quota is spent
  // and the material under NDA has already been opened.
  const h = home();
  transcript(h, 'secret', 'a', [user('CLIENT-CONFIDENTIAL'), agent('understood')]);
  transcript(h, 'ok', 'b', [user('ORDINARY-WORK'), agent('sure')]);

  run(h, ['scaffold']);
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.excludeConversations = ['*secret*'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  // the excluded session must be identifiable by its folder, not its content
  const p = join(h, '.claude', 'projects', 'secret', 'a.jsonl');
  writeFileSync(
    p,
    [user('CLIENT-CONFIDENTIAL', { cwd: 'C:/clients/secret-co' }), agent('understood')]
      .map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
  settled(p);

  const r = run(h, ['sync']);
  const out = staged(h);
  assert.ok(!out.includes('CLIENT-CONFIDENTIAL'), 'excluded content was staged');
  assert.match(out, /ORDINARY-WORK/);
  assert.match(r.out, /excluded/);
});

// ------------------------------------------------------------ the gate, Codex
//
// A Codex rollout names its folder in a payload, not on every line, and the
// line that names it is big: base_instructions and dynamic_tools put a real
// session_meta at 14–34 KB. These drive the real CLI against a synthetic home
// and record its reads, because what is under test is what gets OPENED —
// staging alone would also pass if exclusion happened after a read.

const ALLOWED = 'C:/work/thing';
const SECRET = 'C:/clients/secret-co';

/** A home with a Codex sessions folder and the install scaffold requires. */
function codexHome() {
  const h = home();
  // Model the permanent install without relying on the developer's PATH.
  const bin = join(h, 'bin');
  mkdirSync(bin);
  for (const name of ['exposurie', 'exposurie.cmd']) writeFileSync(join(bin, name), '');
  const searchPath = [bin, process.env.PATH || process.env.Path || ''].join(delimiter);
  const env = { PATH: searchPath, Path: searchPath };
  const dir = join(h, '.codex', 'sessions', '2026', '08', '25');
  mkdirSync(dir, { recursive: true });
  return { h, env, dir };
}

function rollout(file, lines) {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return settled(file);
}

const said = (text) => ({
  type: 'response_item', timestamp: t(1),
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

/** Scaffold, checked, so a scaffold failure is not reported as a missing config. */
function scaffoldExcluding(h, env, patterns) {
  const s = run(h, ['scaffold'], { env });
  // exit 10 is a pending HUMAN step, which the contract says is not a failure.
  assert.ok(s.code === 0 || s.code === 10, `scaffold exited ${s.code}\n${s.out}`);
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.excludeConversations = patterns;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * `sync --json`, recording every read of the watched files.
 *
 * Observes the actual CLI's I/O, including ESM's named fs imports. Each test
 * also asserts the allowed rollout's full read, which proves the observer is
 * active, rather than making a missing log look like a successful privacy gate.
 */
function observedSync(h, env, watched) {
  const log = join(h, 'reads.jsonl');
  const preload = join(h, 'observe-reads.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const { syncBuiltinESMExports } = require('node:module');
    const watched = new Map(${JSON.stringify(watched)}.map((path) => [fs.realpathSync(path), path]));
    const record = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
    const readFile = fs.readFileSync;
    fs.readFileSync = function (path, ...args) {
      if (watched.has(String(path))) record({ path: watched.get(String(path)), kind: 'full' });
      return readFile.call(this, path, ...args);
    };
    const handles = new Map();
    const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
    fs.openSync = function (path, ...args) {
      const fd = open.call(this, path, ...args);
      if (watched.has(String(path))) handles.set(fd, watched.get(String(path)));
      return fd;
    };
    fs.readSync = function (fd, buffer, offset, length, position) {
      const bytes = read.call(this, fd, buffer, offset, length, position);
      if (handles.has(fd)) record({ path: handles.get(fd), kind: 'peek', bytes, position });
      return bytes;
    };
    fs.closeSync = function (fd) {
      handles.delete(fd);
      return close.call(this, fd);
    };
    syncBuiltinESMExports();
  `, 'utf8');

  const r = run(h, ['sync', '--json'], { env, nodeArgs: ['--require', preload] });
  assert.equal(r.code, 0, r.out);
  const reads = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { summary: JSON.parse(r.out), reads };
}

/** The rollout got the bounded metadata peek and nothing else. */
function assertPeekOnly(reads, file) {
  const mine = reads.filter((entry) => entry.path === file);
  assert.ok(mine.length > 0, 'the metadata peek was not observed');
  assert.ok(mine.every((entry) => entry.kind === 'peek'), 'the rollout was loaded in full');
  // A null position reads on from wherever the last read stopped, so without
  // this a peek could take the whole file in 64 KB chunks and pass the bound.
  assert.ok(mine.every((entry) => Number.isInteger(entry.position)), 'a read of the rollout had no fixed position');
  assert.ok(mine.every((entry) => entry.position >= 0 && entry.position + entry.bytes <= 65536),
    'the rollout was read beyond the bounded metadata peek');
}

const fullyRead = (reads, file) => reads.some((entry) => entry.path === file && entry.kind === 'full');

for (const metadata of ['session_meta', 'turn_context']) {
  test(`Codex exclusion reads ${metadata} cwd before loading a rollout`, () => {
    const { h, env, dir } = codexHome();
    const secret = rollout(join(dir, 'rollout-secret.jsonl'), [
      // An unrelated payload's cwd is not session identity, nor is the first
      // line necessarily the one that identifies the session.
      { type: 'event_msg', payload: { cwd: ALLOWED } },
      { type: 'session_meta', payload: { id: 'secret' } },
      { type: metadata, payload: { cwd: SECRET } },
      // Keep the conversation beyond the bounded 64 KB metadata peek. A test
      // of staging alone would also pass if exclusion happened after a read.
      { type: 'event_msg', payload: { padding: 'x'.repeat(65536) } },
      said('CLIENT-CONFIDENTIAL'),
    ]);
    const ordinary = rollout(join(dir, 'rollout-ordinary.jsonl'), [
      { type: 'event_msg', payload: { cwd: SECRET } },
      { type: 'session_meta', payload: { id: 'ordinary', cwd: ALLOWED } },
      said('ORDINARY-CODEX-WORK'),
    ]);
    scaffoldExcluding(h, env, ['*secret*']);

    const { summary, reads } = observedSync(h, env, [secret, ordinary]);
    assert.equal(summary.excluded, 1, 'Codex cwd did not reach the exclusion gate');
    assert.equal(summary.staged, 1, 'the allowed rollout was not staged');
    assertPeekOnly(reads, secret);
    assert.ok(fullyRead(reads, ordinary), 'the reader was not observed');
    const out = staged(h);
    assert.match(out, /ORDINARY-CODEX-WORK/);
    assert.ok(!out.includes('CLIENT-CONFIDENTIAL'), 'excluded Codex content was staged');
  });
}

// A session_meta carrying more tools passes 64 KB, and cut at the boundary it
// no longer parses; the turn_context that also names the folder sits after it,
// out of reach. Codex writes `cwd` before the big fields, so the part of the
// line that fits still names it.
for (const layout of ['on line 1', 'after another line']) {
  test(`Codex exclusion reads cwd from a session_meta line too big for the peek, ${layout}`, () => {
    const { h, env, dir } = codexHome();
    const meta = {
      timestamp: t(0),
      type: 'session_meta',
      payload: {
        id: 'secret', timestamp: t(0), cwd: SECRET, originator: 'codex_cli_rs', cli_version: '0.154.0',
        base_instructions: { text: 'x'.repeat(70000) },
      },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(meta)) > 65536, 'the session_meta fixture fits in the peek');
    const secret = rollout(join(dir, 'rollout-secret.jsonl'), [
      // Not on line 1, the match has to find it at the start of a later line —
      // past a nested cwd on another type, which is not the session's folder.
      ...(layout === 'on line 1' ? [] : [{ type: 'event_msg', payload: { cwd: ALLOWED } }]),
      meta,
      { type: 'turn_context', payload: { cwd: SECRET } },
      said('CLIENT-CONFIDENTIAL'),
    ]);
    const ordinary = rollout(join(dir, 'rollout-ordinary.jsonl'), [
      { type: 'session_meta', payload: { id: 'ordinary', cwd: ALLOWED } },
      said('ORDINARY-CODEX-WORK'),
    ]);
    scaffoldExcluding(h, env, ['*secret*']);

    const { summary, reads } = observedSync(h, env, [secret, ordinary]);
    assert.equal(summary.excluded, 1, 'the cwd of an oversized session_meta did not reach the gate');
    assert.equal(summary.staged, 1, 'the allowed rollout was not staged');
    assertPeekOnly(reads, secret);
    assert.ok(fullyRead(reads, ordinary), 'the reader was not observed');
    const out = staged(h);
    assert.match(out, /ORDINARY-CODEX-WORK/);
    assert.ok(!out.includes('CLIENT-CONFIDENTIAL'), 'excluded Codex content was staged');
  });
}

// Codex writes a turn_context with its own cwd on every turn, so a session that
// moves to another folder names both. Any of them on the list excludes it, in
// either order; with first-found-wins, the allowed one decided.
for (const order of ['allowed, then excluded', 'excluded, then allowed']) {
  test(`Codex exclusion excludes on any cwd in the peek: session_meta and turn_context ${order}`, () => {
    const { h, env, dir } = codexHome();
    const [metaCwd, turnCwd] = order === 'allowed, then excluded' ? [ALLOWED, SECRET] : [SECRET, ALLOWED];
    const secret = rollout(join(dir, 'rollout-secret.jsonl'), [
      { type: 'session_meta', payload: { id: 'secret', cwd: metaCwd } },
      { type: 'turn_context', payload: { cwd: turnCwd } },
      { type: 'event_msg', payload: { padding: 'x'.repeat(65536) } },
      said('CLIENT-CONFIDENTIAL'),
    ]);
    // Two allowed folders and a nested excluded one on another type: any-match
    // must not reach past the session's own folders.
    const ordinary = rollout(join(dir, 'rollout-ordinary.jsonl'), [
      { type: 'session_meta', payload: { id: 'ordinary', cwd: ALLOWED } },
      { type: 'event_msg', payload: { cwd: SECRET } },
      { type: 'turn_context', payload: { cwd: 'C:/work/other' } },
      said('ORDINARY-CODEX-WORK'),
    ]);
    scaffoldExcluding(h, env, ['*secret*']);

    const { summary, reads } = observedSync(h, env, [secret, ordinary]);
    assert.equal(summary.excluded, 1, 'a cwd on the list was outvoted by one that was not');
    assert.equal(summary.staged, 1, 'the allowed rollout was not staged');
    assertPeekOnly(reads, secret);
    assert.ok(fullyRead(reads, ordinary), 'the reader was not observed');
    const out = staged(h);
    assert.match(out, /ORDINARY-CODEX-WORK/);
    assert.ok(!out.includes('CLIENT-CONFIDENTIAL'), 'excluded Codex content was staged');
  });
}

// Unknown is not allowed. A rollout whose head names no folder could be on the
// list, and reading it to find out is the read the gate exists to prevent.
// The fixture's cwd sits after a nested object and past 64 KB, both out of a
// bounded peek's sight — and it is in an excluded folder.
const unplaceable = (dir) => rollout(join(dir, 'rollout-unknown.jsonl'), [
  {
    timestamp: t(0),
    type: 'session_meta',
    payload: { id: 'unknown', timestamp: t(0), base_instructions: { text: 'x'.repeat(70000) }, cwd: SECRET },
  },
  said('MAYBE-CONFIDENTIAL'),
]);

test('a Codex rollout whose first 64 KB names no folder is held back while an exclude list is set', () => {
  const { h, env, dir } = codexHome();
  const unknown = unplaceable(dir);
  const ordinary = rollout(join(dir, 'rollout-ordinary.jsonl'), [
    { type: 'session_meta', payload: { id: 'ordinary', cwd: ALLOWED } },
    said('ORDINARY-CODEX-WORK'),
  ]);
  scaffoldExcluding(h, env, ['*secret*']);

  const { summary, reads } = observedSync(h, env, [unknown, ordinary]);
  assert.equal(summary.unidentified, 1, 'a rollout with no folder in its head was not held back');
  assert.equal(summary.excluded, 0, 'an unknown folder was reported as excluded');
  assert.equal(summary.staged, 1, 'the allowed rollout was not staged');
  assertPeekOnly(reads, unknown);
  assert.ok(fullyRead(reads, ordinary), 'the reader was not observed');
  assert.ok(!staged(h).includes('MAYBE-CONFIDENTIAL'), 'a rollout of unknown folder was staged');

  // Said in the batch, under its own heading rather than "excluded".
  const manifest = staged(h, 'MANIFEST.md');
  assert.match(manifest, /## Folder unknown — held back/);
  assert.ok(manifest.includes('rollout-unknown.jsonl'), 'the manifest does not name the held rollout');
  // And not marked read, so the next sync looks at it again.
  const state = JSON.parse(readFileSync(join(h, 'brain', '.exposurie', 'state.json'), 'utf8'));
  const recorded = [...Object.keys(state.files || {}), ...Object.keys(state.pendingBatch?.files || {})];
  assert.ok(!recorded.some((p) => p.endsWith('rollout-unknown.jsonl')), 'the held rollout was recorded as read');
});

test('a held-back rollout is reported when it is all there is, never as "nothing has changed"', () => {
  const { h, env, dir } = codexHome();
  unplaceable(dir);
  scaffoldExcluding(h, env, ['*secret*']);

  const r = run(h, ['sync'], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NOTHING NEW/);
  assert.match(r.out, /held\s+back\s+unread/);
  assert.doesNotMatch(r.out, /Nothing\s+on\s+this\s+machine\s+has\s+changed/);
});

test('with no exclude list set, a rollout of unknown folder is read as before', () => {
  const { h, env, dir } = codexHome();
  unplaceable(dir);
  scaffoldExcluding(h, env, []);

  const r = run(h, ['sync', '--json'], { env });
  assert.equal(r.code, 0, r.out);
  const summary = JSON.parse(r.out);
  assert.equal(summary.unidentified, 0);
  assert.equal(summary.staged, 1);
  assert.match(staged(h), /MAYBE-CONFIDENTIAL/);
});

// ----------------------------------------------------------------- the cutoff
test('the cutoff moves on evidence that pages exist, never on a claim', () => {
  // It is the only record of what has been read. Advancing it before the pages
  // are written turns an interrupted sync into silent, permanent data loss.
  const h = home();
  transcript(h, 'thing', 'a', [user('SOMETHING-WORTH-KEEPING'), agent('noted')]);
  run(h, ['scaffold']);
  run(h, ['sync']);

  const premature = run(h, ['--done', 'sync']);
  assert.equal(premature.code, 1, 'the cutoff moved without any pages being written');
  const state = JSON.parse(readFileSync(join(h, 'brain', '.exposurie', 'state.json'), 'utf8'));
  assert.ok(state.pendingBatch, 'the batch was closed anyway');

  // write a page, then it advances
  writeFileSync(join(h, 'brain', 'wiki', 'entities', 'Thing.md'), '# Thing\n', 'utf8');
  const ok = run(h, ['sync', '--done']);
  assert.equal(ok.code, 0, ok.out);
  const after = JSON.parse(readFileSync(join(h, 'brain', '.exposurie', 'state.json'), 'utf8'));
  assert.ok(!after.pendingBatch);
  assert.ok(Object.keys(after.files).length > 0, 'nothing was recorded as read');

  // and a second sync has nothing to say
  assert.match(run(h, ['sync']).out, /NOTHING NEW/);
});

// ------------------------------------------------------------------ the batch
test('a batch is bounded and never splits a session in half', () => {
  // Half a conversation is worse than none: the half that explains why is
  // usually the half that gets cut.
  const h = home();
  const big = 'x'.repeat(9000);
  for (const n of ['a', 'b', 'c', 'd']) {
    transcript(h, 'thing', n, [user(`SESSION-${n} ${big}`), agent('ok')]);
  }
  run(h, ['scaffold']);
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.guards.batchChars = 12000;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const r = run(h, ['sync', '--json']);
  const j = JSON.parse(r.out);
  assert.ok(j.staged >= 1 && j.staged < 4, `staged ${j.staged}; the budget did nothing`);
  assert.ok(j.remaining > 0, 'the remainder was not reported');

  // whatever landed, landed whole
  const out = staged(h);
  const started = (out.match(/SESSION-/g) || []).length;
  assert.equal(started, j.staged, 'a session was staged in pieces');
});

// ----------------------------------------------------------------- resumption
test('a session that continues is re-read from where it stopped, not from the top', () => {
  const h = home();
  const p = transcript(h, 'thing', 'a', [user('FIRST-ROUND — with an em dash'), agent('ok')]);
  run(h, ['scaffold']);
  run(h, ['sync']);
  writeFileSync(join(h, 'brain', 'wiki', 'entities', 'A.md'), '# A\n', 'utf8');
  run(h, ['sync', '--done']);

  appendFileSync(p, JSON.stringify(user('SECOND-ROUND')) + '\n' + JSON.stringify(agent('ok again')) + '\n', 'utf8');
  // The person came back later and the conversation ENDED again. Without this
  // the append leaves the transcript looking live, and sync correctly holds it
  // — which is the right behaviour and the wrong fixture.
  settled(p);
  run(h, ['sync']);

  const out = staged(h);
  assert.match(out, /SECOND-ROUND/);
  // The offset is in bytes and the text is in characters. An em dash is three
  // bytes and one character, so conflating them resumes mid-character and
  // corrupts the first turn of every incremental sync.
  assert.ok(!out.includes('FIRST-ROUND'), 'the whole session was re-staged');
});

// ------------------------------------------------------------------- redaction
test('a pasted key is removed before anything is written to disk', () => {
  const h = home();
  transcript(h, 'thing', 'a', [
    user('use this: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234 and deploy'),
    agent('ok'),
  ]);
  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  const out = staged(h);
  assert.ok(!out.includes('sk-ant-api03-AAAA'), 'a key was written into the brain');
  assert.match(out, /redacted:anthropic-key/);
  assert.match(out, /and deploy/, 'redaction ate the surrounding sentence');
  assert.match(r.out, /redacted/, 'a silent redaction is indistinguishable from a bug');
});

// ----------------------------------------------------------------- no brain
test('sync without a brain says what to do about it', () => {
  const h = home();
  const r = run(h, ['sync']);
  assert.equal(r.code, 1);
  assert.match(r.out, /RUN: exposurie scaffold/);
});
