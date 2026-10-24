// Search, held to the failures it was rebuilt for.
//
// Through 1.2.0 a search was one substring match of the whole query. Replayed
// against the brains of the public benchmark (sekhonlabs/exposurie-bench), 23
// of the 61 searches agents actually typed came back empty: 6 rightly, for things
// the brain was never told, and 17 only because they were several words. In the
// benchmark's long task a fresh session
// searched three times, got nothing three times, was told to say so plainly,
// and went on without rules its brain held on pages titled with the very words
// it had searched for. Every test below is one of those shapes, or a guard on a
// rule that made the fix safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seamDefaults, writeSeam } from '../src/vault.js';
import { read } from '../src/commands/read.js';
import { allPages, fold } from '../src/read.js';
import { stem, words, parseQuery, matchWeight, probe, rank } from '../src/search.js';

const PAGES = {
  'concepts/Project Webhooks (ENG-447).md': `---
type: concept
tags: [webhooks, eng-447]
---
# Project Webhooks (ENG-447)

Outbound webhooks for project events, shipped dark behind a flag.

## Contract
- **Events:** \`project.<past-tense verb>\`.
- **Dead letters belong to staff, not customers.** Listing and replaying them goes under the admin routes only.
- **Retention:** deliveries are kept 45 days; a nightly job deletes anything older.

## Retention and cleanup
The nightly job runs at 03:00 and logs what it removed.

## Related
- [[Pull Request Conventions]] · [[Weekly Log]] · [[Nowhere At All]]
`,
  'concepts/Pull Request Conventions.md': `---
type: concept
---
# Pull Request Conventions

The template lives in the team handbook, not in any repo.

- **Branch:** ticket key + short slug, e.g. \`ENG-415-page-size-edge\`. Not a prefix directory.
- **Description, in this order:** Why, What changed, How I tested, Rollback.
`,
  'entities/Book Club.md': `---
type: entity
---
# Book Club

Six friends. The reading order is kept in a member Google Sheet.
`,
  'entities/Spending Summary.md': `---
type: entity
---
# Spending Summary

They already check Sheets on the phone, so the totals go there.
`,
  'entities/Inês.md': `---
type: entity
---
# Inês

A designer friend; she drew the logo.
`,
  'concepts/Letters of Recommendation.md': `---
type: concept
---
# Letters of Recommendation

Three LORs are needed, and two professors have agreed.
`,
  'concepts/Explorer Notes.md': `---
type: concept
---
# Explorer Notes

The file explorer opens in colour, and the floor plan is on the wall.
`,
  'concepts/Sixty Days — Summer Film.md': `---
type: concept
---
# Sixty Days — Summer Film

A short film shot over one summer.
`,
};

function weeklyLog() {
  // A long page that mentions webhooks only in passing, the shape that wins
  // when hits are counted raw rather than damped by length.
  const filler = 'Routine notes about the week, nothing in particular, more of the same. ';
  const parts = ['---', 'type: source', '---', '# Weekly Log', ''];
  for (let i = 0; i < 60; i++) {
    parts.push(`## Week ${i + 1}`, filler.repeat(8) + (i % 20 === 0 ? 'Someone mentioned webhooks again.' : ''), '');
  }
  return parts.join('\n');
}

function brain(budget) {
  const dir = mkdtempSync(join(tmpdir(), 'exposurie-search-'));
  for (const [rel, text] of Object.entries(PAGES)) {
    const p = join(dir, 'wiki', ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  mkdirSync(join(dir, 'wiki', 'sources'), { recursive: true });
  writeFileSync(join(dir, 'wiki', 'sources', 'Weekly Log.md'), weeklyLog(), 'utf8');
  const seam = seamDefaults('test');
  if (budget) seam.guards.maxReadChars = budget;
  writeSeam(dir, seam);
  writeFileSync(
    join(dir, 'index.md'),
    '# Index\n\n- [[Book Club]] — six friends, one shared sheet — 2026-10-01\n',
    'utf8',
  );
  return dir;
}

const out = (res) => res.body.join('\n');
const search = (dir, query) => out(read({ at: dir, search: query }));
const firstResult = (text) => text.match(/^\[1\] (.+?)(?:\s{3}\[|$)/m)?.[1];

// ---- the shapes that broke ----------------------------------------------------

test('a query is words, not a phrase: a page holding every word is found first', () => {
  const dir = brain();
  // The exact query a fresh session typed, which 1.2.0 answered with zero pages.
  const s = search(dir, 'dead letter replay deliveries cleanup');
  assert.equal(firstResult(s), 'Project Webhooks (ENG-447)');
  assert.doesNotMatch(s, /TOTAL: 0/);
  assert.doesNotMatch(s, /Say so plainly/);
});

test('the search hands back the rule itself, as written, not a pointer to it', () => {
  const dir = brain();
  const s = search(dir, 'dead letter replay deliveries cleanup');
  assert.match(s, /admin routes only/);
  assert.match(s, /kept 45 days/);
  // Real page text: every printed line of the page is in the file.
  const file = readFileSync(join(dir, 'wiki', 'concepts', 'Project Webhooks (ENG-447).md'), 'utf8');
  assert.ok(file.includes('Listing and replaying them goes under the admin routes only.'));
});

test('any form of a word: a plural finds the singular, and the other way round', () => {
  const dir = brain();
  // "google sheets" never found a page that said "a member Google Sheet".
  const s = search(dir, 'google sheets');
  assert.match(s, /Book Club/);
  assert.match(s, /Spending Summary/);
  const back = search(dir, 'sheet');
  assert.match(back, /Spending Summary/, '"Sheets" on a page answers a search for "sheet"');
});

test('a word is a word: a short query does not match inside a longer one', () => {
  const dir = brain();
  // A substring "lor" is inside "explorer", "colour" and "floor".
  const s = search(dir, 'LOR');
  assert.equal(firstResult(s), 'Letters of Recommendation');
  assert.doesNotMatch(s, /Explorer Notes/);
});

test('accents are ignored both ways', () => {
  const dir = brain();
  assert.equal(firstResult(search(dir, 'Ines logo')), 'Inês');
  assert.equal(firstResult(search(dir, 'Inês')), 'Inês');
});

test('a page about the thing outranks a long page that mentions it in passing', () => {
  const dir = brain();
  const s = search(dir, 'webhooks');
  assert.equal(firstResult(s), 'Project Webhooks (ENG-447)');
  assert.ok(s.indexOf('Weekly Log') > s.indexOf('Project Webhooks'), 'the long log ranks below');
});

test('every result says which words it has and which it lacks', () => {
  const dir = brain();
  const s = search(dir, 'webhooks kubernetes');
  assert.match(s, /No page has both words/);
  assert.match(s, /\[has: webhooks · lacks: kubernetes\]/);
  // And the closing line says what a missing word means.
  assert.match(s, /the brain does not\s+record it: say so rather than answering from memory/);
});

test('a miss is never the end: it says what to try before saying no', () => {
  const dir = brain();
  const s = search(dir, 'kubernetes helm');
  assert.match(s, /TOTAL: 0 pages match/);
  assert.match(s, /RUN: {2}exposurie read --search "<other words>"/);
  assert.match(s, /RUN: {2}exposurie read$/m, 'the catalog of every page is offered');
  assert.match(s, /Do not answer from memory\./);
  assert.doesNotMatch(s, /Say so plainly; do not answer from memory/);
});

test('the best pages are printed as written; the rest are listed and marked unread', () => {
  const dir = brain();
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(dir, 'wiki', 'entities', `Meridian Note ${i}.md`), `# Meridian Note ${i}\n\nMeridian, part ${i}.\n`);
  }
  const s = search(dir, 'meridian');
  assert.match(s, /^\[1\] Meridian Note \d\n {4}RUN: {2}exposurie read "Meridian Note \d"\n {4}The whole page, as written:\n\nMeridian, part \d\.$/m);
  assert.match(s, /NOT READ: \d+ more pages matched/);
  assert.match(s, /The pages only listed, you have NOT read\./);
});

test('text printed as written loses no line but the title, code examples included', () => {
  const dir = brain(3000);
  const long = 'More setup detail that goes on for a while. '.repeat(40);
  writeFileSync(
    join(dir, 'wiki', 'concepts', 'Setup Notes.md'),
    `# Setup Notes\n\nInstall it like this:\n\n\`\`\`bash\n# fetch the zebra package first\nnpm i zebra\n\`\`\`\n\n## Later\n\n${long}\n`,
  );
  const s = search(dir, 'zebra');
  assert.match(s, /The top of the page, as written:/, 'a long page prints the block that matched');
  assert.match(s, /^# fetch the zebra package first$/m, 'a # inside a code example is text, not a title');
  assert.doesNotMatch(s, /^# Setup Notes$/m, 'the title line is the one line left out');
});

test('a page that shares one word of several is listed, not printed', () => {
  const dir = brain();
  const s = search(dir, 'dead letter replay deliveries cleanup weekly');
  // Weekly Log has "weekly" only: one word of six is not worth its text.
  assert.ok(!/^\[\d\] Weekly Log/m.test(s), 'a one-word match must not be expanded');
});

test('every command a search prints opens what it says it opens', () => {
  const dir = brain();
  for (const query of ['dead letter replay deliveries cleanup', 'webhooks', 'google sheets', 'week']) {
    const s = search(dir, query);
    for (const m of s.matchAll(/RUN: {2}exposurie read "([^"]+)"(?: --section "([^"]+)")?(?: --nth (\d+))?$/gm)) {
      const [, title, section, nth] = m;
      const res = out(read({ at: dir, section, nth }, [title]));
      const want = section ? `${title} -> ${section}` : title;
      assert.ok(res.startsWith(want), `"${m[0]}" returned:\n${res.slice(0, 160)}`);
    }
  }
});

test('a search stays inside the read budget', () => {
  for (const budget of [3000, 6000, 16000]) {
    const dir = brain(budget);
    for (const query of ['webhooks', 'dead letter replay deliveries cleanup', 'week']) {
      const s = search(dir, query);
      assert.ok(s.length <= budget, `budget ${budget}, "${query}": ${s.length} chars`);
    }
  }
});

test('a long list of matches is cut to the budget, and says it was cut', () => {
  const dir = brain(1500);
  for (let i = 1; i <= 40; i++) {
    writeFileSync(
      join(dir, 'wiki', 'entities', `Meridian Harbour Planning Note ${i}.md`),
      `# Meridian Harbour Planning Note ${i}\n\nMeridian harbour, planning note ${i}.\n`,
    );
  }
  const s = search(dir, 'meridian harbour planning');
  assert.ok(s.length <= 1500, `${s.length} chars`);
  assert.match(s, /^\[1\] Meridian Harbour Planning Note/m, 'the best match is printed, however tight the budget');
  assert.match(s, /Showing \d+ of \d+\. Do NOT describe this list as complete\./);
});

// ---- reading by name ------------------------------------------------------------

test('a title that names no page is searched for on the spot', () => {
  const dir = brain();
  const s = out(read({ at: dir }, ['dead letters']));
  assert.match(s, /No page is titled "dead letters"\. Searched the brain for those words instead\./);
  assert.equal(firstResult(s), 'Project Webhooks (ENG-447)');
});

test('a title typed loosely still opens the page', () => {
  const dir = brain();
  // A hyphen for the em-dash, and [[brackets]] copied from a page.
  assert.ok(out(read({ at: dir }, ['Sixty Days - Summer Film'])).startsWith('Sixty Days — Summer Film'));
  assert.ok(out(read({ at: dir }, ['[[Book Club]]'])).startsWith('Book Club'));
  assert.ok(out(read({ at: dir }, ['ines'])).startsWith('Inês'));
});

test('a section that is not there names the closest, and never returns a different one', () => {
  const dir = brain();
  const s = out(read({ at: dir, section: 'cleanup policy' }, ['Project Webhooks (ENG-447)']));
  assert.match(s, /has no section named "cleanup policy"/);
  assert.match(s, /RUN: {2}exposurie read "Project Webhooks \(ENG-447\)" --section "Retention and cleanup"/);
  assert.doesNotMatch(s, /logs what it removed/, 'the closest section is named, not printed');
  assert.match(s, /--outline/);
});

test('a section name typed with a hyphen for its em-dash still resolves', () => {
  const dir = brain();
  const page = join(dir, 'wiki', 'concepts', 'Dashes.md');
  writeFileSync(page, '# Dashes\n\n## How it ships — and why\n\nShipping prose.\n', 'utf8');
  const s = out(read({ at: dir, section: 'How it ships - and why' }, ['Dashes']));
  assert.ok(s.startsWith('Dashes -> How it ships — and why'), s.slice(0, 120));
});

// ---- the catalog -------------------------------------------------------------------

test('read with nothing named lists every page, each with a command that opens it', () => {
  const dir = brain();
  const s = out(read({ at: dir }, []));
  const pages = allPages(dir, seamDefaults('test'));
  assert.match(s, new RegExp(`BRAIN: all ${pages.length} pages, every one listed`));
  for (const p of pages) {
    assert.ok(s.includes(`RUN:  exposurie read "${p.title}"`), `missing ${p.title}`);
    assert.ok(out(read({ at: dir }, [p.title])).startsWith(p.title), `${p.title} does not open`);
  }
  // What the index says of a page is its description; otherwise its first line.
  assert.match(s, /six friends, one shared sheet/);
  assert.match(s, /A designer friend; she drew the logo\./);
});

test('the catalog drops descriptions, then commands, before it drops a single page', () => {
  for (const [budget, shape] of [
    [700, /Each RUN line opens that page\./],
    [300, /by title only: too many to describe within one read/],
  ]) {
    const dir = brain(budget);
    const s = out(read({ at: dir }, []));
    assert.match(s, shape);
    assert.doesNotMatch(s, /six friends, one shared sheet/);
    for (const p of allPages(dir, seamDefaults('test'))) assert.ok(s.includes(`"${p.title}"`), `${budget}: ${p.title}`);
  }
});

test('a map of a large page lists the pages it links to, as commands', () => {
  const dir = brain();
  const s = out(read({ at: dir, outline: true }, ['Project Webhooks (ENG-447)']));
  assert.match(s, /LINKED FROM THIS PAGE: 2 pages/);
  assert.match(s, /RUN: {2}exposurie read "Pull Request Conventions"/);
  assert.match(s, /RUN: {2}exposurie read "Weekly Log"/);
  assert.doesNotMatch(s, /Nowhere At All/, 'a link to no page is not a doorway');
});

// ---- the rules underneath ---------------------------------------------------------

test('forms of one word meet at one key', () => {
  const same = [
    ['sheet', 'sheets', 'Sheet'],
    ['letter', 'letters'],
    ['delivery', 'deliveries'],
    ['replay', 'replays', 'replaying', 'replayed'],
    ['name', 'names', 'naming', 'named'],
    ['archive', 'archived', 'archiving', 'archives'],
    ['branch', 'branches', 'branching'],
    ['use', 'uses', 'using', 'used'],
    ['vote', 'votes', 'voting', 'voted'],
    ['run', 'running', 'runs'],
    ['plan', 'planned', 'plans'],
    ['reply', 'replies', 'replied', 'replying'],
    ['colour', 'color', 'colours'],
    ['organisation', 'organization'],
    ['licence', 'license', 'licensed'],
    ['analyse', 'analyze'],
    ['cancel', 'cancelled', 'canceled'],
    ['Inês', 'Ines'],
    ['PRs', 'PR'],
  ];
  for (const group of same) {
    const keys = new Set(group.map((w) => words(w)[0].key));
    assert.equal(keys.size, 1, `${group.join('/')} -> ${[...keys].join(', ')}`);
  }
});

test('different words keep different keys', () => {
  const apart = [
    ['note', 'not'],
    ['name', 'nam'],
    ['news', 'new'],
    ['case', 'cas'],
    ['hope', 'hop'],
    ['status', 'stat'],
    ['in', 'Inês'],
  ];
  for (const [a, b] of apart) assert.notEqual(stem(fold(a)), stem(fold(b)), `${a} and ${b} must stay apart`);
});

test('identifiers keep their digits and split at punctuation', () => {
  assert.deepEqual(
    words('ENG-447').map((w) => w.key),
    ['eng', '447'],
  );
  assert.equal(matchWeight('447', '4470'), 0, 'a number is never a prefix match');
});

test('a query drops its stopwords, unless it is nothing but stopwords', () => {
  assert.deepEqual(
    parseQuery('how does the owner name branches').terms.map((t) => t.key),
    ['owner', 'name', 'branch'],
  );
  assert.ok(parseQuery('who am I').terms.length > 0);
});

test('a long word reaches the words it begins, at half weight', () => {
  assert.equal(matchWeight('deploy', 'deployment'), 0.5);
  assert.equal(matchWeight('translat', 'translation'), 0.5);
  assert.equal(matchWeight('test', 'testament'), 0, 'not for short words');
});

test('the quick pass never skips a page the full match would keep', () => {
  // `rank` skips any page that does not contain a term's probe. That is only
  // safe if every word matching a term contains it — checked here over every
  // pair drawn from a vocabulary built to break it: added e's, y's, doubled
  // consonants, spelling folds, acronym plurals and accents.
  const vocab = [
    'vote', 'voting', 'voted', 'name', 'naming', 'try', 'tried', 'tries', 'copy', 'copies', 'use', 'using',
    'write', 'writing', 'stage', 'staging', 'plan', 'planned', 'run', 'running', 'reply', 'replied',
    'delivery', 'deliveries', 'deliver', 'delivered', 'colour', 'color', 'organisation', 'organization',
    'licence', 'license', 'centre', 'center', 'theatre', 'catalogue', 'programme', 'analyse', 'analysed',
    'promise', 'promising', 'exercise', 'exercising', 'PRs', 'APIs', 'IDs', 'Inês', 'Ines', 'tie', 'ties',
    'agree', 'agreed', 'archive', 'archiving', 'install', 'installed', 'deploy', 'deployment', 'translation',
    'travelled', 'cancelled', 'behaviour', 'favourite', 'defence', 'rise', 'rising', 'raise', 'noise',
  ];
  for (const a of vocab) {
    const qk = words(a)[0].key;
    for (const b of vocab) {
      const dk = words(b)[0].key;
      if (!matchWeight(qk, dk)) continue;
      assert.ok(fold(b).includes(probe(qk)), `"${b}" matches "${a}" but lacks its probe "${probe(qk)}"`);
    }
  }
});

test('ranking reads only what it was handed, and reports how many pages it searched', () => {
  const dir = brain();
  const pages = allPages(dir, seamDefaults('test'));
  const { searched, results } = rank(pages, 'webhooks');
  assert.equal(searched, pages.length);
  assert.ok(results.length >= 2);
});
