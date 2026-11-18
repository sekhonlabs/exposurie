import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  lstatSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  curatedVault,
  pageFiles,
  readInside,
  noLinks,
  within,
} from '../dates.js';
import { SYSTEM_IDS, createScope } from './scope.js';
export { SYSTEM_IDS };

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const load = (path, fallback) => {
  try {
    noLinks(dirname(dirname(path)), path);
    if (!lstatSync(path).isFile())
      throw Error('Expected a regular state/config file.');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
function safePath(root, id, missing = false, scope = localScope(root)) {
  scope.validId(id, true);
  const path = within(root, id);
  noLinks(root, path, { missing });
  return path;
}
function localScope(root) {
  const { config } = curatedVault(root);
  return createScope(config.categories, config.raw, config);
}
function internalDirectory(root) {
  for (const id of ['.exposurie', '.exposurie/cloud-sync']) {
    const path = join(root, id);
    if (
      existsSync(path) &&
      (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
    )
      throw Error('Cloud state must be a real directory.');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return join(root, '.exposurie/cloud-sync');
}
export function atomic(path, text) {
  // Validate all ancestors, including merge/conflict state directories.
  let parent = dirname(path);
  while (parent !== dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw Error('Cloud writes do not follow directory symlinks.');
    parent = dirname(parent);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw Error('Refusing to overwrite a symlink.');
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
export function scanBrain(root) {
  const { config } = curatedVault(root);
  const scope = createScope(config.categories, config.raw, config);
  // Cloud writes need a reviewed source policy in addition to the page schema.
  readInside(root, scope.policy);
  const warnings = [];
  const pages = new Map();
  for (const path of pageFiles(root, config, warnings)) {
    const id = relative(root, path).split('\\').join('/');
    scope.validId(id);
    const content = readInside(root, path);
    pages.set(id, { id, content, hash: hash(content) });
  }
  for (const id of scope.systemIds) {
    const path = safePath(root, id, true, scope);
    if (!existsSync(path)) continue;
    const content = readInside(root, id);
    pages.set(id, { id, content, hash: hash(content) });
  }
  return pages;
}
export function mergeVersions(local, base, cloud, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = join(directory, randomUUID());
  const paths = ['local', 'base', 'cloud'].map((s) => `${prefix}.${s}`);
  [local, base, cloud].forEach((s, i) =>
    writeFileSync(paths[i], s, { mode: 0o600 }),
  );
  try {
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '--diff3',
        '-L',
        'local',
        '-L',
        'base',
        '-L',
        'cloud',
        ...paths,
      ],
      { encoding: 'utf8', maxBuffer: 2000000 },
    );
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } finally {
    paths.forEach((p) => {
      try {
        unlinkSync(p);
      } catch {}
    });
  }
}
export function planPage(local, cloud, base, merge) {
  if (local && cloud && local.hash === cloud.hash) return { action: 'same' };
  if (!local && cloud && !base) return { action: 'pull' };
  if (local && !cloud && !base)
    return { action: 'push', content: local.content };
  if (!local || !cloud)
    return {
      action: 'conflict',
      reason: !local ? 'local-deletion-needs-review' : 'cloud-page-missing',
    };
  if (!base) return { action: 'conflict', reason: 'no-shared-base' };
  if (local.hash === base.hash) return { action: 'pull' };
  if (cloud.hash === base.hash)
    return { action: 'push', content: local.content };
  const merged = merge(local.content, base.content, cloud.content);
  return merged === null
    ? { action: 'conflict', reason: 'overlapping-edits' }
    : { action: 'push', content: merged, merged: true };
}
export function cloudConfig(root, supplied) {
  const config = supplied ?? load(join(root, '.exposurie/cloud.json'), null);
  if (!config) return null;
  const url = new URL(config.url);
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error(
      'Cloud URL must be an HTTPS origin (HTTP is allowed only on loopback).',
    );
  const tokenEnv = config.tokenEnv ?? 'EXPOSURIE_SYNC_TOKEN';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
    throw Error(
      'tokenEnv must name an environment variable, not contain a credential.',
    );
  return { url: url.origin, tokenEnv };
}
export function makeCloudApi(config, token = process.env[config.tokenEnv]) {
  if (!token || /[\r\n]/.test(token))
    throw Error(
      `Set ${config.tokenEnv} in your environment or secret manager before mirroring.`,
    );
  return async function api(action, payload) {
    const response = await fetch(`${config.url}/api/sync`, {
      method: action === 'manifest' ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(action === 'manifest'
        ? {}
        : { body: JSON.stringify({ action, ...payload }) }),
    });
    if (!response.ok)
      throw Error(
        `Cloud sync request failed (${response.status}). Local pages are retained.`,
      );
    return response.json();
  };
}
export async function syncCloud(root, options = {}) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
    throw Error('Brain must be a real local directory.');
  root = curatedVault(root).root;
  const config = cloudConfig(root);
  const scope = localScope(root);
  if (!config) throw Error('Cloud brain has not been configured.');
  const dir = internalDirectory(root);
  const lock = join(dir, 'sync.lock');
  let fd;
  noLinks(root, lock, { missing: true });
  try {
    fd = openSync(lock, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') running = false;
    }
    if (running) return { status: 'already-running' };
    unlinkSync(lock);
    fd = openSync(lock, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
  }
  const statePath = join(dir, 'state.json');
  let state;
  try {
    state = load(statePath, { version: 1, url: config.url, pages: {} });
    if (
      state.version !== 1 ||
      !state.pages ||
      typeof state.pages !== 'object' ||
      Array.isArray(state.pages)
    )
      throw Error('Invalid mirror state. Review it before retrying.');
  } catch (error) {
    closeSync(fd);
    unlinkSync(lock);
    throw error;
  }
  if (state.url && state.url !== config.url) {
    closeSync(fd);
    unlinkSync(lock);
    throw Error(
      'Cloud destination changed. Review and archive the old cloud-sync directory before using another server.',
    );
  }
  state.url = config.url;
  const save = () => atomic(statePath, JSON.stringify(state, null, 2) + '\n');
  const report = {
    status: 'synced',
    at: new Date().toISOString(),
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    unchanged: 0,
    conflicts: [],
    errors: [],
  };
  try {
    const local = scanBrain(root),
      api = options.api ?? makeCloudApi(config);
    const manifest = await api('manifest');
    if (!Array.isArray(manifest.pages))
      throw Error('Cloud manifest is invalid.');
    const remote = new Map();
    for (const page of manifest.pages) {
      if (
        !page ||
        remote.has(page.id) ||
        !/^[a-f0-9]{64}$/.test(page.hash) ||
        !Number.isSafeInteger(page.revision) ||
        page.revision < 1
      )
        throw Error('Cloud manifest is invalid.');
      scope.validId(page.id, true);
      remote.set(page.id, page);
    }
    for (const id of remote.keys()) safePath(root, id, true, scope);
    const ids = [
      ...new Set([
        ...local.keys(),
        ...remote.keys(),
        ...Object.keys(state.pages),
      ]),
    ].sort();
    for (const id of ids) scope.validId(id, true);
    const needed = ids.filter(
      (id) => remote.has(id) && local.get(id)?.hash !== remote.get(id).hash,
    );
    for (let n = 0; n < needed.length; n += 25) {
      const batch = needed.slice(n, n + 25);
      const pulled = await api('pull', { ids: batch });
      const received = new Set();
      if (!Array.isArray(pulled.pages))
        throw Error('Cloud pull response is invalid.');
      for (const page of pulled.pages) {
        if (
          !page ||
          !batch.includes(page.id) ||
          received.has(page.id) ||
          typeof page.content !== 'string' ||
          Buffer.byteLength(page.content) > 300000 ||
          hash(page.content) !== page.hash ||
          !Number.isSafeInteger(page.revision) ||
          page.revision < remote.get(page.id).revision
        )
          throw Error('Cloud response failed content verification.');
        received.add(page.id);
        remote.set(page.id, page);
      }
      if (received.size !== batch.length)
        throw Error('Cloud pull omitted a requested page.');
    }
    const pending = [];
    for (const id of ids) {
      const l = local.get(id),
        c = remote.get(id),
        base = state.pages[id];
      if (
        base &&
        (typeof base.content !== 'string' || hash(base.content) !== base.hash)
      )
        throw Error(
          'Mirror base failed content verification. Review saved state.',
        );
      const plan = planPage(l, c, base, (a, b, d) => {
        const mergeDir = join(dir, 'merge');
        noLinks(root, mergeDir, { missing: true });
        return mergeVersions(a, b, d, mergeDir);
      });
      const accept = (content, revision) => {
        state.pages[id] = { hash: hash(content), content, revision };
      };
      if (plan.action === 'same') {
        accept(l.content, c.revision);
        report.unchanged++;
        continue;
      }
      if (plan.action === 'conflict') {
        report.conflicts.push({ id, reason: plan.reason });
        const prefix = join(dir, 'conflicts', hash(id).slice(0, 16));
        for (const [label, value] of [
          ['local', l],
          ['cloud', c],
          ['base', base],
        ])
          if (value?.content) atomic(`${prefix}.${label}.md`, value.content);
        continue;
      }
      if (plan.action === 'pull') {
        const path = safePath(root, id, true, scope),
          current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (current !== (l?.content ?? null)) {
          report.errors.push({ id, error: 'local-changed-during-sync' });
          continue;
        }
        atomic(path, c.content);
        accept(c.content, c.revision);
        report.downloaded++;
        if (!l && !scope.systemIds.has(id))
          addCatalogEntry(root, id, c.content, scope);
        continue;
      }
      pending.push({
        id,
        content: plan.content,
        expected_revision: c?.revision ?? 0,
        request_id: `mirror_${randomUUID()}`,
        reason: plan.merged
          ? 'Merge independent local and cloud edits.'
          : 'Mirror the permitted curated local wiki.',
        localContent: l?.content,
        merged: plan.merged,
      });
    }
    for (let n = 0; n < pending.length; n += 25) {
      const chunk = pending.slice(n, n + 25);
      const response = await api('push', {
        pages: chunk.map(({ localContent, merged, ...p }) => p),
      });
      for (let i = 0; i < chunk.length; i++) {
        const input = chunk[i],
          result = response.results[i];
        if (!result || result.id !== input.id || result.error) {
          report.errors.push({
            id: input.id,
            error: result?.error ?? 'missing-result',
          });
          continue;
        }
        if (
          result.hash !== hash(input.content) ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < 1
        )
          throw Error('Cloud saved an unexpected content hash.');
        if (input.merged) {
          const path = safePath(root, input.id, false, scope),
            current = readFileSync(path, 'utf8');
          if (current === input.localContent) {
            atomic(path, input.content);
            report.merged++;
          } else
            report.errors.push({
              id: input.id,
              error: 'local-changed-during-sync',
            });
        }
        state.pages[input.id] = {
          hash: result.hash,
          content: input.content,
          revision: result.revision,
        };
        report.uploaded++;
      }
      save();
    }
    if (report.conflicts.length || report.errors.length)
      report.status = 'needs-review';
    state.lastSync = report;
    save();
    return report;
  } catch (error) {
    state.lastSync = {
      ...report,
      status: 'offline-or-error',
      message: error.message,
    };
    save();
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {}
  }
}
function addCatalogEntry(root, id, content, scope) {
  const path = safePath(root, scope.index, true, scope);
  if (!existsSync(path)) return;
  const title = basename(id, '.md');
  let catalog = readFileSync(path, 'utf8');
  if (catalog.includes(`[[${title}]]`)) return;
  const section =
    {
      entities: 'Entities',
      concepts: 'Concepts',
      sources: 'Sources',
      syntheses: 'Syntheses',
    }[scope.category(id)] ?? scope.category(id);
  const summary =
    content
      .split('\n')
      .find((line) => line.trim() && !/^(---|#|[a-z_]+:)/.test(line)) ??
    'Saved from ChatGPT.';
  const entry = `- [[${title}]] - ${summary.replace(/\[\[|\]\]/g, '').slice(0, 140)} ${new Date().toISOString().slice(0, 10)}.\n`;
  if (catalog.includes(`## ${section}\n`))
    catalog = catalog.replace(`## ${section}\n`, `## ${section}\n\n${entry}`);
  else catalog += `\n## ${section}\n\n${entry}`;
  atomic(path, catalog);
}
export function cloudStatus(root) {
  curatedVault(root);
  const config = cloudConfig(root);
  const state = load(join(root, '.exposurie/cloud-sync/state.json'), null);
  return {
    configured: !!config,
    url: config?.url ?? null,
    localFirst: true,
    schedulingManagedExternally: true,
    lastSync: state?.lastSync ?? null,
    trackedPages: Object.keys(state?.pages ?? {}).length,
  };
}
