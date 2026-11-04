// Tests for leaving.
//
// remove() in reach.js was written with the reason attached — "a pointer we
// cannot remove is a pointer we have imposed" — and then no command called it
// for the life of the product. The pointer could go into every client's global
// instructions file and never come back out, which makes that sentence a claim
// the code did not support.
//
// Three properties, and the whole trust argument rests on them:
//
//   1. everything of ours goes          — including files we created
//   2. nothing of the user's moves      — byte-identical, not merely intact
//   3. the brain is never touched       — not by default, not by any flag
//
// The third is the one worth being paranoid about. Uninstall is the only place
// in this product where "remove what you installed" could be read as "remove
// the thing you built", and those are opposite acts. A test that only checked
// the folder still exists would pass on a version that emptied it, so the pages
// are counted too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { inject, remove, START, END } from '../src/reach.js';
import { NAMES } from '../src/commands/names.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

/** A machine with three clients on it, one of which has rules of its own. */
function home({ mine = 'my own rules\ndo not touch this line\n' } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-uninstall-'));
  for (const d of ['.claude', '.codex', '.cursor', 'Downloads']) mkdirSync(join(h, d), { recursive: true });
  mkdirSync(join(h, '.claude', 'projects', 'w'), { recursive: true });
  writeFileSync(
    join(h, '.claude', 'projects', 'w', 'a.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: 'C:/w',
      sessionId: 's',
      timestamp: '2026-08-20T10:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'a real typed sentence about a decision' }] },
    }) + '\n',
    'utf8',
  );
  if (mine !== null) writeFileSync(join(h, '.claude', 'CLAUDE.md'), mine, 'utf8');
  return h;
}

/**
 * A sandboxed machine that HAS exposurie installed -- a real file, because
 * scaffold refuses without one, and onPath() stats it.
 *
 * The PATH is sandboxed rather than inherited, and that is not tidiness. With
 * the real PATH these tests resolve the developer's OWN global install, and
 * since 2026-08-30 `uninstall` removes the package it finds -- so `npm test`
 * deleted it and the next 93 tests failed because scaffold refuses without one.
 * A fake binary with no node_modules beside it is not one npm placed, so the
 * removal declines and the suite cannot eat the machine it runs on.
 */
function sandboxPath(h) {
  const dir = join(h, 'fakebin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'exposurie.cmd' : 'exposurie'), '', 'utf8');
  return dir + (process.platform === 'win32' ? ';' : ':') + dirname(process.execPath);
}

function run(h, args) {
  const p = sandboxPath(h);
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local'), PATH: p, Path: p },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const CLAUDE = (h) => join(h, '.claude', 'CLAUDE.md');
const CODEX = (h) => join(h, '.codex', 'AGENTS.md');
const CURSOR = (h) => join(h, '.cursor', 'rules', 'exposurie.mdc');

// ------------------------------------------------------ everything goes
test('one command takes the pointer out of every client', () => {
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  for (const f of [CLAUDE, CODEX, CURSOR]) {
    assert.match(readFileSync(f(h), 'utf8'), new RegExp(START), 'the pointer was never installed');
  }

  const r = run(h, ['uninstall', '--at', vault]);
  assert.equal(r.code, 0);

  assert.equal(readFileSync(CLAUDE(h), 'utf8').includes(START), false, 'the pointer stayed in a file we wrote it to');
  assert.equal(existsSync(CODEX(h)), false, 'a file we created was left behind as an empty husk');
  assert.equal(existsSync(CURSOR(h)), false, 'the cursor rule file was left behind');
});

test('a file we created is deleted, not emptied', () => {
  // The husk bug. ~/.codex/AGENTS.md did not exist, scaffold wrote it, and
  // uninstall left one byte behind while reporting itself finished. A client
  // scanning that directory goes on loading nothing forever, and the user is
  // told their machine is clean when it is not.
  const h = home();
  assert.equal(existsSync(CODEX(h)), false, 'the fixture already had the file');

  run(h, ['scaffold', '--at', join(h, 'brain')]);
  assert.equal(existsSync(CODEX(h)), true);

  run(h, ['uninstall', '--at', join(h, 'brain')]);
  assert.equal(existsSync(CODEX(h)), false, 'left an empty file where there had been none');
});

// -------------------------------------------------- nothing of theirs
test('the user\'s own file comes back byte-identical', () => {
  // Not "their lines survived" — identical. A tool that hands back a file one
  // byte different from the one it was given has not really left, and the whole
  // reason to trust an uninstall is that you can check.
  const h = home();
  const before = readFileSync(CLAUDE(h));

  run(h, ['scaffold', '--at', join(h, 'brain')]);
  run(h, ['uninstall', '--at', join(h, 'brain')]);

  assert.deepEqual(readFileSync(CLAUDE(h)), before, 'the file was returned altered');
});

test('a block in the middle of a file leaves both sides alone', () => {
  const h = home({ mine: null });
  const p = join(h, 'rules.md');
  const original = 'top matter\n\n<!-- exposurie:start -->\nold\n<!-- exposurie:end -->\n\nbottom matter\n';
  writeFileSync(p, original, 'utf8');

  remove(p);
  const after = readFileSync(p, 'utf8');
  assert.match(after, /top matter/);
  assert.match(after, /bottom matter/);
  assert.equal(after.includes(START), false);
});

test('injecting then removing is a no-op, whatever the file looked like', () => {
  // Round-trip over the shapes a real global instructions file comes in. Every
  // one of these ends in a newline, because every editor writes one.
  const h = home({ mine: null });
  const shapes = ['one line\n', 'a\n\nb\n\nc\n', '# heading\n\n- a bullet\n', '- x\n- y\n\n## more\n\ntext\n'];
  shapes.forEach((text, i) => {
    const p = join(h, `f${i}.md`);
    writeFileSync(p, text, 'utf8');
    inject(p);
    remove(p);
    assert.equal(readFileSync(p, 'utf8'), text, `round trip altered a file shaped like: ${JSON.stringify(text)}`);
  });
});

test('the one deviation is the end of the file, normalised to a single newline', () => {
  // Named rather than hidden, and named accurately. inject() trims trailing
  // whitespace before appending, so how a file ENDED is gone before remove()
  // ever sees it — no final newline, or three of them, both come back as one.
  //
  // Content is never touched; only the run of whitespace at the very end. This
  // is pinned so the deviation cannot quietly grow, and so nobody reads the
  // byte-identical test above as covering more than it does.
  const h = home({ mine: null });
  for (const [given, expected] of [
    ['no trailing newline', 'no trailing newline\n'],
    ['trailing blanks\n\n\n', 'trailing blanks\n'],
    ['tabs and spaces  \n  \n', 'tabs and spaces\n'],
  ]) {
    const p = join(h, `d${given.length}.md`);
    writeFileSync(p, given, 'utf8');
    inject(p);
    remove(p);
    assert.equal(readFileSync(p, 'utf8'), expected, `deviation changed shape for ${JSON.stringify(given)}`);
  }
});

// ------------------------------------------------------- the brain lives
test('the brain is not touched, and its pages are still there', () => {
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);

  const page = join(vault, 'wiki', 'entities', 'A Person.md');
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, '# A Person\n\nsomething only they know.\n', 'utf8');

  run(h, ['uninstall', '--at', vault]);

  assert.equal(existsSync(vault), true, 'uninstall deleted the brain');
  assert.equal(readFileSync(page, 'utf8').includes('something only they know'), true, 'uninstall emptied the brain');
  assert.ok(readdirSync(vault).includes('CLAUDE.md'), 'the brain lost its schema');
});

test('no flag deletes the brain', () => {
  // Checked by grep as well as by behaviour: the guarantee is that the code to
  // delete it does not exist, not that the current flags happen to miss it.
  const src = readFileSync(join(ROOT, 'src', 'commands', 'uninstall.js'), 'utf8');
  assert.equal(/rmSync|rmdirSync|unlinkSync|rimraf/.test(src), false, 'uninstall contains code that deletes files');

  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  for (const flag of ['--full', '--done', '--json']) {
    run(h, ['uninstall', flag, '--at', vault]);
    assert.equal(existsSync(join(vault, 'CLAUDE.md')), true, `${flag} deleted the brain`);
  }
});

test('it says where the brain is on the way out', () => {
  // A person who uninstalls and cannot find what they built has lost it in
  // every way that matters.
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  const r = run(h, ['uninstall', '--at', vault]);
  assert.match(r.out, /YOUR BRAIN IS UNTOUCHED/);
  assert.ok(r.out.includes('brain'), 'the output does not name the brain folder');
});

// ------------------------------------------------------ it is the user's
test('it is a command a person can type, not a plan for an agent', () => {
  // Every other command here talks to an agent. Leaving does not get to require
  // one — a person who wants this gone should not have to ask a coding agent
  // nicely, so the output is in second person and hands out no relay work.
  const h = home();
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  const r = run(h, ['uninstall', '--at', vault]);

  assert.equal(/TELL YOUR USER/.test(r.out), false, 'uninstall is talking past the person who ran it');
  assert.equal(/ASK YOUR USER/.test(r.out), false, 'uninstall is asking an agent to relay something');
  assert.equal(/DO THESE IN ORDER/.test(r.out), false, 'uninstall handed back a plan instead of finishing');
  assert.match(r.out, /your brain/i, 'the output does not address the person who typed it');
});

test('it survives with no brain and no clients at all', () => {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-bare-'));
  const r = run(h, ['uninstall', '--at', join(h, 'nope')]);
  assert.equal(r.code, 0, 'uninstalling a machine with nothing on it should not fail');
});

test('it is reachable and it is named', () => {
  assert.equal(NAMES.includes('uninstall'), true);
  const help = run(home(), ['help']).out;
  assert.match(help, /uninstall/);
  assert.match(help, /LEAVING/, 'help does not tell a person how to leave');
});

// ------------------------------------------------- the retention ask
test('the retention step will not be done without an explicit yes', () => {
  // It edits a file belonging to software we do not own. The agent is told to
  // ask and wait, and told where to put a no — otherwise "ask" degrades into
  // "mention while doing it anyway" in an auto-approving session.
  const h = home();
  const r = run(h, ['init', '--at', join(h, 'brain')]);
  assert.match(r.out, /ONLY IF THEY SAID YES/);
  assert.match(r.out, /silence is not consent/);
  assert.match(r.out, /exposurie decline claude-code-retention/, 'a no has nowhere to go');
});

test('the number of days lives in one place', () => {
  const ctx = readFileSync(join(ROOT, 'src', 'context.js'), 'utf8');
  const pend = readFileSync(join(ROOT, 'src', 'pending.js'), 'utf8');
  assert.match(ctx, /KEEP_YEARS_DAYS = 3650/);
  assert.equal(/3650/.test(pend), false, 'pending.js has its own copy of the retention number');
  assert.match(pend, /KEEP_YEARS_DAYS/);
});
