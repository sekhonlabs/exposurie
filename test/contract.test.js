// Tests for the output contract.
//
// These are not unit tests for convenience — each one pins a rule that, if it
// silently broke, would produce the exact failure the rule exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateLine, planBlock, pendingBlock, render, block, wrap } from '../src/output.js';
import { STEPS, lines, unresolved } from '../src/pending.js';
import { OK, HUMAN, footer } from '../src/exit-codes.js';
import { SYNC, exists } from '../src/commands/names.js';
import { init } from '../src/commands/init.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function allSource(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) allSource(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------- rule 1
test('RULE 1: nothing in the product can ever read stdin', () => {
  // An agent runs these commands with nobody at the keyboard. A tool that waits
  // for input does not get input — it hangs, and the agent looks frozen.
  // This test is the enforcement; prose in a doc is not.
  const banned = [/readline/, /process\.stdin/, /prompt\s*\(/, /inquirer/, /\benquirer\b/];
  for (const file of allSource(SRC)) {
    const text = readFileSync(file, 'utf8');
    // Strip comments so the rule can be *described* without tripping itself.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of banned) {
      assert.ok(!re.test(code), `${file} reads input (${re}). Commands must never block.`);
    }
  }
});

test('nothing in the shipped source can open a network connection', () => {
  // The README promises no network code at all -- not "off by default" -- and
  // says the claim can be verified in one grep. This is that grep, run on every
  // build, over exactly what npm ships. It went from a promise to a test when a
  // contributed cloud mirror (PR #6) would have made `read` network-capable.
  const banned = [
    /\bnode:(net|http|https|http2|dgram|tls|dns)\b/,
    /\b(from|import|require)\s*\(?\s*['"](net|http|https|http2|dgram|tls|dns)['"]/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bXMLHttpRequest\b/,
    /\bEventSource\b/,
    /\bundici\b/,
    /\bsendBeacon\b/,
  ];
  // A guard that cannot fail is decoration: it has to catch what it keeps out.
  for (const leak of ["import { request } from 'node:https';", "const http = require('http');", 'await fetch(url);']) {
    assert.ok(banned.some((re) => re.test(leak)), `the guard misses: ${leak}`);
  }
  const shipped = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).files;
  const files = shipped.flatMap((top) => allSource(join(SRC, top)));
  assert.ok(files.length > 20, 'the shipped source was not found, so nothing was checked');
  for (const file of files) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of banned) {
      assert.ok(!re.test(code), `${file} can reach the network (${re}). exposurie has no network code.`);
    }
  }
});

// ---------------------------------------------------------------- rule 2
test('RULE 2: every actionable line opens with a caps verb', () => {
  const lines = planBlock([
    { run: 'exposurie scaffold' },
    { ask: 'can you export your chats?' },
    { read: 'BRAIN.md' },
  ]);
  assert.ok(lines.some((l) => l.includes('RUN:')));
  assert.ok(lines.some((l) => l.includes('ASK YOUR USER')));
  assert.ok(lines.some((l) => l.includes('READ:')));
});

test('a human step in a plan never reads as a stopping point', () => {
  const lines = planBlock([{ ask: 'export your chats' }]).join('\n');
  assert.match(lines, /Do NOT wait/);
});

// ---------------------------------------------------------------- rule 4
test('RULE 4: the sync nudge rides output, but never inside its own command', () => {
  const stale = { vault: '/b', pages: 10, unfiled: 6, lastSyncDays: 9 };
  const out = stateLine(stale).join('\n');

  // The numbers ride on every command regardless — they are the mechanism, and
  // they are what makes a stale brain impossible to not notice.
  assert.match(out, /6 sessions unfiled/);
  assert.match(out, /last sync 9d ago/);

  // The arrow is the call to action, and it only exists once there is an action.
  if (exists(SYNC)) {
    assert.match(out, new RegExp(`RUN: exposurie ${SYNC}`));
    // ...and must not fire while the user is already running sync.
    assert.doesNotMatch(stateLine({ ...stale, self: SYNC }).join('\n'), /RUN: exposurie/);
  } else {
    assert.doesNotMatch(out, /->/, 'pointed at a command this version does not have');
  }

  assert.doesNotMatch(stateLine({ vault: null, self: 'init' }).join('\n'), /RUN: exposurie init/);
});

test('a healthy brain gets no nudge at all, so the arrow keeps meaning something', () => {
  const fresh = { vault: '/b', pages: 61, unfiled: 0, lastSyncDays: 0 };
  assert.doesNotMatch(stateLine(fresh).join('\n'), /->/);
});

// ---------------------------------------------------------------- exit codes
test('staleness never changes the exit code', () => {
  // A stale brain still works. Exiting non-zero over it trains agents to
  // ignore the number.
  const r = init({});
  assert.ok(r.code === OK || r.code === HUMAN, `unexpected exit ${r.code}`);
});

test('exit 10 says plainly that nothing failed', () => {
  assert.match(footer(HUMAN), /Nothing has failed/);
});

// ---------------------------------------------------------------- pending
test('every human step ships exact words, not a topic', () => {
  for (const [id, s] of Object.entries(STEPS)) {
    for (const f of ['title', 'why', 'ask', 'doneWhen']) {
      assert.ok(s[f]?.length > 10, `${id}.${f} is missing or too thin to relay`);
    }
    // Either channel is fine and the bar is identical. `verbatim` is read TO
    // the user; `onYes` is what the agent does FOR them after a yes. What is
    // banned is a step that names a topic and leaves the words to be invented —
    // so a step must carry exactly one of the two, and it must be real lines.
    const said = lines(s, { vault: '/somewhere/brain' });
    assert.ok(Array.isArray(said) && said.length >= 2, `${id} must ship real steps, not a topic`);
    assert.ok(
      said.every((l) => typeof l === 'string'),
      `${id} steps must be literal lines`,
    );
    assert.ok(
      Boolean(s.verbatim) !== Boolean(s.onYes),
      `${id} must be read out OR done for them, never ambiguously both`,
    );
    assert.equal(typeof s.resolved, 'function', `${id} must be detectable, not self-reported`);
  }
});

test('the export step is detected as done, never marked done', () => {
  const step = STEPS['claude-web-export'];
  assert.equal(step.resolved({ exports: [] }), false);
  assert.equal(step.resolved({ exports: [{ path: 'data-x.zip' }] }), true);
});

test('the export instructions warn about the wait, which is the real failure', () => {
  // People click through, see nothing, and conclude it broke.
  const t = STEPS['claude-web-export'].verbatim.join(' ');
  assert.match(t, /HOURS|hours/);
  assert.match(t, /email/i);
});

test('pending steps are relayed verbatim and marked non-blocking', () => {
  const out = pendingBlock([STEPS['claude-web-export']]).join('\n');
  assert.match(out, /RELAY THESE EXACTLY/);
  assert.match(out, /do not paraphrase/);
  assert.match(out, /does NOT block/);
});

// ---------------------------------------------------------------- skeleton
test('the response skeleton never varies: state, then pending, then body', () => {
  const out = render({
    state: { vault: '/b', pages: 3, lastSyncDays: 0 },
    pending: [STEPS['claude-web-export']],
    body: block('STATE', [['a', 'b']]),
    code: HUMAN,
  });
  const iState = out.indexOf('exposurie');
  const iPending = out.indexOf('FOR YOUR USER');
  const iBody = out.indexOf('STATE');
  assert.ok(iState < iPending && iPending < iBody, 'skeleton order broke');
});

test('wrap never splits a word and honours the indent', () => {
  const lines = wrap('alpha beta gamma delta epsilon zeta', 12, '>> ');
  assert.ok(lines.every((l) => l.startsWith('>> ')));
  assert.ok(lines.every((l) => l.length <= 12 + 3));
  assert.equal(lines.join(' ').replace(/>> /g, ''), 'alpha beta gamma delta epsilon zeta');
});

// ---------------------------------------------------------------- honesty
test('a client we cannot parse is reported, not silently dropped', () => {
  // This named Cursor until Cursor got a reader. Naming a client was always the
  // weaker version of the rule — the rule is that a client we cannot read is
  // VISIBLE and uncounted, whichever client that happens to be this month.
  const r = init({});
  for (const c of r.json.clients) {
    assert.equal(typeof c.readable, 'boolean', `${c.id} does not say whether it can be read`);
    assert.equal(typeof c.count, 'number', `${c.id} does not say how much it found`);
  }
  const unreadable = r.json.clients.filter((c) => c.present && !c.readable);
  const counted = r.json.clients
    .filter((c) => c.present && c.readable)
    .reduce((n, c) => n + c.count, 0);
  assert.equal(
    r.json.sessions,
    counted,
    'the promised session count includes clients nothing can read',
  );
  for (const c of unreadable) {
    assert.match(
      r.body.join(String.fromCharCode(10)),
      new RegExp('NO READER YET'),
      `${c.id} is present and unreadable but the output never says so`,
    );
  }
});
