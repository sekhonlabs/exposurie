// Shared by the local reader and remote brain; this module has no filesystem access.
const FIELDS = new Set(['events', 'created', 'updated', 'all']);
const KINDS = new Set([
  'event',
  'decision',
  'milestone',
  'deadline',
  'planned',
  'correction',
]);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function calendarDate(value, label = 'Date') {
  if (
    typeof value !== 'string' ||
    !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)
  ) {
    throw Error(`${label} must be YYYY, YYYY-MM or YYYY-MM-DD`);
  }
  const parts = value.split('-').map(Number);
  const [year, month, day] = parts;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    (month !== undefined && (month < 1 || month > 12)) ||
    (day !== undefined && (day < 1 || day > monthDays[month - 1]))
  ) {
    throw Error(`${label} is not a valid calendar date: ${value}`);
  }
  const precision = ['year', 'month', 'day'][parts.length - 1];
  return {
    text: value,
    precision,
    start:
      parts.length === 1
        ? `${value}-01-01`
        : parts.length === 2
          ? `${value}-01`
          : value,
    end:
      parts.length === 1
        ? `${value}-12-31`
        : parts.length === 2
          ? `${value}-${monthDays[month - 1]}`
          : value,
  };
}

function dateSpan(text) {
  const parts = text.split('..');
  if (parts.length > 2)
    throw Error('Date range must have one start and one end');
  const first = calendarDate(parts[0]);
  const last = parts.length === 2 ? calendarDate(parts[1]) : first;
  if (first.start > last.end) throw Error('Date range ends before it starts');
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
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function queryOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw Error('Date options must be an object');
  const field = options.field ?? 'events';
  const order = options.order ?? 'desc';
  if (!FIELDS.has(field))
    throw Error('field must be events, created, updated or all');
  if (!['asc', 'desc'].includes(order))
    throw Error('order must be asc or desc');
  if (
    options.on !== undefined &&
    (options.from !== undefined || options.to !== undefined)
  )
    throw Error('on cannot be combined with from or to');
  const on = options.on === undefined ? null : calendarDate(options.on, 'on');
  const from =
    options.from === undefined ? null : calendarDate(options.from, 'from');
  const to = options.to === undefined ? null : calendarDate(options.to, 'to');
  const start = on?.start ?? from?.start ?? '0001-01-01';
  const end = on?.end ?? to?.end ?? '9999-12-31';
  if (start > end) throw Error('from must not be after to');
  if (options.search !== undefined && typeof options.search !== 'string')
    throw Error('search must be a string');
  return {
    field,
    order,
    start,
    end,
    search: (options.search ?? '').trim().toLowerCase(),
    limit: integer(options.limit, 50, 1, 500, 'limit'),
    offset: integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
  };
}

export function markdownLines(text) {
  const lines = text.split(/\r?\n/);
  let bodyStart = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end >= 0) bodyStart = end + 1;
  }
  let fence = null;
  let comment = false;
  function withoutComments(text) {
    let visible = '';
    let cursor = 0;
    while (cursor < text.length) {
      if (comment) {
        const end = text.indexOf('-->', cursor);
        if (end < 0) break;
        comment = false;
        cursor = end + 3;
      } else {
        const start = text.indexOf('<!--', cursor);
        if (start < 0) {
          visible += text.slice(cursor);
          break;
        }
        visible += text.slice(cursor, start);
        comment = true;
        cursor = start + 4;
      }
    }
    return visible;
  }
  return lines.map((text, index) => {
    if (index < bodyStart)
      return { text, line: index + 1, body: false, visible: false };
    if (fence) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      return { text, line: index + 1, body: true, visible: false };
    }
    text = withoutComments(text);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return { text, line: index + 1, body: true, visible: false };
    }
    return { text, line: index + 1, body: true, visible: true };
  });
}

function heading(text) {
  const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
  return match ? { level: match[1].length, text: match[2] } : null;
}

const normalized = (value) => value.trim().toLowerCase();
const headingSlug = (value) =>
  normalized(value)
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/\s/g, '-');

function sourceError(source, pagesByTitle) {
  const link = /^\[\[([^\[\]\r\n]+)\]\]$/.exec(source);
  if (!link) return 'Event source must be one wiki link';
  const target = link[1].split('|', 1)[0].trim();
  const split = target.indexOf('#');
  const name = (split < 0 ? target : target.slice(0, split)).trim();
  const section = split < 0 ? null : target.slice(split + 1).trim();
  if (!name || (section !== null && !section))
    return 'Event source must name a page and a nonempty section when # is used';
  const candidates = pagesByTitle.get(normalized(name));
  if (!candidates?.length) return `Source page does not exist: ${name}`;
  if (candidates.length !== 1) return `Source page is ambiguous: ${name}`;
  if (
    section !== null &&
    !candidates[0].headings.some(
      (h) =>
        normalized(h) === normalized(section) ||
        headingSlug(h) === normalized(section),
    )
  ) {
    return `Source section does not exist: ${target}`;
  }
  return null;
}

/** Portable query engine used by local and remote brains. No filesystem access. */
export function queryDatePages(inputPages, options = {}) {
  const query = queryOptions(options);
  const warnings = [];
  const pages = inputPages.map((page) => {
    const lines = markdownLines(page.content);
    return {
      title: page.title,
      path: page.path ?? page.id,
      lines,
      headings: lines
        .filter((l) => l.visible)
        .map((l) => heading(l.text)?.text)
        .filter(Boolean),
    };
  });
  const pagesByTitle = new Map();
  for (const page of pages) {
    const key = normalized(page.title);
    pagesByTitle.set(key, [...(pagesByTitle.get(key) ?? []), page]);
  }
  const records = [];
  const warn = (page, line, code, message) =>
    warnings.push({ path: page.path, line, code, message });
  function add(page, line, span, field, kind, summary, source) {
    records.push({
      ...span,
      field,
      title: page.title,
      path: page.path,
      line,
      kind,
      summary,
      source,
    });
  }
  for (const page of pages) {
    if (query.field !== 'events') {
      const wanted =
        query.field === 'all' ? ['created', 'updated'] : [query.field];
      for (const field of wanted) {
        const matches = page.lines.filter(
          (l) => !l.body && new RegExp(`^${field}:`).test(l.text),
        );
        if (!matches.length) continue;
        if (matches.length > 1) {
          warn(
            page,
            matches[1].line,
            'invalid-metadata',
            `Duplicate ${field} date`,
          );
          continue;
        }
        const line = matches[0];
        const value = line.text
          .slice(field.length + 1)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^(['"])(.*)\1$/, '$2');
        try {
          const date = calendarDate(value, field);
          add(
            page,
            line.line,
            {
              date: value,
              dateEnd: null,
              dateText: value,
              precision: date.precision,
              start: date.start,
              end: date.end,
            },
            field,
            null,
            `Page ${field}`,
            null,
          );
        } catch (error) {
          warn(page, line.line, 'invalid-metadata', error.message);
        }
      }
    }
    let inSection = false;
    for (const line of page.lines) {
      if (!line.visible) continue;
      const h = heading(line.text);
      if (h) {
        if (h.level <= 2)
          inSection = h.level === 2 && normalized(h.text) === 'dated events';
        continue;
      }
      if (!inSection || !/^\s*[-*+]\s/.test(line.text)) continue;
      const match =
        /^-\s+(\S+)\s+\|\s+([a-z]+)\s+\|\s+(.+?)\s+\|\s+(\[\[.*\]\])\s*$/.exec(
          line.text,
        );
      if (!match) {
        warn(
          page,
          line.line,
          'invalid-event',
          'Use - DATE | kind | summary | [[Source Page#Section]]',
        );
        continue;
      }
      const [, dateText, kind, rawSummary, rawSource] = match;
      const summary = rawSummary.trim();
      const source = rawSource.trim();
      if (!KINDS.has(kind)) {
        warn(page, line.line, 'invalid-event', `Unknown event kind: ${kind}`);
        continue;
      }
      if (!summary) {
        warn(page, line.line, 'invalid-event', 'Event summary cannot be empty');
        continue;
      }
      let span;
      try {
        span = dateSpan(dateText);
      } catch (error) {
        warn(page, line.line, 'invalid-event', error.message);
        continue;
      }
      const invalidSource = sourceError(source, pagesByTitle);
      if (invalidSource) {
        warn(page, line.line, 'invalid-source', invalidSource);
        continue;
      }
      add(page, line.line, span, 'events', kind, summary, source);
    }
  }
  const eventRecords = records.filter((item) => item.field === 'events');
  const pagesWithEvents = new Set(eventRecords.map((item) => item.path)).size;
  const matching = records.filter(
    (item) =>
      (query.field === 'all' || query.field === item.field) &&
      item.start <= query.end &&
      item.end >= query.start &&
      (!query.search ||
        `${item.title}\n${item.summary}`.toLowerCase().includes(query.search)),
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
    search: options.search ?? '',
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
    items: matching
      .slice(query.offset, query.offset + query.limit)
      .map(({ start, end, ...item }) => item),
    warnings,
  };
}
