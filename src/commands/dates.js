// `exposurie dates` — what the brain says happened when, rendered.
//
//   exposurie dates --on 2026-06                       events in June 2026
//   exposurie dates --from 2026-05 --to 2026-06        events across a span
//   exposurie dates --on 2026 --search "parser"        only the ones about it
//   exposurie dates --field created --on 2026-06       pages written in June
//
// Every event comes back with the command that opens its source, because a date
// with no way back to its evidence is a claim an agent can only repeat. And an
// empty answer is never a verdict: it says how much of the brain is dated at
// all and names the next command, for the reason a search miss does — an agent
// told "nothing matched" says "nothing happened", and the brain may simply not
// have dated it.

import { configState, brokenConfig, resolveVault, noBrainAt, pointedVault } from '../context.js';
import { vaultState, expandPath } from '../vault.js';
import { cmd } from '../install.js';
import { OK, ERROR, USAGE } from '../exit-codes.js';
import { q, sectionCmd } from '../read.js';
import { queryOptions } from '../dates-core.js';
import { queryDates } from '../dates.js';

/** The date flags, in the order a printed command spells them. */
const FLAGS = ['on', 'from', 'to', 'field', 'search', 'order', 'limit', 'offset'];

/** How many skipped lines text output names. `--json` carries every one. */
const WARNINGS_SHOWN = 5;

/**
 * The caller's own command, rebuilt with some flags changed — for the next page,
 * the full list of skipped lines, and the fix for a bare word. That last one is
 * built before the flags are checked, so any value that is not a plain token is
 * quoted: a printed command has to split where it was meant to.
 */
function again(values, change = {}, { at = true, json = false } = {}) {
  const v = { ...values, ...change };
  const parts = [cmd('dates')];
  for (const k of FLAGS) {
    if (v[k] === undefined || v[k] === null || v[k] === '') continue;
    const value = String(v[k]);
    parts.push(`--${k} ${k !== 'search' && /^[\w.:-]+$/.test(value) ? value : q(value)}`);
  }
  if (at && v.at) parts.push(`--at ${q(v.at)}`);
  if (json) parts.push('--json');
  return parts.join(' ');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function body(r, values) {
  const out = [];
  const openStart = r.from === '0001-01-01';
  const openEnd = r.to === '9999-12-31';
  const span =
    openStart && openEnd
      ? 'at any date'
      : openEnd
        ? `from ${r.from} on`
        : openStart
          ? `up to ${r.to}`
          : r.from === r.to
            ? `on ${r.from}`
            : `between ${r.from} and ${r.to}`;
  const what = {
    events: ['dated event', 'dated events'],
    created: ['page created date', 'page created dates'],
    updated: ['page updated date', 'page updated dates'],
    all: ['event or page date', 'events and page dates'],
  }[r.field];
  const about = r.search ? ` about ${q(r.search)}` : '';
  out.push(
    `DATES: ${plural(r.total, ...what)} ${span}${about}, ${r.order === 'asc' ? 'oldest' : 'newest'} first.`,
  );

  // Hand-broken rather than wrapped: a wrap is free to split the heading an
  // agent has to type, and `"##` at the end of one line is no use to anybody.
  const events = r.field === 'events' || r.field === 'all';
  if (events) {
    out.push(
      `${plural(r.coverage.events, 'event is', 'events are')} dated in this brain, on ` +
        `${r.coverage.pagesWithEvents} of ${plural(r.pages, 'page')}.`,
    );
    out.push('Only lines under "## Dated events" count as dates.');
  }
  if (r.field !== 'events') {
    out.push('Page dates say when a PAGE was written, not when anything in it happened.');
  }
  if (r.search && r.searchWords?.length === 0) {
    out.push(`${q(r.search)} has no word in it to look for, so nothing can match it.`);
  }

  if (r.items.some((i) => i.field === 'events')) {
    out.push('Under each event: the RUN line for its source, then for its page.');
  }
  for (const item of r.items) {
    out.push('');
    out.push(`${item.dateText} | ${item.field === 'events' ? item.kind : item.field} | ${q(item.title)}: ${item.summary}`);
    const page = cmd(`read ${q(item.title)}`);
    if (item.field === 'events') {
      const source = item.sourceSection
        ? sectionCmd(item.sourceTitle, item.sourceSection)
        : cmd(`read ${q(item.sourceTitle)}`);
      out.push(`  RUN:  ${source}`);
      if (source !== page) out.push(`  RUN:  ${page}`);
    } else {
      out.push(`  RUN:  ${page}`);
    }
  }

  const shownTo = r.offset + r.items.length;
  if (r.items.length && (r.offset > 0 || shownTo < r.total)) {
    out.push('');
    out.push(`Showing ${r.offset + 1}-${shownTo} of ${r.total}. Do NOT describe this list as complete.`);
  }
  if (r.items.length && shownTo < r.total) {
    out.push(`The next ${Math.min(r.limit, r.total - shownTo)}:`);
    out.push(`  RUN:  ${again(values, { offset: String(shownTo) })}`);
  }
  if (!r.items.length && r.total > 0) {
    out.push('');
    out.push(`Nothing at offset ${r.offset}: there ${r.total === 1 ? 'is 1' : `are ${r.total}`}. From the start:`);
    out.push(`  RUN:  ${again(values, { offset: undefined })}`);
  }

  if (r.total === 0 && events) {
    out.push('');
    out.push('No dated event matches, and that does not mean nothing happened: only what');
    out.push('a page records under "## Dated events" can match. Before telling your user');
    out.push('nothing happened, search the pages by their words:');
    out.push(`  RUN:  ${cmd(`read --search ${q(r.search && r.searchWords?.length ? r.search : '<topic>')}`)}`);
  }

  if (r.warnings.length) {
    out.push('');
    const shown = r.warnings.slice(0, WARNINGS_SHOWN);
    out.push(
      `WARNINGS: ${plural(r.warnings.length, 'line was', 'lines were')} left out because ` +
        `${r.warnings.length === 1 ? 'it is' : 'they are'} not usable as written.` +
        (shown.length < r.warnings.length ? ` The first ${shown.length}:` : ''),
    );
    for (const w of shown) out.push(`  ${w.path}${w.line ? `:${w.line}` : ''}  ${w.message}`);
    if (shown.length < r.warnings.length) {
      out.push(`Every one of the ${r.warnings.length}, with the full answer:`);
      out.push(`  RUN:  ${again(values, {}, { json: true })}`);
    }
  }
  return out;
}

export function dates(values = {}, positionals = []) {
  // The same three refusals `read` makes, for the same reasons: a broken
  // pointer cannot be told from no brain, and `--at` naming a folder with no
  // brain in it must never fall back to the one the pointer names.
  const cfg = configState();
  if (cfg.status === 'unreadable' && !expandPath(values.at)) {
    return { code: ERROR, state: { vault: null, self: 'dates', brokenPointer: true }, error: brokenConfig(cfg) };
  }
  const vault = resolveVault(values.at);
  const state = vaultState(vault, 'dates');

  if (positionals.length) {
    // `dates 2026-06` is the first call an agent tries, so the fix is the call
    // that works rather than a pointer to the help page.
    const [only] = positionals;
    let fix = `RUN: ${cmd('help')}`;
    if (positionals.length === 1 && /^\d{4}(-\d{2}){0,2}$/.test(only) && !values.on && !values.from && !values.to) {
      fix = `RUN: ${again(values, { on: only })}`;
    } else if (positionals.length === 1 && !values.search) {
      fix = `RUN: ${again(values, { search: only })}`;
    }
    return {
      code: USAGE,
      state,
      error: { message: `dates takes flags, not words on their own: ${positionals.map(q).join(' ')}.`, fix },
    };
  }

  const options = {};
  for (const k of FLAGS) if (values[k] !== undefined) options[k] = values[k];
  try {
    queryOptions(options);
  } catch (e) {
    return { code: USAGE, state, error: { message: e.message, fix: `RUN: ${cmd('help')}` } };
  }

  const asked = expandPath(values.at);
  if (asked && !vault) {
    const pointed = pointedVault();
    return {
      code: USAGE,
      state: vaultState(pointed, 'dates'),
      error: noBrainAt(asked, pointed, again(values, {}, { at: false })),
    };
  }
  if (!vault) {
    return {
      code: ERROR,
      state,
      error: { message: 'No brain on this machine yet, so there is nothing to look up.', fix: `RUN: ${cmd('init')}` },
    };
  }

  const result = queryDates(vault, options);
  return { code: OK, state, body: body(result, values), json: result };
}
