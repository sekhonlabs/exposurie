// The defects the pre-1.2.0 audit found, pinned.
//
// They share a shape worth naming: every one produced output that was WRONG
// BUT WELL-FORMED. Nothing threw, nothing exited non-zero, and no existing
// test failed — the suite was 318 green while all of them were live. That is
// the only kind of bug left in a suite this healthy, and it is exactly the
// kind that survives a release nobody is going to patch for months.
//
// The worst of them is the one that reads best: `init` printed a `scaffold
// --at` command with an unquoted path, so on any machine whose owner has a
// space in their name the first command of the product built the brain in the
// wrong place and reported success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bytes, shrink } from '../src/output.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') };
  }
}

const home = () => mkdtempSync(join(tmpdir(), 'exposurie-fmt-'));

// ---------------------------------------------------------------- bytes()

test('a transcript smaller than a megabyte is not reported as 0.0 MB', () => {
  // `sync` spelled its own formatter twice as `(n / 1048576).toFixed(1) MB`, so
  // everything under ~50 KB printed `0.0 MB` — directly beside an exact
  // character count, which is where a rounded zero stops reading as rounding
  // and starts reading as broken. It is also precisely the first sync on a new
  // machine: the first number the product ever shows anyone.
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(999), '999 B');
  assert.equal(bytes(1024), '1 KB');
  assert.equal(bytes(15000), '15 KB');
  assert.equal(bytes(1048576), '1.0 MB');
  for (const n of [1, 500, 15000, 52428]) {
    assert.ok(!bytes(n).includes('0.0 MB'), `${n} bytes still renders as 0.0 MB`);
  }
});

test('bytes() never throws on a number it should not have been given', () => {
  // It formats a size read off a disk that can hand back anything.
  for (const n of [NaN, -1, undefined, null, Infinity]) {
    assert.equal(typeof bytes(n), 'string', `bytes(${n}) did not return a string`);
  }
});

// --------------------------------------------------------------- shrink()

test('the compression ratio never says "1x smaller", and never rounds up', () => {
  // Two rules in one line. "1x smaller" is a claim about a non-difference, and
  // it appeared exactly when the batch was small — the demo and the first run.
  // And because this ratio IS the extractor's whole pitch, it floors rather
  // than rounds: it may under-sell itself, never oversell.
  assert.equal(shrink(100, 100), '');
  assert.equal(shrink(150, 100), '', 'a 1.5x ratio was rounded up to 2x');
  assert.equal(shrink(199, 100), '');
  assert.equal(shrink(200, 100), '  (2x smaller)');
  assert.equal(shrink(4100, 100), '  (41x smaller)');
  assert.equal(shrink(0, 0), '');
});

test('one formatter, so the two spellings cannot drift apart again', () => {
  // The bug was a duplicate: `src/extract/files.js` had a correct B/KB/MB
  // formatter while `sync` hand-rolled a wrong one a few files away. Neither
  // was reachable from the other, so fixing one could never fix the other.
  const src = ['src/commands/sync.js', 'src/extract/files.js']
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n');
  assert.equal(
    /1048576\)\s*\)?\.toFixed/.test(src),
    false,
    'a hand-rolled megabyte formatter is back; import bytes() from output.js instead',
  );
});

// ----------------------------------------------------------------- --json

test('--json never answers with prose, for any command', () => {
  // `read --json` returned the human rendering at exit 0, because the writer
  // said `wantsJson && result.json` and `read` has no structured payload. A
  // machine caller got something that looked fine and would not parse — the
  // worst shape a failure takes, since nothing reports it.
  const h = home();
  run(h, ['scaffold']);
  for (const args of [['read', '--search', 'anything'], ['help'], ['init'], ['sync']]) {
    const r = run(h, [...args, '--json']);
    assert.doesNotThrow(
      () => JSON.parse(r.out),
      `exposurie ${args.join(' ')} --json did not return JSON:\n${r.out.slice(0, 200)}`,
    );
    assert.equal(JSON.parse(r.out).exit, r.code, `${args.join(' ')} --json disagreed with its own exit code`);
  }
});

test('a usage error still answers in JSON when JSON was asked for', () => {
  // The failing call is the one a programmatic caller most needs to parse.
  const h = home();
  const r = run(h, ['nosuchcommand', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.exit, 2);
  assert.equal(j.ok, false);
  assert.ok(j.error?.message, 'the JSON envelope dropped the error');
});

test('a --json inside somebody\'s search terms is data, not a flag', () => {
  // The writer decides the format from the PARSED flag rather than by scanning
  // raw argv for the string. Both spellings happen to agree today — this pins
  // that, so the cheaper scan cannot come back and quietly disagree.
  //
  // `--search=--json` is the only spelling that searches for the literal word:
  // the spaced form is rejected by parseArgs itself as ambiguous, which is the
  // right answer and is covered below.
  const h = home();
  run(h, ['scaffold']);
  const r = run(h, ['read', '--search=--json']);
  assert.throws(() => JSON.parse(r.out), 'the search term was read as the output flag');
  assert.match(r.out, /^exposurie /, 'the prose state line is missing');
});

test('an unparseable command line still exits 2 and still says why', () => {
  // Parsing failed, so there are no parsed values to consult and the writer
  // falls back to the argv scan. The requirement is only that this stays a
  // usage error that explains itself — not that it guesses what was meant.
  const h = home();
  const r = run(h, ['read', '--search', '--json']);
  assert.equal(r.code, 2, 'an ambiguous flag should be a usage error');
  assert.match(r.out, /ambiguous|EXIT 2/, 'the failure did not explain itself');
});

// --------------------------------------------------- printed commands run

test('no printed command names a path with a space in it unquoted', () => {
  // The rule this generalises: the tool never prints a command that does not
  // WORK. `init` printed `scaffold --at C:\Users\Priya Sharma\brain` with no
  // quotes, so an agent running the line built the brain at `C:\Users\Priya`,
  // said it had succeeded, and exited 10 — the code meaning "nothing failed".
  //
  // On Windows `C:\Users\First Last` is the ordinary shape of a home
  // directory, so this was the first command of the product being wrong on a
  // large share of the machines it had never run on. Checked across every
  // command rather than at the one site, because the next one will be printed
  // somewhere else.
  const h = mkdtempSync(join(tmpdir(), 'exposurie has a space '));
  const runs = [];
  for (const args of [['init'], ['scaffold'], ['sync'], ['help'], ['read', '--search', 'x'], ['uninstall']]) {
    const out = run(h, args).out;
    for (const line of out.split('\n')) {
      if (/\bRUN:/.test(line)) runs.push([args.join(' '), line]);
    }
  }
  assert.ok(runs.length > 0, 'no RUN lines were printed at all — the check proved nothing');

  for (const [from, line] of runs) {
    let i = line.indexOf(h);
    while (i !== -1) {
      assert.equal(
        line[i - 1],
        '"',
        `exposurie ${from} printed an unquoted path containing a space:\n  ${line.trim()}`,
      );
      i = line.indexOf(h, i + 1);
    }
  }
});

test('the printed scaffold command actually builds the brain where it says', () => {
  // The end-to-end version of the rule above: take the line the tool printed,
  // split it the way a shell does, and run it. The brain must land at the path
  // in the message and nowhere else.
  const h = mkdtempSync(join(tmpdir(), 'exposurie has a space '));
  const line = run(h, ['init']).out.split('\n').find((l) => /RUN:.*scaffold/.test(l));
  assert.ok(line, 'init did not offer a scaffold command');

  // Shell-style tokenising: quoted runs stay one argument.
  const argv = (line.slice(line.indexOf('RUN:') + 4).trim().match(/"[^"]*"|\S+/g) || [])
    .map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t))
    .slice(1); // drop the leading `exposurie`

  run(h, argv);
  assert.ok(existsSync(join(h, 'brain', 'CLAUDE.md')), 'the brain is not at the path the command named');
  assert.equal(
    existsSync(join(dirname(h), basename(h).split(' ')[0])),
    false,
    'a directory was created from the first word of the path — the argument was split',
  );
});

// ------------------------------------------------------------- the clock

test('a last-sync date in the future does not print a negative age', () => {
  // The state line is printed FIRST by every command, so a number that cannot
  // mean anything lands on every invocation. `last sync -5d ago` came from a
  // timestamp ahead of the clock — a brain restored onto a machine set wrong,
  // or carried across a timezone change.
  const h = home();
  run(h, ['scaffold']);
  const state = join(h, 'brain', '.exposurie', 'state.json');
  const ahead = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  writeFileSync(state, JSON.stringify({ lastSyncUtc: ahead }));

  const out = run(h, ['read', '--search', 'x']).out;
  assert.equal(/-\d+d ago/.test(out), false, `a negative age reached the state line:\n  ${out.split('\n')[0]}`);
  assert.match(out, /synced today/, 'a sync that has not happened yet should read as today');
});

test('an unparseable last-sync date reads as never, not as NaN', () => {
  const h = home();
  run(h, ['scaffold']);
  writeFileSync(join(h, 'brain', '.exposurie', 'state.json'), JSON.stringify({ lastSyncUtc: 'not a date' }));
  const out = run(h, ['read', '--search', 'x']).out;
  assert.match(out, /never synced/);
  assert.equal(/NaN/.test(out), false, 'NaN reached the output');
});

// ------------------------------------------------------- the curate report

test('a badly drifted brain does not print a finding per page', () => {
  // `sync` runs curate, and curate printed every finding it had with a
  // two-line explanation each. A brain whose index had fallen behind produced
  // 1,220 lines / 71 KB from ONE sync — four times the 16,000-character budget
  // this same product enforces on a single `read`, spent by the command that
  // runs most often, on a reader that re-pays for it every turn.
  const h = home();
  run(h, ['scaffold']);
  const dir = join(h, 'brain', 'wiki', 'concepts');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 200; i++) {
    writeFileSync(
      join(dir, `P${i}.md`),
      `---\ntype: concept\ncreated: 2026-08-01\nupdated: 2026-08-01\ntags: []\n---\n\n# P${i}\n\nBody.\n`,
    );
  }

  const out = run(h, ['sync']).out;
  assert.ok(out.length < 16000, `the curate report spent ${out.length} chars on one sync`);

  // Capped, not truncated: the count is still stated, and every DISTINCT kind
  // survives. Capping the list overall instead of per kind would have buried
  // the second kind entirely under the first.
  assert.match(out, /\d+ more \[UNINDEXED\]/, 'the unlisted findings were not counted');
  assert.match(out, /\[ORPHAN\]/, 'a whole finding kind was dropped rather than capped');
});

test('a small brain still prints every finding it has', () => {
  // The cap must be invisible below it — a handful of findings is the case
  // this report was designed for, and it should read exactly as it always did.
  const h = home();
  run(h, ['scaffold']);
  const dir = join(h, 'brain', 'wiki', 'concepts');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(
      join(dir, `Small ${i}.md`),
      `---\ntype: concept\ncreated: 2026-08-01\nupdated: 2026-08-01\ntags: []\n---\n\n# Small ${i}\n\nBody.\n`,
    );
  }
  const out = run(h, ['sync']).out;
  for (let i = 0; i < 3; i++) {
    assert.match(out, new RegExp(`Small ${i}\\.md`), `Small ${i} was not listed on a 3-finding brain`);
  }
  assert.equal(/more \[/.test(out), false, 'a brain under the cap should say nothing about unlisted findings');
});

// -------------------------------------------------------------- the flush

test('the whole of a large page reaches stdout', () => {
  // `process.exit()` on the line after `process.stdout.write()` does not wait
  // for the write on a Windows TTY. The tool is nothing but its output, so a
  // truncation here is silent and total.
  const h = home();
  run(h, ['scaffold']);
  const page = join(h, 'brain', 'wiki', 'concepts');
  mkdirSync(page, { recursive: true });
  const filler = Array.from({ length: 4000 }, (_, i) => `Line ${i} of a deliberately long page.`).join('\n');
  const file = join(page, 'Big Page.md');
  writeFileSync(
    file,
    `---\ntype: concept\ncreated: 2026-08-31\nupdated: 2026-08-31\ntags: []\n---\n\n# Big Page\n\n${filler}\n`,
  );
  const old = new Date(Date.now() - 6 * 3600 * 1000);
  utimesSync(file, old, old);

  const r = run(h, ['read', 'Big Page', '--full']);
  assert.ok(r.out.length > 100000, `output was only ${r.out.length} chars — it looks truncated`);
  assert.match(r.out, /Line 3999 of a deliberately long page\./, 'the end of the page never arrived');
  assert.match(r.out, /EXIT 0 — done\./, 'the footer never arrived');
});
