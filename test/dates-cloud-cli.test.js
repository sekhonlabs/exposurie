import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localFirst } from '../src/cloud/local-first.js';
import { read } from '../src/commands/read.js';
import { dates } from '../src/commands/dates.js';

const cli = fileURLToPath(new URL('../bin/exposurie.js', import.meta.url));
function fixture(t) {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), 'exposurie-cloud-cli-')),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, 'brain');
  mkdirSync(join(vault, '.exposurie'), { recursive: true });
  mkdirSync(join(vault, 'wiki/entities'), { recursive: true });
  const put = (id, text) => writeFileSync(join(vault, id), text);
  put(
    '.exposurie/config.json',
    JSON.stringify({ categories: { entities: 'wiki/entities' } }),
  );
  put('.exposurie/state.json', '{"fixture":"checkpoint-must-not-change"}\n');
  put(
    'wiki/entities/Example.md',
    '# Example\n## Evidence\nKnown event.\n## Dated events\n- 2026-06-01 | event | Built the parser. | [[Example#Evidence]]\n',
  );
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args, '--at', vault], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData/Roaming'),
        LOCALAPPDATA: join(home, 'AppData/Local'),
      },
    });
  return { home, vault, put, run };
}

test('CLI dates emits normal text or structured JSON while preserving conversation checkpoints', (t) => {
  const { vault, run } = fixture(t);
  const checkpoint = join(vault, '.exposurie/state.json'),
    before = readFileSync(checkpoint);
  const json = run('dates', '--on', '2026-06', '--json');
  assert.equal(json.status, 0, json.stdout + json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.operation, 'dates');
  assert.equal(result.items[0].date, '2026-06-01');
  assert.equal(result.exit, 0);
  assert.equal(result.readOnly, true);
  const text = run('dates', '--on', '2026-06');
  assert.match(text.stdout, /DATES: 1 matches/);
  assert.match(text.stdout, /RUN: .*read "Example"/);
  assert.deepEqual(readFileSync(checkpoint), before);
  for (const args of [
    ['--limit', '1.5'],
    ['--on', '2026-02-30'],
    ['unexpected'],
    ['--unknown'],
  ])
    assert.notEqual(run('dates', ...args).status, 0);
});

test('cloud configure stores an origin and variable name; bad input preserves the old config and help never acts', (t) => {
  const { vault, run } = fixture(t);
  const result = run(
    'cloud',
    'configure',
    '--url',
    'https://brain.example',
    '--token-env',
    'FIXTURE_BRAIN_TOKEN',
    '--json',
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const path = join(vault, '.exposurie/cloud.json'),
    before = readFileSync(path);
  assert.deepEqual(JSON.parse(before), {
    url: 'https://brain.example',
    tokenEnv: 'FIXTURE_BRAIN_TOKEN',
  });
  for (const url of [
    'http://brain.example',
    'https://user:secret@brain.example',
    'https://brain.example/path',
  ])
    assert.notEqual(run('cloud', 'configure', '--url', url).status, 0);
  assert.deepEqual(readFileSync(path), before);
  const files = readdirSync(join(vault, '.exposurie'));
  assert.equal(run('cloud', 'sync', '--help').status, 0);
  assert.deepEqual(readdirSync(join(vault, '.exposurie')), files);
  const status = JSON.parse(run('cloud', 'status', '--json').stdout);
  assert.equal(status.configured, true);
  assert.equal(status.lastSync, null);
});

test('local hits make no cloud calls; misses refresh and offline failure preserves the local answer', async (t) => {
  const { vault, put } = fixture(t);
  put('.exposurie/cloud.json', '{"url":"https://brain.example"}');
  let calls = 0;
  const mirror = async () => {
    calls++;
    put(
      'wiki/entities/New Page.md',
      '# New Page\n## Dated events\n- 2026-06-02 | event | Arrived from the cloud. | [[New Page]]\n',
    );
    return { status: 'synced', downloaded: 1, conflicts: [] };
  };
  const hit = await localFirst(
    read,
    { at: vault, search: 'Example' },
    [],
    mirror,
  );
  assert.equal(hit.code, 0);
  assert.equal(calls, 0);
  const fetched = await localFirst(
    read,
    { at: vault, search: 'Arrived' },
    [],
    mirror,
  );
  assert.equal(calls, 1);
  assert.match(fetched.body.join('\n'), /Arrived from the cloud/);
  const date = await localFirst(
    dates,
    { at: vault, on: '2026-06-02' },
    [],
    mirror,
  );
  assert.equal(date.json.total, 1);
  assert.equal(calls, 1);
  const offline = await localFirst(
    read,
    { at: vault, search: 'Unrecorded' },
    [],
    async () => {
      throw Error('offline');
    },
  );
  assert.equal(offline.code, 0);
  assert.match(offline.body.join('\n'), /TOTAL: 0/);
  assert.match(offline.body.join('\n'), /Cloud refresh unavailable/);
});
