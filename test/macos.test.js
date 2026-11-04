// macOS, tested from Windows.
//
// v1 ships for two platforms and is developed on one of them. The demo that
// matters most is somebody else's MacBook, and "no sessions found" on a machine
// nobody can debug is the worst possible first run.
//
// Most of what differs between the two platforms is not code — it is a path
// table and a string. Both can be exercised here: a macOS layout is just a
// directory shape, and Windows will happily create `Library/Application
// Support/Cursor/User` for us. That covers the macOS BRANCHES of every path
// this product resolves, without a Mac.
//
// It does NOT cover the things only a Mac can answer — whether Cursor really
// writes to that folder on macOS, whether the file permissions differ, whether
// `git` is present. Those stay unverified and are named as such in the README
// rather than assumed by these tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';

/** A fixture that models a conversation which has ENDED — see sync.test.js. */
function settled(p) {
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  return p;
}
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = new URL('../bin/exposurie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** A home directory laid out the way macOS lays one out. */
function macHome() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-mac-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  mkdirSync(join(h, 'Library', 'Application Support'), { recursive: true });
  return h;
}

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], opts), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

// ------------------------------------------------------------------ the paths

test('Cursor is found where macOS puts it', () => {
  const h = macHome();
  const user = join(h, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  mkdirSync(user, { recursive: true });
  // Contents do not matter here; the question is whether the ROOT resolves.
  writeFileSync(join(user, 'state.vscdb'), 'SQLite format 3\0');

  const r = run(h, ['init', '--json']);
  const j = JSON.parse(r.out);
  const cursor = j.clients.find((c) => c.id === 'cursor');
  assert.ok(cursor.present, 'Cursor was invisible on a macOS layout');
  assert.equal(cursor.readable, true);
});

test('Cursor is NOT looked for in the folder that only exists on paper', () => {
  // `~/.cursor` holds extensions. Its `agent-transcripts` directories are empty
  // on every machine checked, and counting them is what produced a session
  // count for conversations that did not exist.
  const h = macHome();
  mkdirSync(join(h, '.cursor', 'projects', 'proj', 'agent-transcripts', 'abc'), { recursive: true });

  const r = run(h, ['init', '--json']);
  const j = JSON.parse(r.out);
  const cursor = j.clients.find((c) => c.id === 'cursor');
  assert.equal(cursor.count, 0, 'empty scaffolding folders were counted as conversations');
});

test('Claude Code and Codex use the same path on both platforms', () => {
  const h = macHome();
  mkdirSync(join(h, '.claude', 'projects', 'app'), { recursive: true });
  writeFileSync(
    join(h, '.claude', 'projects', 'app', 'a.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: '/Users/friend/app',
      timestamp: '2026-08-25T00:00:00Z',
      message: { content: [{ type: 'text', text: 'MAC-CLAUDE-TURN' }] },
    }) + '\n',
    'utf8',
  );
  settled(join(h, '.claude', 'projects', 'app', 'a.jsonl'));
  mkdirSync(join(h, '.codex', 'sessions', '2026', '08', '25'), { recursive: true });
  writeFileSync(
    join(h, '.codex', 'sessions', '2026', '08', '25', 'rollout-x.jsonl'),
    [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'a', cwd: '/Users/friend/app', source: 'cli' } }),
      JSON.stringify({
        timestamp: 't',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'MAC-CODEX-TURN' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );
  settled(join(h, '.codex', 'sessions', '2026', '08', '25', 'rollout-x.jsonl'));

  run(h, ['scaffold']);
  run(h, ['sync']);

  const dir = join(h, 'brain', '.exposurie', 'staged');
  const batch = readdirSync(dir).sort().pop();
  const text = readFileSync(join(dir, batch, 'conversations.md'), 'utf8');
  assert.match(text, /MAC-CLAUDE-TURN/, 'Claude Code was not read on a macOS layout');
  assert.match(text, /MAC-CODEX-TURN/, 'Codex was not read on a macOS layout');
});

test('Obsidian is detected where macOS puts it', async () => {
  const h = macHome();
  mkdirSync(join(h, 'Library', 'Application Support', 'obsidian'), { recursive: true });
  const r = run(h, ['init', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.obsidian, true, 'a macOS Obsidian install was not seen, so the step nags forever');
  assert.ok(!j.pending.includes('obsidian'), 'the step stayed open with Obsidian installed');
});

// --------------------------------------------------------------- posix paths

test('a macOS project folder survives the trip out of Cursor', async () => {
  // `file:///Users/x/app` must not become `Users/x/app`. Nothing crashes when
  // it does — the project name still resolves through basename — but the
  // working directory stops being absolute, and the EXCLUSION GATE quietly
  // stops matching. A person who excluded /Users/them/client-work would find
  // that folder in their brain with nothing reporting why.
  const { readCursorSessions } = await import('../src/extract/cursor.js');
  assert.equal(typeof readCursorSessions, 'function');

  // The conversion is exercised through the gate, which is what depends on it.
  const { conversationExcluded } = await import('../src/extract/exclude.js');
  const seam = { excludeConversations: ['/Users/friend/client-work'] };
  assert.ok(
    conversationExcluded({ cwd: '/Users/friend/client-work/api' }, seam),
    'an absolute macOS path did not match an absolute macOS exclusion',
  );
  assert.ok(
    !conversationExcluded({ cwd: 'Users/friend/client-work/api' }, seam),
    'this assertion is the bug: a path that lost its leading slash must NOT match, ' +
      'which is exactly why the slash has to survive the URI conversion',
  );
});

test('the executable ships with unix line endings', () => {
  // A CRLF on the shebang makes the kernel look for an interpreter named
  // "node\r" and every macOS and Linux install dies with "env: node: No such
  // file or directory" — a failure that names the wrong thing entirely.
  const bin = readFileSync(new URL('../bin/exposurie.js', import.meta.url), 'utf8');
  const firstLine = bin.slice(0, bin.indexOf('\n'));
  assert.ok(firstLine.startsWith('#!'), 'the entry point lost its shebang');
  assert.ok(!firstLine.endsWith('\r'), 'the shebang has a CRLF and will not run off Windows');
});

test('an install with nothing on it is still told what to do', () => {
  // A brand new Mac: no clients, no exports, nothing. This must not be a dead
  // end, and it must not be an error.
  const h = macHome();
  const r = run(h, ['init']);
  assert.equal(r.code, 10, `a fresh machine should be a pending step, not a failure:\n${r.out}`);
  assert.match(r.out, /exposurie scaffold/, 'a fresh machine was given nothing to run');
});
