import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuth } from '../src/cloud/oauth.js';
import { handleMcp } from '../src/cloud/mcp.js';
import { BrainError } from '../src/cloud/store.js';

test('real RS256 signatures bind OAuth tokens to issuer, audience, owner, expiry and scopes', async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: 'fixture-key',
    alg: 'RS256',
    use: 'sig',
  };
  const config = {
    issuer: 'https://login.example/',
    audience: 'https://brain.example/mcp',
    owner: 'owner-fixture',
  };
  const now = 1800000000000;
  const oauth = createOAuth(config, {
    now: () => now,
    fetcher: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration'))
        return Response.json({
          issuer: config.issuer,
          jwks_uri: 'https://login.example/jwks',
        });
      assert.equal(url, 'https://login.example/jwks');
      return Response.json({ keys: [publicKey] });
    },
  });
  const encode = (object) =>
    Buffer.from(JSON.stringify(object)).toString('base64url');
  async function token(overrides = {}, header = {}) {
    const body = `${encode({ alg: 'RS256', kid: publicKey.kid, ...header })}.${encode({ iss: config.issuer, aud: config.audience, sub: config.owner, exp: now / 1000 + 600, scope: 'brain.read brain.write', ...overrides })}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(body),
    );
    return `${body}.${Buffer.from(signature).toString('base64url')}`;
  }
  const request = (value) =>
    new Request(config.audience, {
      headers: {
        Authorization: `Bearer ${value}`,
        'oai-authenticated-user-email': 'untrusted@example.test',
      },
    });
  const read = { annotations: { readOnlyHint: true } },
    write = { annotations: { readOnlyHint: false } };
  assert.equal(
    await oauth.authorize(request(await token()), write),
    config.owner,
  );
  const readOnly = request(await token({ scope: 'brain.read' }));
  assert.equal(await oauth.authorize(readOnly, read), config.owner);
  await assert.rejects(
    oauth.authorize(readOnly, write),
    (e) => e.status === 401,
  );
  for (const overrides of [
    { iss: 'https://other.example/' },
    { aud: 'https://other.example/mcp' },
    { sub: 'someone-else' },
    { exp: now / 1000 - 1 },
    { nbf: now / 1000 + 100 },
    { scope: '' },
  ])
    await assert.rejects(
      oauth.authorize(request(await token(overrides)), read),
      (e) => e.status === 401,
    );
  await assert.rejects(
    oauth.authorize(request(await token({}, { alg: 'none' })), read),
  );
  await assert.rejects(
    oauth.authorize(request((await token()).replace(/.$/, '!')), read),
  );
  await assert.rejects(
    oauth.authorize(
      new Request(config.audience, {
        headers: { 'oai-authenticated-user-email': 'owner@example.test' },
      }),
      read,
    ),
  );
  assert.equal(oauth.metadata.resource, config.audience);
});

test('MCP modern discovery and legacy initialization work; anonymous calls reveal no brain content', async () => {
  let reads = 0;
  const store = {
    async all() {
      reads++;
      return [];
    },
  };
  const authorize = async () => {
    throw new BrainError('Sign in.', 'unauthorized', 401);
  };
  const challenge =
    'Bearer resource_metadata="https://brain.example/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in"';
  function rpc(method, params = {}, modern = false, headers = {}) {
    return new Request('https://brain.example/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(modern
          ? {
              'MCP-Protocol-Version': '2026-07-28',
              'Mcp-Method': method,
              ...(params.name ? { 'Mcp-Name': params.name } : {}),
            }
          : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              }
            : {}),
        },
      }),
    });
  }
  const call = async (...args) =>
    (await handleMcp(rpc(...args), store, authorize, { challenge })).json();
  const discovered = await call('server/discover', {}, true);
  assert.equal(discovered.result.resultType, 'complete');
  assert.equal(
    discovered.result._meta['io.modelcontextprotocol/serverInfo'].name,
    'exposurie-brain',
  );
  assert(discovered.result.supportedVersions.includes('2026-07-28'));
  assert.equal(
    (await call('initialize', { protocolVersion: '2025-06-18' })).result
      .protocolVersion,
    '2025-06-18',
  );
  assert.equal((await call('tools/list')).result.tools.length, 7);
  const denied = await call(
    'tools/call',
    { name: 'search', arguments: { query: 'private' } },
    true,
  );
  assert.equal(denied.result.isError, true);
  assert.deepEqual(denied.result._meta['mcp/www_authenticate'], [challenge]);
  assert.equal(reads, 0);
  assert.equal(
    (
      await call('server/discover', {}, true, {
        'MCP-Protocol-Version': '2025-11-25',
      })
    ).error.code,
    -32020,
  );
  assert.equal(
    (
      await call('tools/list', {}, false, {
        'MCP-Protocol-Version': '1900-01-01',
      })
    ).error.code,
    -32022,
  );
  const malformed = new Request('https://brain.example/mcp', {
    method: 'POST',
    body: '[',
  });
  assert.equal(
    (await (await handleMcp(malformed, store, authorize)).json()).error.code,
    -32700,
  );
});
