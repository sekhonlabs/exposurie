// Tests for the third state: a step the user said NO to.
//
// The catalog's rule is that "done" is detected and never marked, and every
// other test in this repo defends that. This file defends the one case the rule
// cannot cover: a decision leaves nothing on disk to detect, so without a place
// to put it, "repeat until done" becomes "repeat forever" for anything a person
// has decided against. That is the cries-wolf failure the whole product fears,
// reaching the one component that talks directly to a human.
//
// It was live before this shipped. Claude Code's retention step resolves only
// at a year or more; a user who keeps the 30-day default on purpose — because
// they sync often enough that it never bites — got the same request at the top
// of every command, forever, with no way to answer it.
//
// Four things have to hold, and each is a test below: the refusal is honoured,
// it is honoured ONLY for the step refused, it never masquerades as done, and
// it is undone by deleting a file rather than by remembering a command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { STEPS, unresolved, declined, decline, stepCtx } from '../src/pending.js';
import { pendingBlock } from '../src/output.js';
import { NAMES } from '../src/commands/names.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

/** A machine with Claude Code on it, one real session, and no brain yet. */
function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-decline-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  mkdirSync(join(h, '.claude', 'projects', 'work'), { recursive: true });
  writeFileSync(
    join(h, '.claude', 'projects', 'work', 'a.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: 'C:/w',
      sessionId: 's',
      timestamp: '2026-08-20T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'a real typed sentence about a decision' }] },
    }) + '\n',
    'utf8',
  );
  return h;
}

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** A scaffolded brain on a fresh machine. Returns { h, vault }. */
function brain() {
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  return { h, vault };
}

const asks = (h, vault, id) => run(h, ['init', '--at', vault]).out.includes(id);

// ------------------------------------------------------- it stops asking
test('a step the user said no to stops being asked', () => {
  // The whole point, end to end through the real binary rather than through the
  // predicate — because the first version of this fix passed at the function
  // and did nothing in the product. See the stepCtx test at the bottom.
  const { h, vault } = brain();
  assert.equal(asks(h, vault, 'claude-code-retention'), true, 'nothing to decline: the step was never asked');

  run(h, ['decline', 'claude-code-retention', '--because', 'i sync often, 30 days never bites me', '--at', vault]);

  assert.equal(
    asks(h, vault, 'claude-code-retention'),
    false,
    'the step reprinted after the user had already said no to it',
  );
});

test('the reminder file goes with it, so the brain does not contradict the decision', () => {
  // A decline that leaves "waiting on you" sitting in the brain has moved the
  // nag from the terminal into the vault, where it is worse: the terminal
  // scrolls away and Obsidian does not.
  const { h, vault } = brain();
  const mirror = join(vault, '.exposurie', 'pending', 'claude-code-retention.md');
  assert.equal(existsSync(mirror), true);

  run(h, ['decline', 'claude-code-retention', '--because', 'no', '--at', vault]);
  assert.equal(existsSync(mirror), false, 'the brain still says a declined step is waiting');

  // And the next command does not put it back.
  run(h, ['init', '--at', vault]);
  assert.equal(existsSync(mirror), false, 'a later command re-recorded a step the user declined');
});

// --------------------------------------------------- and only that step
test('declining one step does not silence the others', () => {
  // The failure that would make this feature worse than the bug: one "no"
  // swallowing every remaining request. A person who declines a settings change
  // has not declined their own export.
  const { h, vault } = brain();
  run(h, ['decline', 'claude-code-retention', '--because', 'no', '--at', vault]);

  assert.equal(asks(h, vault, 'claude-web-export'), true, 'one decline silenced an unrelated step');
  assert.equal(asks(h, vault, 'obsidian'), true, 'one decline silenced an unrelated step');
});

test('a stray file cannot invent a step, and a retired one cannot error', () => {
  const { vault } = brain();
  mkdirSync(join(vault, '.exposurie', 'declined'), { recursive: true });
  writeFileSync(join(vault, '.exposurie', 'declined', 'not-a-real-step.md'), 'x', 'utf8');
  assert.deepEqual([...declined(vault)], [], 'an unknown id was read as a step');
});

// ------------------------------------------------ it is never "done"
test('a decline is not a resolution, and can never be read as one', () => {
  // The line this feature must not cross. Everything else in the catalog holds
  // that a step closes only when the world changes; declining closes the ASKING
  // and changes nothing about the world. If the two ever collapse, the tool
  // starts believing transcripts are being kept when they are being deleted.
  const { vault } = brain();
  decline(vault, 'claude-code-retention', 'no thanks');

  // A machine where Claude Code IS the corpus, so the step's own relevance gate
  // is satisfied and what is being tested is only the decline. `readable` and
  // `count` are on here because relevance is now a question of share rather
  // than of mere presence — a client at 3% of somebody's sessions is not a
  // reason to edit another vendor's settings file.
  const claudeOnly = [{ id: 'claude-code', present: true, readable: true, count: 1 }];

  const step = STEPS['claude-code-retention'];
  assert.equal(step.resolved({ retention: { days: 30 } }), false, 'declining made the step look done');
  assert.equal(step.applies({ clients: claudeOnly }), true, 'declining rewrote applies');

  // It is closed for asking, and only there.
  const open = unresolved({ vault, clients: claudeOnly, retention: { days: 30 } }, [
    'claude-code-retention',
  ]);
  assert.deepEqual(open, []);
});

test('the user\'s own words are what gets written down', () => {
  // The guard that replaces detection. A decline is the one thing here taken on
  // a claim, so the claim is recorded verbatim in the user's own brain where
  // they can read it back — an invented one is visible as invented.
  const { h, vault } = brain();
  const said = 'no keep the 30 days as it is because i do sync oftenly';
  run(h, ['decline', 'claude-code-retention', '--because', said, '--at', vault]);

  const file = readFileSync(join(vault, '.exposurie', 'declined', 'claude-code-retention.md'), 'utf8');
  assert.match(file, new RegExp(`> ${said}`), 'the reason was paraphrased or dropped');
  assert.match(file, /Delete this file/, 'the file does not say how to undo itself');
});

test('no reason given is recorded as none, not invented', () => {
  const { h, vault } = brain();
  const r = run(h, ['decline', 'claude-code-retention', '--at', vault]);
  const file = readFileSync(join(vault, '.exposurie', 'declined', 'claude-code-retention.md'), 'utf8');
  assert.match(file, /_No reason recorded._/);
  assert.match(r.out, /--because/, 'the agent was not told it could record why');
});

// ------------------------------------------------------------- the undo
test('deleting the file brings the step back, with no command to remember', () => {
  // The undo has to survive the user forgetting this tool exists. A file they
  // can see in Obsidian and delete is the only undo that does.
  const { h, vault } = brain();
  run(h, ['decline', 'claude-code-retention', '--because', 'no', '--at', vault]);
  assert.equal(asks(h, vault, 'claude-code-retention'), false);

  rmSync(join(vault, '.exposurie', 'declined', 'claude-code-retention.md'));
  assert.equal(asks(h, vault, 'claude-code-retention'), true, 'the step did not come back after the undo');
});

test('declining twice is not an error', () => {
  const { h, vault } = brain();
  run(h, ['decline', 'claude-code-retention', '--because', 'no', '--at', vault]);
  const r = run(h, ['decline', 'claude-code-retention', '--because', 'no', '--at', vault]);
  assert.equal(r.code, 0);
  assert.match(r.out, /ALREADY SET ASIDE/);
});

// --------------------------------------------------------- bad input
test('an unknown id is refused, and the refusal names the real ones', () => {
  // An agent that guessed wrong cannot discover the right answer from "unknown".
  const { h, vault } = brain();
  const r = run(h, ['decline', 'retention', '--at', vault]);
  assert.equal(r.code, 2);
  assert.match(r.out, /claude-code-retention/, 'the error did not name the ids that exist');
});

test('there is nowhere to record a decline without a brain', () => {
  const h = home();
  const r = run(h, ['decline', 'claude-code-retention', '--at', join(h, 'nope')]);
  assert.equal(r.code, 2);
  assert.match(r.out, /exposurie scaffold/);
});

// ------------------------------------------------- the agent is told
test('every asked step tells the agent how to record a no', () => {
  // Without this line the catalog can only be told yes. The capability would
  // ship, be tested, pass, and never once be used — which is this product's
  // signature failure: the component that reports correctly and reaches nobody.
  assert.equal(NAMES.includes('decline'), true, 'the command is not registered');

  const out = pendingBlock([STEPS['claude-code-retention']]).join('\n');
  assert.match(out, /IF THEY SAY NO/);
  assert.match(out, /exposurie decline claude-code-retention --because/);
});

// --------------------------------------------- the regression guard
test('the step context carries the vault, or the whole feature is inert', () => {
  // This is not hypothetical. The first version of this fix recorded declines
  // correctly, filtered them correctly, and did nothing at all — because both
  // callers hand-built their ctx from detect() and neither included `vault`, so
  // the filter had nothing to read. The mechanism was right and the wiring was
  // absent, which is the exact class this repo keeps finding: a component that
  // reports the correct-looking answer and reaches nobody.
  //
  // One builder now, so a new command cannot reintroduce it by omission.
  const ctx = stepCtx({ vault: '/b', clients: [], exports: [] });
  assert.equal(ctx.vault, '/b', 'stepCtx dropped the vault and every decline is ignored');

  const src = readFileSync(join(ROOT, 'src', 'commands', 'init.js'), 'utf8');
  const scaf = readFileSync(join(ROOT, 'src', 'commands', 'scaffold.js'), 'utf8');
  for (const [name, text] of [['init', src], ['scaffold', scaf]]) {
    assert.match(text, /stepCtx\(/, `${name} builds its own step context and will ignore declines`);
  }
});
