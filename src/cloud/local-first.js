import { resolveVault } from '../context.js';
import { cloudConfig, syncCloud } from './sync.js';

/** Optional miss refresh. A local hit never loads credentials or uses the net. */
export async function localFirst(run, values, positionals, mirror = syncCloud) {
  const local = run(values, positionals);
  if (!local.miss) return local;
  const vault = resolveVault(values.at);
  if (!vault) return local;
  try {
    if (!cloudConfig(vault)) return local;
    const refreshed = await mirror(vault);
    const result = refreshed.downloaded ? run(values, positionals) : local;
    const status = {
      status: refreshed.status,
      downloaded: refreshed.downloaded ?? 0,
      conflicts: refreshed.conflicts?.length ?? 0,
    };
    return {
      ...result,
      body: [
        ...(result.body ?? []),
        '',
        `Cloud refresh: ${status.status}; ${status.downloaded} files downloaded.`,
      ],
      ...(result.json ? { json: { ...result.json, cloud: status } } : {}),
    };
  } catch {
    return {
      ...local,
      body: [
        ...(local.body ?? []),
        '',
        'Cloud refresh unavailable. Showing the local result.',
      ],
      ...(local.json
        ? { json: { ...local.json, cloud: { status: 'unavailable' } } }
        : {}),
    };
  }
}
