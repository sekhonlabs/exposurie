import { join } from 'node:path';
import { resolveVault } from '../context.js';
import { vaultState } from '../vault.js';
import { curatedVault, noLinks } from '../dates.js';
import { cloudConfig, cloudStatus, syncCloud, atomic } from '../cloud/sync.js';
import { OK, ERROR, USAGE } from '../exit-codes.js';

export async function cloud(values = {}, positionals = []) {
  const vault = resolveVault(values.at);
  const state = vaultState(vault, 'cloud');
  const action = positionals[0] ?? 'status';
  if (
    positionals.length > 1 ||
    !['status', 'configure', 'sync'].includes(action)
  )
    return {
      code: USAGE,
      state,
      error: {
        message:
          'Use cloud status, cloud configure --url <https-origin>, or cloud sync.',
      },
    };
  if (!vault)
    return {
      code: ERROR,
      state,
      error: { message: 'No brain at the requested location.' },
    };
  try {
    const { root } = curatedVault(vault);
    if (action === 'configure') {
      if (!values.url)
        throw Error('cloud configure requires --url <https-origin>.');
      // Validate before touching the previous configuration. No secret is read
      // or stored by configure; only the name of an environment variable.
      const config = cloudConfig(null, {
        url: values.url,
        tokenEnv: values['token-env'] ?? 'EXPOSURIE_SYNC_TOKEN',
      });
      const path = join(root, '.exposurie/cloud.json');
      noLinks(root, path, { missing: true });
      atomic(path, JSON.stringify(config, null, 2) + '\n');
      return {
        code: OK,
        state,
        body: [
          'CLOUD CONFIGURED',
          `  ${config.url}`,
          `  Set ${config.tokenEnv} through your secret manager, then run exposurie cloud sync.`,
          '  This does not schedule mirroring or ingest conversations.',
        ],
        json: { configured: true, ...config },
      };
    }
    const result =
      action === 'sync' ? await syncCloud(vault) : cloudStatus(vault);
    return {
      code: result.status === 'needs-review' ? ERROR : OK,
      state,
      body: [
        action === 'sync' ? 'CLOUD MIRROR' : 'CLOUD STATUS',
        JSON.stringify(result, null, 2),
      ],
      json: result,
    };
  } catch (error) {
    return {
      code: ERROR,
      state,
      error: {
        message: error.message,
        fix: 'Local pages remain available. Check cloud status, source policy and docs/cloud.md before retrying.',
      },
    };
  }
}
