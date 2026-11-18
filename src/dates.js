import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { queryDatePages } from './dates-core.js';
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function within(root, input) {
  if (typeof input !== 'string' || !input)
    throw Error('A configured path must be a nonempty string');
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Error('Configured path escapes the vault');
  return path;
}

export function noLinks(root, path, { missing = false } = {}) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw Error(`Symlink paths are not followed: ${relative(root, current)}`);
  }
  return true;
}

export function readInside(root, input) {
  const path = within(root, input);
  noLinks(root, path);
  if (!lstatSync(path).isFile())
    throw Error(`Expected a regular file: ${input}`);
  return readFileSync(path, 'utf8');
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export function pageFiles(root, config, warnings) {
  const categories = config.categories;
  if (
    !categories ||
    typeof categories !== 'object' ||
    Array.isArray(categories) ||
    !Object.keys(categories).length
  ) {
    throw Error('No valid page categories in the Exposurie configuration');
  }
  const protectedPaths = [
    'raw',
    '.git',
    '.exposurie',
    'history',
    'staging',
    'staged',
    config.raw ?? 'raw',
  ].map((path) => within(root, path));
  const reserved = new Set(['raw', 'history', 'staging', 'staged']);
  const forbidden = (path) =>
    protectedPaths.some((parent) => isInside(parent, path)) ||
    relative(root, path)
      .split(sep)
      .some((part) => part.startsWith('.') || reserved.has(part.toLowerCase()));
  const starts = [
    ...new Set(Object.values(categories).map((path) => within(root, path))),
  ];
  // Validate every category before opening any page content.
  for (const start of starts) {
    if (start === root || forbidden(start))
      throw Error(
        'Page category overlaps a protected source/history directory',
      );
    noLinks(root, start, { missing: true });
  }
  const files = new Set();
  const visited = new Set();
  function walk(path) {
    if (visited.has(path)) return;
    visited.add(path);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory())
      throw Error(`Page category must be a directory: ${relative(root, path)}`);
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => compare(a.name, b.name),
    )) {
      const child = join(path, entry.name);
      const rel = relative(root, child);
      if (entry.isSymbolicLink()) {
        warnings.push({
          path: rel,
          line: null,
          code: 'symlink-skipped',
          message: 'Symlink page or directory was not read',
        });
        continue;
      }
      if (forbidden(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.add(child);
    }
  }
  starts.forEach(walk);
  return [...files].sort(compare);
}

/** Resolve a configured vault without following a root or configuration symlink. */
export function curatedVault(vault) {
  if (typeof vault !== 'string' || !vault.trim())
    throw Error('Vault must be a directory path');
  const requestedRoot = resolve(vault);
  const stat = lstatSync(requestedRoot);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(requestedRoot) === requestedRoot
  )
    throw Error(
      'Vault must be a real directory, not a symlink or filesystem root',
    );
  const root = realpathSync(requestedRoot);
  const config = JSON.parse(readInside(root, '.exposurie/config.json'));
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw Error('Invalid Exposurie configuration');
  if (config.sourcePolicy !== undefined) {
    const policy = within(root, config.sourcePolicy);
    noLinks(root, policy);
    if (!lstatSync(policy).isFile())
      throw Error('Source policy must be a regular file');
  }
  return { root, config };
}

/** Read curated page metadata and explicit dated events without changing the vault. */
export function queryDates(vault, options = {}) {
  const { root, config } = curatedVault(vault);
  const warnings = [];
  const pages = pageFiles(root, config, warnings).map((path) => ({
    title: basename(path, '.md'),
    path: relative(root, path).split(sep).join('/'),
    content: readInside(root, path),
  }));
  const result = queryDatePages(pages, options);
  return {
    ...result,
    vault: root,
    warnings: [...warnings, ...result.warnings],
  };
}
