// Files the user put in their brain.
//
// `scaffold` created `raw/` from the first release and nothing ever read it.
// That is worse than an unbuilt feature: a folder the product makes and then
// ignores is an invitation it does not honour, and the person who drops a lease
// or a lecture PDF in there has no way to know it went nowhere.
//
// The division these tests hold: exposurie NOTICES, the agent OPENS. We never
// parse a document and never inline one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = new URL('../bin/exposurie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], opts), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

/** A brain with documents in it and no conversation anywhere on the machine. */
function brainWithFiles(files) {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-files-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  run(h, ['scaffold']);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(h, 'brain', 'raw', ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return h;
}

function stagedFile(h, name) {
  const dir = join(h, 'brain', '.exposurie', 'staged');
  const batch = readdirSync(dir).sort().pop();
  return readFileSync(join(dir, batch, name), 'utf8');
}

/**
 * Only the table of files the agent is told to open.
 *
 * `files.md` also DISCLOSES what was withheld and why, by name — that is the
 * point of it. So "is this file in the document" is the wrong question and
 * these assertions used to ask it: an excluded file appears in the page and
 * must not appear in the handover.
 */
function handedOver(h) {
  const text = stagedFile(h, 'files.md');
  const end = text.search(/^## /m);
  return end === -1 ? text : text.slice(0, end);
}

/** Write a page, so the cutoff is allowed to move. */
const writePage = (h) =>
  writeFileSync(join(h, 'brain', 'wiki', 'entities', 'Thing.md'), '# Thing\n', 'utf8');

// ---------------------------------------------------------------------------

test('a document dropped in the brain is found and handed over', () => {
  const h = brainWithFiles({ 'notes/lease.md': 'RENT-STABILIZED-CLAUSE-42' });
  const r = run(h, ['sync']);
  assert.match(r.out, /files/i, `files were never mentioned:\n${r.out}`);
  assert.match(stagedFile(h, 'files.md'), /raw\/notes\/lease\.md/, 'the file was not listed');
});

test('a document is pointed at, never parsed and never inlined', () => {
  // The division of labour. Inlining would mean shipping a document parser and
  // guessing at a size threshold — and the agent reads the real bytes better
  // than our idea of them.
  const h = brainWithFiles({ 'notes/lease.md': 'RENT-STABILIZED-CLAUSE-42' });
  run(h, ['sync']);
  assert.ok(
    !stagedFile(h, 'files.md').includes('RENT-STABILIZED-CLAUSE-42'),
    'the contents were inlined; exposurie is parsing documents it should be pointing at',
  );
});

test('the plan says to OPEN them, not just where the list is', () => {
  // A READ step used to drop its note. That was invisible until a step needed
  // to say what to do with what it points at: the page is a list of paths, and
  // "open every one of these" is the instruction.
  const h = brainWithFiles({ 'a.md': 'one' });
  const r = run(h, ['sync']);
  assert.match(r.out, /OPEN EACH ONE/, `the agent is handed a list with no instruction:\n${r.out}`);
});

test('files alone are a batch', () => {
  // Without this, somebody whose brain is entirely documents gets "nothing has
  // changed since the last sync" while the folder fills up — the same dead end
  // the claude.ai export used to be.
  const h = brainWithFiles({ 'a.md': 'one', 'b.csv': 'x,y' });
  const j = JSON.parse(run(h, ['sync', '--json']).out);
  assert.equal(j.staged, 0, 'this machine has no conversation on it');
  assert.equal(j.files.staged, 2, 'a files-only sync staged nothing');
});

test('a files-only batch does not report itself as three zeroes', () => {
  const h = brainWithFiles({ 'a.md': 'one' });
  const r = run(h, ['sync']);
  assert.ok(
    !/0 staged/.test(r.out) && !/0 chars/.test(r.out),
    `a working sync reads like a failed one:\n${r.out}`,
  );
});

test('a nested repository is a project, with no configuration', () => {
  const h = brainWithFiles({
    'proj/.git/HEAD': 'ref: x',
    'proj/index.js': 'code',
    'keep.md': 'note',
  });
  run(h, ['sync']);
  const given = handedOver(h);
  assert.match(given, /keep\.md/, 'a real note was dropped');
  assert.ok(!given.includes('proj/index.js'), 'source inside a nested repo was handed over as content');
  assert.match(stagedFile(h, 'files.md'), /has its own \.git/, 'the exclusion was never explained');
});

test('what cannot be read is reported, not silently skipped', () => {
  const h = brainWithFiles({ 'clip.mp4': 'not really a video', 'keep.md': 'note' });
  run(h, ['sync']);
  const list = stagedFile(h, 'files.md');
  assert.match(list, /Left alone/, 'a file nothing can read vanished without a word');
  assert.match(list, /clip\.mp4/);
});

test('excludeFiles is live policy, not a setting that does nothing', () => {
  // It shipped with a config note saying it would be read "once file ingestion
  // ships", and `fileExcluded()` was called from nowhere at all.
  const h = brainWithFiles({ 'private/taxes.md': 'SECRET-NUMBERS', 'keep.md': 'note' });
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.excludeFiles = ['private'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  run(h, ['sync']);
  const given = handedOver(h);
  assert.ok(!given.includes('taxes.md'), 'an excluded file was handed to the agent anyway');
  assert.match(given, /keep\.md/, 'the exclusion took everything with it');
  assert.match(stagedFile(h, 'files.md'), /Excluded by your settings/, 'the withholding was not disclosed');
});

test('an excluded file is never opened, only named', () => {
  const h = brainWithFiles({ 'private/taxes.md': 'SECRET-NUMBERS' });
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.excludeFiles = ['private'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const r = run(h, ['sync']);
  assert.ok(!r.out.includes('SECRET-NUMBERS'), 'excluded content reached the output');
});

test('a file already handed over is not handed over again', () => {
  const h = brainWithFiles({ 'a.md': 'one' });
  run(h, ['sync']);
  writePage(h);
  run(h, ['sync', '--done']);
  assert.match(run(h, ['sync']).out, /NOTHING NEW/, 'an unchanged file was staged twice');
});

test('an edited file comes back', () => {
  // A document is not append-only, so there is no offset to resume from — a
  // changed file is simply offered again.
  const h = brainWithFiles({ 'a.md': 'one' });
  run(h, ['sync']);
  writePage(h);
  run(h, ['sync', '--done']);

  writeFileSync(join(h, 'brain', 'raw', 'a.md'), 'one, and something new', 'utf8');
  const j = JSON.parse(run(h, ['sync', '--json']).out);
  assert.equal(j.files.staged, 1, 'an edited document was never re-offered');
});

test('the cutoff still refuses to move without pages', () => {
  // The evidence rule has to hold for a batch that is entirely documents, or an
  // interrupted files sync loses them.
  const h = brainWithFiles({ 'a.md': 'one' });
  run(h, ['sync']);
  const refused = run(h, ['sync', '--done']);
  assert.notEqual(refused.code, 0, 'the cutoff moved with nothing written');

  writePage(h);
  const accepted = run(h, ['sync', '--done']);
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /files\s+1 now marked as read/, 'the filing did not say what it filed');
});

test('a brain with nothing in raw/ is not told about files at all', () => {
  const h = brainWithFiles({});
  const r = run(h, ['sync']);
  assert.match(r.out, /NOTHING NEW/, r.out);
  assert.ok(!/files\.md/.test(r.out), 'an empty raw/ produced a file list anyway');
});
