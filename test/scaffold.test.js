// Tests for scaffold — the first command that writes anything.
//
// These run the real CLI as a child process against a throwaway HOME, because
// the things worth pinning here are about what lands on disk and what survives
// a second run. Testing the exported function would miss both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { NAMES } from '../src/commands/registry.js';
import { stateLine } from '../src/output.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-test-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  return h;
}

/** Run the real command. Returns its output and exit code, never throws. */
function run(h, args) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const brainOf = (h) => join(h, 'brain');

// ------------------------------------------------------------------ the rule
test('scaffold NEVER overwrites a file the user has edited', () => {
  // The whole ownership split rests on this. Every file copied in becomes the
  // user's, and a schema their agent tuned to their life is the goal rather
  // than drift — so a re-run that clobbered it would destroy the product's
  // central promise, silently, on a command that looks idempotent.
  const h = home();
  run(h, ['scaffold']);

  const schema = join(brainOf(h), 'CLAUDE.md');
  const mine = '\n## My own rule\n\nEvery paper page links its arXiv id.\n';
  appendFileSync(schema, mine, 'utf8');

  const second = run(h, ['scaffold']);
  assert.ok(readFileSync(schema, 'utf8').includes('My own rule'), 'the schema was overwritten');
  assert.match(second.out, /KEPT/, 'a re-run must report what it left alone');
  assert.match(second.out, /not touched/);
});

test('a user who adds a category gets it counted, because both sides read one config', () => {
  // The silent failure this prevents: the code hardcodes the category folders,
  // so a renamed folder means search quietly stops seeing part of the brain and
  // nothing reports it. The config is the seam that makes a rename safe.
  const h = home();
  run(h, ['scaffold']);

  const cfgPath = join(brainOf(h), '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.categories.people = 'wiki/people';
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  mkdirSync(join(brainOf(h), 'wiki', 'people'), { recursive: true });
  writeFileSync(join(brainOf(h), 'wiki', 'people', 'Someone.md'), '# Someone\n', 'utf8');

  const after = run(h, ['init']);
  assert.match(after.out, /1 page/, 'a page in a user-declared folder was not counted');

  // and their edit survives the next scaffold
  run(h, ['scaffold']);
  const kept = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(kept.categories.people, 'wiki/people');
});

test('the state line reports what is actually on disk, not a hardcoded zero', () => {
  // The state line is the retention mechanism — v1 sync is manual, so a number
  // riding on output the agent already reads is what stops a brain going stale
  // unnoticed. A constant there would make the whole mechanism decoration.
  const h = home();
  run(h, ['scaffold']);
  assert.match(run(h, ['init']).out, /exposurie\s+0 pages/);

  writeFileSync(join(brainOf(h), 'wiki', 'concepts', 'An Idea.md'), '# An Idea\n', 'utf8');
  writeFileSync(join(brainOf(h), 'wiki', 'entities', 'A Tool.md'), '# A Tool\n', 'utf8');
  assert.match(run(h, ['init']).out, /exposurie\s+2 pages/);
});

// ------------------------------------------------------------------ layout
test('scaffold builds the whole layout and hands over the files that are theirs', () => {
  const h = home();
  const r = run(h, ['scaffold']);
  const b = brainOf(h);

  for (const rel of [
    'CLAUDE.md',
    'AGENTS.md',
    'index.md',
    'log.md',
    '.gitignore',
    join('.exposurie', 'config.json'),
    join('.exposurie', 'wiki-prompt.md'),
    join('.exposurie', 'sync.md'),
    join('.exposurie', 'templates', 'entity.md'),
    join('wiki', 'sources'),
    join('wiki', 'entities'),
    join('wiki', 'concepts'),
    join('wiki', 'syntheses'),
    'raw',
  ]) {
    assert.ok(existsSync(join(b, rel)), `scaffold did not create ${rel}`);
  }

  // The pointer that lets any later command find the brain from any folder.
  const cfg = JSON.parse(readFileSync(join(h, '.exposurie', 'config.json'), 'utf8'));
  assert.equal(cfg.vault, b);

  // The two files most likely to need bending are named in the output, since
  // a handover nobody is told about is not a handover.
  assert.match(r.out, /CLAUDE\.md/);
  assert.match(r.out, /wiki-prompt\.md/);
});

test('scaffold gives local history and never creates a remote', () => {
  // No backup and the disk dies is bad, known and the user's own risk. We push
  // and a visibility setting is wrong once, and every conversation they have
  // ever had with an AI is public — irreversible, and our fault.
  const h = home();
  run(h, ['scaffold']);
  const b = brainOf(h);
  if (!existsSync(join(b, '.git'))) return; // git absent: reported, not fatal

  const remotes = execFileSync('git', ['remote'], { cwd: b, encoding: 'utf8' });
  assert.equal(remotes.trim(), '', 'scaffold created a remote');

  const log = execFileSync('git', ['log', '--oneline'], { cwd: b, encoding: 'utf8' });
  assert.ok(log.trim().length > 0, 'no commit to undo back to');
});

test('a second brain location is refused, never silently re-pointed', () => {
  // Re-pointing the config would orphan a brain that still holds everything,
  // with nothing saying so. Refusing is recoverable.
  const h = home();
  run(h, ['scaffold']);
  const elsewhere = join(h, 'other-brain');
  const r = run(h, ['scaffold', '--at', elsewhere]);

  assert.equal(r.code, 1);
  assert.ok(!existsSync(elsewhere), 'a second brain was created anyway');
  const cfg = JSON.parse(readFileSync(join(h, '.exposurie', 'config.json'), 'utf8'));
  assert.equal(cfg.vault, brainOf(h), 'the config was re-pointed');
});

// ------------------------------------------------------------------ honesty
test('the tool never prints a command it does not have', () => {
  // The failure this exists to prevent: `init` printed `RUN: exposurie scaffold`
  // while no such command existed, so an agent following the plan hit "no such
  // command" and had nothing to do with that. An agent taught once that the
  // plan is not to be trusted does not un-learn it when the command ships.
  const h = home();
  const outputs = [run(h, ['init']).out, run(h, ['scaffold']).out, run(h, ['init']).out];

  for (const out of outputs) {
    for (const m of out.matchAll(/RUN:\s+exposurie\s+([a-z][a-z-]*)/g)) {
      assert.ok(NAMES.includes(m[1]), `output names "exposurie ${m[1]}", which does not exist`);
    }
  }
});

test('a FIX line stays short, because it is never wrapped', () => {
  // FIX carries a command, and a wrapped command is a broken command — so it
  // is printed as-is. That only stays safe while every fix is short enough to
  // fit, which is what this pins.
  const h = home();
  run(h, ['scaffold']);
  const bad = run(h, ['scaffold', '--at', join(h, 'other-brain')]);
  const nonsense = run(h, ['definitely-not-a-command']);

  for (const out of [bad.out, nonsense.out]) {
    const line = out.split('\n').find((l) => l.includes('FIX:'));
    assert.ok(line, 'an error without a fix leaves the agent nothing to do');
    assert.ok(line.length <= 78, `FIX line is ${line.length} chars and will wrap: ${line}`);
  }
});

test('the files copied into a brain name no command either', () => {
  // The templates are output too — they are read by the agent working in the
  // brain, and a `RUN:` line in one fails exactly the same way as a `RUN:` line
  // on stdout. Prose describing a command that is coming is fine; an
  // instruction to run it is not.
  const dir = join(ROOT, 'src', 'templates');
  const walk = (d, acc = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else acc.push(p);
    }
    return acc;
  };
  for (const f of walk(dir)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/RUN:?\s+`?exposurie\s+([a-z][a-z-]*)/g)) {
      assert.ok(NAMES.includes(m[1]), `${f} tells the agent to run "${m[1]}", which does not exist`);
    }
  }
});

test('the sync nudge cannot point at a command that does not exist', () => {
  // stdout tests cannot reach this: the nudge only fires on a brain with
  // unfiled sessions or a week of staleness, and nothing writes that state
  // yet. It would start firing the moment something did.
  const nudged = stateLine({ vault: '/b', pages: 3, unfiled: 6, lastSyncDays: 9 }).join('\n');
  for (const m of nudged.matchAll(/RUN:\s+exposurie\s+([a-z][a-z-]*)/g)) {
    assert.ok(NAMES.includes(m[1]), `the state line nudges "${m[1]}", which does not exist`);
  }
});

test('an unknown command says which ones exist', () => {
  const h = home();
  const r = run(h, ['librarian']); // a real future command, not built yet
  assert.equal(r.code, 2);
  for (const n of NAMES) assert.match(r.out, new RegExp(n));
});

test('scaffold puts the pointer where every session will load it', () => {
  const h = home();
  mkdirSync(join(h, '.claude'), { recursive: true });
  writeFileSync(join(h, '.claude', 'CLAUDE.md'), '# mine\n\nkeep this\n', 'utf8');

  run(h, ['scaffold']);

  const global = readFileSync(join(h, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(global.includes('keep this'), 'the user config must survive scaffold');
  assert.match(global, /exposurie read --search/, 'the pointer must be installed');
  assert.ok(
    global.length < 1400,
    `the global file is paid on every message; got ${global.length} bytes`,
  );
});

// ------------------------------------------------------- the corrupt pointer
//
// The failure these pin: a config that exists but does not parse used to be
// indistinguishable from a machine with no brain. Every command then pointed at
// `exposurie init`, which cannot repair JSON, and following that into scaffold
// built a SECOND brain while the real one stayed referenced by the broken file.

function corrupt(h) {
  const p = join(h, '.exposurie', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  // Invalid JSON escapes — exactly what a hand-typed Windows path produces.
  writeFileSync(p, '{ "vault": "C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'someone' + String.fromCharCode(92) + 'brain" }', 'utf8');
  return p;
}

test('scaffold refuses on a corrupt pointer rather than orphaning a brain', () => {
  const h = home();
  corrupt(h);

  const r = run(h, ['scaffold']);
  assert.notEqual(r.code, 0, 'must not exit clean');
  assert.match(r.out, /could not be read/);
  assert.match(r.out, /orphan the brain you have/);
  assert.ok(!existsSync(join(h, 'brain')), 'no second brain may be created');
});

test('the fix names the file, and is not the old dead end', () => {
  const h = home();
  const p = corrupt(h);

  const r = run(h, ['scaffold']);
  assert.match(r.out, /FIX:  EDIT:/, 'the fix must point at the file');
  assert.ok(r.out.includes(p) || r.out.includes('config.json'), 'the path must be named');
  assert.ok(!/FIX:.*RUN: exposurie init/.test(r.out), 'init cannot repair JSON — never offer it');
});

test('read says the pointer is broken, not that there is no brain', () => {
  const h = home();
  corrupt(h);

  const r = run(h, ['read', '--search', 'anything']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /could not be read/);
  assert.ok(!/no brain on this machine yet/i.test(r.out), 'must not claim the brain is absent');
});

test('--at keeps working while the pointer is broken', () => {
  const h = home();
  corrupt(h);

  const r = run(h, ['scaffold', '--at', join(h, 'mybrain')]);
  // exit 10 is a pending HUMAN step, which the contract says is not a failure;
  // what matters is that the brain got built and no error was raised.
  assert.ok(r.code === 0 || r.code === 10, `unexpected exit ${r.code}`);
  assert.ok(!/could not be read/.test(r.out), 'an explicit path cannot be misled');
  assert.ok(existsSync(join(h, 'mybrain', 'CLAUDE.md')));
});

test('init reports the broken pointer and never offers scaffold', () => {
  const h = home();
  corrupt(h);

  const r = run(h, ['init']);
  assert.match(r.out, /pointer unreadable/);
  assert.ok(!/RUN: exposurie scaffold/.test(r.out), 'scaffold is the command that would orphan it');
});

test('the state line stops claiming there is no brain, and drops the arrow', () => {
  const h = home();
  corrupt(h);

  const r = run(h, ['scaffold']);
  assert.match(r.out, /brain location unknown/);
  assert.ok(!/no brain yet/.test(r.out), 'we cannot tell — saying so is a guess');
  assert.ok(!/-> RUN: exposurie init/.test(r.out), 'no command repairs this; the arrow would lie');
});

// --------------------------------------------------- the frontier tells truth
//
// `init` prints a SCOPE block. It rotted once in the direction
// nobody checks: it went on denying `read` and the client pointer for a whole
// release after both shipped, while `scaffold` printed the REACH table three
// lines below it. Denying a capability we have is the same lie as promising one
// we lack, so the block is pinned against what is actually built.

function frontier(out) {
  const i = out.indexOf('SCOPE');
  if (i === -1) return '';
  const rest = out.slice(i);
  const end = rest.indexOf('EXIT');
  return (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
}

test('the frontier never denies a capability that ships', () => {
  const h = home();
  const f = frontier(run(h, ['init']).out);

  // Every command in the table is, by definition, built.
  for (const name of NAMES) {
    if (name === 'help') continue;
    assert.ok(
      !f.includes(`exposurie ${name}`),
      `the frontier names \`${name}\`, which is in the command table`,
    );
  }
  // The two capabilities it wrongly denied, by the words it used for them.
  assert.ok(!f.includes('searching the brain'), 'read --search is built');
  assert.ok(!f.includes('registering it with your clients'), 'the pointer is built');
  // The third one it went on denying after it shipped. Curation is a stage of
  // sync rather than a command, which is exactly the shape that rots here: no
  // entry in the command table names it, so nothing else would catch the lie.
  assert.ok(!f.includes('curat'), 'the curator ships inside sync');
});

test('the frontier still names something, so it does not become decoration', () => {
  const h = home();
  const f = frontier(run(h, ['init']).out);
  assert.ok(f.length > 40, 'an empty frontier teaches an agent to stop reading it');
  assert.ok(f.includes('file'), 'file ingestion is the real frontier now');
});
