import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCloud, scanBrain, hash, planPage } from '../src/cloud/sync.js';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exposurie-cloud-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.exposurie'));
  mkdirSync(join(root, 'wiki/entities'), { recursive: true });
  writeFileSync(
    join(root, '.exposurie/config.json'),
    JSON.stringify({ categories: { entities: 'wiki/entities' } }),
  );
  writeFileSync(
    join(root, '.exposurie/source-policy.md'),
    'Permitted fixture source only.',
  );
  writeFileSync(
    join(root, '.exposurie/cloud.json'),
    JSON.stringify({ url: 'https://test.example' }),
  );
  writeFileSync(join(root, 'index.md'), '# Index\n\n## Entities\n');
  const id = 'wiki/entities/Example.md';
  const path = join(root, id);
  writeFileSync(path, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  const remote = new Map();
  let fail = false;
  const calls = [];
  async function api(action, body) {
    calls.push(action);
    if (fail) throw Error('offline');
    if (action === 'manifest')
      return { pages: [...remote.values()].map(({ content, ...p }) => p) };
    if (action === 'pull')
      return { pages: body.ids.map((id) => remote.get(id)) };
    return {
      results: body.pages.map((p) => {
        const old = remote.get(p.id);
        if ((old?.revision ?? 0) !== p.expected_revision)
          return { id: p.id, error: 'revision_conflict' };
        const page = {
          id: p.id,
          title: p.id.split('/').at(-1).replace('.md', ''),
          content: p.content,
          hash: hash(p.content),
          revision: (old?.revision ?? 0) + 1,
          system: !p.id.startsWith('wiki/entities'),
        };
        remote.set(p.id, page);
        return { id: p.id, hash: page.hash, revision: page.revision };
      }),
    };
  }
  return {
    root,
    id,
    path,
    remote,
    api,
    calls,
    offline() {
      fail = true;
    },
    changeCloud(content) {
      const p = remote.get(id);
      remote.set(id, {
        ...p,
        content,
        hash: hash(content),
        revision: p.revision + 1,
      });
    },
  };
}
test('initial import, local edits, cloud edits and no-op sync use one shared base', async (t) => {
  const f = fixture(t);
  let r = await syncCloud(f.root, { api: f.api });
  assert.equal(r.uploaded, 3);
  writeFileSync(f.path, 'local edit\n');
  r = await syncCloud(f.root, { api: f.api });
  assert.equal(r.uploaded, 1);
  assert.equal(f.remote.get(f.id).content, 'local edit\n');
  f.changeCloud('phone edit\n');
  r = await syncCloud(f.root, { api: f.api });
  assert.equal(r.downloaded, 1);
  assert.equal(readFileSync(f.path, 'utf8'), 'phone edit\n');
  r = await syncCloud(f.root, { api: f.api });
  assert.equal(r.uploaded + r.downloaded, 0);
  assert.equal(r.status, 'synced');
});
test('independent edits merge and overlapping edits retain both copies', async (t) => {
  const f = fixture(t);
  await syncCloud(f.root, { api: f.api });
  const base = readFileSync(f.path, 'utf8');
  writeFileSync(f.path, base.replace('one', 'local one'));
  f.changeCloud(base.replace('eight', 'phone eight'));
  const r = await syncCloud(f.root, { api: f.api });
  assert.equal(r.merged, 1);
  assert.match(readFileSync(f.path, 'utf8'), /local one/);
  assert.match(readFileSync(f.path, 'utf8'), /phone eight/);
  const shared = readFileSync(f.path, 'utf8');
  writeFileSync(f.path, shared.replace('three', 'local three'));
  f.changeCloud(shared.replace('three', 'phone three'));
  const conflict = await syncCloud(f.root, { api: f.api });
  assert.equal(conflict.status, 'needs-review');
  assert.equal(conflict.conflicts[0].reason, 'overlapping-edits');
  assert.match(readFileSync(f.path, 'utf8'), /local three/);
  assert.match(f.remote.get(f.id).content, /phone three/);
});
test('offline errors preserve local knowledge and mark sync state clearly', async (t) => {
  const f = fixture(t);
  await syncCloud(f.root, { api: f.api });
  const before = readFileSync(f.path, 'utf8');
  f.offline();
  await assert.rejects(syncCloud(f.root, { api: f.api }), /offline/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(
    JSON.parse(
      readFileSync(join(f.root, '.exposurie/cloud-sync/state.json'), 'utf8'),
    ).lastSync.status,
    'offline-or-error',
  );
});
test('cloud paths are checked before bodies are loaded; raw sources never enter snapshot', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'raw'));
  writeFileSync(join(f.root, 'raw/do-not-read.md'), 'excluded');
  assert.equal(
    [...scanBrain(f.root).keys()].some((k) => k.startsWith('raw/')),
    false,
  );
  f.remote.set('raw/unsafe.md', {
    id: 'raw/unsafe.md',
    hash: hash('invalid'),
    revision: 1,
  });
  await assert.rejects(
    syncCloud(f.root, { api: f.api }),
    /non-curated|protected/,
  );
  assert.deepEqual(f.calls, ['manifest']);
});
test('a new cloud page appears locally with one catalog entry', async (t) => {
  const f = fixture(t);
  await syncCloud(f.root, { api: f.api });
  const id = 'wiki/entities/New Subject.md',
    content =
      '---\ntype: entity\ncreated: 2026-11-18\nupdated: 2026-11-18\ntags: []\n---\n\nNew sourced fact.\n';
  f.remote.set(id, {
    id,
    title: 'New Subject',
    content,
    hash: hash(content),
    revision: 1,
    system: 0,
  });
  await syncCloud(f.root, { api: f.api });
  await syncCloud(f.root, { api: f.api });
  assert.equal(readFileSync(join(f.root, id), 'utf8'), content);
  assert.equal(
    readFileSync(join(f.root, 'index.md'), 'utf8').split('[[New Subject]]')
      .length - 1,
    1,
  );
});
test('missing pages are reviewable and never silently deleted', () => {
  assert.equal(
    planPage(null, { hash: 'cloud' }, { hash: 'base' }, () => null).action,
    'conflict',
  );
  assert.equal(
    planPage({ hash: 'local' }, null, { hash: 'base' }, () => null).reason,
    'cloud-page-missing',
  );
});
