import { queryDatePages, markdownLines } from '../dates-core.js';

import { SYSTEM_IDS, DEFAULT_SCOPE } from './scope.js';
export { SYSTEM_IDS };
export class BrainError extends Error {
  constructor(message, code = 'invalid_request', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export async function digest(text) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export function today(timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function titleOf(id) {
  return id.split('/').at(-1).replace(/\.md$/, '');
}
export function validId(id, system = false, scope = DEFAULT_SCOPE) {
  try {
    return scope.validId(id, system);
  } catch {
    throw new BrainError(
      'Use a curated page path; raw sources, history and arbitrary files are unavailable.',
    );
  }
}
export function validateContent(
  id,
  text,
  previous = null,
  normalizeDate = false,
  scope = DEFAULT_SCOPE,
  timeZone = 'UTC',
) {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    new TextEncoder().encode(text).length > 300000 ||
    text.includes('\u0000')
  )
    throw new BrainError('Page must contain 1 to 300000 bytes of Markdown.');
  if (scope.systemIds.has(id)) return text;
  if (!text.startsWith('---\n') || text.indexOf('\n---', 4) < 0)
    throw new BrainError(
      'Keep the brain YAML front matter. Read brain_rules before writing.',
    );
  const front = text.slice(4, text.indexOf('\n---', 4));
  const fields = Object.fromEntries(
    front
      .split('\n')
      .map((line) => /^([a-z_]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const expected = scope.type(id);
  if (
    !['entity', 'concept', 'source', 'synthesis'].includes(fields.type) ||
    (expected && fields.type !== expected) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fields.created ?? '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fields.updated ?? '') ||
    fields.tags === undefined
  )
    throw new BrainError(
      'Required front matter: correct type, created, updated and tags.',
    );
  queryDatePages([{ path: id, title: titleOf(id), content: text }], {
    field: 'created',
  }).warnings.forEach((w) => {
    if (w.code === 'invalid-metadata') throw new BrainError(w.message);
  });
  queryDatePages([{ path: id, title: titleOf(id), content: text }], {
    field: 'updated',
  }).warnings.forEach((w) => {
    if (w.code === 'invalid-metadata') throw new BrainError(w.message);
  });
  if (
    fields.type === 'source' &&
    (!fields.source_file ||
      !/^(article|paper|video|podcast|transcript|chat|note|other)$/.test(
        fields.source_kind ?? '',
      ))
  )
    throw new BrainError(
      'Source pages require source_file and a supported source_kind.',
    );
  if (previous) {
    const oldCreated = /^created:\s*(.*)$/m.exec(previous)?.[1];
    if (oldCreated !== fields.created)
      throw new BrainError('Keep the original created date.');
  }
  return normalizeDate
    ? text.replace(/^updated:.*$/m, `updated: ${today(timeZone)}`)
    : text;
}

export function validateLinks(id, content, pages) {
  const byTitle = new Map();
  for (const page of pages.filter((p) => !p.system && p.id !== id)) {
    const key = page.title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), page]);
  }
  const ownTitle = titleOf(id).toLowerCase();
  byTitle.set(ownTitle, [
    ...(byTitle.get(ownTitle) ?? []),
    { id, title: titleOf(id), content },
  ]);
  const withoutCode = markdownLines(content)
    .filter((line) => line.visible)
    .map((line) => line.text)
    .join('\n');
  for (const match of withoutCode.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const name = match[1].split('|')[0].split('#')[0].trim();
    if (byTitle.get(name.toLowerCase())?.length !== 1)
      throw new BrainError(
        `Linked page does not exist or is ambiguous: ${name}. Create the source page first.`,
      );
  }
  const updated = pages
    .filter((p) => p.id !== id && !p.system)
    .map((p) => ({ path: p.id, title: p.title, content: p.content }));
  const result = queryDatePages([
    ...updated,
    { path: id, title: titleOf(id), content },
  ]);
  const warning = result.warnings.find((w) => w.path === id);
  if (warning) throw new BrainError(`Invalid dated event: ${warning.message}`);
}

export function searchPages(pages, query, origin) {
  if (typeof query !== 'string' || !query.trim() || query.length > 300)
    throw new BrainError('Use a short distinctive search query.');
  const terms = query.toLowerCase().trim().split(/\s+/);
  const ranked = pages
    .filter((p) => !p.system)
    .map((p) => {
      const title = p.title.toLowerCase(),
        body = p.content.toLowerCase();
      const scores = terms.map((term) =>
        title.includes(term) ? 10 : body.includes(term) ? 1 : 0,
      );
      return {
        p,
        score: scores.every(Boolean)
          ? scores.reduce((a, b) => a + b, 0) +
            (title === query.toLowerCase() ? 30 : 0)
          : 0,
      };
    })
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title));
  return {
    results: ranked
      .slice(0, 25)
      .map(({ p }) => ({
        id: p.id,
        title: p.title,
        url: `${origin}/brain?id=${encodeURIComponent(p.id)}`,
      })),
  };
}

export function datePages(pages, options) {
  return queryDatePages(
    pages
      .filter((p) => !p.system)
      .map((p) => ({ path: p.id, title: p.title, content: p.content })),
    options,
  );
}

export class BrainStore {
  constructor(db, { scope = DEFAULT_SCOPE, timeZone = 'UTC' } = {}) {
    this.db = db;
    this.scope = scope;
    this.timeZone = timeZone;
    today(timeZone);
  }
  async all() {
    return (await this.db.prepare('SELECT * FROM pages ORDER BY id').all())
      .results;
  }
  async get(id) {
    return this.db.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  }
  async manifest() {
    return (
      await this.db
        .prepare(
          'SELECT id, title, hash, revision, system, updated_at FROM pages ORDER BY id',
        )
        .all()
    ).results;
  }
  async write(input, { actor = 'unknown', sync = false } = {}) {
    const id = validId(input.id, sync, this.scope);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0
    )
      throw new BrainError('A fetched expected_revision is required.');
    if (
      typeof input.request_id !== 'string' ||
      !/^[a-zA-Z0-9:_-]{10,180}$/.test(input.request_id)
    )
      throw new BrainError(
        'Use a unique request_id of 10 to 180 letters, numbers, underscores, colons or hyphens.',
      );
    if (
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 500
    )
      throw new BrainError('Give a short factual reason for the edit.');
    const previous = await this.get(id);
    const replay = await this.db
      .prepare(
        'SELECT page_id, hash, revision, content FROM changes WHERE request_id = ?',
      )
      .bind(input.request_id)
      .first();
    if (replay) {
      let retry = validateContent(
        id,
        input.content,
        null,
        false,
        this.scope,
        this.timeZone,
      );
      if (!sync && !this.scope.systemIds.has(id))
        retry = retry.replace(
          /^updated:.*$/m,
          /^updated:.*$/m.exec(replay.content)[0],
        );
      const hash = await digest(retry);
      if (replay.page_id !== id || replay.hash !== hash)
        throw new BrainError(
          'request_id was already used for a different edit.',
        );
      return { id, revision: replay.revision, hash, replayed: true };
    }
    if (previous && previous.revision !== input.expected_revision)
      throw new BrainError(
        'This page changed on another device. Fetch it again, merge your edit and retry.',
        'revision_conflict',
        409,
      );
    if (!previous && input.expected_revision !== 0)
      throw new BrainError(
        'Page is missing. Use expected_revision 0 only when creating.',
        'revision_conflict',
        409,
      );
    const supplied = validateContent(
      id,
      input.content,
      previous?.content,
      false,
      this.scope,
      this.timeZone,
    );
    if (
      !sync &&
      previous &&
      supplied.replace(/^updated:.*$/m, '') ===
        previous.content.replace(/^updated:.*$/m, '')
    )
      return {
        id,
        revision: previous.revision,
        hash: previous.hash,
        unchanged: true,
      };
    const content = validateContent(
      id,
      supplied,
      previous?.content,
      !sync,
      this.scope,
      this.timeZone,
    );
    const hash = await digest(content);
    if (previous?.hash === hash)
      return { id, revision: previous.revision, hash, unchanged: true };
    if (!sync) {
      const pages = await this.all();
      if (
        !previous &&
        pages.some(
          (p) =>
            !p.system && p.title.toLowerCase() === titleOf(id).toLowerCase(),
        )
      )
        throw new BrainError(
          'A page with this title already exists. Update it instead.',
        );
      validateLinks(id, content, pages);
    }
    const values = [
      titleOf(id),
      content,
      hash,
      (previous?.revision ?? 0) + 1,
      this.scope.systemIds.has(id) ? 1 : 0,
      new Date().toISOString(),
      actor,
      input.reason,
      input.request_id,
    ];
    let result;
    if (!previous) {
      result = await this.db
        .prepare(
          'INSERT INTO pages (id,title,content,hash,revision,system,updated_at,actor,reason,request_id) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id,revision,hash',
        )
        .bind(id, ...values)
        .first();
    } else {
      result = await this.db
        .prepare(
          'UPDATE pages SET title=?,content=?,hash=?,revision=?,system=?,updated_at=?,actor=?,reason=?,request_id=? WHERE id=? AND revision=? RETURNING id,revision,hash',
        )
        .bind(...values, id, input.expected_revision)
        .first();
    }
    if (!result)
      throw new BrainError(
        'This page changed on another device. Fetch it again and merge your edit.',
        'revision_conflict',
        409,
      );
    return { ...result, saved: true };
  }
}
