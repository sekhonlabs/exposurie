// Optional host adapter. No npm runtime dependency or private account service.
import { BrainStore } from '../../src/cloud/store.js';
import { createScope, DEFAULT_CATEGORIES } from '../../src/cloud/scope.js';
import { createOAuth } from '../../src/cloud/oauth.js';
import { createCloudHandler } from '../../src/cloud/server.js';

export default {
  async fetch(request, env) {
    try {
      const scope = createScope(
        env.BRAIN_CATEGORIES
          ? JSON.parse(env.BRAIN_CATEGORIES)
          : DEFAULT_CATEGORIES,
        env.BRAIN_RAW ?? 'raw',
        {
          index: env.BRAIN_INDEX,
          log: env.BRAIN_LOG,
          sourcePolicy: env.BRAIN_SOURCE_POLICY,
        },
      );
      const oauth = createOAuth({
        issuer: env.OAUTH_ISSUER,
        audience: `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/mcp`,
        owner: env.OWNER_SUBJECT,
      });
      const store = new BrainStore(env.DB, {
        scope,
        timeZone: env.BRAIN_TIME_ZONE ?? 'UTC',
      });
      return createCloudHandler(store, {
        origin: env.PUBLIC_ORIGIN,
        oauth,
        syncToken: env.EXPOSURIE_SYNC_TOKEN,
      })(request);
    } catch {
      return Response.json(
        { error: 'Cloud brain configuration unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
};
