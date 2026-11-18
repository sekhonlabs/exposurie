// Logical cloud paths. Shared by the filesystem mirror and the remote store.
// No raw sources, checkpoints, credentials, hidden pages or Git history cross
// this boundary. Renamed categories must be configured on BOTH ends.
export const DEFAULT_CATEGORIES = {
  sources: 'wiki/sources',
  entities: 'wiki/entities',
  concepts: 'wiki/concepts',
  syntheses: 'wiki/syntheses',
};
export const SYSTEM_IDS = new Set([
  'CLAUDE.md',
  '.exposurie/source-policy.md',
  '.exposurie/wiki-prompt.md',
  '.exposurie/how-they-work.md',
  '.exposurie/curate.md',
  ...['entity', 'concept', 'source', 'synthesis'].map(
    (n) => `.exposurie/templates/${n}.md`,
  ),
  'index.md',
  'log.md',
]);
const RESERVED = new Set(['raw', 'history', 'staging', 'staged']);
function parts(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 500 ||
    /[\\\u0000-\u001f:*?"<>|]/.test(path)
  )
    throw Error('Invalid curated path.');
  const result = path.split('/');
  if (
    result.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p.startsWith('.') ||
        p.endsWith('.') ||
        p.endsWith(' ') ||
        RESERVED.has(p.toLowerCase()),
    )
  )
    throw Error('Cloud path overlaps a protected source/history directory.');
  return result;
}
export function createScope(
  categories = DEFAULT_CATEGORIES,
  raw = 'raw',
  paths = {},
) {
  if (
    !categories ||
    Array.isArray(categories) ||
    typeof categories !== 'object' ||
    !Object.keys(categories).length
  )
    throw Error('Configure at least one page category.');
  const entries = Object.entries(categories).map(([name, path]) => {
    parts(path);
    if (typeof raw === 'string' && (path === raw || path.startsWith(`${raw}/`)))
      throw Error('Cloud category overlaps raw sources.');
    return { name, path };
  });
  const index = paths.index ?? 'index.md',
    log = paths.log ?? 'log.md';
  for (const path of [index, log]) {
    parts(path);
    if (path.includes('/') || !path.endsWith('.md'))
      throw Error('Cloud catalog and log must be top-level Markdown files.');
  }
  const policy = paths.sourcePolicy ?? '.exposurie/source-policy.md';
  if (!/^\.exposurie\/[A-Za-z0-9_-]+\.md$/.test(policy))
    throw Error(
      'Cloud source policy must be a Markdown file directly in .exposurie/.',
    );
  const systemIds = new Set(
    [...SYSTEM_IDS].filter(
      (id) =>
        !['index.md', 'log.md', '.exposurie/source-policy.md'].includes(id),
    ),
  );
  systemIds.add(policy);
  systemIds.add(index);
  systemIds.add(log);
  function category(id) {
    parts(id);
    if (id === raw || id.startsWith(`${raw}/`))
      throw Error('Raw sources are not mirrored.');
    if (!id.endsWith('.md')) throw Error('Cloud pages must be Markdown.');
    const found = entries
      .filter((e) => id.startsWith(`${e.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!found) throw Error('Cloud sync rejected a non-curated path.');
    return found.name;
  }
  return {
    categories: { ...categories },
    systemIds,
    index,
    log,
    policy,
    validId(id, system = false) {
      if (!(system && systemIds.has(id))) category(id);
      return id;
    },
    category,
    type(id) {
      return (
        {
          entities: 'entity',
          concepts: 'concept',
          sources: 'source',
          syntheses: 'synthesis',
        }[category(id)] ?? null
      );
    },
  };
}
export const DEFAULT_SCOPE = createScope();
