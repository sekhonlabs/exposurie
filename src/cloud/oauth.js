// Resource-server verification only. An established OAuth provider owns login,
// PKCE, client registration, consent, refresh and revocation. No identity headers
// supplied by an HTTP caller are trusted.
import { BrainError } from './store.js';

function https(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      'OAuth URLs must use HTTPS without credentials, query or fragment.',
    );
  return url;
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid JWT encoding.');
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}
const denied = () =>
  new BrainError(
    'Sign in with the brain owner account and required scopes.',
    'unauthorized',
    401,
  );

export function createOAuth(
  { issuer, audience, owner },
  { fetcher = fetch, now = () => Date.now() } = {},
) {
  https(issuer);
  https(audience);
  if (typeof owner !== 'string' || !owner)
    throw Error('Configure the OAuth owner subject.');
  let cached;
  async function json(url) {
    https(url);
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error('OAuth metadata unavailable.');
    const text = await response.text();
    if (text.length > 100000) throw Error('OAuth metadata too large.');
    return JSON.parse(text);
  }
  async function keys(refresh = false) {
    if (!refresh && cached && cached.expires > now()) return cached.keys;
    const metadata = await json(
      `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    );
    if (metadata.issuer !== issuer)
      throw Error('OAuth metadata issuer mismatch.');
    const jwks = await json(metadata.jwks_uri);
    if (!Array.isArray(jwks.keys)) throw Error('Invalid OAuth key set.');
    cached = { keys: jwks.keys, expires: now() + 300000 };
    return cached.keys;
  }
  return {
    metadata: {
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ['brain.read', 'brain.write'],
      bearer_methods_supported: ['header'],
    },
    async authorize(request, tool) {
      try {
        const token = /^Bearer ([^\s]+)$/i.exec(
          request.headers.get('Authorization') ?? '',
        )?.[1];
        if (!token || token.length > 20000) throw denied();
        const parts = token.split('.');
        if (parts.length !== 3) throw denied();
        const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
        const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
        if (
          header.alg !== 'RS256' ||
          typeof header.kid !== 'string' ||
          header.crit
        )
          throw denied();
        let candidates = (await keys()).filter(
          (k) =>
            k.kid === header.kid &&
            k.kty === 'RSA' &&
            (!k.alg || k.alg === 'RS256') &&
            (!k.use || k.use === 'sig'),
        );
        if (!candidates.length)
          candidates = (await keys(true)).filter(
            (k) =>
              k.kid === header.kid &&
              k.kty === 'RSA' &&
              (!k.alg || k.alg === 'RS256') &&
              (!k.use || k.use === 'sig'),
          );
        if (candidates.length !== 1) throw denied();
        const key = await crypto.subtle.importKey(
          'jwk',
          candidates[0],
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        if (
          !(await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            decode(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
          ))
        )
          throw denied();
        const time = now() / 1000;
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (
          claims.iss !== issuer ||
          !audiences.includes(audience) ||
          claims.sub !== owner ||
          !Number.isFinite(claims.exp) ||
          claims.exp <= time ||
          (claims.nbf !== undefined &&
            (!Number.isFinite(claims.nbf) || claims.nbf > time + 15))
        )
          throw denied();
        const scopes =
          typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [];
        const required = tool.annotations.readOnlyHint
          ? ['brain.read']
          : ['brain.read', 'brain.write'];
        if (!required.every((scope) => scopes.includes(scope))) throw denied();
        return claims.sub;
      } catch {
        throw denied();
      }
    },
  };
}
