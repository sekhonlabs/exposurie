import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BrainStore, validateLinks, datePages } from '../src/cloud/store.js';
import { createScope } from '../src/cloud/scope.js';
import { runTool, TOOLS } from '../src/cloud/mcp.js';
import { createCloudHandler } from '../src/cloud/server.js';
import { syncCloud, makeCloudApi, cloudConfig } from '../src/cloud/sync.js';
import { localFirst } from '../src/cloud/local-first.js';
import { read } from '../src/commands/read.js';

// Production uses D1. Node >=22's SQLite lets these tests exercise the actual
// migration, SQL CAS and triggers without a cloud account or npm dependency.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
const sqliteTest = (name, fn) =>
  test(
    name,
    {
      skip:
        !DatabaseSync && 'SQL integration requires Node >=22 with node:sqlite',
    },
    fn,
  );

function fixture(t, scope) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    readFileSync(
      new URL(
        '../examples/cloudflare/migrations/0001_brain.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const adapter = {
    prepare(sql) {
      return {
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...(this.values ?? [])) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...(this.values ?? [])) };
        },
      };
    },
  };
  return { db, store: new BrainStore(adapter, { scope }) };
}
const markdown = (extra = 'A sourced note.') =>
  `---\ntype: entity\ncreated: 2026-06-01\nupdated: 2026-06-01\ntags: []\n---\n# Example\n\n${extra}\n`;
const edit = (
  content = markdown(),
  revision = 0,
  request = 'request_initial_01',
) => ({
  id: 'wiki/entities/Example.md',
  content,
  expected_revision: revision,
  request_id: request,
  reason: 'Save explicitly authorized fixture evidence.',
});
const context = { origin: 'https://brain.example', actor: 'owner' };

sqliteTest(
  'actual migration and SQL preserve revisions; stale writes and request-id reuse cannot overwrite',
  async (t) => {
    const { store, db } = fixture(t);
    const first = await store.write(edit(), { sync: true, actor: 'local' });
    assert.equal(first.revision, 1);
    assert.equal(first.hash.length, 64);
    const input = edit(markdown('Phone edit.'), 1, 'request_phone_01');
    await store.write(input, { sync: true, actor: 'phone' });
    await assert.rejects(
      store.write(edit(markdown('Stale local edit.'), 1, 'request_stale_01'), {
        sync: true,
      }),
      (e) => e.code === 'revision_conflict',
    );
    assert.equal((await store.write(input, { sync: true })).replayed, true);
    await assert.rejects(
      store.write(
        { ...input, content: markdown('Different request.') },
        { sync: true },
      ),
      /different edit/,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM changes').get().n, 2);
    assert.match(
      db.prepare('SELECT content FROM changes ORDER BY sequence LIMIT 1').get()
        .content,
      /sourced note/,
    );
    assert.match((await store.get(input.id)).content, /Phone edit/);
  },
);

sqliteTest(
  'cloud content validates metadata, sources and creation date; mirrors preserve exact bytes',
  async (t) => {
    const { store } = fixture(t);
    await assert.rejects(
      store.write(edit('no schema'), { sync: true }),
      /front matter/,
    );
    await assert.rejects(
      store.write(
        edit(markdown().replace('created: 2026-06-01', 'created: 2026-02-30')),
        { sync: true },
      ),
      /calendar/,
    );
    await store.write(edit(), { sync: true });
    await assert.rejects(
      store.write(
        edit(
          markdown().replace('created: 2026-06-01', 'created: 2025-01-01'),
          1,
          'request_created_01',
        ),
        { sync: true },
      ),
      /created/,
    );
    assert.equal((await store.get(edit().id)).content, markdown());
    assert.throws(
      () => validateLinks(edit().id, markdown('[[Missing]]'), []),
      /does not exist/,
    );
    assert.doesNotThrow(() =>
      validateLinks(
        edit().id,
        markdown('~~~~md\n[[Missing]]\n~~~~\n<!-- [[Missing]] -->'),
        [],
      ),
    );
  },
);

sqliteTest(
  'cloud follows renamed nested categories and exposes only the configured scope',
  async (t) => {
    const scope = createScope({ entities: 'knowledge/people' }, 'archives', {
      index: 'catalog.md',
    });
    const { store } = fixture(t, scope);
    const input = { ...edit(), id: 'knowledge/people/team/Example.md' };
    await store.write(input, { sync: true });
    assert.equal((await store.get(input.id)).title, 'Example');
    for (const id of [
      'archives/a.md',
      'wiki/entities/A.md',
      '.git/A.md',
      '.exposurie/config.json',
      'knowledge/people/../A.md',
      'knowledge/people/.hidden.md',
    ])
      await assert.rejects(store.write({ ...edit(), id }, { sync: true }));
    await assert.rejects(
      store.write({ ...edit(), id: 'catalog.md' }),
      /curated/,
    );
  },
);

sqliteTest(
  'standard search/fetch retain source text, citation URL and current revision; dates share one engine',
  async (t) => {
    const { store } = fixture(t);
    await store.write(
      edit(
        markdown(
          '## Dated events\n- 2026-05 | milestone | Built the parser. | [[Example#Example]]',
        ),
      ),
      { sync: true },
    );
    const found = await runTool(store, 'search', { query: 'Example' }, context);
    assert.deepEqual(Object.keys(found), ['results']);
    const fetched = await runTool(
      store,
      'fetch',
      { id: found.results[0].id },
      context,
    );
    assert.equal(fetched.metadata.revision, 1);
    assert.match(fetched.url, /\/brain\?id=/);
    assert.equal(datePages(await store.all(), { on: '2026-05-15' }).total, 1);
    assert.equal(datePages(await store.all(), { on: '2026-06-01' }).total, 0);
    assert.equal(
      datePages(await store.all(), { on: '2026-06-01', field: 'created' })
        .total,
      1,
    );
    assert.equal(
      TOOLS.find((t) => t.name === 'search').annotations.readOnlyHint,
      true,
    );
    assert.equal(
      TOOLS.find((t) => t.name === 'update_page').annotations.readOnlyHint,
      false,
    );
    await assert.rejects(
      runTool(
        store,
        'search',
        { query: 'Example', unsupported: true },
        context,
      ),
      /Invalid argument/,
    );
  },
);

sqliteTest(
  'explicit saves require rules, preserve sourced content and replay after later edits',
  async (t) => {
    const { store } = fixture(t);
    await assert.rejects(
      runTool(store, 'create_page', edit(), context),
      /source policy/,
    );
    for (const id of [
      store.scope.policy,
      'CLAUDE.md',
      '.exposurie/wiki-prompt.md',
      '.exposurie/how-they-work.md',
    ])
      await store.write(
        {
          ...edit('Fixture rules.'),
          id,
          request_id: `rules_${id.replace(/[^a-z]/gi, '_')}`,
        },
        { sync: true },
      );
    assert.equal(
      (await runTool(store, 'brain_rules', {}, context)).categories.entities,
      'wiki/entities',
    );
    const first = await runTool(store, 'create_page', edit(), context);
    await runTool(
      store,
      'update_page',
      edit(markdown('Later edit.'), first.revision, 'request_later_01'),
      context,
    );
    assert.equal(
      (await runTool(store, 'create_page', edit(), context)).replayed,
      true,
    );
    assert.match((await store.get(edit().id)).content, /Later edit/);
  },
);

sqliteTest(
  'HTTP sync rejects anonymous calls and invalid paths before content reads; push uses CAS',
  async (t) => {
    const { store } = fixture(t);
    const token = 'test-only-sync-token-at-least-32-characters';
    const oauth = {
      metadata: { resource: 'https://brain.example/mcp' },
      authorize: async () => {
        throw Object.assign(Error(), { status: 401 });
      },
    };
    const handler = createCloudHandler(store, {
      origin: context.origin,
      oauth,
      syncToken: token,
    });
    const req = (path, body, auth = true) =>
      new Request(`${context.origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await handler(req('/api/sync', null, false))).status, 401);
    let got = 0;
    const get = store.get.bind(store);
    store.get = async (id) => {
      got++;
      return get(id);
    };
    assert.equal(
      (
        await handler(
          req('/api/sync', {
            action: 'pull',
            ids: [edit().id, 'raw/private.md'],
          }),
        )
      ).status,
      400,
    );
    assert.equal(got, 0);
    const first = await (
      await handler(req('/api/sync', { action: 'push', pages: [edit()] }))
    ).json();
    assert.equal(first.results[0].revision, 1);
    const stale = await (
      await handler(
        req('/api/sync', {
          action: 'push',
          pages: [edit(markdown('stale'), 0, 'request_stale_02')],
        }),
      )
    ).json();
    assert.equal(stale.results[0].error, 'revision_conflict');
    const pulled = await (
      await handler(req('/api/sync', { action: 'pull', ids: [edit().id] }))
    ).json();
    assert.equal(pulled.pages[0].content, markdown());
    const attack = new Request(req('/api/sync'), {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://other.example',
      },
    });
    assert.equal((await handler(attack)).status, 403);
  },
);

sqliteTest(
  'real HTTP round trip mirrors local and mobile edits, rejects stale writes and keeps offline reads',
  async (t) => {
    const { store } = fixture(t);
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'exposurie-http-roundtrip-')),
    );
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.exposurie'));
    mkdirSync(join(root, 'wiki/entities'), { recursive: true });
    const put = (id, text) => writeFileSync(join(root, id), text);
    put(
      '.exposurie/config.json',
      JSON.stringify({ categories: store.scope.categories }),
    );
    for (const id of [
      store.scope.policy,
      'CLAUDE.md',
      '.exposurie/wiki-prompt.md',
      '.exposurie/how-they-work.md',
    ])
      put(id, 'Synthetic fixture policy and schema.');
    put('index.md', '# Index\n\n## Entities\n');
    put(edit().id, markdown());
    let handler,
      calls = 0;
    const server = createServer(async (request, response) => {
      calls++;
      const url = `http://127.0.0.1:${server.address().port}${request.url}`;
      const input = new Request(url, {
        method: request.method,
        headers: request.headers,
        ...(['GET', 'HEAD'].includes(request.method)
          ? {}
          : { body: request, duplex: 'half' }),
      });
      const output = await handler(input);
      response.writeHead(output.status, Object.fromEntries(output.headers));
      response.end(Buffer.from(await output.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    t.after(async () => {
      if (server.listening) await close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const token = 'fixture-only-local-sync-token-over-32-characters';
    const oauth = {
      metadata: {},
      authorize: async (request) => {
        if (request.headers.get('Authorization') !== 'Bearer fixture-oauth')
          throw new BrainError('Sign in.', 'unauthorized', 401);
        return 'fixture-owner';
      },
    };
    handler = createCloudHandler(store, { origin, oauth, syncToken: token });
    put('.exposurie/cloud.json', JSON.stringify({ url: origin }));
    const api = makeCloudApi(cloudConfig(root), token);
    const mirror = () => syncCloud(root, { api });
    assert.equal((await mirror()).status, 'synced');
    async function call(name, args) {
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fixture-oauth',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const rpc = await response.json();
      return { ...rpc.result, value: JSON.parse(rpc.result.content[0].text) };
    }
    const fetched = (await call('fetch', { id: edit().id })).value;
    const update = edit(
      markdown('Phone change.'),
      fetched.metadata.revision,
      'request_http_phone',
    );
    assert.equal((await call('update_page', update)).isError, undefined);
    await mirror();
    assert.match(readFileSync(join(root, edit().id), 'utf8'), /Phone change/);
    const stale = await call('update_page', {
      ...update,
      content: markdown('Stale overwrite.'),
      request_id: 'request_http_stale',
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.value.error, 'revision_conflict');
    const current = readFileSync(join(root, edit().id), 'utf8');
    put(edit().id, current.replace('Phone change.', 'Laptop change.'));
    await mirror();
    assert.match(
      (await call('fetch', { id: edit().id })).value.text,
      /Laptop change/,
    );
    const newId = 'wiki/entities/New Cloud Page.md';
    assert.equal(
      (
        await call('create_page', {
          ...edit(markdown('A new cloud fact.')),
          id: newId,
          request_id: 'request_http_new_page',
        })
      ).isError,
      undefined,
    );
    const refreshed = await localFirst(
      read,
      { at: root, search: 'new cloud fact' },
      [],
      mirror,
    );
    assert.match(refreshed.body.join('\n'), /A new cloud fact/);
    assert.match(
      readFileSync(join(root, 'index.md'), 'utf8'),
      /\[\[New Cloud Page\]\]/,
    );
    await close();
    const before = calls;
    assert.equal(
      (await localFirst(read, { at: root, search: 'Laptop' }, [], mirror)).code,
      0,
    );
    assert.equal(calls, before);
    const offline = await localFirst(
      read,
      { at: root, search: 'Unrecorded' },
      [],
      mirror,
    );
    assert.equal(offline.code, 0);
    assert.match(offline.body.join('\n'), /Cloud refresh unavailable/);
  },
);
