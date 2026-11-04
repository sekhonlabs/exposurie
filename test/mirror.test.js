// Tests for the other half of the reminder: taking it back.
//
// Every open human step is mirrored to a file in the brain, because auto mode
// blows past a terminal and a file is still there tomorrow. That half was wired
// into both commands from the start. The half that removes the file once the
// step is actually done was written, exported, tested by nobody, and CALLED BY
// NOBODY for the whole life of the feature.
//
// What a user got: they set `cleanupPeriodDays` for real, the tool correctly
// stopped asking — and a file stayed in their brain saying "Waiting on you",
// directly under a line promising it would delete itself. Wrong in the worst
// place, since the brain is the thing they are being taught to trust, and it is
// visible in Obsidian next to real pages.
//
// Correct component, no caller. That is the class this repo keeps finding, and
// it is the second instance in one session — the decline filter read a `vault`
// that neither caller passed. So the fix is not "call reap()": it is that
// writing and removing are ONE call, and a caller cannot do half of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { STEPS, mirror, reap, record } from '../src/pending.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-mirror-'));
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

function brain() {
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  return { h, vault };
}

const pending = (vault, id) => join(vault, '.exposurie', 'pending', `${id}.md`);

/** Do the retention step for real, the way a user's agent would. */
const doTheStep = (h) => writeFileSync(join(h, '.claude', 'settings.json'), '{"cleanupPeriodDays":3650}', 'utf8');

// ------------------------------------------------------------- the bug
test('a step the user actually did loses its reminder', () => {
  const { h, vault } = brain();
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), true, 'nothing to reap: the reminder was never written');

  doTheStep(h);
  const r = run(h, ['init', '--at', vault]);

  assert.equal(r.out.includes('claude-code-retention'), false, 'the step was still being asked');
  assert.equal(
    existsSync(pending(vault, 'claude-code-retention')),
    false,
    'the brain kept telling the user to do something they had already done',
  );
});

test('the promise written on the file is one the tool actually keeps', () => {
  // The file says this in its own words. A product whose artefacts describe
  // behaviour it does not have is lying in the one place the user is being
  // taught to trust, so the sentence and the behaviour are pinned together.
  const { h, vault } = brain();
  const said = readFileSync(pending(vault, 'claude-code-retention'), 'utf8');
  assert.match(said, /disappears by itself once the step is detected as complete/);

  doTheStep(h);
  run(h, ['init', '--at', vault]);
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), false, 'the file made a promise the tool does not keep');
});

// -------------------------------------------------- and only that step
test('the steps still owed keep their reminders', () => {
  // Over-reaping is the worse bug of the two: a stale file is a nuisance, a
  // vanished one is a step the user never hears about again.
  const { h, vault } = brain();
  doTheStep(h);
  run(h, ['init', '--at', vault]);

  assert.equal(existsSync(pending(vault, 'claude-web-export')), true, 'reaped a step that is still owed');
  assert.equal(existsSync(pending(vault, 'obsidian')), true, 'reaped a step that is still owed');
});

test('a file that is not ours is left alone', () => {
  const { vault } = brain();
  const mine = join(vault, '.exposurie', 'pending', 'notes-to-self.md');
  writeFileSync(mine, 'my own scratch', 'utf8');

  reap(vault, []);
  assert.equal(existsSync(mine), true, 'deleted a file that was not a step of ours');
});

// ------------------------------------------------------ it stays clean
test('running it again does not re-litter the brain', () => {
  // scaffold never overwrites and is expected to be run twice; init runs
  // constantly. Either one re-recording a finished step would restore the bug
  // on the very next command.
  const { h, vault } = brain();
  doTheStep(h);
  run(h, ['init', '--at', vault]);

  run(h, ['scaffold', '--at', vault]);
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), false, 'scaffold re-recorded a completed step');

  run(h, ['init', '--at', vault]);
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), false, 'init re-recorded a completed step');
});

test('a declined step loses its reminder through the same path', () => {
  // Declining and completing are different answers that close a step the same
  // way, so they must leave the brain in the same state. decline() unlinks
  // directly for immediacy; this proves the mirror agrees rather than fights.
  const { h, vault } = brain();
  run(h, ['decline', 'claude-code-retention', '--because', 'i sync often', '--at', vault]);
  run(h, ['init', '--at', vault]);
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), false);
});

// ------------------------------------------- the command that matters
test('sync reaps, because sync is the only command typed repeatedly', () => {
  // The gap the first fix left, and the one that actually bites. `init` and
  // `scaffold` are typed ONCE at setup; `sync` is the loop a person lives in.
  // Mirroring only from the setup commands fixes the bug everywhere except
  // where a user would ever meet it — the step leaves the output as designed
  // and the file stays in the brain forever, still promising to delete itself.
  //
  // Deliberately exercised WITHOUT calling init or scaffold again, because
  // that is the whole scenario: setup happened once, and life is `sync`.
  const { h, vault } = brain();
  assert.equal(existsSync(pending(vault, 'claude-code-retention')), true);

  doTheStep(h);
  run(h, ['sync', '--at', vault]);

  assert.equal(
    existsSync(pending(vault, 'claude-code-retention')),
    false,
    'a user who lives in the sync loop never reaps, so the reminder is immortal',
  );
  assert.equal(existsSync(pending(vault, 'obsidian')), true, 'sync reaped a step that is still owed');
});

test('sync reaps a declined step too, on the recurring command', () => {
  const { h, vault } = brain();
  run(h, ['decline', 'obsidian', '--because', 'i read markdown in my editor', '--at', vault]);
  run(h, ['sync', '--at', vault]);
  assert.equal(existsSync(pending(vault, 'obsidian')), false);
});

// ------------------------------------------------- the two cannot split
test('writing and removing are one call, so a caller cannot do half', () => {
  // The structural fix, and the whole point. Calling reap() from each site
  // would leave exactly the gap that produced this bug: a future command wires
  // up record(), forgets the other half, and the reminders start accumulating
  // again with nothing failing.
  // sync is in this list for the reason the other two are not enough: it is the
  // only one of the three a person types more than once.
  for (const f of ['init.js', 'scaffold.js', 'sync.js']) {
    const src = readFileSync(join(ROOT, 'src', 'commands', f), 'utf8');
    assert.match(src, /mirror\(/, `${f} does not mirror its steps to disk`);
    assert.equal(
      /\brecord\(/.test(src),
      false,
      `${f} writes reminders directly, so nothing removes them when the step is done`,
    );
  }
});

test('mirror does both halves in one pass', () => {
  const { vault } = brain();
  const open = [STEPS['claude-web-export']];
  record(vault, STEPS['claude-code-retention']);

  const { written, gone } = mirror(vault, open);
  assert.deepEqual(written, ['claude-web-export']);
  assert.equal(gone.includes('claude-code-retention'), true, 'mirror wrote the open step but reaped nothing');
});

test('no brain, no writing, no crash', () => {
  assert.deepEqual(mirror(null, [STEPS['obsidian']]), { written: [], gone: [] });
  assert.deepEqual(reap(null, []), []);
});
