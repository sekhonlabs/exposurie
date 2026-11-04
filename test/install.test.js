// Tests for the install mode, and for the pointer that depends on it.
//
// THE BUG THESE PIN. The pointer written into every client's global
// instructions names a command, and for a whole release the documented way in
// left no such command on PATH. So setup wrote an instruction naming nothing,
// into the one file that loads on every message forever, and it failed
// SILENTLY: prose naming a missing command does not error, it simply never
// runs. Retrieval is the whole product and it was dead at rest.
//
// It was answered twice. First by carrying a second, slower invocation to name
// instead; then, on 2026-08-29, by deleting that second form and having
// `scaffold` REFUSE until the real command exists. These pin the second answer,
// which is the stronger one: there is no file left to be wrong.
//
// It could not be found on the machine this was built on, where the binary is
// on PATH for unrelated reasons. It took a real install on somebody else's
// laptop. So these tests do the thing that machine did: run the real CLI with a
// PATH that has no exposurie in it, and read what landed in the user's files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { onPath, installState, INSTALL, UNINSTALL } from '../src/install.js';
import { pointer, POINTER, reachAll } from '../src/reach.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-install-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  // A client, so there is something to write a pointer into.
  mkdirSync(join(h, '.codex'), { recursive: true });
  return h;
}

/** A directory holding a plausible `exposurie` binary, on every platform. */
function withBinary() {
  const d = mkdtempSync(join(tmpdir(), 'exposurie-bin-'));
  writeFileSync(join(d, 'exposurie'), '#!/bin/sh\n', 'utf8');
  writeFileSync(join(d, 'exposurie.cmd'), '@echo off\n', 'utf8');
  return d;
}

/** An empty directory, so PATH is well-formed but holds nothing of ours. */
const withoutBinary = () => mkdtempSync(join(tmpdir(), 'exposurie-nobin-'));

function run(h, args, path) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), PATH: path, Path: path },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const agentsFile = (h) => join(h, '.codex', 'AGENTS.md');

// ---------------------------------------------------------------- detection
test('a binary on PATH is found; an empty PATH finds nothing', () => {
  const d = withBinary();
  assert.ok(onPath({ PATH: d }, 'linux'), 'should resolve the posix name');
  assert.ok(onPath({ PATH: d }, 'win32'), 'should resolve the .cmd shim');
  assert.equal(onPath({ PATH: withoutBinary() }, 'linux'), null);
  assert.equal(onPath({ PATH: '' }, 'linux'), null);
});

test('a DIRECTORY named exposurie is not a command', () => {
  // The cheap version of onPath used existsSync and reported this as installed,
  // which would write a bare-command pointer on a machine that cannot run it.
  const d = mkdtempSync(join(tmpdir(), 'exposurie-dir-'));
  mkdirSync(join(d, 'exposurie'));
  assert.equal(onPath({ PATH: d }, 'linux'), null);
});

test('PATH is searched in order, across several entries', () => {
  const empty = withoutBinary();
  const real = withBinary();
  assert.ok(onPath({ PATH: [empty, real].join(delimiter) }, 'linux'));
});

test('installState answers permanent and invocation together, from one place', () => {
  const yes = installState({ PATH: withBinary() }, 'linux');
  assert.equal(yes.permanent, true);
  assert.equal(yes.invocation, 'exposurie');

  // `permanent` changes with the machine. `invocation` does not, and that is
  // the whole point of the 2026-08-29 removal: there is one spelling of every
  // command, so the only question left is whether it is there yet.
  const no = installState({ PATH: withoutBinary() }, 'linux');
  assert.equal(no.permanent, false);
  assert.equal(no.invocation, 'exposurie');
});

// ------------------------------------------------------------------ pointer
test('the pointer names the one invocation', () => {
  assert.match(pointer('exposurie'), /^ {4}exposurie read --search/m);
  assert.equal(pointer(), POINTER, 'the default is the only form');
});

test('reachAll writes a runnable pointer even when the caller passes no text', () => {
  // A caller that forgets to pass text must still write something runnable.
  // This is the whole class of bug: the component was correct and the default
  // was wrong, so every real caller inherited the wrong answer.
  const h = home();
  reachAll({ home: h });
  assert.match(readFileSync(agentsFile(h), 'utf8'), /\n {4}exposurie read --search/);
});

// ------------------------------------------------------- the end-to-end bug
test('REGRESSION: scaffolding with no exposurie on PATH writes nothing at all', () => {
  // The shipped bug was a pointer naming a command that did not exist. It is
  // now impossible by construction rather than by translation: there is no
  // pointer, because there was no scaffold.
  const h = home();
  const r = run(h, ['scaffold'], withoutBinary());

  assert.equal(r.code, 10, 'a missing install is a step for a person, not a failure');
  assert.match(r.out, new RegExp(INSTALL.replace(/[/@]/g, '\\$&')), 'it must name the one-line fix');
  assert.equal(existsSync(agentsFile(h)), false, 'no client file may be touched');
  assert.equal(existsSync(join(h, 'brain')), false, 'and no brain may be created');
});

test('scaffolding with the package installed writes the pointer', () => {
  const h = home();
  run(h, ['scaffold'], withBinary());
  assert.match(readFileSync(agentsFile(h), 'utf8'), /\n {4}exposurie read --search/);
});

test('scaffold says which command the pointer it just wrote actually names', () => {
  const h = home();
  const out = run(h, ['scaffold'], withBinary()).out;
  assert.match(out, /names\s+exposurie read --search/);
});

// --------------------------------------------------------------------- init
test('init makes the permanent install the FIRST step, before scaffold', () => {
  const out = run(home(), ['init'], withoutBinary()).out;
  assert.match(out, /NOT INSTALLED/, 'the state block must say so plainly');

  const install = out.indexOf(INSTALL);
  const scaffold = out.indexOf('exposurie scaffold');
  assert.ok(install > -1, 'the install line must be in the plan');
  assert.ok(scaffold > -1, 'scaffold must still be planned');
  assert.ok(install < scaffold, 'installing must come before the command that writes the pointer');
});

test('init does not nag about installing when it is already installed', () => {
  const out = run(home(), ['init'], withBinary()).out;
  assert.ok(!out.includes('NOT INSTALLED'));
  assert.ok(!out.includes(INSTALL), 'a step that does not apply is never printed');
});

// --------------------------------------------------------------- the repair
test('sync repairs a pointer an older release spelled differently', () => {
  // scaffold is typed ONCE, so whatever it wrote is what the user has forever
  // unless something later refreshes it. Releases before 2026-08-29 could write
  // a second, longer invocation here; this is the path by which those machines
  // heal without anybody being told to re-scaffold.
  const h = home();
  run(h, ['scaffold'], withBinary());

  const file = agentsFile(h);
  const stale = readFileSync(file, 'utf8').replace(
    /^ {4}exposurie read --search/m,
    '    npx -y @sekhon/exposurie read --search',
  );
  writeFileSync(file, stale, 'utf8');
  assert.match(readFileSync(file, 'utf8'), /npx -y/, 'the fixture has to actually be stale');

  run(h, ['sync'], withBinary());
  const after = readFileSync(file, 'utf8');
  assert.match(after, /\n {4}exposurie read --search/, 'the pointer must be rewritten');
  assert.ok(!after.includes('npx'), 'and the old spelling must be gone');
});

test('sync reaches a client that was installed after the brain was scaffolded', () => {
  const h = home();
  run(h, ['scaffold'], withBinary());
  mkdirSync(join(h, '.claude'), { recursive: true });

  run(h, ['sync'], withBinary());
  assert.match(readFileSync(join(h, '.claude', 'CLAUDE.md'), 'utf8'), /exposurie read --search/);
});

// ---------------------------------------------------------------- uninstall
test('uninstall states which of the two cases is actually true here', () => {
  const h = home();
  run(h, ['scaffold'], withBinary());

  const installed = run(h, ['uninstall'], withBinary()).out;
  assert.match(installed, new RegExp(UNINSTALL.replace(/[/@]/g, '\\$&')));

  const notInstalled = run(h, ['uninstall'], withoutBinary()).out;
  assert.match(notInstalled, /Nothing to remove/);
  assert.ok(
    !notInstalled.includes(UNINSTALL),
    'never print a removal line for a package that is not there',
  );
});

// ==========================================================================
// A command a machine does not have is never named without the way to get it
// ==========================================================================
//
// Defect 3 of the first outside install was the pointer naming `exposurie` on
// a machine where the documented way in left no such command behind. That was
// fixed in reach.js and NOWHERE ELSE, so the same literal stayed in the output
// of `init`, `scaffold` and `help` -- including in the one sentence that
// promises the whole thing is reversible.
//
// It is worse here than it was in the pointer, for one reason. Everywhere else
// an agent reads the output, and an agent that has just run the tool knows the
// invocation that worked and can recover from "command not found". `uninstall`
// is documented as the user's own -- typed by a person, in a terminal, with no
// agent involved -- so a name that does not resolve has nobody to notice it,
// at the exact moment somebody has decided to stop trusting the tool.
//
// WHAT THIS ASSERTS NOW, and why it changed on 2026-08-29. It used to assert
// that no output named `exposurie uninstall` on a machine without it, which was
// satisfiable only because a second, slower invocation existed to print
// instead. That form is gone: there is one spelling of every command, so `help`
// naming `exposurie uninstall` on a machine that has not installed yet is
// correct rather than a bug -- it is what the command WILL be, one line from
// now.
//
// The property that still matters, and is the one worth keeping: nobody is ever
// left holding a command they cannot run with no way forward. So any output
// that names one on an uninstalled machine must also name the install line.
// That is a weaker claim about spelling and a stronger one about the reader.

test('a command this machine lacks is never named without the way to get it', () => {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-leaving-'));
  mkdirSync(join(h, '.claude'), { recursive: true });

  // A machine where nothing installed exposurie. installState() scans PATH, so
  // removing the npm directory from it is the whole simulation.
  // NOTE: `scaffold` refuses outright here since 2026-08-29 -- that refusal is
  // itself output, and it must obey this rule like everything else.
  const bare = {
    ...process.env,
    HOME: h,
    USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'),
    PATH: dirname(process.execPath),
    Path: dirname(process.execPath),
  };
  const run = (args) => {
    try {
      return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: bare });
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };

  const NAMES_RE = /(^|[^/\w-])exposurie (init|scaffold|sync|read|decline|uninstall|help)\b/;

  // `uninstall` is exempt, and the exemption is the point rather than a gap:
  // telling somebody who is LEAVING to install the package would be absurd. It
  // has its own test above, which pins the opposite promise -- that it never
  // claims to remove a package that is not there.
  //
  // Worth knowing, found by this test and deliberately not fixed here: on a
  // machine with no brain, `uninstall` prints `RUN: exposurie init` from the
  // pending block. Handing a plan to somebody on their way out is a product
  // question, not an invocation one.
  for (const args of [['init'], ['scaffold'], ['help']]) {
    const out = run(args);
    if (!NAMES_RE.test(out)) continue;
    assert.ok(
      out.includes(INSTALL),
      `exposurie ${args[0]} names a command this machine does not have, and ` +
        `never says how to get it:\n${out}`,
    );
  }
});

test('the refusal to scaffold is itself output, and obeys the same rule', () => {
  // The one place the rule could quietly stop applying: a NEW early return that
  // nobody thought of as output. scaffold gained exactly such a return on
  // 2026-08-29.
  const h = mkdtempSync(join(tmpdir(), 'exposurie-gate-out-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  const bare = {
    ...process.env,
    HOME: h,
    USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'),
    PATH: dirname(process.execPath),
    Path: dirname(process.execPath),
  };
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, 'scaffold'], { encoding: 'utf8', env: bare });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  assert.ok(out.includes(INSTALL), 'the refusal must name the line that clears it');
});

test('...and the same output on an installed machine says the short form', () => {
  // Without this the test above passes on a build that never mentions leaving
  // at all, which would be a worse product and a green suite.
  const h = mkdtempSync(join(tmpdir(), 'exposurie-leaving-ok-'));
  mkdirSync(join(h, '.claude'), { recursive: true });
  const fake = join(h, 'bin');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, process.platform === 'win32' ? 'exposurie.cmd' : 'exposurie'), '', 'utf8');

  const withIt = { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), PATH: fake, Path: fake };
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', env: withIt });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  assert.match(out, /exposurie uninstall/, 'an installed machine should get the short command');
});
