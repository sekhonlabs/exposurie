import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { queryDates } from '../src/dates.js';

function fixture(t) {
  const home = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'exposurie-dates-')),
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = join(home, 'brain');
  const put = (rel, content) => {
    fs.mkdirSync(dirname(join(vault, rel)), { recursive: true });
    fs.writeFileSync(join(vault, rel), content);
  };
  const config = {
    categories: { entities: 'wiki/entities', sources: 'wiki/sources' },
    raw: 'raw',
    sourcePolicy: '.exposurie/source-policy.md',
  };
  const configure = (updates) =>
    put('.exposurie/config.json', JSON.stringify({ ...config, ...updates }));
  configure({});
  put('.exposurie/source-policy.md', 'Keep excluded sources out.');
  put('.exposurie/state.json', '{"pendingBatch":{"id":"never-touch"}}');
  put(
    'wiki/sources/Evidence.md',
    '---\ntype: source\ncreated: 2026-11-15\nupdated: 2026-11-16\nsource_file: raw/private.txt\n---\n# Evidence\n## Verified facts\nCurated evidence.\n',
  );
  put(
    'wiki/entities/Project.md',
    '---\ntype: entity\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Project\nNo events yet.\n',
  );
  const events = (lines) =>
    put(
      'wiki/entities/Project.md',
      `---\ntype: entity\ncreated: 2026-11-15\nupdated: 2026-11-16\n---\n# Project\n## Dated events\n${lines.join('\n')}\n`,
    );
  return { home, vault, put, events, configure };
}

const event = (
  date,
  kind = 'decision',
  summary = 'Choose a simpler design',
  source = '[[Evidence#Verified facts]]',
) => `- ${date} | ${kind} | ${summary} | ${source}`;

test('event dates stay distinct from metadata and arbitrary dates in prose', (t) => {
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
  });
  const metadata = queryDates(vault, { field: 'updated', on: '2026-11-16' });
  assert.equal(metadata.total, 2);
  assert(
    metadata.items.every(
      (item) =>
        item.field === 'updated' && item.source === null && item.kind === null,
    ),
  );
  assert.equal(queryDates(vault, { field: 'created', on: '2026-08' }).total, 0);
  assert.equal(queryDates(vault, { field: 'all' }).total, 5);
});

test('range filters use inclusive overlap and retain partial precision', (t) => {
  const { vault, events } = fixture(t);
  events([
    event('2026'),
    event('2026-11'),
    event('2026-11-26..2026-12-05', 'planned', 'Exam window'),
    event('2026-11-30'),
  ]);
  const november = queryDates(vault, { on: '2026-11' });
  assert.equal(november.total, 4);
  assert.deepEqual(
    november.items.find((item) => item.precision === 'range'),
    {
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
    },
  );
  assert.equal(queryDates(vault, { on: '2026-12-05' }).total, 2);
  assert.equal(queryDates(vault, { on: '2026-12-06' }).total, 1);
  assert.equal(
    queryDates(vault, { from: '2026-11-30', to: '2026-11-30' }).total,
    4,
  );
  assert.equal(queryDates(vault, { on: '2027' }).total, 0);
  assert.equal(
    november.items.find((item) => item.precision === 'month').date,
    '2026-11',
  );
});

test('query options reject invalid calendar dates, ambiguous ranges and unsafe pagination', (t) => {
  const { vault } = fixture(t);
  for (const on of [
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-00-10',
    '2026-13',
    '2026-01-00',
    '2026-1-01',
    '0000',
    '',
    'yesterday',
    '2026-11-16T00:00:00Z',
  ]) {
    assert.throws(() => queryDates(vault, { on }), /date|YYYY/);
  }
  assert.doesNotThrow(() => queryDates(vault, { on: '2000-02-29' }));
  assert.doesNotThrow(() => queryDates(vault, { on: '2024-02-29' }));
  assert.throws(
    () => queryDates(vault, { on: '2026', from: '2026-01' }),
    /combined/,
  );
  assert.throws(
    () => queryDates(vault, { from: '2026-12', to: '2026-11' }),
    /after/,
  );
  for (const limit of [0, -1, 501, 1.5, '2.5', NaN, Infinity])
    assert.throws(() => queryDates(vault, { limit }), /limit/);
  for (const offset of [-1, 0.5, Infinity])
    assert.throws(() => queryDates(vault, { offset }), /offset/);
  assert.throws(() => queryDates(vault, { field: 'body' }), /field/);
  assert.throws(() => queryDates(vault, { order: 'random' }), /order/);
  assert.throws(() => queryDates(vault, { search: {} }), /search/);
});

test('invalid event dates and kinds yield warnings without substituting page dates', (t) => {
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
  assert(result.warnings.every((item) => item.code === 'invalid-event'));
});

test('source validation accepts aliases and section slugs and rejects missing or ambiguous sources', (t) => {
  const { vault, put, events } = fixture(t);
  events([
    event(
      '2026-11-01',
      'decision',
      'One | useful distinction',
      '[[Evidence#Verified facts|proof]]',
    ),
    event(
      '2026-11-02',
      'decision',
      'Slug source',
      '[[Evidence#verified-facts]]',
    ),
    event('2026-11-03', 'decision', 'Missing page', '[[Missing]]'),
    event(
      '2026-11-04',
      'decision',
      'Missing heading',
      '[[Evidence#Unwritten]]',
    ),
    event('2026-11-05', 'decision', 'Empty page', '[[#Verified facts]]'),
    event('2026-11-06', 'decision', 'Empty heading', '[[Evidence#]]'),
    event(
      '2026-11-07',
      'decision',
      'Two sources',
      '[[Evidence]] | [[Project]]',
    ),
  ]);
  const result = queryDates(vault);
  assert.equal(result.total, 2);
  assert.equal(
    result.items.find((item) => item.date === '2026-11-01').source,
    '[[Evidence#Verified facts|proof]]',
  );
  assert.equal(
    result.items.find((item) => item.date === '2026-11-01').summary,
    'One | useful distinction',
  );
  assert.equal(result.warnings.length, 5);
  put(
    'wiki/entities/Evidence.md',
    '# Evidence\n## Verified facts\nOther evidence',
  );
  const duplicate = queryDates(vault);
  assert.equal(duplicate.total, 0);
  assert(duplicate.warnings.some((w) => /ambiguous/.test(w.message)));
});

test('fenced examples and headings inside fences cannot create events or source sections', (t) => {
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
  put(
    'wiki/sources/Evidence.md',
    '# Evidence\n```\n## Fake heading\n```\n## Verified facts\nReal section',
  );
  const result = queryDates(vault);
  assert.deepEqual(
    result.items.map((item) => item.date),
    ['2026-05-01', '2026-04-01'],
  );
  assert.equal(result.warnings.length, 0);
});

test('HTML comments cannot add events or source headings and preserve visible line numbers', (t) => {
  const { vault, put } = fixture(t);
  put(
    'wiki/sources/Evidence.md',
    ['# Evidence', '<!--', '## Hidden proof', '-->', '## Verified facts'].join(
      '\n',
    ),
  );
  const lines = [
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
    event(
      '2026-04-01',
      'decision',
      'No hidden proof',
      '[[Evidence#Hidden proof]]',
    ),
    '```',
    '<!-- literal code, not an open HTML comment',
    '```',
    event('2026-05-01'),
    `<!-- ${event('2026-06-01')} -->`,
  ];
  put('wiki/entities/Project.md', lines.join('\n'));
  const result = queryDates(vault);
  assert.deepEqual(
    result.items.map((item) => item.date),
    ['2026-05-01', '2026-03-01'],
  );
  assert.equal(
    result.items.find((item) => item.date === '2026-03-01').line,
    11,
  );
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'invalid-source');
});

test('literal title/summary search, pagination and ties are deterministic', (t) => {
  const { vault, put, events } = fixture(t);
  events([
    event('2026-10-01', 'decision', 'Keep the old API'),
    event('2026-11-01', 'correction', 'Fix API date'),
    event('2026-12-01', 'milestone', 'Release parser'),
  ]);
  put(
    'wiki/entities/Another.md',
    `# Another\n## Dated events\n${event('2026-11-01', 'event', 'API discussion')}\n`,
  );
  assert.deepEqual(
    queryDates(vault, { search: 'api', limit: '2', offset: '1' }).items.map(
      (item) => item.title,
    ),
    ['Project', 'Project'],
  );
  const filtered = queryDates(vault, {
    search: 'API',
    order: 'asc',
    limit: 1,
    offset: 1,
  });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.items[0].title, 'Another');
  assert.equal(queryDates(vault, { search: 'project' }).total, 3);
  assert.equal(queryDates(vault, { search: '.*' }).total, 0);
  assert.equal(queryDates(vault, { offset: 100 }).items.length, 0);
});

test('quoted metadata is read and invalid metadata is visible only for selected fields', (t) => {
  const { vault, put } = fixture(t);
  put(
    'wiki/entities/Project.md',
    '---\ncreated: "2026-10"\nupdated: 2026-02-29\n---\n# Project',
  );
  const created = queryDates(vault, { field: 'created', on: '2026-10' });
  assert.equal(created.total, 1);
  assert.equal(created.items[0].precision, 'month');
  assert.equal(created.warnings.length, 0);
  assert.equal(queryDates(vault, { field: 'events' }).warnings.length, 0);
  const updated = queryDates(vault, { field: 'updated' });
  assert.equal(updated.total, 1);
  assert.equal(updated.warnings[0].code, 'invalid-metadata');
  put(
    'wiki/entities/Project.md',
    '---\ncreated: 2026-10-01\ncreated: 2026-10-02\n---\n# Project',
  );
  assert(
    queryDates(vault, { field: 'created' }).warnings.some((w) =>
      /Duplicate/.test(w.message),
    ),
  );
});

test('overlapping categories do not duplicate pages', (t) => {
  const { vault, configure } = fixture(t);
  configure({ categories: { all: 'wiki', entities: 'wiki/entities' } });
  const result = queryDates(vault, { field: 'created' });
  assert.equal(result.pages, 2);
  assert.equal(result.total, 2);
});

test('escaped/protected category paths, root symlinks and symlink configuration are rejected', (t) => {
  const { vault, home, configure } = fixture(t);
  for (const path of [
    '../outside',
    '.',
    'raw',
    '.git',
    '.exposurie/staged',
    'history',
    'staging',
  ]) {
    configure({ categories: { entries: path } });
    assert.throws(() => queryDates(vault), /escapes|protected/);
  }
  configure({});
  fs.symlinkSync(vault, join(home, 'linked-brain'));
  assert.throws(() => queryDates(join(home, 'linked-brain')), /symlink/);
  const configPath = join(vault, '.exposurie/config.json');
  fs.copyFileSync(configPath, join(home, 'config.json'));
  fs.unlinkSync(configPath);
  fs.symlinkSync(join(home, 'config.json'), configPath);
  assert.throws(() => queryDates(vault), /Symlink/);
});

test('category symlinks fail and nested file/directory symlinks are skipped', (t) => {
  const { vault, home, events, configure } = fixture(t);
  events([event('2026-11-16')]);
  fs.writeFileSync(
    join(home, 'outside.md'),
    `# Secret\n## Dated events\n${event('2026-11-17')}`,
  );
  fs.symlinkSync(
    join(home, 'outside.md'),
    join(vault, 'wiki/entities/Linked.md'),
  );
  fs.symlinkSync(
    join(home, 'missing.md'),
    join(vault, 'wiki/entities/Dangling.md'),
  );
  fs.symlinkSync(home, join(vault, 'wiki/entities/Directory'));
  const result = queryDates(vault);
  assert.equal(result.total, 1);
  assert.equal(
    result.warnings.filter((w) => w.code === 'symlink-skipped').length,
    3,
  );
  configure({ categories: { entries: 'wiki/entities/Directory' } });
  assert.throws(() => queryDates(vault), /Symlink/);
});

test('date retrieval reads only curated pages and config, without writes or conversation ingestion', (t) => {
  const { vault, put, events, configure } = fixture(t);
  events([event('2026-11-16')]);
  put('raw/private.txt', 'SECRET RAW');
  put('.git/history.md', '# Secret');
  put('.exposurie/staged/secret.md', '# Secret');
  put('wiki/.git/Secret.md', '# Secret');
  put('wiki/.exposurie/staged/Secret.md', '# Secret');
  put('wiki/history/Secret.md', '# Secret');
  put(
    'wiki/private/Secret.md',
    `# Private\n## Dated events\n${event('2026-11-16')}`,
  );
  configure({ categories: { pages: 'wiki' }, raw: 'wiki/private' });
  const before = new Map();
  function snapshot(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) snapshot(child);
      else
        before.set(child, {
          bytes: fs.readFileSync(child),
          mtime: fs.statSync(child).mtimeMs,
        });
    }
  }
  snapshot(vault);
  const original = fs.readFileSync;
  const reads = [];
  let result;
  try {
    fs.readFileSync = function (path, ...args) {
      reads.push(relative(vault, String(path)));
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    result = queryDates(vault);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(result.total, 1);
  assert.deepEqual(reads.sort(), [
    '.exposurie/config.json',
    'wiki/entities/Project.md',
    'wiki/sources/Evidence.md',
  ]);
  for (const [path, old] of before) {
    assert.deepEqual(fs.readFileSync(path), old.bytes);
    assert.equal(fs.statSync(path).mtimeMs, old.mtime);
  }
});

test('missing or linked source policy fails before opening page bodies', (t) => {
  const { vault, home } = fixture(t);
  const policy = join(vault, '.exposurie/source-policy.md');
  fs.unlinkSync(policy);
  assert.throws(() => queryDates(vault), /ENOENT/);
  fs.writeFileSync(join(home, 'policy.md'), 'External policy');
  fs.symlinkSync(join(home, 'policy.md'), policy);
  assert.throws(() => queryDates(vault), /Symlink/);
});
