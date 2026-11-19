// The date engine behind `exposurie dates`. It works from page TEXT and reads
// nothing from disk: src/dates.js hands it the pages `read` sees, so every rule
// here can be tested on strings.
//
// TWO KINDS OF DATE, KEPT APART. A page's `created` and `updated` say when the
// PAGE was written, which is usually the day a sync ran. Answering "what
// happened in June" from those would answer with an import date, stated as a
// fact. So an event has exactly one source: a line an agent wrote on purpose,
// under `## Dated events` on the page it is about, naming where it came from:
//
//   - 2026-06-01 | decision | Chose a streaming parser. | [[Parser Evidence#Decision]]
//
// Page dates are only ever reported as page dates (`--field created`). Nothing
// is guessed from prose, a file name or an import.
//
// WHERE THIS USES READ'S RULES, AND WHY. A source link counts only if read.js's
// findSection() resolves it among the page's headings(), because the command
// printed for it is a `read --section`, and a printed command that does not
// open what it names is the failure read.js exists to prevent. An earlier
// draft carried its own heading parser and it disagreed within a day: under
// `## C#` it rejected `[[Lang#C#]]` while `read --section "C#"` opened it.
// Search words come from search.js, so `--search` matches the way
// `read --search` does, and front matter ends where search.js says it ends.
//
// What stays this file's own is how a `## Dated events` section is scanned,
// because that is a stricter question than any `read` asks: an event inside a
// code block is an example, and one inside an HTML comment was switched off.

import { headings, findSection } from './read.js';
import { parseQuery, words, matchWeight, frontmatterEnd } from './search.js';

const FIELDS = new Set(['events', 'created', 'updated', 'all']);

/** Every kind an event line may name. The template and docs list these same six. */
export const KINDS = ['event', 'decision', 'milestone', 'deadline', 'planned', 'correction'];
const KIND = new Set(KINDS);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, checked against a real calendar, as the span it covers. */
function calendarDate(value, label = 'Date') {
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) {
    throw new Error(`${label} must be YYYY, YYYY-MM or YYYY-MM-DD`);
  }
  const parts = value.split('-').map(Number);
  const [year, month, day] = parts;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    (month !== undefined && (month < 1 || month > 12)) ||
    (day !== undefined && (day < 1 || day > monthDays[month - 1]))
  ) {
    throw new Error(`${label} is not a valid calendar date: ${value}`);
  }
  return {
    text: value,
    precision: ['year', 'month', 'day'][parts.length - 1],
    start: parts.length === 1 ? `${value}-01-01` : parts.length === 2 ? `${value}-01` : value,
    end: parts.length === 1 ? `${value}-12-31` : parts.length === 2 ? `${value}-${monthDays[month - 1]}` : value,
  };
}

/** One date or a `start..end` range, keeping the precision it was written with. */
function dateSpan(text) {
  const parts = text.split('..');
  if (parts.length > 2) throw new Error('Date range must have one start and one end');
  const first = calendarDate(parts[0]);
  const last = parts.length === 2 ? calendarDate(parts[1]) : first;
  if (first.start > last.end) throw new Error('Date range ends before it starts');
  return {
    date: first.text,
    dateEnd: parts.length === 2 ? last.text : null,
    dateText: text,
    precision: parts.length === 2 ? 'range' : first.precision,
    start: first.start,
    end: last.end,
  };
}

function integer(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return number;
}

/**
 * The question, checked. Throws on anything that cannot be answered, so the
 * command can refuse it as a usage error before it opens a single page.
 */
export function queryOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Date options must be an object');
  }
  const field = options.field ?? 'events';
  const order = options.order ?? 'desc';
  if (!FIELDS.has(field)) throw new Error('--field must be events, created, updated or all');
  if (order !== 'asc' && order !== 'desc') throw new Error('--order must be asc or desc');
  if (options.on !== undefined && (options.from !== undefined || options.to !== undefined)) {
    throw new Error('--on cannot be combined with --from or --to');
  }
  const on = options.on === undefined ? null : calendarDate(options.on, '--on');
  const from = options.from === undefined ? null : calendarDate(options.from, '--from');
  const to = options.to === undefined ? null : calendarDate(options.to, '--to');
  const start = on?.start ?? from?.start ?? '0001-01-01';
  const end = on?.end ?? to?.end ?? '9999-12-31';
  if (start > end) throw new Error('--from must not be after --to');
  if (options.search !== undefined && typeof options.search !== 'string') {
    throw new Error('--search must be text');
  }
  const search = (options.search ?? '').trim();
  return {
    field,
    order,
    start,
    end,
    search,
    // null: no search was asked for. []: one was, and nothing in it is a word.
    terms: search ? parseQuery(search).terms : null,
    limit: integer(options.limit, 50, 1, 500, '--limit'),
    offset: integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, '--offset'),
  };
}

// The same heading shape read.js's headings() matches, so a line is a heading
// here exactly when it is one there; this file only adds what hides it.
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every line of a page, marked visible or not for the purpose of finding
 * events. Front matter, fenced code and HTML comments are not visible.
 *
 * Fences close the way Markdown closes them — the same character, at least as
 * many of it — so a `~~~` inside a `~~~~` block does not end the example early
 * and turn the rest of it into events. A comment hides the text inside it,
 * including any fence marker, and line numbers stay the file's own.
 */
export function markdownLines(text) {
  const lines = String(text).split(/\r?\n/);
  const bodyStart = frontmatterEnd(lines);
  let fence = null;
  let comment = false;
  const withoutComments = (s) => {
    let visible = '';
    let cursor = 0;
    while (cursor < s.length) {
      if (comment) {
        const end = s.indexOf('-->', cursor);
        if (end < 0) break;
        comment = false;
        cursor = end + 3;
      } else {
        const start = s.indexOf('<!--', cursor);
        if (start < 0) {
          visible += s.slice(cursor);
          break;
        }
        visible += s.slice(cursor, start);
        comment = true;
        cursor = start + 4;
      }
    }
    return visible;
  };
  return lines.map((raw, index) => {
    const line = index + 1;
    if (index < bodyStart) return { text: raw, line, body: false, visible: false };
    if (fence) {
      const m = FENCE.exec(raw);
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null;
      return { text: raw, line, body: true, visible: false };
    }
    const shown = withoutComments(raw);
    const m = FENCE.exec(shown);
    if (m) {
      fence = { char: m[1][0], length: m[1].length };
      return { text: shown, line, body: true, visible: false };
    }
    return { text: shown, line, body: true, visible: true };
  });
}

// A bullet of any of Markdown's three kinds, and the event inside it.
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const EVENT = /^(\S+)\s+\|\s+([A-Za-z]+)\s+\|\s+(.+?)\s+\|\s+(\[\[.*\]\])\s*$/;

/**
 * The text after a bullet, parsed as one event — not yet checked against the
 * brain, which is what the source link needs. `{ error }` when it is not one.
 */
export function parseEvent(content) {
  const m = EVENT.exec(String(content).trim());
  if (!m) return { error: 'Use - DATE | kind | summary | [[Source Page#Section]]' };
  const [, dateText, kind, rawSummary, rawSource] = m;
  if (!KIND.has(kind)) return { error: `Unknown event kind: ${kind}. Use one of: ${KINDS.join(', ')}` };
  const summary = rawSummary.trim();
  if (!summary) return { error: 'Event summary cannot be empty' };
  let span;
  try {
    span = dateSpan(dateText);
  } catch (e) {
    return { error: e.message };
  }
  return { span, kind, summary, source: rawSource.trim() };
}

/**
 * Whether a source link opens, by read's own rules: the page by its title,
 * case aside, which is read's exact match; the section by findSection() over
 * that page's headings(). The answer carries the names the printed RUN line is
 * built from, so the line opens exactly what was checked.
 *
 * A section findSection() cannot settle — two headings answer to it — is not a
 * source. Pointing the RUN line at the first would print a command that may
 * open the wrong evidence while looking like it worked.
 */
function resolveSource(source, byTitle) {
  const link = /^\[\[([^[\]\r\n]+)\]\]$/.exec(source);
  if (!link) return { error: 'Event source must be one wiki link' };
  const target = link[1].split('|', 1)[0].trim();
  const cut = target.indexOf('#');
  const name = (cut < 0 ? target : target.slice(0, cut)).trim();
  const section = cut < 0 ? null : target.slice(cut + 1).trim();
  if (!name || (section !== null && !section)) {
    return { error: 'Event source must name a page, and a heading after # when # is used' };
  }
  const pages = byTitle.get(name.toLowerCase()) ?? [];
  if (pages.length === 0) return { error: `Source page does not exist: ${name}` };
  if (pages.length > 1) return { error: `Source page is ambiguous: ${pages.length} pages are titled ${name}` };
  const page = pages[0];
  if (section === null) return { title: page.title, section: null };
  page.heads ??= headings(page.text);
  const { hit, candidates } = findSection(page.heads, section);
  // A hit is unique among the page's headings, so it never needs --nth.
  if (hit) return { title: page.title, section: hit.text };
  return {
    error: candidates.length
      ? `Source section is ambiguous: ${target} matches ${candidates.length} headings`
      : `Source section does not exist: ${target}`,
  };
}

/** Whether an item's title and summary hold every searched word, in any order and any form. */
function holds(item, terms) {
  if (terms === null) return true;
  if (terms.length === 0) return false;
  const keys = words(`${item.title}\n${item.summary}`).map((w) => w.key);
  return terms.every((t) => keys.some((k) => matchWeight(t.key, k) > 0));
}

/**
 * Dated events and page dates across a set of pages, filtered, ordered and
 * paged. `inputPages` is [{ title, path, content }]; nothing is read or written.
 */
export function queryDatePages(inputPages, options = {}) {
  const query = queryOptions(options);
  const wantsEvents = query.field === 'events' || query.field === 'all';
  const warnings = [];
  const pages = inputPages.map((p) => ({ title: p.title, path: p.path, text: String(p.content) }));
  const byTitle = new Map();
  for (const page of pages) {
    const key = page.title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), page]);
  }

  const records = [];
  const warn = (page, line, code, message) => warnings.push({ path: page.path, line, code, message });
  const add = (page, line, span, field, kind, summary, source, open) =>
    records.push({
      ...span,
      field,
      title: page.title,
      path: page.path,
      line,
      kind,
      summary,
      source,
      sourceTitle: open?.title ?? null,
      sourceSection: open?.section ?? null,
    });

  for (const page of pages) {
    const lines = markdownLines(page.text);

    if (query.field !== 'events') {
      const wanted = query.field === 'all' ? ['created', 'updated'] : [query.field];
      for (const field of wanted) {
        const found = lines.filter((l) => !l.body && l.text.startsWith(`${field}:`));
        if (!found.length) continue;
        if (found.length > 1) {
          warn(page, found[1].line, 'invalid-metadata', `Duplicate ${field} date`);
          continue;
        }
        const value = found[0].text
          .slice(field.length + 1)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^(['"])(.*)\1$/, '$2');
        try {
          const date = calendarDate(value, field);
          const span = { date: value, dateEnd: null, dateText: value, precision: date.precision, start: date.start, end: date.end };
          add(page, found[0].line, span, field, null, `Page ${field}`, null, null);
        } catch (e) {
          warn(page, found[0].line, 'invalid-metadata', e.message);
        }
      }
    }

    // Events are counted on every query, because the coverage line is what
    // stops an empty answer from reading as "nothing happened".
    let inSection = false;
    for (const l of lines) {
      if (!l.visible) continue;
      const h = HEADING.exec(l.text);
      if (h) {
        if (h[1].length <= 2) inSection = h[1].length === 2 && h[2].trim().toLowerCase() === 'dated events';
        continue;
      }
      if (!inSection) continue;
      const b = BULLET.exec(l.text);
      if (!b) continue;
      // A bullet indented under an event is a note about it, not a second
      // event — unless it is written as one, in which case it is read as one.
      const nested = b[1].includes('\t') || b[1].length >= 2;
      if (nested && !EVENT.test(b[2].trim())) continue;
      const ev = parseEvent(b[2]);
      if (ev.error) {
        if (wantsEvents) warn(page, l.line, 'invalid-event', ev.error);
        continue;
      }
      const open = resolveSource(ev.source, byTitle);
      if (open.error) {
        if (wantsEvents) warn(page, l.line, 'invalid-source', open.error);
        continue;
      }
      add(page, l.line, ev.span, 'events', ev.kind, ev.summary, ev.source, open);
    }
  }

  const eventRecords = records.filter((r) => r.field === 'events');
  const pagesWithEvents = new Set(eventRecords.map((r) => r.path)).size;
  const matching = records.filter(
    (r) =>
      (query.field === 'all' || query.field === r.field) &&
      r.start <= query.end &&
      r.end >= query.start &&
      holds(r, query.terms),
  );
  matching.sort(
    (a, b) =>
      (query.order === 'asc' ? 1 : -1) * compare(a.start, b.start) ||
      compare(a.path, b.path) ||
      a.line - b.line ||
      compare(a.field, b.field),
  );
  return {
    operation: 'dates',
    readOnly: true,
    field: query.field,
    from: query.start,
    to: query.end,
    order: query.order,
    search: query.search,
    searchWords: query.terms ? query.terms.map((t) => t.word) : null,
    pages: pages.length,
    total: matching.length,
    limit: query.limit,
    offset: query.offset,
    coverage: {
      mode: 'explicit-dated-events-only',
      events: eventRecords.length,
      pagesWithEvents,
      pagesWithoutEvents: pages.length - pagesWithEvents,
    },
    items: matching.slice(query.offset, query.offset + query.limit).map(({ start, end, ...item }) => item),
    warnings,
  };
}
