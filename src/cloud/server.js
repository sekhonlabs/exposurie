import { BrainError, digest, validId } from './store.js';
import { handleMcp } from './mcp.js';

const json = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });

async function bodyText(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8000000)
        throw new BrainError('Request body too large.', 'too_large', 413);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

async function matchesToken(request, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const supplied = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get('Authorization') ?? '',
  )?.[1];
  if (!supplied || supplied.length > 1000) return false;
  const [a, b] = await Promise.all([digest(token), digest(supplied)]);
  let different = 0;
  for (let i = 0; i < a.length; i++)
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

/** Fetch handler, independent of any host's account or identity headers. */
export function createCloudHandler(store, { origin, oauth, syncToken }) {
  const host = new URL(origin);
  if (
    host.protocol !== 'https:' &&
    !(
      host.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(host.hostname)
    )
  )
    throw Error('Use HTTPS for the public cloud origin.');
  if (
    host.username ||
    host.password ||
    host.pathname !== '/' ||
    host.search ||
    host.hash
  )
    throw Error('Configure a bare public origin.');
  const challenge = `Bearer resource_metadata="${host.origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="Sign in to access this private brain"`;
  return async (request) => {
    const url = new URL(request.url);
    const browserOrigin = request.headers.get('Origin');
    if (browserOrigin && browserOrigin !== host.origin)
      return json({ error: 'Invalid Origin.' }, 403);
    try {
      if (
        url.pathname === '/.well-known/oauth-protected-resource' &&
        request.method === 'GET'
      )
        return json(oauth.metadata);
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST')
          return json({ error: 'Use POST for MCP.' }, 405, { Allow: 'POST' });
        if (
          !request.headers
            .get('Content-Type')
            ?.toLowerCase()
            .startsWith('application/json')
        )
          return json({ error: 'Use application/json.' }, 415);
        const text = await bodyText(request);
        return handleMcp(
          new Request(request, { body: text }),
          store,
          oauth.authorize,
          { challenge },
        );
      }
      if (url.pathname === '/api/sync') {
        if (!(await matchesToken(request, syncToken)))
          throw new BrainError(
            'Cloud sync authentication required.',
            'unauthorized',
            401,
          );
        if (request.method === 'GET')
          return json({
            pages: await store.manifest(),
            categories: store.scope.categories,
          });
        if (request.method !== 'POST')
          return json({ error: 'Use GET or POST.' }, 405, {
            Allow: 'GET, POST',
          });
        let body;
        try {
          body = JSON.parse(await bodyText(request));
        } catch (error) {
          if (error instanceof BrainError) throw error;
          throw new BrainError('Invalid JSON.');
        }
        if (body?.action === 'pull') {
          if (!Array.isArray(body.ids) || body.ids.length > 25)
            throw new BrainError('Pull up to 25 curated file IDs.');
          // All paths are checked BEFORE loading any content.
          body.ids.forEach((id) => validId(id, true, store.scope));
          const pages = await Promise.all(body.ids.map((id) => store.get(id)));
          if (pages.some((p) => !p))
            throw new BrainError(
              'A requested file is missing. Refresh the manifest.',
              'revision_conflict',
              409,
            );
          return json({ pages });
        }
        if (body?.action === 'push') {
          if (!Array.isArray(body.pages) || body.pages.length > 25)
            throw new BrainError('Push up to 25 curated files.');
          body.pages.forEach((page) => validId(page?.id, true, store.scope));
          const results = [];
          for (const page of body.pages) {
            try {
              results.push(
                await store.write(page, { actor: 'local-mirror', sync: true }),
              );
            } catch (error) {
              results.push({
                id: page.id,
                error:
                  error instanceof BrainError ? error.code : 'storage_error',
              });
            }
          }
          return json({ results });
        }
        throw new BrainError('Use action pull or push.');
      }
      if (url.pathname === '/brain' && request.method === 'GET') {
        await oauth.authorize(request, { annotations: { readOnlyHint: true } });
        const page = await store.get(
          validId(url.searchParams.get('id'), false, store.scope),
        );
        if (!page) throw new BrainError('Page not found.', 'not_found', 404);
        return new Response(page.content, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      return json(
        {
          error: error instanceof BrainError ? error.code : 'server_error',
          message:
            error instanceof BrainError
              ? error.message
              : 'Cloud brain unavailable.',
        },
        error.status ?? 500,
        error.status === 401 ? { 'WWW-Authenticate': challenge } : {},
      );
    }
  };
}
