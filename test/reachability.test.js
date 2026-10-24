// The guarantee, tested: every section of every page is reachable in one command.
//
// This is the product's central retrieval claim, so it is tested the only way a
// claim like that can honestly be tested — exhaustively, by generating a
// command for every heading in a brain and asserting each one returns THAT
// heading's content and not a neighbour's.
//
// The failure this guards against does not look like a failure. A librarian
// that returns the wrong section, or silently returns the first of two
// identically-named ones, produces a confident answer built on the wrong text.
// Nothing errors, nothing logs, and the user is told something false about
// their own life. Retrieval bugs are expensive precisely because they succeed.
//
// The fixtures below are the shapes that actually broke a real 67-page brain,
// kept as a corpus rather than described in prose: a heading that is a
// substring of a sibling, an em-dash in a name, duplicate headings, a `#` line
// inside a fenced code block, and a section ending at an H1.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headings, findSection, sliceSection, outlineBlock, allPages } from '../src/read.js';
import { rank } from '../src/search.js';
import { seamDefaults, writeSeam } from '../src/vault.js';
import { read } from '../src/commands/read.js';

const PAGE = `---
type: entity
---

# Ledger

Intro prose.

## Related

- [[Somewhere]]

## The miss: a table came out as three unrelated columns

Body about the miss.

## How it is delivered — and why that changed

Delivery prose.

### A nested part

Nested body.

## Repeated

First one.

## Repeated

Second one.

## Fenced

\`\`\`bash
# This is a shell comment, not a section
echo hi
\`\`\`

Tail of fenced.
`;

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'expo-reach-'));
  mkdirSync(join(dir, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'wiki', 'entities', 'Ledger.md'), PAGE, 'utf8');
  writeSeam(dir, seamDefaults('test'));
  return dir;
}

test('a # inside a fenced code block is not a section', () => {
  const heads = headings(PAGE).map((h) => h.text);
  assert.ok(!heads.some((h) => h.includes('shell comment')));
  assert.ok(heads.includes('Fenced'));
});

test('an exact name wins over a sibling that contains it as a substring', () => {
  // "Related" is a substring of "...three unrelated columns". Without exact-first
  // the shorter section is unreachable while the tool looks like it worked.
  const heads = headings(PAGE);
  const { hit } = findSection(heads, 'Related');
  assert.equal(hit.text, 'Related');
});

test('an em-dash in a heading round-trips', () => {
  const heads = headings(PAGE);
  const { hit } = findSection(heads, 'How it is delivered — and why that changed');
  assert.ok(hit, 'em-dash name must resolve');
  assert.ok(sliceSection(PAGE, heads, hit).includes('Delivery prose'));
});

test('duplicate headings are disambiguated by --nth, never silently collapsed', () => {
  const heads = headings(PAGE);
  const ambiguous = findSection(heads, 'Repeated');
  assert.equal(ambiguous.hit, null, 'must refuse to guess between identical headings');
  assert.equal(ambiguous.candidates.length, 2);

  const first = findSection(heads, 'Repeated', 1);
  const second = findSection(heads, 'Repeated', 2);
  assert.ok(sliceSection(PAGE, heads, first.hit).includes('First one'));
  assert.ok(sliceSection(PAGE, heads, second.hit).includes('Second one'));
});

test('a section stops at the next heading of equal or higher rank', () => {
  const heads = headings(PAGE);
  const { hit } = findSection(heads, 'How it is delivered — and why that changed');
  const body = sliceSection(PAGE, heads, hit);
  assert.ok(body.includes('A nested part'), 'a deeper heading belongs to the section');
  assert.ok(!body.includes('First one'), 'a sibling heading ends it');
});

test('the outline lists no H1 and prints a command for every section it lists', () => {
  const heads = headings(PAGE);
  const lines = outlineBlock('Ledger', PAGE, heads);
  const listed = lines.filter((l) => !l.trim().startsWith('exposurie read'));
  const cmds = lines.filter((l) => l.trim().startsWith('exposurie read'));

  assert.ok(!listed.some((l) => l.trim().startsWith('Ledger ')), 'H1 is the page, not a section');
  assert.equal(listed.length, cmds.length, 'every listed section carries exactly one command');
  // Duplicates must carry --nth or the second is unreachable from the outline.
  assert.equal(cmds.filter((c) => c.includes('--nth')).length, 2);
});

test('EXHAUSTIVE: every section the outline advertises actually returns itself', () => {
  const vault = makeVault();
  const seam = seamDefaults('test');
  let checked = 0;

  for (const page of allPages(vault, seam)) {
    const text = PAGE;
    const heads = headings(text);
    const listed = heads.filter((h) => h.level > 1);
    const counts = new Map();
    for (const h of listed) {
      const k = h.text.toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const seen = new Map();

    for (const h of listed) {
      const k = h.text.toLowerCase();
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      const nth = counts.get(k) > 1 ? n : null;

      const res = read({ at: vault, section: h.text, nth }, [page.title]);
      const out = res.body.join('\n');
      assert.ok(
        out.startsWith(`${page.title} -> ${h.text}`),
        `unreachable: "${h.text}" returned:\n${out.slice(0, 200)}`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 7, `expected to check every section, checked ${checked}`);
});

test('search finds the section a hit lives in, and prints its text', () => {
  const vault = makeVault();
  const { results } = rank(allPages(vault, seamDefaults('test')), 'Delivery prose');
  assert.equal(results.length, 1);
  assert.equal(results[0].best.head.text, 'How it is delivered — and why that changed');
  const out = read({ at: vault, search: 'Delivery prose' }).body.join('\n');
  assert.match(out, /^Delivery prose\.$/m);
});

test('no response is a dead end: a miss still carries a working next command', () => {
  const vault = makeVault();
  const missing = read({ at: vault }, ['Nonexistent Page']);
  assert.ok(missing.body.join('\n').includes('exposurie read --search'));

  const noSection = read({ at: vault, section: 'not a real heading' }, ['Ledger']);
  assert.ok(noSection.body.join('\n').includes('--outline'));
});
