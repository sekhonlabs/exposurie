
// ==========================================================================
// THE GUARD: one invocation, and setup refuses rather than naming a dead one
// ==========================================================================
//
// This is defect 3 of the first outside install, and by 2026-08-29 it had
// appeared three times: the pointer (fixed 08-28, in reach.js and NOWHERE
// ELSE), then `uninstall`, then thirty-one other sites found by looking.
//
// Each time the fix was applied where the bug was REPORTED rather than where it
// lived, so each fix was correct and the class survived it. What was missing
// was never care -- it was a check that does not depend on anyone remembering.
//
// HOW THE PROPERTY CHANGED, 2026-08-29. The old guard ran every command on a
// PATH with nothing installed and asserted that no line named a bare
// `exposurie <cmd>` -- because a second, slower invocation existed to be named
// instead. That second form is gone. There is one spelling of every command on
// every machine, so "which form did it print" is no longer a question a test
// can ask.
//
// The invariant underneath it is unchanged and is now asserted directly: NO
// FILE IS EVER WRITTEN NAMING A COMMAND THE MACHINE DOES NOT HAVE. It is kept
// by refusing instead of by translating -- `scaffold` declines on a bare PATH
// and writes nothing at all. That is a stronger claim than the old one and a
// much easier one to check.
//
// And the second guard here exists because the removal is the kind that gets
// quietly undone: nothing this product prints, or writes into a brain, may
// contain the string `npx` ever again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { NAMES } from '../src/commands/names.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

/**
 * A bare `exposurie <cmd>`, not preceded by `/` or `@` -- so the PACKAGE name
 * never matches and the check stays honest.
 *
 * String.raw, and that is not a style choice. Written as an ordinary template
 * literal this reads `` `(^|[^\w/@-])exposurie (...)\b` ``, where `\w` is an
 * unknown escape that collapses to a literal `w` and `\b` becomes a BACKSPACE
 * character -- a regular expression that matches nothing, in a test that then
 * passes on every build forever. It did exactly that here, and was caught only
 * by breaking the fix on purpose and noticing the guard did not care.
 *
 * Which is this product's own signature bug wearing a test's clothes: a checker
 * that reports success while checking nothing is worth less than no checker,
 * because it also stops anyone else from looking.
 */
const BARE = new RegExp(String.raw`(^|[^\w/@-])exposurie (${NAMES.join('|')})\b`);

/** A home with a brain, a finished conversation, and an export -- so output is rich. */
function home(prefix) {
  const h = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  const dir = join(h, '.claude', 'projects', 'w');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'a.jsonl');
  writeFileSync(
    p,
    JSON.stringify({
      type: 'user',
      cwd: 'C:/w',
      sessionId: 's1',
      timestamp: '2026-08-20T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'a real typed sentence about a decision' }] },
    }) + '\n',
    'utf8',
  );
  // Backdated so it models a conversation that ENDED. sync correctly defers
  // anything still being written, and a fixture written this millisecond is one
  // -- which would leave the guard checking only the "nothing new" path, the
  // thinnest output the product has, instead of the staged plan where a
  // hardcoded command would actually hide.
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  return h;
}

/** That machine, with nothing named exposurie anywhere on PATH. */
function bare(h) {
  return { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), PATH: dirname(process.execPath), Path: dirname(process.execPath) };
}

/**
 * And the same machine after the one install step.
 *
 * A real file, because onPath() stats it -- the cheap version of that check
 * returned a false positive on a DIRECTORY named exposurie, so a fixture that
 * is not a file would be testing the bug rather than the fix.
 */
function installed(h) {
  const dir = join(h, 'fakebin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'exposurie.cmd' : 'exposurie'), '', 'utf8');
  const env = bare(h);
  const sep = process.platform === 'win32' ? ';' : ':';
  const PATH = `${dir}${sep}${env.PATH}`;
  return { ...env, PATH, Path: PATH };
}

function run(env, args) {
  try {
    return { out: execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env }), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

const CALLS = [
  ['init'], ['scaffold'], ['sync'], ['help'], ['uninstall'], ['decline'],
  ['read'], ['read', '--search', 'decision'], ['read', 'Nothing At All'],
  ['sync', '--done'], ['sync', '--done', '--abort'],
  ['nonsense'], ['--version'], ['scaffold', '--at', '/no/such/place'],
];

test('scaffold refuses on a machine with no install, and writes nothing', () => {
  // The invariant the old guard bought with a second invocation. Buying it by
  // refusing is stronger: there is no file left to be wrong.
  const h = home('exposurie-gate-');
  const r = run(bare(h), ['scaffold']);

  assert.equal(r.code, 10, 'a missing install is a step for a person, not a failure');
  assert.match(r.out, /NOT INSTALLED/, 'it has to say why it stopped');
  assert.match(r.out, /npm install -g @sekhon\/exposurie/, 'and name the one line that fixes it');
  assert.equal(existsSync(join(h, 'brain')), false, 'nothing may be written before the command exists');
});

test('nothing this product prints ever contains npx again', () => {
  // The removal this guard exists to make permanent, on 2026-08-29: one
  // invocation, everywhere, forever. Checked on BOTH machines, because the
  // whole point of the old fallback was that it appeared on only one of them.
  const withBrain = home('exposurie-clean-');
  const env = installed(withBrain);
  run(env, ['scaffold']);

  for (const machine of [bare(home('exposurie-clean-bare-')), env]) {
    for (const args of CALLS) {
      const { out } = run(machine, args);
      const bad = out.split('\n').filter((l) => /npx/i.test(l));
      assert.deepEqual(bad, [], `exposurie ${args.join(' ')} printed npx:\n  ${bad.join('\n  ')}`);
    }
  }
});

test('the calls that MUST name a command name the one invocation', () => {
  // Without this, a build that printed no commands at all would pass the guards
  // above by saying nothing -- and printing the exact next command is rule 3 of
  // the output contract. Named calls rather than a count, because "10 of 14 is
  // enough" is not a property anyone can reason about later.
  const h = home('exposurie-live-');
  const env = installed(h);
  run(env, ['scaffold']);

  const MUST = [
    [['init'], 'the first-run plan has to say what to run next'],
    [['help'], 'the help text lists reading and leaving as commands'],
    [['nonsense'], 'a usage error points at help'],
    [['sync'], 'a sync hands back the step that closes it'],
  ];

  for (const [args, why] of MUST) {
    assert.ok(
      BARE.test(run(env, args).out),
      `exposurie ${args.join(' ')} named no command at all — ${why}`,
    );
  }
});

test('the files copied into the brain name the command that runs there', () => {
  // sync.md is the file the agent is sent to on EVERY sync, and scaffold never
  // overwrites it -- so a wrong command in there is wrong for the life of the
  // brain. This reads what actually landed on disk rather than the template.
  const h = home('exposurie-tmpl-');
  run(installed(h), ['scaffold']);

  const brain = join(h, 'brain');
  const walk = (d, acc = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(md|txt)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };

  const files = walk(brain);
  assert.ok(files.length > 0, 'scaffold must actually have written the brain');

  let named = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const bad = text.split('\n').filter((l) => /npx/i.test(l));
    assert.deepEqual(bad, [], `${f} names npx:\n  ${bad.join('\n  ')}`);
    if (BARE.test(text)) named += 1;
  }
  assert.ok(named > 0, 'the brain has to tell the agent what to run');
});
