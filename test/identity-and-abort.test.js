// Two smaller things the first outside install turned up, and one shape between
// them: work that cannot be taken back.
//
//   IDENTITY. A transcript is identified by its path, and a path is not unique.
//   An agent isolating one client by faking `HOME` reached the same files under
//   a second name, and the resume offsets are keyed by name — so the same
//   conversation was read twice, and would be written into somebody's brain
//   twice. The workaround that surfaced it does not matter: `~/.claude`
//   symlinked onto another drive is an ordinary thing to do.
//
//   ABORT. A batch staged by accident had no way out. Running `sync` again only
//   stages a second one beside it, `--done` refuses to close it — correctly,
//   since the pages were never written — and the folder and the pending record
//   sit there forever, with nothing to tell an agent which batch is live.
//
// The reason abort is safe to offer at all is the property that makes `--done`
// strict: the cutoff only ever moves on evidence. A batch that was never closed
// advanced nothing, so throwing it away cannot lose a conversation. The output
// says so, and the test below makes the promise true rather than reassuring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
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

function transcript(dir, text) {
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
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
      {
        type: 'assistant',
        cwd: 'C:/w',
        sessionId: 's1',
        timestamp: '2026-08-20T10:02:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok.' }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
    'utf8',
  );
  // Backdated: a conversation that has ENDED. sync correctly defers one that
  // has not, and a fixture written this millisecond is one.
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(p, past, past);
  return p;
}

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-ident-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  transcript(join(h, '.claude', 'projects', 'w'), 'SENTINEL: postgres over mysql, June cost us a week');
  return h;
}

/**
 * The same machine reached under a second name.
 *
 * A junction rather than a symlink: it needs no privileges on Windows, and on
 * POSIX the type argument is ignored and an ordinary symlink is made. Returns
 * null where the platform refuses, so a CI box without the right to make links
 * skips these rather than failing them.
 */
function aliasHome(h) {
  const fake = join(h, 'fake');
  mkdirSync(join(fake, 'Downloads'), { recursive: true });
  try {
    symlinkSync(join(h, '.claude'), join(fake, '.claude'), 'junction');
  } catch {
    return null;
  }
  return fake;
}

const state = (vault) => JSON.parse(readFileSync(join(vault, '.exposurie', 'state.json'), 'utf8'));
const batches = (vault) => {
  const d = join(vault, '.exposurie', 'staged');
  return existsSync(d) ? readdirSync(d) : [];
};
const pages = (vault) => readdirSync(join(vault, 'wiki', 'entities')).length;

/** Make the brain change, so `--done` has the evidence it insists on. */
function writeAPage(vault, name) {
  writeFileSync(
    join(vault, 'wiki', 'entities', `${name}.md`),
    `---\ntype: entity\ncreated: 2026-08-29\nupdated: 2026-08-29\ntags: []\n---\n\n# ${name}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------- identity
test('a transcript is identified by the file, not by the name it was reached through', (t) => {
  const h = home();
  const fake = aliasHome(h);
  if (!fake) return t.skip('this platform will not make links');

  run(fake, ['scaffold']);
  run(fake, ['sync']);

  const recorded = Object.keys(state(join(fake, 'brain')).pendingBatch.files);
  assert.equal(recorded.length, 1);
  assert.ok(
    !recorded[0].includes(`${'fake'}${recorded[0].includes('/') ? '/' : '\\'}.claude`),
    `the offset was keyed by the alias it was reached through:\n  ${recorded[0]}`,
  );
  assert.ok(
    recorded[0].endsWith(join('.claude', 'projects', 'w', 'a.jsonl')),
    `unexpected identity: ${recorded[0]}`,
  );
});

test('the same conversation reached by its other name is not read a second time', (t) => {
  // The whole point, end to end: one brain, two names for the same client tree.
  const h = home();
  const fake = aliasHome(h);
  if (!fake) return t.skip('this platform will not make links');

  run(h, ['scaffold']);
  const vault = join(h, 'brain');

  // A full cycle from the aliased home, so the offsets are actually applied.
  run(fake, ['sync', '--at', vault]);
  writeAPage(vault, 'Postgres');
  assert.match(run(fake, ['sync', '--done', '--at', vault]).out, /FILED/);

  // ...and now from the real one.
  const again = run(h, ['sync', '--at', vault]);
  assert.match(
    again.out,
    /NOTHING NEW/,
    'the same conversation was staged again under its other name',
  );
});

// ------------------------------------------------------------------- abort
test('a batch staged by accident can be thrown away', () => {
  const h = home();
  run(h, ['scaffold']);
  const vault = join(h, 'brain');

  run(h, ['sync']);
  assert.equal(batches(vault).length, 1, 'nothing was staged, so nothing is being tested');
  const before = pages(vault);

  const r = run(h, ['sync', '--abort']);
  assert.equal(r.code, 0);
  assert.match(r.out, /DISCARDED/);
  assert.equal(batches(vault).length, 0, 'the staged folder is still on disk');
  assert.equal(state(vault).pendingBatch, undefined, 'the pending record survived the abort');
  assert.equal(pages(vault), before, 'abort touched the brain');
  assert.equal(state(vault).lastSyncUtc, undefined, 'abort moved the cutoff');
});

test('...and the material really does come back, which is what the output promises', () => {
  // The output says "every conversation in it is still unread, and comes back
  // the next time you sync". That is a promise about somebody's own words, so
  // it is checked rather than reasoned about.
  const h = home();
  run(h, ['scaffold']);
  const vault = join(h, 'brain');

  run(h, ['sync']);
  assert.match(run(h, ['sync', '--abort']).out, /comes back/);

  assert.match(run(h, ['sync']).out, /^STAGED$/m, 'the aborted material never came back');
  const text = readFileSync(join(vault, '.exposurie', 'staged', batches(vault)[0], 'conversations.md'), 'utf8');
  assert.match(text, /SENTINEL/, 'it came back empty');
});

test('there is nothing to discard when nothing is staged, and it says so', () => {
  const h = home();
  run(h, ['scaffold']);
  const r = run(h, ['sync', '--abort']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /nothing to discard/);
  assert.match(r.out, /RUN: exposurie sync/);
});

test('--done and --abort together are refused, and nothing is removed', () => {
  // One closes a batch, the other throws it away. Guessing which they meant is
  // how a batch gets closed by somebody trying to get rid of it.
  const h = home();
  run(h, ['scaffold']);
  const vault = join(h, 'brain');
  run(h, ['sync']);

  const r = run(h, ['sync', '--done', '--abort']);
  assert.equal(r.code, 2);
  assert.match(r.out, /opposites/);
  assert.equal(batches(vault).length, 1, 'the batch was acted on anyway');
  assert.ok(state(vault).pendingBatch, 'the pending record was removed anyway');
});

test('abort is reachable — help says it exists', () => {
  // A capability nothing names is a capability nobody has. This product has
  // shipped three of those, all with passing tests.
  assert.match(run(home(), ['help']).out, /--abort/);
});
