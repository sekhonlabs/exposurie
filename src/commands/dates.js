import { queryDates } from '../dates.js';
import { queryOptions } from '../dates-core.js';
import { resolveVault } from '../context.js';
import { vaultState } from '../vault.js';
import { cmd } from '../install.js';
import { OK, ERROR, USAGE } from '../exit-codes.js';

export function dates(values = {}, positionals = []) {
  const vault = resolveVault(values.at);
  const state = vaultState(vault, 'dates');
  if (positionals.length)
    return {
      code: USAGE,
      state,
      error: {
        message: 'dates takes flags, not positional arguments.',
        fix: `RUN: ${cmd('help')}`,
      },
    };
  const options = Object.fromEntries(
    ['on', 'from', 'to', 'field', 'search', 'order', 'limit', 'offset']
      .filter((k) => values[k] !== undefined)
      .map((k) => [k, values[k]]),
  );
  try {
    queryOptions(options);
  } catch (error) {
    return {
      code: USAGE,
      state,
      error: { message: error.message, fix: `RUN: ${cmd('help')}` },
    };
  }
  if (!vault)
    return {
      code: values.at ? USAGE : ERROR,
      state,
      error: {
        message: 'No brain at the requested location.',
        fix: `RUN: ${cmd('init')}`,
      },
    };
  try {
    const result = queryDates(vault, options);
    const body = [
      `DATES: ${result.total} matches (${result.field}); showing ${result.items.length} from offset ${result.offset}.`,
      `Structured event coverage: ${result.coverage.events} events on ${result.coverage.pagesWithEvents} of ${result.pages} pages.`,
      'Event dates come from explicit sourced entries. Created/updated describe the page, not when events happened.',
      '',
      ...result.items.flatMap((item) => [
        `${item.dateText} | ${item.field === 'events' ? item.kind : item.field} | ${item.title}: ${item.summary}`,
        ...(item.source ? [`  source: ${item.source}`] : []),
        `  RUN: ${cmd(`read ${JSON.stringify(item.title)}`)}`,
      ]),
      ...result.warnings.map(
        (w) => `WARNING: ${w.path}:${w.line ?? '?'} ${w.message}`,
      ),
      ...(result.total === 0 && result.field === 'events'
        ? [
            'No recorded event matched. Structured coverage may be incomplete; search and read source pages before concluding nothing happened.',
          ]
        : []),
    ];
    return { code: OK, state, body, json: result, miss: result.total === 0 };
  } catch (error) {
    return {
      code: ERROR,
      state,
      error: {
        message: error.message,
        fix: 'Check the date flags and the configured curated page paths. See docs/dates.md.',
      },
    };
  }
}
