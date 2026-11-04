// Tests for WHICH human steps a given machine is asked for.
//
// THE BUG THESE PIN, measured on a real laptop on 2026-08-26. `init` detected 6
// Claude Code sessions, 165 Codex and 11 Cursor — correctly — and then asked
// for a claude.ai export the person did not have, offered to change Claude
// Code's retention to protect 3% of their history, and NEVER asked for the
// ChatGPT export sitting in their Downloads with 1,164 conversations in it.
//
// Nothing was mis-detected. Every gate read the counts as a boolean, `present`,
// so six stale transcripts outvoted 165. Worse, the two export gates were
// written as each other's negation on that same boolean, which made "asked for
// the wrong one" and "never asked for the right one" a single bug that no
// machine could exhibit only half of.
//
// So the matrix below is the point of this file: every mix of clients, and what
// each one is owed. The first test is that laptop, reconstructed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { STEPS, unresolved, material, MATERIAL_SHARE } from '../src/pending.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

/** A client as detect() reports one. */
const c = (id, count) => ({ id, present: true, readable: true, count });

/** Which of the four steps a machine is asked for, by id. */
const asked = (ctx) => unresolved(ctx).map((s) => s.id);

const EXPORTS = ['claude-web-export', 'chatgpt-web-export'];

// ------------------------------------------------------------ the machine
test('REGRESSION: the machine that exposed this — 6 Claude Code, 165 Codex, 11 Cursor', () => {
  const ctx = {
    clients: [c('claude-code', 6), c('codex', 165), c('cursor', 11)],
    retention: { days: 30 },
  };
  const ids = asked(ctx);

  assert.ok(
    ids.includes('chatgpt-web-export'),
    'the 1,164-conversation ChatGPT export must be asked for — this is the import that was silently lost',
  );
  assert.ok(
    !ids.includes('claude-web-export'),
    'a claude.ai export must not be requested off 3% of the corpus',
  );
  assert.ok(
    !ids.includes('claude-code-retention'),
    'do not offer to edit another vendor\'s settings to protect 6 sessions out of 182',
  );
});

test('the two export steps are no longer each other\'s negation', () => {
  // The structural half of the bug. Whatever the mix, it must be POSSIBLE to be
  // asked for both — a person who works in both places has both histories.
  const both = asked({ clients: [c('claude-code', 100), c('codex', 100)] });
  assert.deepEqual(
    EXPORTS.filter((id) => both.includes(id)),
    EXPORTS,
    'an even split must be asked for both exports',
  );
});

// ------------------------------------------------------------- the matrix
test('a machine that is only Claude Code is asked for claude.ai only', () => {
  const ids = asked({ clients: [c('claude-code', 40)], retention: { days: 30 } });
  assert.ok(ids.includes('claude-web-export'));
  assert.ok(ids.includes('claude-code-retention'), 'retention matters where the history is');
  assert.ok(!ids.includes('chatgpt-web-export'));
});

test('a machine that is only Codex is asked for ChatGPT only', () => {
  const ids = asked({ clients: [c('codex', 40)], retention: { days: 30 } });
  assert.ok(ids.includes('chatgpt-web-export'));
  assert.ok(!ids.includes('claude-web-export'));
  assert.ok(!ids.includes('claude-code-retention'), 'nothing here deletes anything');
});

test('a client below the share is not treated as somewhere they work', () => {
  assert.equal(material({ clients: [c('claude-code', 6), c('codex', 165)] }, 'claude-code'), false);
  assert.equal(material({ clients: [c('claude-code', 6), c('codex', 165)] }, 'codex'), true);
});

test('the threshold is a share, and it is ours — not a count and not a setting', () => {
  const at = Math.ceil((MATERIAL_SHARE / (1 - MATERIAL_SHARE)) * 100);
  assert.equal(material({ clients: [c('claude-code', at), c('codex', 100)] }, 'claude-code'), true);
  assert.equal(material({ clients: [c('claude-code', at - 2), c('codex', 100)] }, 'claude-code'), false);
});

test('a client that is not on the machine is never material', () => {
  assert.equal(material({ clients: [c('codex', 10)] }, 'claude-code'), false);
});

// ----------------------------------------------------------- the fallbacks
test('no client at all: the web is their whole history, so ask for both', () => {
  // Guessing here costs them everything they have; asking costs one command to
  // decline. This is the case the old rule answered with "claude.ai" and a 50%
  // chance of silently losing a person's entire corpus.
  const ids = asked({ clients: [] });
  assert.deepEqual(EXPORTS.filter((id) => ids.includes(id)), EXPORTS);
});

test('installed but never run: presence is the only signal there is, so use it', () => {
  const ids = asked({ clients: [c('codex', 0)] });
  assert.ok(ids.includes('chatgpt-web-export'));
  assert.ok(!ids.includes('claude-web-export'), 'nothing here suggests a Claude account');
});

test('an export on disk closes its step, whatever the local mix says', () => {
  // Relevance decides what to ASK for. It must never decide what gets READ:
  // sync folds in every export it finds regardless of client ratios, so a
  // Codex-only machine with a claude.ai zip on it loses nothing by never being
  // asked — the step is already satisfied, which is why it is not in the list.
  const ctx = { clients: [c('codex', 165)], exports: [{ path: '/d/data-1.zip' }] };
  assert.equal(STEPS['claude-web-export'].resolved(ctx), true);
  assert.ok(!asked(ctx).includes('claude-web-export'), 'a satisfied step is not a pending one');

  const gpt = { clients: [c('claude-code', 165)], chatgptExports: [{ path: '/d/gpt.zip' }] };
  assert.equal(STEPS['chatgpt-web-export'].resolved(gpt), true);
  assert.ok(!asked(gpt).includes('chatgpt-web-export'));
});

test('a step still closes on evidence, not on relevance', () => {
  // Materiality decides whether to ask. It must never decide whether something
  // is DONE — that stays detected from disk.
  assert.equal(STEPS['claude-code-retention'].resolved({ retention: { days: 3650 } }), true);
  assert.equal(STEPS['claude-code-retention'].resolved({ retention: { days: 30 } }), false);
});

// -------------------------------------------------------------- end to end
function jashansMachine() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-mat-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });

  const claude = join(h, '.claude', 'projects', 'work');
  mkdirSync(claude, { recursive: true });
  for (let i = 0; i < 6; i += 1) writeFileSync(join(claude, `s${i}.jsonl`), '', 'utf8');

  const codex = join(h, '.codex', 'sessions', '2026', '08', '26');
  mkdirSync(codex, { recursive: true });
  for (let i = 0; i < 165; i += 1) writeFileSync(join(codex, `rollout-2026-08-26-${i}.jsonl`), '', 'utf8');

  return h;
}

test('END TO END: that laptop, through the real binary, asks the right things', () => {
  const h = jashansMachine();
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, 'init'], opts);
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }

  assert.match(out, /chatgpt-web-export/, 'the export holding their web history must be requested');
  assert.ok(!out.includes('claude-web-export'), 'must not request an export they have no account for');
  assert.ok(!out.includes('claude-code-retention'), 'must not offer to edit settings for 3% of a corpus');
});

test('END TO END: the share is printed, so the ranking is visible not just held', () => {
  const h = jashansMachine();
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, 'init'], opts);
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }

  assert.match(out, /codex\s+165 sessions · 9\d%/, 'the dominant client must show its share');
  assert.match(out, /claude-code\s+6 sessions · \d%/, 'the incidental one must show its share too');
});

test('a lone client does not get a 100% row, which says nothing', () => {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-mat1-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  const codex = join(h, '.codex', 'sessions', '2026', '08', '26');
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'rollout-2026-08-26-a.jsonl'), '', 'utf8');

  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, 'init'], opts);
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  assert.ok(!out.includes('100%'), 'a single client is always all of it');
});
