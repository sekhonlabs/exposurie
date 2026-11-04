// The curator, tested by the failures it exists to prevent.
//
// This component's failure mode is NOISE, not misses. A checker that reports
// twenty false findings gets switched off in week one, and then it is worth
// nothing on the day something is actually wrong. So most of what is tested
// here is the tool DECLINING to report things — each case one of the classes
// that made the reference implementation's first run 29 findings, of which
// roughly 20 were false.
//
// The rest test the two edits that run unattended, because "lossless" and
// "no approval needed" is a combination that has to be earned rather than
// claimed.

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { curate, report } from '../src/curate.js';
import { headings, findSection, nthFor, outlineBlock, sectionCmd } from '../src/read.js';
import { seamDefaults, writeSeam } from '../src/vault.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ fixtures

function brain(pages = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'expo-curate-'));
  for (const [rel, text] of Object.entries(pages)) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  for (const [rel, text] of Object.entries(extra)) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  writeSeam(dir, seamDefaults('test'));
  return dir;
}

const seam = () => seamDefaults('test');
const page = (title, body, updated = '2026-01-01') =>
  `---\ntype: entity\ncreated: 2026-01-01\nupdated: ${updated}\ntags: []\n---\n\n# ${title}\n\n${body}\n`;
const kinds = (r) => [...r.broken, ...r.notice].map((f) => f.kind);

function git(dir, args, env = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function commit(dir, message, when) {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

// ------------------------------------------------------- the noise classes

test('a page describing the link syntax is not linking to a page called "wikilink"', () => {
  // Class 1, and the largest single source of false findings in the reference
  // implementation: prose ABOUT the convention, inside backticks. Code spans
  // are blanked before the graph is read.
  const v = brain({
    'wiki/concepts/Conventions.md': page(
      'Conventions',
      'Links are written `[[Page Name]]`, and an embed is `![[photo.jpg]]`.\n\n' +
        '```\n[[Another Example]]\n```\n',
    ),
  });
  const r = curate(v, seam());
  assert.deepEqual(r.broken.filter((f) => f.kind === 'DEADLINK'), []);
});

test('an embed resolves against the files in the brain, not its pages', () => {
  // Class 2. `![[photo.jpg]]` is an attachment reference. Resolving it against
  // the page namespace turns every image in a brain into a dead link.
  const v = brain(
    { 'wiki/entities/Trip.md': page('Trip', 'Here it is: ![[view.jpg]]') },
    { 'raw/view.jpg': 'not really a jpg' },
  );
  const r = curate(v, seam());
  assert.equal(r.broken.length, 0, JSON.stringify(r.broken));

  // And the finding still fires when the file genuinely is not there.
  const v2 = brain({ 'wiki/entities/Trip.md': page('Trip', 'Here it is: ![[gone.jpg]]') });
  assert.deepEqual(curate(v2, seam()).broken.map((f) => f.kind), ['MISSINGASSET']);
});

test('a link to a note that is not a wiki page still resolves', () => {
  // Class 4: THE LINK NAMESPACE IS BIGGER THAN THE PAGE NAMESPACE. A brain
  // holds loose notes and raw sources that are legitimate link targets and are
  // correctly not pages. Missing this reports working links as broken.
  const v = brain(
    { 'wiki/entities/Journal.md': page('Journal', 'See [[monday scratch]] for the rest.') },
    { 'monday scratch.md': '# whatever' },
  );
  assert.deepEqual(curate(v, seam()).broken, []);
});

test('a page that links a title once is not reported for mentioning it again', () => {
  // The convention is to link once, not on every mention. Reporting the plain
  // mentions after the link would make every well-written page a finding.
  const v = brain({
    'wiki/entities/Rate Limiting.md': page('Rate Limiting', 'A thing.'),
    'wiki/entities/Gateway.md': page(
      'Gateway',
      'It does [[Rate Limiting]] at the edge. Rate Limiting again, and Rate Limiting once more.',
    ),
  });
  assert.equal(curate(v, seam()).notice.filter((f) => f.kind === 'UNLINKED').length, 0);
});

test('a shorter title inside this page\'s own title is not a missing link to itself', () => {
  const v = brain({
    'wiki/entities/Rate Limiting.md': page('Rate Limiting', 'A thing.'),
    'wiki/entities/Rate Limiting — What Broke.md': page(
      'Rate Limiting — What Broke',
      'The incident. Rate Limiting was the cause.',
    ),
  });
  const hits = curate(v, seam()).notice.filter((f) => f.kind === 'UNLINKED');
  assert.deepEqual(hits.map((f) => f.page), []);
});

test('a commit too small to be work does not make a page look fresh', () => {
  // Class 3, and the one that does REAL damage rather than merely wasting
  // attention. A rename commit that fixed one wikilink is not the work
  // happening — bumping `updated:` there advertises a stale page as fresh,
  // which is the exact harm the check exists to prevent.
  const v = brain({
    'wiki/entities/Old.md': page('Old', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n\n'), '2026-02-01'),
  });
  git(v, ['init', '-q']);
  commit(v, 'the work', '2026-02-01T10:00:00');

  // A one-line touch, five months later. Nothing about the page changed.
  const p = join(v, 'wiki', 'entities', 'Old.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('a\n', 'a.\n'), 'utf8');
  commit(v, 'fix a link', '2026-07-01T10:00:00');

  assert.equal(curate(v, seam()).broken.filter((f) => f.kind === 'STALE').length, 0);

  // Substantive work on the same page IS reported, or the check is decoration.
  writeFileSync(p, readFileSync(p, 'utf8') + '\n' + Array(20).fill('new material.').join('\n'), 'utf8');
  commit(v, 'real work', '2026-07-02T10:00:00');
  const stale = curate(v, seam()).broken.filter((f) => f.kind === 'STALE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].newDate, '2026-07-02');
});

test('a brain with no git history reports nothing about dates, and does not crash', () => {
  // Every brain is in this state for its first few minutes, and most of a
  // stranger's pages are never committed at all. Nothing knows when they
  // changed, so nothing may call them stale.
  const v = brain({ 'wiki/entities/New.md': page('New', 'Body.', '2020-01-01') });
  const r = curate(v, seam());
  assert.equal(r.broken.filter((f) => ['STALE', 'NOFRONTMATTER'].includes(f.kind)).length, 0);
});

// ---------------------------------------------------- the unattended edits

test('the fixer fires on a line that already holds a link or a code span', () => {
  // The bug that made the reference implementation's fixer worthless: it
  // skipped any line containing `[[` or a backtick, and in a densely linked
  // brain that is nearly every prose line. Every finding it reported was
  // unfixable by the tool reporting it, which is a permanent nag — this
  // component's stated failure mode wearing a different hat.
  const v = brain({
    'wiki/entities/Gateway.md': page('Gateway', 'A thing.'),
    'wiki/entities/Edge.md': page('Edge', 'A thing.'),
    'wiki/entities/Notes.md': page(
      'Notes',
      'Running `npm test` against [[Edge]] showed Gateway was the problem.',
    ),
  });
  const r = curate(v, seam(), { fix: true });
  const text = readFileSync(join(v, 'wiki', 'entities', 'Notes.md'), 'utf8');
  assert.match(text, /\[\[Gateway\]\] was the problem/);
  assert.equal(r.fixed.length, 1);
});

test('the two auto-fixes only ever add, never remove', () => {
  // "Lossless" and "no approval needed" is a combination that has to be earned.
  // Both edits are additive by construction, and this is the assertion that
  // keeps them that way: every character that was in the file is still in it.
  const before = 'Running the [[Edge]] path, Gateway was the problem.';
  const v = brain({
    'wiki/entities/Gateway.md': page('Gateway', 'A thing.'),
    'wiki/entities/Edge.md': page('Edge', 'A thing.'),
    'wiki/entities/Notes.md': page('Notes', before),
  });
  curate(v, seam(), { fix: true });
  const after = readFileSync(join(v, 'wiki', 'entities', 'Notes.md'), 'utf8');
  assert.ok(after.includes(before.replace('Gateway', '[[Gateway]]')));
  assert.ok(after.length > before.length);
  // and nothing was deleted from the brain
  assert.ok(existsSync(join(v, 'wiki', 'entities', 'Edge.md')));
});

test('a page with a sibling rendered artifact is never cosmetically edited', () => {
  // Class 5, bought by damage rather than by noise: the tool linked a line in a
  // resume whose .md is hand-mirrored into an .html that prints a PDF.
  // Invisible in an editor, literal brackets on a document that goes to
  // strangers. Reported, never touched.
  const v = brain(
    {
      'wiki/entities/Gateway.md': page('Gateway', 'A thing.'),
      'wiki/syntheses/Resume.md': page('Resume', 'Built the Gateway service.'),
    },
    { 'wiki/syntheses/Resume.html': '<html>mirrored by hand</html>' },
  );
  const r = curate(v, seam(), { fix: true });
  const text = readFileSync(join(v, 'wiki', 'syntheses', 'Resume.md'), 'utf8');
  assert.ok(!text.includes('[[Gateway]]'), 'the resume was edited');
  assert.equal(r.fixed.length, 0);
  assert.equal(r.notice.filter((f) => f.kind === 'UNLINKED').length, 1, 'and it is still reported');
});

// --------------------------------------------------------- reaching zero

test('an allowlisted finding is retired, and the count of them is never silent', () => {
  // Some findings are TRUE and still correct to leave alone. Reported forever
  // they put a permanent floor under the count, and a report that cannot reach
  // zero is a report nobody reads. A SILENT allowlist would be the same bug
  // wearing the opposite mask, so the suppression count is always printed.
  const v = brain({
    'wiki/entities/Cadence.md': page('Cadence', 'The product.'),
    'wiki/entities/Substack.md': page('Substack', 'Publishing Cadence — not a schedule.'),
  });
  assert.equal(curate(v, seam()).notice.filter((f) => f.kind === 'UNLINKED').length, 1);

  mkdirSync(join(v, '.exposurie'), { recursive: true });
  writeFileSync(
    join(v, '.exposurie', 'curate-allow.txt'),
    '# an ordinary English word here, not the product\nwiki/entities/Substack.md|UNLINKED|Cadence\n',
    'utf8',
  );
  const r = curate(v, seam());
  assert.equal(r.notice.filter((f) => f.kind === 'UNLINKED').length, 0);
  assert.equal(r.suppressed, 1);
  assert.match(report(r, v).join('\n'), /1 reviewed earlier and correct as-is/);
});

test('the report prints the exact line that retires a finding', () => {
  // Rule 3 of the output contract: print the command, never the concept. A
  // retirement mechanism an agent has to infer the format of is a mechanism
  // that never gets used.
  const v = brain({ 'wiki/entities/A.md': page('A', 'See [[Nowhere]].') });
  const out = report(curate(v, seam()), v).join('\n');
  assert.match(out, /wiki\/entities\/A\.md\|DEADLINK\|Nowhere/);
});

// --------------------------------------------------- size is not a verdict

test('a large page is a number in the header, never a finding', () => {
  // It was a finding for exactly one measurement: on a real 67-page brain it
  // produced 14 of 17 entries, for pages working exactly as designed. And no
  // edit clears them — splitting a page to hit a number is the one thing the
  // owner of that brain ruled out. Unfixable findings are a permanent floor.
  const v = brain({
    'wiki/entities/Long.md': page('Long', Array(900).fill('Real material worth keeping.').join('\n\n')),
  });
  const r = curate(v, seam());
  assert.ok(!kinds(r).includes('OVERSIZE'), 'size came back as a finding');
  assert.equal(r.heavy.length, 1);
  assert.match(report(r, v).join('\n'), /read cost/);
});

// ------------------------------------------------- the librarian's guarantee

test('every section the outline advertises returns that section, on every page', () => {
  // The guarantee, checked the only honest way: generate the command for every
  // heading and assert each returns ITS OWN section. The corpus is the shapes
  // that have actually broken — including a page with a section named after
  // itself, which is what the curator's reachability pass found in the shipped
  // librarian. Before that fix, the outline printed a command with no --nth
  // for it, and the command matched two headings and returned neither.
  const pages = {
    'wiki/entities/Cadence.md':
      '# Cadence\n\nIntro.\n\n## What it is\n\nBody.\n\n## Cadence\n\nNamed after the page.\n',
    'wiki/entities/Ledger.md':
      '# Ledger\n\n## Related\n\nx\n\n## The miss: three unrelated columns\n\ny\n\n' +
      '## Repeated\n\nfirst\n\n## Repeated\n\nsecond\n\n## Fenced\n\n```bash\n# not a section\n```\n',
  };
  const v = brain(pages);

  let checked = 0;
  for (const [rel, text] of Object.entries(pages)) {
    const heads = headings(text);
    const nth = nthFor(heads);
    for (const h of heads) {
      if (h.level <= 1) continue;
      const { hit } = findSection(heads, h.text, nth.get(h));
      assert.equal(hit, h, `${rel}: ${sectionCmd('x', h.text, nth.get(h))} does not return its own section`);
      checked += 1;
    }
    // and the printed outline carries a command for every one of them
    const outline = outlineBlock('x', text, heads).join('\n');
    for (const h of heads) {
      if (h.level <= 1) continue;
      assert.ok(outline.includes(sectionCmd('x', h.text, nth.get(h))));
    }
  }
  assert.ok(checked >= 7, `only ${checked} sections checked`);

  // And the curator agrees: nothing on this brain is unreachable.
  assert.deepEqual(curate(v, seam()).broken.filter((f) => f.kind === 'UNREACHABLE'), []);
});

// ------------------------------------------------------------- index drift

test('a finding our own fix just resolved is not reported anyway', () => {
  // The noise class the tool produces ITSELF, and the one no guard above
  // covers. Linking a page nothing pointed at stops it being an orphan — so
  // reporting the orphan afterwards describes a brain that stopped existing
  // halfway through the run. Seen in the first real end-to-end run: the fixer
  // linked a page and the same output called it unreachable.
  const v = brain({
    'wiki/concepts/Queue Worker.md': page('Queue Worker', 'The worker that was deleted.'),
    'wiki/entities/myapp.md': page('myapp', 'Retries moved inline when the Queue Worker went.'),
  });

  const dry = curate(v, seam());
  assert.ok(
    dry.notice.some((f) => f.kind === 'ORPHAN' && f.file.includes('Queue Worker')),
    'nothing links it before the fix',
  );

  const r = curate(v, seam(), { fix: true });
  assert.equal(r.fixed.length, 1);
  assert.ok(
    !r.notice.some((f) => f.kind === 'ORPHAN' && f.file.includes('Queue Worker')),
    'reported as an orphan after being linked in the same run',
  );
  assert.ok(r.links > dry.links, 'and the graph really did gain the edge');
});

test('a page missing from the index is a finding, and a dead index entry is too', () => {
  const v = brain(
    { 'wiki/entities/Kept.md': page('Kept', 'x'), 'wiki/entities/Missing.md': page('Missing', 'y') },
    { 'index.md': '# Index\n\n- [[Kept]] — a page\n- [[Vanished]] — renamed away\n' },
  );
  const k = kinds(curate(v, seam()));
  assert.ok(k.includes('UNINDEXED'));
  assert.ok(k.includes('DEADINDEX'));
});

// -------------------------------------------- the stage inside the command

test('the curator\'s own edits are never mistaken for the pages being written', () => {
  // The one way this stage could do real damage. `--done` advances the cutoff
  // only when the brain changed since the batch was staged — that is what makes
  // an interrupted sync re-stage rather than lose material. A date the curator
  // bumped, or a link it added, is a change to the brain that is NOT the pages
  // being written. Left alone, it forges exactly that evidence and a batch gets
  // marked read that nothing ever read.
  const h = mkdtempSync(join(tmpdir(), 'expo-stage-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  const run = (args) => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'bin', 'exposurie.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') },
      });
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };
  run(['scaffold']);
  const v = join(h, 'brain');

  // A page the curator will want to edit, and a batch waiting to be filed.
  writeFileSync(join(v, 'wiki', 'entities', 'Gateway.md'), page('Gateway', 'A thing.'), 'utf8');
  writeFileSync(
    join(v, 'wiki', 'entities', 'Notes.md'),
    page('Notes', 'The Gateway was the problem.'),
    'utf8',
  );
  const statePath = join(v, '.exposurie', 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      files: {},
      pendingBatch: { id: 'b1', sessions: 1, files: {}, pagesAt: Date.now() },
      unfiled: 0,
    }),
    'utf8',
  );

  const out = run(['sync']); // nothing new -> the curate stage runs and fixes
  assert.match(out, /linked \[\[Gateway\]\]/, 'the curator did not actually edit anything');

  const done = run(['sync', '--done']);
  assert.match(done, /nothing in the brain has changed/, 'our own edit was accepted as evidence');
  assert.ok(
    JSON.parse(readFileSync(statePath, 'utf8')).pendingBatch,
    'the batch was closed on evidence the tool manufactured',
  );
});

test('no index file at all means no index findings, rather than one per page', () => {
  // A brain mid-scaffold, or one whose owner deleted the catalog on purpose.
  // Reporting every page as unindexed there is a wall of noise on the first run.
  const v = brain({ 'wiki/entities/A.md': page('A', 'x'), 'wiki/entities/B.md': page('B', 'y') });
  const k = kinds(curate(v, seam()));
  assert.ok(!k.includes('UNINDEXED'));
  assert.ok(!k.includes('DEADINDEX'));
});
