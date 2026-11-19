// `exposurie dates`, held to the review it shipped from.
//
// The feature came in as half of PR #6, beside a cloud mirror that was not
// accepted. The engine is that PR's: lines under `## Dated events`, dates
// checked against a real calendar, precision kept, page dates reported only as
// page dates. The first half of this file is its tests, ported.
//
// The second half pins the review's fixes, each where it broke:
//   - pages come from read.js's allPages(), so dates sees exactly what read
//     sees. The PR's own walker refused a brain with a category named `history`
//     that read opened fine, and dropped pages under folders named `raw`.
//   - a source counts when read would open it, and every command printed for a
//     source is run here and has to open the section it names. The PR's own
//     heading parser refused `[[Lang#C#]]`, which read opens.
//   - --search takes words the way read --search does, not one substring.
//   - the seven new flags are refused by every other command.
//   - text output names the first few skipped lines; --json carries them all.
//   - `*` and `+` bullets are events; a note indented under one is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queryDates } from '../src/dates.js';
import { parseEvent, KINDS } from '../src/dates-core.js';
import { allPages } from '../src/read.js';
import { readSeam } from '../src/vault.js';
import { NAMES } from '../src/commands/names.js';
import { pointer } from '../src/reach.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'exposurie.js');

/** Forward slashes, so a path compares the same on Windows as everywhere else. */
const slash = (p) => p.split(sep).join('/');

/**
 * A brain with two pages, at a path with a space in it, on a home of its own.
 * The space is deliberate: every RUN line dates prints that carries `--at` is
 * executed below, and an unquoted path would split there.
 */
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'exposurie-dates-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = join(home, 'the brain');
  const put = (rel, content) => {
    const p = join(vault, ...rel.split('/'));
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const configure = (updates = {}) =>
    put(
      '.exposurie/config.json',
      JSON.stringify({ categories: { entities: 'wiki/entities', sources: 'wiki/sources' }, raw: 'raw', ...updates }),
    );
  configure();
  put('.exposurie/state.json', '{"pendingBatch":{"id":"never-touch"}}');
  put(
    'wiki/sources/Evidence.md',
    '---\ntype: source\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Evidence\n## Verified facts\nCurated evidence.\n',
  );
  put('wiki/entities/Project.md', '---\ntype: entity\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Project\nNo events yet.\n');
  const events = (lines) =>
    put(
      'wiki/entities/Project.md',
      `---\ntype: entity\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Project\n## Dated events\n${lines.join('\n')}\n`,
    );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  const run = (...args) => {
    try {
      return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env }), code: 0 };
    } catch (e) {
      return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
    }
  };
  return { home, vault, put, events, configure, run };
}

const event = (date, kind = 'decision', summary = 'Choose a simpler design', source = '[[Evidence#Verified facts]]') =>
  `- ${date} | ${kind} | ${summary} | ${source}`;

/**
 * A printed command, split the way a shell splits it. Double quotes group, and
 * `\"` inside them is a quote, which is the only escape q() writes.
 */
function argv(line) {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2],
  );
}

/** The RUN lines of some output, as argv without the leading `exposurie`. */
function runLines(out, filter = () => true) {
  return out
    .split('\n')
    .filter((l) => /^\s*(FIX:\s+)?RUN:\s+exposurie /.test(l) && filter(l))
    .map((l) => argv(l.replace(/^\s*(FIX:\s+)?RUN:\s+/, '')).slice(1));
}

/** Every file under a folder, with its bytes and mtime. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[slash(relative(dir, p))] = `${fs.readFileSync(p).toString('base64')} @ ${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

// ============================================================================
// The engine, as PR #6 specified it
// ============================================================================

test('event dates stay apart from page dates and from dates mentioned in prose', (t) => {
  const { vault, put } = fixture(t);
  put(
    'wiki/entities/Project.md',
    `---\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Project\nDiscussed on 2026-08-20.\n## Dated events\n${event('2026-08-21')}\n## Other notes\n${event('2026-01-01')}\n`,
  );
  const result = queryDates(vault);
  assert.equal(result.readOnly, true);
  assert.equal(result.total, 1);
  assert.deepEqual(result.coverage, {
    mode: 'explicit-dated-events-only',
    events: 1,
    pagesWithEvents: 1,
    pagesWithoutEvents: 1,
  });
  assert.deepEqual(result.items[0], {
    date: '2026-08-21',
    dateEnd: null,
    dateText: '2026-08-21',
    precision: 'day',
    field: 'events',
    title: 'Project',
    path: 'wiki/entities/Project.md',
    line: 8,
    kind: 'decision',
    summary: 'Choose a simpler design',
    source: '[[Evidence#Verified facts]]',
    sourceTitle: 'Evidence',
    sourceSection: 'Verified facts',
  });
  const metadata = queryDates(vault, { field: 'updated', on: '2026-11-16' });
  assert.equal(metadata.total, 2);
  assert.ok(metadata.items.every((item) => item.field === 'updated' && item.source === null && item.kind === null));
  assert.equal(queryDates(vault, { field: 'created', on: '2026-08' }).total, 0);
  assert.equal(queryDates(vault, { field: 'all' }).total, 5);
});

test('a range or a month matches by overlap and keeps the precision it was written with', (t) => {
  const { vault, events } = fixture(t);
  events([event('2026'), event('2026-11'), event('2026-11-26..2026-12-05', 'planned', 'Exam window'), event('2026-11-30')]);
  const november = queryDates(vault, { on: '2026-11' });
  assert.equal(november.total, 4);
  assert.deepEqual(november.items.find((item) => item.precision === 'range'), {
    date: '2026-11-26',
    dateEnd: '2026-12-05',
    dateText: '2026-11-26..2026-12-05',
    precision: 'range',
    field: 'events',
    title: 'Project',
    path: 'wiki/entities/Project.md',
    line: 10,
    kind: 'planned',
    summary: 'Exam window',
    source: '[[Evidence#Verified facts]]',
    sourceTitle: 'Evidence',
    sourceSection: 'Verified facts',
  });
  assert.equal(queryDates(vault, { on: '2026-12-05' }).total, 2);
  assert.equal(queryDates(vault, { on: '2026-12-06' }).total, 1);
  assert.equal(queryDates(vault, { from: '2026-11-30', to: '2026-11-30' }).total, 4);
  assert.equal(queryDates(vault, { on: '2027' }).total, 0);
  assert.equal(november.items.find((item) => item.precision === 'month').date, '2026-11');
});

test('impossible dates, mixed ranges and bad paging are refused before any page is read', (t) => {
  const { vault } = fixture(t);
  for (const on of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-13', '2026-01-00', '2026-1-01', '0000', '', 'yesterday', '2026-11-16T00:00:00Z']) {
    assert.throws(() => queryDates(vault, { on }), /date|YYYY/, `--on ${on} was accepted`);
  }
  assert.doesNotThrow(() => queryDates(vault, { on: '2000-02-29' }));
  assert.doesNotThrow(() => queryDates(vault, { on: '2024-02-29' }));
  assert.throws(() => queryDates(vault, { on: '2026', from: '2026-01' }), /combined/);
  assert.throws(() => queryDates(vault, { from: '2026-12', to: '2026-11' }), /after/);
  for (const limit of [0, -1, 501, 1.5, '2.5', NaN, Infinity]) assert.throws(() => queryDates(vault, { limit }), /limit/);
  for (const offset of [-1, 0.5, Infinity]) assert.throws(() => queryDates(vault, { offset }), /offset/);
  assert.throws(() => queryDates(vault, { field: 'body' }), /field/);
  assert.throws(() => queryDates(vault, { order: 'random' }), /order/);
  assert.throws(() => queryDates(vault, { search: {} }), /search/);
});

test('a line that is not a usable event is named, and never replaced by a page date', (t) => {
  const { vault, events } = fixture(t);
  events([
    event('2026-02-29'),
    event('2026-12..2026-11'),
    event('2026-11-20', 'invented'),
    '- 2026-11-21 incomplete event',
    event('2026-11-22', 'milestone'),
  ]);
  const result = queryDates(vault);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].date, '2026-11-22');
  assert.equal(result.warnings.length, 4);
  assert.ok(result.warnings.every((item) => item.code === 'invalid-event'));
});

test('a source may carry an alias or a slug; a missing, empty, doubled or ambiguous one is named', (t) => {
  const { vault, put, events } = fixture(t);
  events([
    event('2026-11-01', 'decision', 'One | useful distinction', '[[Evidence#Verified facts|proof]]'),
    event('2026-11-02', 'decision', 'Slug source', '[[Evidence#verified-facts]]'),
    event('2026-11-03', 'decision', 'Missing page', '[[Missing]]'),
    event('2026-11-04', 'decision', 'Missing heading', '[[Evidence#Unwritten]]'),
    event('2026-11-05', 'decision', 'Empty page', '[[#Verified facts]]'),
    event('2026-11-06', 'decision', 'Empty heading', '[[Evidence#]]'),
    event('2026-11-07', 'decision', 'Two sources', '[[Evidence]] | [[Project]]'),
  ]);
  const result = queryDates(vault);
  assert.equal(result.total, 2);
  const aliased = result.items.find((item) => item.date === '2026-11-01');
  assert.equal(aliased.source, '[[Evidence#Verified facts|proof]]');
  assert.equal(aliased.summary, 'One | useful distinction');
  // The slug resolves to the heading as written, which is what its RUN line names.
  assert.equal(result.items.find((item) => item.date === '2026-11-02').sourceSection, 'Verified facts');
  assert.equal(result.warnings.length, 5);

  put('wiki/entities/Evidence.md', '# Evidence\n## Verified facts\nOther evidence');
  const duplicate = queryDates(vault);
  assert.equal(duplicate.total, 0);
  assert.ok(duplicate.warnings.some((w) => /ambiguous/.test(w.message)));
});

test('an event inside a fenced example does not count, and a fence closes the way Markdown closes it', (t) => {
  const { vault, put } = fixture(t);
  put(
    'wiki/entities/Project.md',
    [
      '# Project',
      '```md',
      '## Dated events',
      event('2026-01-01'),
      '```',
      '## Dated events',
      '~~~~md',
      event('2026-02-01'),
      '~~~',
      event('2026-03-01'),
      '~~~~',
      event('2026-04-01'),
      '```',
      '## Other notes',
      '```',
      event('2026-05-01'),
      '## Other notes',
      event('2026-06-01'),
    ].join('\n'),
  );
  put('wiki/sources/Evidence.md', '# Evidence\n```\n## Fake heading\n```\n## Verified facts\nReal section');
  const result = queryDates(vault);
  assert.deepEqual(result.items.map((item) => item.date), ['2026-05-01', '2026-04-01']);
  assert.equal(result.warnings.length, 0);
});

test('an HTML comment switches an event off and keeps the line numbers the file has', (t) => {
  const { vault, put } = fixture(t);
  put('wiki/sources/Evidence.md', ['# Evidence', '<!--', '## Hidden proof', '-->', '## Verified facts'].join('\n'));
  put(
    'wiki/entities/Project.md',
    [
      '# Project',
      '<!--',
      '## Dated events',
      event('2026-01-01'),
      '-->',
      '## Dated events',
      '<!--',
      event('2026-02-01'),
      '```',
      '-->',
      `<!-- ignore -->${event('2026-03-01')} <!-- ignore too -->`,
      event('2026-04-01', 'decision', 'Cites a commented heading', '[[Evidence#Hidden proof]]'),
      '```',
      '<!-- literal code, not an open HTML comment',
      '```',
      event('2026-05-01'),
      `<!-- ${event('2026-06-01')} -->`,
    ].join('\n'),
  );
  const result = queryDates(vault);
  assert.deepEqual(result.items.map((item) => item.date), ['2026-05-01', '2026-04-01', '2026-03-01']);
  assert.equal(result.items.find((item) => item.date === '2026-03-01').line, 11);
  // A source is what `read` opens, and read opens a heading inside a comment;
  // the PR refused it with a parser of its own. One rule, not two.
  assert.equal(result.items.find((item) => item.date === '2026-04-01').sourceSection, 'Hidden proof');
  assert.equal(result.warnings.length, 0);
});

test('paging and ties are deterministic: newest first, then page, then line', (t) => {
  const { vault, put, events } = fixture(t);
  events([event('2026-10-01', 'decision', 'Keep the old API'), event('2026-11-01', 'correction', 'Fix API date'), event('2026-12-01', 'milestone', 'Release parser')]);
  put('wiki/entities/Another.md', `# Another\n## Dated events\n${event('2026-11-01', 'event', 'API discussion')}\n`);
  assert.deepEqual(
    queryDates(vault, { search: 'api', limit: '2', offset: '1' }).items.map((item) => item.title),
    ['Project', 'Project'],
  );
  const filtered = queryDates(vault, { search: 'API', order: 'asc', limit: 1, offset: 1 });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.items[0].title, 'Another');
  assert.equal(queryDates(vault, { search: 'project' }).total, 3);
  assert.equal(queryDates(vault, { offset: 100 }).items.length, 0);
});

test('page dates are read quoted or not, and a bad one is named only when page dates were asked for', (t) => {
  const { vault, put } = fixture(t);
  put('wiki/entities/Project.md', '---\ncreated: "2026-10"\nupdated: 2026-02-29\n---\n# Project');
  const created = queryDates(vault, { field: 'created', on: '2026-10' });
  assert.equal(created.total, 1);
  assert.equal(created.items[0].precision, 'month');
  assert.equal(created.warnings.length, 0);
  assert.equal(queryDates(vault, { field: 'events' }).warnings.length, 0);
  const updated = queryDates(vault, { field: 'updated' });
  assert.equal(updated.total, 1);
  assert.equal(updated.warnings[0].code, 'invalid-metadata');
  put('wiki/entities/Project.md', '---\ncreated: 2026-10-01\ncreated: 2026-10-02\n---\n# Project');
  assert.ok(queryDates(vault, { field: 'created' }).warnings.some((w) => /Duplicate/.test(w.message)));
});

test('two categories naming the same folder do not double a page or its events', (t) => {
  const { vault, events, configure } = fixture(t);
  events([event('2026-11-16')]);
  configure({ categories: { all: 'wiki', entities: 'wiki/entities' } });
  assert.equal(queryDates(vault, { field: 'created' }).pages, 2);
  assert.equal(queryDates(vault, { field: 'created' }).total, 2);
  // A page met twice would be its own namesake, and every source on it ambiguous.
  const result = queryDates(vault);
  assert.equal(result.total, 1);
  assert.equal(result.warnings.length, 0);
});

// ============================================================================
// The review's fixes
// ============================================================================

test('dates sees exactly the pages read sees: renamed, nested, and folders named history or raw', (t) => {
  const { vault, put, configure, run } = fixture(t);
  // Every name here made PR #6's walker refuse the brain or drop pages, while
  // read opened all of them. A source policy that is not there is not checked:
  // that was the cloud mirror's guard, and dates writes nothing anywhere.
  configure({
    categories: { people: 'notes/people', history: 'wiki/history', sources: 'wiki/sources' },
    sourcePolicy: '.exposurie/no-such-policy.md',
  });
  const page = (title) => `---\ncreated: 2026-06-01\n---\n# ${title}\n`;
  put('notes/people/Ada.md', page('Ada'));
  put('notes/people/raw/Nested Under Raw.md', page('Nested Under Raw'));
  put('wiki/history/Old Days.md', page('Old Days'));
  put('wiki/sources/staging/Draft.md', page('Draft'));
  put('wiki/sources/.obsidian/Dot Folder.md', page('Dot Folder'));
  // Outside every category. read never sees these, so dates must not either.
  put('raw/private.md', `# Private\n## Dated events\n${event('2026-06-01')}\n`);
  put('.exposurie/staged/batch/session.md', page('Session'));

  const seen = new Set(allPages(vault, readSeam(vault)).map((p) => slash(relative(vault, p.path))));
  assert.equal(seen.size, 6, 'the fixture is not the brain it says it is');
  const result = queryDates(vault, { field: 'created' });
  assert.equal(result.pages, seen.size);
  assert.deepEqual(new Set(result.items.map((i) => i.path)), seen);

  const cli = run('dates', '--field', 'created', '--at', vault);
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out, /DATES: 6 page created dates at any date/);
});

test('every source command dates prints is run, and opens the section it names', (t) => {
  const { vault, put, events, run } = fixture(t);
  put('wiki/sources/Lang.md', '# Lang\n## C#\nNotes on the language.\n## Q&A: "the hard one"\nAnswered.\n');
  put('wiki/sources/Parser Evidence.md', '# Parser Evidence\n## Decision\nStreaming won.\n## Verified facts\nChecked twice.\n');
  events([
    event('2026-06-01', 'decision', 'A heading with a hash in it.', '[[Lang#C#]]'),
    event('2026-06-02', 'decision', 'Quotes in the heading.', '[[Lang#Q&A: "the hard one"]]'),
    event('2026-06-03', 'decision', 'Linked by a slug.', '[[Parser Evidence#verified-facts]]'),
    event('2026-06-04', 'decision', 'Linked in lower case, by part of a heading.', '[[parser evidence#decis]]'),
    event('2026-06-05', 'event', 'The whole page.', '[[Lang]]'),
    event('2026-06-06', 'event', 'Through an alias.', '[[Parser Evidence#Decision|why]]'),
  ]);
  const json = JSON.parse(run('dates', '--at', vault, '--json').out);
  assert.equal(json.total, 6, JSON.stringify(json.warnings));
  assert.equal(json.warnings.length, 0, JSON.stringify(json.warnings));

  const out = run('dates', '--at', vault).out;
  // Titles go through q(), like every title read prints.
  assert.match(out, /^2026-06-01 \| decision \| "Project": A heading with a hash in it\.$/m);

  const sections = runLines(out, (l) => l.includes('--section'));
  assert.equal(sections.length, json.items.filter((i) => i.sourceSection).length);
  for (const args of sections) {
    assert.deepEqual([args[0], args[2]], ['read', '--section']);
    const opened = run(...args, '--at', vault);
    assert.equal(opened.code, 0, opened.out);
    assert.ok(
      opened.out.includes(`${args[1]} -> ${args[3]}`),
      `exposurie ${args.join(' ')} did not open what it names:\n${opened.out}`,
    );
  }
  // The link without a heading prints the page, and the page opens.
  const whole = out.split('\n');
  const at = whole.findIndex((l) => l.startsWith('2026-06-05 |'));
  const [page] = runLines(whole[at + 1]);
  assert.deepEqual(page, ['read', 'Lang']);
  assert.match(run(...page, '--at', vault).out, /^Lang\npath: /m);
});

test('--search takes words the way read --search does: in any order and any form', (t) => {
  const { vault, events } = fixture(t);
  events([
    event('2026-06-01', 'decision', 'Chose a streaming parser.'),
    event('2026-06-02', 'milestone', 'Shipped the APIs.'),
    event('2026-06-03', 'event', 'Lunch with the team.'),
  ]);
  const found = (search) => queryDates(vault, { search }).items.map((i) => i.date);
  assert.deepEqual(found('streaming parser'), ['2026-06-01']);
  // The two PR #6 missed: it matched the whole query as one substring.
  assert.deepEqual(found('parser streaming'), ['2026-06-01']);
  assert.deepEqual(found('streaming parsers'), ['2026-06-01']);
  assert.deepEqual(found('PARSER'), ['2026-06-01']);
  assert.deepEqual(found('api'), ['2026-06-02']);
  assert.deepEqual(found('parser lunch'), [], 'an event has to hold every word');
  assert.deepEqual(found('project'), ['2026-06-03', '2026-06-02', '2026-06-01'], 'the page title counts');
  const nothing = queryDates(vault, { search: '.*' });
  assert.equal(nothing.total, 0);
  assert.deepEqual(nothing.searchWords, []);
});

test('a flag only dates takes is refused by every other command, before anything runs', (t) => {
  const { home, vault, run } = fixture(t);
  const before = snapshot(home);

  const r = run('read', 'Project', '--limit', 'banana', '--order', 'sideways', '--at', vault);
  assert.equal(r.code, 2, `read --limit banana is a usage error, as it was before dates:\n${r.out}`);
  assert.match(r.out, /Unknown option '--limit' for read\. Only dates takes it\./);

  // Every other command, and every one of the seven flags at least once.
  const flags = ['--on', '--from', '--to', '--field', '--order', '--limit', '--offset'];
  NAMES.filter((n) => n !== 'dates').forEach((name, i) => {
    const flag = flags[i % flags.length];
    const res = run(name, flag, '2026', '--at', vault);
    assert.equal(res.code, 2, `exposurie ${name} ${flag} 2026 exited ${res.code}:\n${res.out}`);
    assert.match(res.out, new RegExp(`Unknown option '${flag}' for ${name}`));
  });
  assert.deepEqual(snapshot(home), before, 'a refused flag still changed something');

  assert.equal(run('dates', '--limit', '5', '--order', 'asc', '--offset', '0', '--at', vault).code, 0);
  const bad = run('dates', '--limit', 'banana', '--at', vault);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--limit must be a whole number from 1 to 500/);
});

test('text names the first five lines it skipped, and --json carries every one', (t) => {
  const { vault, events, run } = fixture(t);
  events([event('2026-11-01'), ...Array.from({ length: 8 }, (_, i) => event(`2026-11-1${i}`, 'guess'))]);
  const text = run('dates', '--at', vault);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /WARNINGS: 8 lines were left out because they are not usable as written\. The first 5:/);
  const named = text.out.split('\n').filter((l) => /^ {2}wiki\/entities\/Project\.md:\d+ {2}Unknown event kind: guess/.test(l));
  assert.equal(named.length, 5);

  const all = runLines(text.out, (l) => l.includes('--json'));
  assert.equal(all.length, 1, 'no command lists them all');
  const json = JSON.parse(run(...all[0]).out);
  assert.equal(json.warnings.length, 8);
  assert.ok(json.warnings.every((w) => w.code === 'invalid-event' && w.path === 'wiki/entities/Project.md'));
  assert.equal(json.total, 1);
});

test('`*` and `+` bullets are events; a note indented under one is not, unless it is written as one', (t) => {
  const { vault, events } = fixture(t);
  events([
    event('2026-11-01').replace(/^-/, '*'),
    '  - a note about the first event, not an event',
    '\t* another note, indented with a tab',
    event('2026-11-02').replace(/^-/, '+'),
    `  ${event('2026-11-03')}`,
    '  - 2026-11-04 | guess | nested, and written as a broken event | [[Evidence]]',
  ]);
  const result = queryDates(vault);
  assert.deepEqual(result.items.map((i) => i.date), ['2026-11-03', '2026-11-02', '2026-11-01']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /Unknown event kind: guess/);
});

test('an empty answer is not "nothing happened": it says how much is dated and names a search', (t) => {
  const { vault, events, run } = fixture(t);
  events([event('2026-06-01', 'decision', 'Chose a streaming parser.')]);
  const none = run('dates', '--on', '2027', '--at', vault);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /DATES: 0 dated events between 2027-01-01 and 2027-12-31/);
  assert.match(none.out, /1 event is dated in this brain, on 1 of 2 pages\./);
  assert.match(none.out, /does not mean nothing happened/);
  assert.match(none.out, /RUN: {2}exposurie read --search "<topic>"/);
  const missed = run('dates', '--search', 'release window', '--at', vault);
  assert.match(missed.out, /RUN: {2}exposurie read --search "release window"/);
});

test('the next page is a printed command, and it works', (t) => {
  const { vault, events, run } = fixture(t);
  events([event('2026-06-01'), event('2026-06-02')]);
  const first = run('dates', '--limit', '1', '--at', vault);
  assert.match(first.out, /Showing 1-1 of 2\. Do NOT describe this list as complete\./);
  const [next] = runLines(first.out, (l) => l.includes('--offset'));
  assert.ok(next, `no next-page command:\n${first.out}`);
  const second = run(...next);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /Showing 2-2 of 2\./);
  assert.match(second.out, /^2026-06-01 \|/m);
});

test('dates takes flags, not words: a bare date or word is refused with the call that works', (t) => {
  const { vault, run } = fixture(t);
  const day = run('dates', '2026-06', '--at', vault);
  assert.equal(day.code, 2, day.out);
  assert.deepEqual(runLines(day.out), [['dates', '--on', '2026-06', '--at', vault]]);
  const word = run('dates', 'parser', '--at', vault);
  assert.equal(word.code, 2, word.out);
  assert.deepEqual(runLines(word.out), [['dates', '--search', 'parser', '--at', vault]]);
  // Built before the flags are checked, so a value with a space is quoted.
  const spaced = run('dates', '2026-06', '--order', 'new first', '--at', vault);
  assert.deepEqual(runLines(spaced.out), [['dates', '--on', '2026-06', '--order', 'new first', '--at', vault]]);
});

test('--at naming a folder with no brain is refused, never answered from another brain', (t) => {
  const { home, run } = fixture(t);
  const empty = join(home, 'not a brain');
  fs.mkdirSync(empty);
  const r = run('dates', '--on', '2026', '--at', empty);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /there is no brain there/);
});

test('--json is the whole record, and a refusal asked for as JSON is JSON too', (t) => {
  const { vault, events, run } = fixture(t);
  events([event('2026-06-01'), event('2026-06-02', 'guess')]);
  const r = run('dates', '--on', '2026-06', '--json', '--at', vault);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  for (const key of ['operation', 'readOnly', 'field', 'from', 'to', 'order', 'search', 'searchWords', 'pages', 'total', 'limit', 'offset', 'coverage', 'items', 'warnings', 'vault', 'exit']) {
    assert.ok(key in j, `--json has no "${key}"`);
  }
  assert.equal(j.exit, 0);
  assert.equal(j.readOnly, true);
  assert.equal(j.items[0].sourceSection, 'Verified facts');
  assert.equal(j.warnings.length, 1);
  const refused = run('dates', '--limit', 'banana', '--json', '--at', vault);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.out).exit, 2);
});

test('looking up dates writes nothing, and opens only the config and the pages read would open', (t) => {
  const { vault, put, events } = fixture(t);
  events([event('2026-11-16')]);
  put('raw/private.txt', 'NOT A PAGE');
  put('.git/history.md', '# Not a page');
  put('.exposurie/staged/secret.md', '# Not a page');
  const before = snapshot(vault);
  const original = fs.readFileSync;
  const reads = [];
  let result;
  try {
    fs.readFileSync = function (path, ...args) {
      // Forward slashes: PR #6 compared relative() to 'wiki/entities/...'
      // directly, and Windows answers with backslashes.
      reads.push(slash(relative(vault, String(path))));
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    result = queryDates(vault);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(result.total, 1);
  assert.deepEqual(reads.sort(), ['.exposurie/config.json', 'wiki/entities/Project.md', 'wiki/sources/Evidence.md']);
  assert.deepEqual(snapshot(vault), before);
});

test('the schema teaches the exact line dates reads, and the always-loaded pointer is not grown for it', () => {
  // The template carries the format because the agent writing a page needs it
  // there. The pointer does not: it sits in every always-loaded instruction file
  // on the machine and is paid in every session of every project, so dates is
  // reached from help and from the brain's own schema instead.
  const template = fs.readFileSync(join(ROOT, 'src', 'templates', 'CLAUDE.md'), 'utf8');
  const example = template.match(/`- (\d{4}-\d{2}-\d{2} \| [^`]+)`/);
  assert.ok(example, 'the template no longer shows a dated event line');
  const parsed = parseEvent(example[1]);
  assert.equal(parsed.error, undefined, `the template's own example is not an event: ${parsed.error}`);
  const docs = fs.readFileSync(join(ROOT, 'docs', 'dates.md'), 'utf8');
  for (const kind of KINDS) {
    assert.match(template, new RegExp(`\\b${kind}\\b`), `the template never names the kind "${kind}"`);
    assert.match(docs, new RegExp(`\`${kind}\``), `docs/dates.md never names the kind "${kind}"`);
  }
  assert.doesNotMatch(pointer(), /\bdates\b/);
});
