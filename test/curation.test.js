// Tests for the two things that decide whether curation works for a stranger.
//
// Everything else in this product is verifiable: a transcript either parses or
// it does not, a section either opens or it does not. Curation quality is not
// checkable by any test, on any machine — which is exactly why the two
// mechanisms that shape it need guarding, because nothing downstream will
// report it when they break.
//
// One ships taste by example, since rules alone produce median pages. The other
// collects the user's own corrections so a schema that is somebody else's taste
// becomes theirs without them ever having to write it down.

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
  utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');
const TEMPLATES = join(ROOT, 'src', 'templates');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-curation-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
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

const brainOf = (h) => join(h, 'brain');
const dot = (h, ...p) => join(brainOf(h), '.exposurie', ...p);

/** Every `.exposurie/<name>` a shipped template tells the agent to open. */
function referenced() {
  const found = new Set();
  for (const name of readdirSync(TEMPLATES)) {
    const p = join(TEMPLATES, name);
    if (!name.endsWith('.md') && !name.endsWith('.txt')) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/\.exposurie\/([A-Za-z0-9_-]+\.(?:md|txt))/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

// -------------------------------------------------------------- the guard
test('every procedure file a template points at is one scaffold actually creates', () => {
  // The same class as "never print a command you do not have", one layer down.
  // A prompt that says READ .exposurie/x.md when nothing wrote x.md teaches the
  // agent that this brain's instructions are not worth following — and it does
  // not un-learn that when the file eventually ships. Nothing errors: the agent
  // shrugs and writes worse pages.
  //
  // Only `.md` and `.txt` are covered on purpose. Those are the documents an
  // agent is told to open. `staged/`, `pending/` and `state.json` are runtime
  // artifacts that sync creates later, and are legitimately absent here.
  const h = home();
  run(h, ['scaffold']);

  const missing = referenced().filter((f) => !existsSync(dot(h, f)));
  assert.deepEqual(missing, [], `templates point at files scaffold never wrote: ${missing}`);

  // And the scan is not vacuously passing.
  assert.ok(referenced().length >= 4, 'the scan found almost nothing — check the pattern');
  assert.ok(referenced().includes('how-they-work.md'));
  assert.ok(referenced().includes('examples.md'));
});

test('the guard catches a template pointing at a file that does not exist', () => {
  // A guard that cannot fail is decoration. Break it the way it would really
  // break — a prompt edited to reference a file nobody ships.
  const h = home();
  run(h, ['scaffold']);

  const fake = 'READ `.exposurie/nonexistent-procedure.md` before starting.';
  const scan = (text) => [...text.matchAll(/\.exposurie\/([A-Za-z0-9_-]+\.(?:md|txt))/g)].map((m) => m[1]);

  const names = scan(fake);
  assert.deepEqual(names, ['nonexistent-procedure.md']);
  assert.equal(existsSync(dot(h, names[0])), false, 'the fake file must not exist');
});

// ------------------------------------------------------ 1: taste by example
test('scaffold ships worked examples, and points at them before the first batch', () => {
  // Rules produce median pages. The difference between a brain and an archive
  // is taste, and taste transfers by example — so the examples have to arrive
  // AND be read, and being read is the half a file cannot do for itself.
  const h = home();
  const r = run(h, ['scaffold']);

  const p = dot(h, 'examples.md');
  assert.ok(existsSync(p), 'examples.md was not written');

  const text = readFileSync(p, 'utf8');
  // The contrast is the feature. A file of good pages alone does not teach the
  // difference, because the failure mode is a page that looks fine in isolation.
  assert.match(text, /## Three ways a page goes wrong/);
  assert.match(text, /Log-shaped/);
  assert.ok(text.includes('## A worked entity page'));

  assert.match(r.out, /examples\.md/, 'scaffold never told the agent to read it');
});

test('the shipped example is invented, not borrowed from a real brain', () => {
  // These pages are the product's taste made visible, so they are the likeliest
  // place for someone's real life to leak into a public package. The no-personal
  // -data scan covers names and paths; this covers the thing it cannot know —
  // that the example is meant to be a fiction.
  const text = readFileSync(join(TEMPLATES, 'examples.md'), 'utf8');
  assert.match(text, /The person below is invented/);
});

// ------------------------------------------- 2: the reconstructed correction loop
test('scaffold ships the taste file with nobody else\'s taste in it', () => {
  // It is the one file here whose content cannot ship. Arriving pre-filled
  // would hand a stranger someone else's preferences wearing the authority of
  // their own brain — and this file is defined to outrank the shipped defaults,
  // so a stray line in it is louder than anything in the prompt.
  const h = home();
  run(h, ['scaffold']);

  const text = readFileSync(dot(h, 'how-they-work.md'), 'utf8');
  assert.match(text, /## Recorded/);
  const recorded = text.split('## Recorded')[1];
  assert.match(recorded, /Nothing yet/);

  // The one worked line that does ship is inside an HTML comment, so it shapes
  // the format without ever reading as a rule this person actually stated.
  const live = recorded.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/^\s*-\s+\*\*/m.test(live), false, 'a rule is live in the Recorded section');
});

test('a re-run never clobbers taste the agent has collected', () => {
  // The highest-cost regression this feature can have. Every other file here is
  // written once and read forever; this one accumulates, so a scaffold that
  // topped it up like a template would silently delete months of the only
  // record of who this person is to work with — on a command that looks
  // idempotent and reports success.
  const h = home();
  run(h, ['scaffold']);

  const p = dot(h, 'how-they-work.md');
  const learned = '\n- **Decide, do not present options.** 2026-03-04. "just pick one."\n';
  appendFileSync(p, learned, 'utf8');

  const second = run(h, ['scaffold']);
  assert.equal(second.code === 0 || second.code === 10, true, 'second scaffold failed');

  const after = readFileSync(p, 'utf8');
  assert.ok(after.includes(learned.trim()), 'collected taste was lost on a re-run');
  assert.match(second.out, /not touched/);
});

test('sync reads their taste before the prompt it is allowed to overrule', () => {
  // Order is the whole claim. how-they-work.md is defined to win where it
  // disagrees with wiki-prompt.md, and an agent that reads the defaults first
  // has already formed its plan by the time the override arrives.
  const h = home();
  run(h, ['scaffold']);

  const dir = join(h, '.claude', 'projects', 'work');
  mkdirSync(dir, { recursive: true });
  const ts = (n) => new Date(Date.UTC(2026, 7, 20, 10, n)).toISOString();
  const lines = [
    {
      type: 'user',
      cwd: 'C:/work/thing',
      sessionId: 's1',
      timestamp: ts(1),
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'I dropped the ORM today. The reason is that migrations were the only ' +
              'part I could not reason about, and owning the SQL is cheaper than ' +
              'owning a leaky abstraction over it.',
          },
        ],
      },
    },
    {
      type: 'assistant',
      cwd: 'C:/work/thing',
      sessionId: 's1',
      timestamp: ts(2),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
    },
  ];
  writeFileSync(join(dir, 'a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  // A conversation that has ended, so the in-flight gate does not defer it —
  // see the note on `settled` in sync.test.js.
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(dir, 'a.jsonl'), past, past);

  const r = run(h, ['sync']);
  const taste = r.out.indexOf('how-they-work.md');
  const prompt = r.out.indexOf('wiki-prompt.md');

  assert.notEqual(taste, -1, 'sync never pointed at the taste file');
  assert.notEqual(prompt, -1, 'sync never pointed at the wiki prompt');
  assert.ok(taste < prompt, 'the defaults are read before the file that overrules them');
});

test('a decision is asked for as the rule it set, in the prompt and in every sync', () => {
  // Agents about to do the work read the brain and act on the wording. One read
  // a decision filed as a plan ("readers will put highlights") as another
  // agent's job and left it out; the same decision as a rule was kept. The
  // prompt is the user's once copied and an update never touches it, so the
  // line rides the sync output too, where a brain made before it still gets it.
  const h = home();
  run(h, ['scaffold']);
  assert.match(readFileSync(dot(h, 'wiki-prompt.md'), 'utf8'), /^### Write a decision as the rule it set$/m);

  const dir = join(h, '.claude', 'projects', 'work');
  mkdirSync(dir, { recursive: true });
  const ts = (n) => new Date(Date.UTC(2026, 7, 20, 10, n)).toISOString();
  const say = (type, text, n) => ({
    type, cwd: 'C:/work/thing', sessionId: 's1', timestamp: ts(n),
    message: { role: type, content: [{ type: 'text', text }] },
  });
  const lines = [say('user', 'Every importer keeps the original saved date.', 1), say('assistant', 'Noted.', 2)];
  writeFileSync(join(dir, 'a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(dir, 'a.jsonl'), past, past);

  const r = run(h, ['sync']);
  assert.match(r.out, /WRITE THE PAGES/);
  assert.match(r.out, /Write\s+each\s+decision\s+as\s+the\s+rule\s+it\s+set,\s+in\s+the\s+present\s+tense/);
});
