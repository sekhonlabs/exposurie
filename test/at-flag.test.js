// Tests for `--at`, which every command accepted and almost none obeyed.
//
// `detect()` took no arguments. `decline` and `uninstall` both called it as
// `detect({ at })` — passing an object to a function with no parameters, which
// JavaScript does in silence — and `sync` never forwarded the flag at all. So
// three commands accepted a path, discarded it, and acted on whichever brain
// the pointer named. Nothing threw. Every existing test happened to point
// `--at` at the same brain the pointer already named, so all of them passed.
//
// What that cost, in the order it matters:
//
//   read --at ~/typo --search x   answered "Nothing in the brain matches. Say
//                                 so plainly; do not answer from memory." at
//                                 exit 0, having never opened a brain. A
//                                 retrieval failure wearing the shape of an
//                                 answer is the worst output this tool makes.
//   sync --at <other brain>       staged the batch into the pointer's brain.
//   uninstall --at <anywhere>     printed "YOUR BRAIN IS UNTOUCHED" over a path
//                                 the user had not named.
//
// The rule now: `--at` names a brain OUTRIGHT and is never quietly replaced by
// the pointer's. A path holding no brain is refused by name, because carrying on
// against a brain nobody named is the failure the flag exists to prevent.
//
// Two deliberate exceptions are pinned here too, because both look like the bug
// from outside and a later reader will want to "fix" them:
//   - `init`/`scaffold` ask a different question — which brain already EXISTS —
//     and enforce one brain per person against the pointer, not against a flag.
//   - `uninstall` never refuses. Leaving must always finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** A machine with a brain and one finished conversation a sync would stage. */
function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-at-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  const dir = join(h, '.claude', 'projects', 'w');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'a.jsonl');
  writeFileSync(
    p,
    [
      {
        type: 'user',
        cwd: 'C:/w',
        sessionId: 's1',
        timestamp: '2026-08-20T10:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'SENTINEL: use postgres, mysql lost us a week' }] },
      },
      {
        type: 'assistant',
        cwd: 'C:/w',
        sessionId: 's1',
        timestamp: '2026-08-20T10:02:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'agreed, postgres.' }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
    'utf8',
  );
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  run(h, ['scaffold']);
  return h;
}

/**
 * A second, real brain, built under its own home so `scaffold` will make it.
 * One brain per person is enforced per machine, and that is the point: this is
 * the brain somebody names with `--at` precisely because it is not theirs.
 */
function otherBrain() {
  const h2 = mkdtempSync(join(tmpdir(), 'exposurie-at-other-'));
  mkdirSync(join(h2, 'Downloads'), { recursive: true });
  run(h2, ['scaffold']);
  return join(h2, 'brain');
}

const staged = (vault) => {
  const d = join(vault, '.exposurie', 'staged');
  return existsSync(d) ? readdirSync(d) : [];
};

// ------------------------------------------------------------------ the point
test('--at sends the work to the brain it names, not the one the pointer names', () => {
  const h = home();
  const other = otherBrain();
  const mine = join(h, 'brain');

  const r = run(h, ['sync', '--at', other]);
  assert.match(r.out, /^STAGED$/m, 'sync --at did not stage anything');
  assert.equal(staged(other).length, 1, 'the batch did not land in the brain that was named');
  assert.equal(staged(mine).length, 0, 'the batch landed in the pointer\u2019s brain instead');
});

test('a decline goes into the brain that was named, and only that one', () => {
  const h = home();
  const other = otherBrain();

  run(h, ['decline', 'claude-code-retention', '--because', 'i sync often', '--at', other]);

  assert.match(
    run(h, ['decline', 'claude-code-retention', '--at', other]).out,
    /ALREADY SET ASIDE/,
    'the decline was not recorded in the brain it was aimed at',
  );
  assert.doesNotMatch(
    run(h, ['decline', 'claude-code-retention', '--at', join(h, 'brain')]).out,
    /ALREADY SET ASIDE/,
    'the decline leaked into the brain the pointer names',
  );
});

test('uninstall names the brain it was given', () => {
  const h = home();
  const other = otherBrain();
  const out = run(h, ['uninstall', '--at', other]).out;
  assert.match(out, /YOUR BRAIN IS UNTOUCHED/);
  assert.ok(out.includes(other), 'uninstall named a brain the user did not name');
});

// -------------------------------------------------- a path with no brain in it
test('a named path with no brain is refused by name, and nothing is written', () => {
  const h = home();
  const mine = join(h, 'brain');
  const nowhere = join(h, 'not-a-brain');

  for (const args of [
    ['sync'],
    ['read', '--search', 'postgres'],
    ['decline', 'claude-code-retention', '--because', 'no'],
  ]) {
    const r = run(h, [...args, '--at', nowhere]);
    assert.equal(r.code, 2, `exposurie ${args[0]} --at <no brain> exited ${r.code}, not 2`);
    // Paths print through tilde(), so they arrive home-relative.
    assert.match(r.out, /~\/not-a-brain/, `${args[0]} did not name the path it was given`);
    assert.match(r.out, /against ~\/brain/, `${args[0]} did not name the brain this machine has`);
    assert.equal(staged(mine).length, 0, `${args[0]} acted on the pointer\u2019s brain anyway`);
  }
});

test('a search against a path with no brain never answers "nothing matches"', () => {
  // The specific output this whole fix exists for. `read` searched a directory
  // that was not there, found zero pages, and told the agent - with authority,
  // at exit 0 - that the brain does not contain the thing. An agent acts on that
  // by answering from memory, which is the one behaviour this product is built
  // to stop.
  const h = home();
  const r = run(h, ['read', '--search', 'postgres', '--at', join(h, 'not-a-brain')]);
  assert.doesNotMatch(r.out, /Nothing in the brain matches/);
  assert.doesNotMatch(r.out, /TOTAL: 0 pages match/);
  assert.notEqual(r.code, 0, 'a search that never opened a brain reported success');
});

test('the fix line is a command that actually runs', () => {
  // Rule 3 asks for the exact argv. `RUN: exposurie decline` on its own is a
  // usage error, so a generic `exposurie <name>` here would answer a broken
  // command with a second one.
  const h = home();
  const nowhere = join(h, 'not-a-brain');

  const dec = run(h, ['decline', 'claude-code-retention', '--because', 'i sync often', '--at', nowhere]).out;
  assert.match(dec, /RUN: exposurie decline claude-code-retention --because "i sync often"/);

  const rd = run(h, ['read', '--search', 'postgres', '--at', nowhere]).out;
  assert.match(rd, /RUN: exposurie read --search "postgres"/);

  const sy = run(h, ['sync', '--done', '--at', nowhere]).out;
  assert.match(sy, /RUN: exposurie sync --done/);
});

// --------------------------------------------------------- the two exceptions
test('uninstall never refuses — leaving always finishes', () => {
  // The one command that must not adopt the rule above. `--at` here only decides
  // which folder gets NAMED; nothing is read from it or written to it. Refusing
  // over a wrong path would strand our blocks in somebody's client files at the
  // exact moment they asked to be rid of them.
  const h = home();
  const r = run(h, ['uninstall', '--at', join(h, 'not-a-brain')]);
  assert.equal(r.code, 0, 'a wrong --at stopped someone from uninstalling');
  assert.match(r.out, /UNINSTALLED/);
  assert.match(r.out, /there is no brain there/, 'it did not say the path it was given was empty');
});

test('scaffold still refuses a second brain, because it asks a different question', () => {
  // init and scaffold call detect() with no argument on purpose: one brain per
  // person is enforced against the pointer, and honouring --at here would make
  // d.vault equal the asked path and this guard could never fire again.
  const h = home();
  const r = run(h, ['scaffold', '--at', join(h, 'second')]);
  assert.notEqual(r.code, 0, 'scaffold built a second brain');
  assert.equal(existsSync(join(h, 'second')), false, 'a second brain was created on disk');
});

// ------------------------------------------------------------- the silent hole
test('detect() takes the options its callers pass it', () => {
  // The mechanical cause, pinned directly. Two call sites read `detect({ at })`
  // while the declaration read `detect()`, and JavaScript discards the argument
  // without a word. Every symptom above is downstream of that one line, and a
  // future refactor dropping the parameter would restore all of them at once
  // while every behavioural test above still described the right intent.
  const src = readFileSync(join(ROOT, 'src', 'context.js'), 'utf8');
  assert.match(
    src,
    /export function detect\(\{[^}]*\}\s*=\s*\{\}\)/,
    'detect() no longer declares the options its callers pass',
  );
});
