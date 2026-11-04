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

const staged = (h) => {
  const d = join(h, 'brain', '.exposurie', 'staged');
  if (!existsSync(d)) return null;
  const dirs = readdirSync(d).sort();
  if (!dirs.length) return null;
  return readFileSync(join(d, dirs[dirs.length - 1], 'conversations.md'), 'utf8');
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

for (const metadata of ['session_meta', 'turn_context']) {
  test(`Codex exclusion reads ${metadata} cwd before loading a rollout`, () => {
    const h = home();
    // Model the permanent install without relying on the developer's PATH.
    const bin = join(h, 'bin');
    mkdirSync(bin);
    for (const name of ['exposurie', 'exposurie.cmd']) writeFileSync(join(bin, name), '');
    const path = [bin, process.env.PATH || process.env.Path || ''].join(delimiter);
    const env = { PATH: path, Path: path };
    const dir = join(h, '.codex', 'sessions', '2026', '08', '25');
    mkdirSync(dir, { recursive: true });
    const message = (text) => ({
      type: 'response_item', timestamp: t(1),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    const secret = join(dir, 'rollout-secret.jsonl');
    const ordinary = join(dir, 'rollout-ordinary.jsonl');
    const write = (path, lines) => {
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
      return settled(path);
    };
    write(secret, [
      // An unrelated payload's cwd is not session identity, nor is the first
      // line necessarily the one that identifies the session.
      { type: 'event_msg', payload: { cwd: 'C:/work/thing' } },
      { type: 'session_meta', payload: { id: 'secret' } },
      { type: metadata, payload: { cwd: 'C:/clients/secret-co' } },
      // Keep the conversation beyond the bounded 64 KB metadata peek. A test
      // of staging alone would also pass if exclusion happened after a read.
      { type: 'event_msg', payload: { padding: 'x'.repeat(65536) } },
      message('CLIENT-CONFIDENTIAL'),
    ]);
    write(ordinary, [
      { type: 'event_msg', payload: { cwd: 'C:/clients/secret-co' } },
      { type: 'session_meta', payload: { id: 'ordinary', cwd: 'C:/work/thing' } },
      message('ORDINARY-CODEX-WORK'),
    ]);

    run(h, ['scaffold'], { env });
    const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.excludeConversations = ['*secret*'];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Observe the actual CLI's I/O, including ESM's named fs imports. Recording
    // the allowed read too proves the observer is active, rather than making a
    // missing log look like a successful privacy gate.
    const log = join(h, 'reads.jsonl');
    const preload = join(h, 'observe-reads.cjs');
    writeFileSync(preload, `
      const fs = require('node:fs');
      const { syncBuiltinESMExports } = require('node:module');
      const watched = new Map(${JSON.stringify([secret, ordinary])}.map((path) => [fs.realpathSync(path), path]));
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
    const summary = JSON.parse(r.out);
    assert.equal(summary.excluded, 1, 'Codex cwd did not reach the exclusion gate');
    assert.equal(summary.staged, 1, 'the allowed rollout was not staged');
    const reads = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const secretReads = reads.filter((entry) => entry.path === secret);
    assert.ok(secretReads.length > 0, 'the metadata peek was not observed');
    assert.ok(secretReads.every((entry) => entry.kind === 'peek'), 'the excluded rollout was loaded in full');
    assert.ok(secretReads.every((entry) => entry.position >= 0 && entry.position + entry.bytes <= 65536),
      'the excluded rollout was read beyond the bounded metadata peek');
    assert.ok(reads.some((entry) => entry.path === ordinary && entry.kind === 'full'), 'the reader was not observed');
    const out = staged(h);
    assert.match(out, /ORDINARY-CODEX-WORK/);
    assert.ok(!out.includes('CLIENT-CONFIDENTIAL'), 'excluded Codex content was staged');
  });
}

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
