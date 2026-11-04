// Tests for the two surfaces a person and an agent can REACH FOR.
//
// The pointer in reach.js is handed to an agent on every message and has its
// own suite. These are the opposite: a skill the model picks up when it is
// asked in words, and a slash command a person types when they have decided
// to. Nothing was ever installed for either, which was half of item 3 of the
// first outside install — the report said the slash command was never
// installed, and the finding underneath was that there was none to install.
//
// What is pinned here is mostly not "it writes a file". It is the four ways
// this specific feature goes wrong quietly:
//
//   - naming a command that does not exist on the machine it was written on
//     (the exact failure that killed retrieval for a whole release),
//   - burying the loop in prose so a backlog drains one batch and stops,
//   - paying the always-loaded budget twice for a job the pointer already does,
//   - reaching one directory too far on the way out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  surfaces,
  surfacesAll,
  unsurfaceAll,
  skillDoc,
  commandDoc,
  COMMAND_NAME,
} from '../src/surfaces.js';
import { NAMES } from '../src/commands/names.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

const home = () => mkdtempSync(join(tmpdir(), 'exposurie-surfaces-'));

/** A home with the named clients present, so the skip-if-absent rule is exercised. */
function homeWith(...clients) {
  const h = home();
  for (const c of clients) mkdirSync(join(h, `.${c}`), { recursive: true });
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

const both = (cmd = 'exposurie', vault = '/b') => [skillDoc(cmd, vault), commandDoc(cmd, vault)];

// ------------------------------------------------------------------- the table

test('every target is markdown — the invariant that makes an unconfirmed path safe', () => {
  // Same rule as the pointer's table, and the same reason: a path we guessed
  // wrong writes prose nothing reads. A guessed .json or .toml could corrupt a
  // config the client depends on.
  for (const c of surfaces('/anywhere')) {
    assert.match(c.file, /\.(md|mdc)$/, `${c.id} target is not markdown`);
  }
});

test('Codex gets the typed surface and no skill, because it has nowhere to put one', () => {
  // The asymmetry is the honest part. Codex keeps user prompts, one file per
  // slash command, and has no skills directory to write into. Inventing one to
  // make the table look symmetrical would write a file nothing ever reads and
  // report it as installed.
  const kinds = (id) =>
    surfaces('/anywhere')
      .filter((c) => c.id === id)
      .map((c) => c.kind)
      .sort();

  assert.deepEqual(kinds('claude-code'), ['command', 'skill']);
  assert.deepEqual(kinds('cursor'), ['command', 'skill']);
  assert.deepEqual(kinds('codex'), ['command']);
});

test('a client that is not installed is skipped — no file, no directory', () => {
  const h = homeWith('claude');
  const ids = [...new Set(surfacesAll({ home: h, vault: '/b' }).map((c) => c.id))];

  assert.deepEqual(ids, ['claude-code']);
  assert.ok(!existsSync(join(h, '.cursor')), 'must not create a root for an absent client');
  assert.ok(!existsSync(join(h, '.codex')), 'must not create a root for an absent client');
});

// ------------------------------------------------- the command must be real

test('neither document names a command the tool does not have', () => {
  // Rule 3b, arriving on a surface that did not exist when the rule was
  // written. `init` once printed `RUN: exposurie scaffold` months before
  // scaffold existed; an agent taught once that the plan is not to be trusted
  // does not un-learn it when the command ships. These files are plans too.
  for (const doc of both()) {
    const found = [...doc.matchAll(/RUN:\s+\S*exposurie\s+([a-z][a-z-]*)/g)].map((m) => m[1]);
    assert.ok(found.length, 'a document with no RUN line is not a procedure');
    for (const name of found) {
      assert.ok(NAMES.includes(name), `names "exposurie ${name}", which does not exist`);
    }
  }
});

test('the skill and the command name the one invocation', () => {
  // THE failure of the first outside install, one surface over. The pointer
  // named a command that was not on PATH: correct prose naming a command that
  // is not there, erroring never, running never. A skill written the same way
  // fails the same way, and just as silently.
  //
  // Since 2026-08-29 there is one spelling and `scaffold` refuses to write any
  // of these until it resolves, so what is pinned here is that the files say
  // the one thing they are allowed to say.
  for (const doc of both('exposurie')) {
    assert.ok(doc.includes('RUN: exposurie sync'), 'must name the sync command');
    assert.ok(!/npx/i.test(doc), 'the second invocation is gone and must stay gone');
  }
});

// ------------------------------------------------------------------ the loop

test('the loop is a numbered step in both, never a sentence under one', () => {
  // Defect 2 of the first outside install, pinned so it cannot come back
  // through a new door. The instruction to continue WAS present — as prose
  // beneath the plan block — and rule 2 of the output contract says what
  // happens to those. A 165-session backlog drained only because a human typed
  // "continue" seven times.
  for (const doc of both()) {
    const step = doc.split('\n').find((l) => /^\d\.\s+GO BACK TO 1/.test(l));
    assert.ok(step, 'the loop must be a numbered step of its own');
    assert.match(doc, /do not ask\s+whether to continue|do not ask whether to continue/);
  }
});

test('nothing in either document waits for a person', () => {
  // Rule 1 reaching the newest surface. These are read by an agent with nobody
  // at the keyboard, so a step that reads as "check with your user first"
  // stops a sync that had no reason to stop.
  for (const doc of both()) {
    assert.ok(!/\[Y\/n\]|press enter|wait for (?:their )?(?:reply|confirmation)/i.test(doc));
    assert.match(doc, /Exit 10 is not a failure|Nothing new is a complete answer/);
  }
});

// ------------------------------------------------- the always-loaded budget

test('the skill description does not re-buy what the pointer already pays for', () => {
  // A skill's description is always-loaded, exactly like the pointer. The
  // pointer already fires on "a question about this user" on every message of
  // every project, so a second always-loaded trigger for the same job is the
  // context budget spent twice for nothing. The skill triggers on SYNCING.
  const front = skillDoc().split('---')[1];

  assert.ok(!/read --search/.test(front), 'retrieval is the pointer\'s job, not this one\'s');
  assert.ok(!/\bauthoritative\b/.test(front), 'the pointer makes that claim already');
  assert.match(front, /sync|file|update|catch up/i, 'it must fire on the job it actually owns');
});

test('the body says where retrieval lives, so the two surfaces do not compete', () => {
  // Not always-loaded, so it costs nothing — and without it an agent that
  // reached this skill for a question about the user would sync first, which
  // is slow, expensive and unnecessary: reading needs nothing synced today.
  assert.match(skillDoc(), /read --search/);
  assert.match(skillDoc(), /What this is not for/);
});

// ------------------------------------------------------------------- paths

test('the procedure path is built for the platform it will be opened on', () => {
  // Shipped and caught in one sitting: concatenating a separator produced
  // `C:\Users\...\brain/.exposurie/sync.md`, which happens to work and reads as
  // though nobody ran it. The product ships for two platforms.
  const vault = join('/anywhere', 'brain');
  const wanted = join(vault, '.exposurie', 'sync.md');

  for (const doc of both('exposurie', vault)) {
    assert.ok(doc.includes(wanted), `must contain ${wanted}`);
    assert.ok(
      !doc.includes(`${vault}/.exposurie`) || sep === '/',
      'must not mix separators in one path',
    );
  }
});

test('no line is long enough to wrap in a terminal', () => {
  // A person reads the command file having just typed the command. Prose
  // hard-wrapped mid-word by a terminal is the last place to be sloppy, and
  // these are the only files the product writes that a human reads directly.
  for (const doc of both('exposurie', join('/home', 'me', 'brain'))) {
    for (const line of doc.split('\n')) {
      assert.ok(line.length <= 78, `line is ${line.length} chars: ${line}`);
    }
  }
});

// -------------------------------------------------------------- writing them

test('a second run with the same brain changes nothing', () => {
  const h = homeWith('claude');
  surfacesAll({ home: h, vault: '/b' });
  const again = surfacesAll({ home: h, vault: '/b' });
  for (const c of again) assert.equal(c.action, 'unchanged', `${c.id} ${c.kind} was rewritten`);
});

test('a brain that moved is corrected, because these are ours and not theirs', () => {
  // The opposite of everything scaffold copies INTO the brain, which becomes
  // the user's and is never overwritten. These name a path and an invocation,
  // and a stale copy of either is a document that fails by never running.
  const h = homeWith('claude');
  surfacesAll({ home: h, vault: '/old' });
  const again = surfacesAll({ home: h, vault: '/new' });

  for (const c of again) assert.equal(c.action, 'updated');
  const cmd = readFileSync(join(h, '.claude', 'commands', `${COMMAND_NAME}.md`), 'utf8');
  assert.ok(cmd.includes(join('/new', '.exposurie', 'sync.md')));
  assert.ok(!cmd.includes(join('/old', '.exposurie', 'sync.md')));
});

// ------------------------------------------------------------- taking it back

test('uninstall removes every surface it wrote', () => {
  const h = homeWith('claude', 'cursor', 'codex');
  const written = surfacesAll({ home: h, vault: '/b' });
  for (const c of written) assert.ok(existsSync(c.file), `${c.id} ${c.kind} was not written`);

  const gone = unsurfaceAll({ home: h });
  for (const c of gone) {
    assert.equal(c.action, 'removed');
    assert.ok(!existsSync(c.file), `${c.id} ${c.kind} survived uninstall`);
  }
});

test('the folder we made for the skill goes; the client\'s own folders stay', () => {
  // The overreach, pinned. The first version of drop() pruned the parent of
  // whatever it deleted, which removed `~/.claude/commands/` whenever it
  // happened to be empty — a directory we did not create, holding every other
  // command the user will ever write. Small, and exactly the class that makes
  // somebody stop trusting a tool with their files.
  const h = homeWith('claude');
  surfacesAll({ home: h, vault: '/b' });
  unsurfaceAll({ home: h });

  assert.ok(!existsSync(join(h, '.claude', 'skills', 'exposurie')), 'our folder must go');
  assert.ok(existsSync(join(h, '.claude', 'skills')), "the client's skills folder must stay");
  assert.ok(existsSync(join(h, '.claude', 'commands')), "the client's commands folder must stay");
});

test('a command the user wrote themselves survives, and keeps its folder', () => {
  const h = homeWith('claude');
  const mine = join(h, '.claude', 'commands', 'deploy.md');
  mkdirSync(dirname(mine), { recursive: true });
  writeFileSync(mine, '# deploy\n', 'utf8');

  surfacesAll({ home: h, vault: '/b' });
  unsurfaceAll({ home: h });

  assert.equal(readFileSync(mine, 'utf8'), '# deploy\n', "the user's command must be untouched");
  assert.ok(!existsSync(join(h, '.claude', 'commands', `${COMMAND_NAME}.md`)), 'ours must go');
});

test('removing what was never written is not an error', () => {
  const h = homeWith('claude');
  for (const c of unsurfaceAll({ home: h })) assert.equal(c.action, 'absent');
});

// ------------------------------------------------------------- through the CLI

test('scaffold installs them, and tells the user what they can now type', () => {
  const h = homeWith('claude', 'cursor', 'codex');
  const r = run(h, ['scaffold']);

  assert.ok(existsSync(join(h, '.claude', 'skills', 'exposurie', 'SKILL.md')));
  assert.ok(existsSync(join(h, '.claude', 'commands', `${COMMAND_NAME}.md`)));
  assert.ok(existsSync(join(h, '.codex', 'prompts', `${COMMAND_NAME}.md`)));

  // The relay line is the point of the whole feature: the user never has to
  // ask an agent to sync, and never has to explain what syncing is.
  assert.match(r.out, new RegExp(`TELL YOUR USER: they can type /${COMMAND_NAME}`));
});

test('the relay line is only printed for surfaces a person can actually type', () => {
  // A skill is the agent's to reach for. Telling somebody they can "type" one
  // is telling them something untrue, and it is untrue on precisely the
  // machine where only a skill got installed.
  const h = homeWith('claude');
  const typed = surfacesAll({ home: h, vault: '/b' }).filter((c) => c.kind === 'command');
  assert.equal(typed.length, 1, 'this fixture is meant to have exactly one typed surface');
  assert.match(run(h, ['scaffold']).out, new RegExp(`/${COMMAND_NAME}`));
});

test('a client installed after setup gets them on the next sync', () => {
  // scaffold is typed once, so anything written only there is written only for
  // the clients that happened to exist that day. The pointer already carries
  // this argument and sync already re-runs it; the slash command has the
  // stronger version of the same problem, because a user who adds Cursor next
  // month would go on typing nothing at all, with the feature installed and
  // invisible to them.
  const h = homeWith('claude');
  run(h, ['scaffold']);
  assert.ok(!existsSync(join(h, '.cursor')), 'fixture must start without Cursor');

  mkdirSync(join(h, '.cursor'), { recursive: true });
  run(h, ['sync']);

  assert.ok(existsSync(join(h, '.cursor', 'commands', `${COMMAND_NAME}.md`)), 'no slash command');
  assert.ok(existsSync(join(h, '.cursor', 'skills', 'exposurie', 'SKILL.md')), 'no skill');
});

test('uninstall reports each surface by name, so a person can see it finished', () => {
  const h = homeWith('claude', 'cursor', 'codex');
  run(h, ['scaffold']);
  const out = run(h, ['uninstall']).out;

  for (const label of ['Claude Code skill', 'Claude Code command', 'Codex command']) {
    assert.ok(out.includes(label), `uninstall never mentioned ${label}`);
  }
});
