// `exposurie read` — the librarian, rendered.
//
// Five shapes, one command, because an agent choosing between `page`, `section`
// and `search` subcommands is an agent that can choose wrong. What it wants is
// always "show me this"; the flags say how much.
//
//   exposurie read                              every page, by title
//   exposurie read "<page>"                     the page, or its map if large
//   exposurie read "<page>" --section "<name>"  one section
//   exposurie read "<page>" --outline           the map, whatever the size
//   exposurie read --search "<words>"           find it first
//
// Nothing here is ever a dead end. Every response that does not contain what
// was asked for contains the exact command that does — or, better, the thing
// itself: a title that names no page is searched for on the spot, rather than
// handing back a command to search for it. That is rule 3 of the output
// contract applied where it is most easily skipped: the failure paths.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSeam, vaultState, expandPath } from '../vault.js';
import { configState, brokenConfig, resolveVault, noBrainAt, pointedVault } from '../context.js';
import { OK, ERROR, USAGE } from '../exit-codes.js';
import { cmd } from '../install.js';
import { SYNC, exists } from './names.js';
import {
  allPages,
  headings,
  findSection,
  sliceSection,
  outlineBlock,
  sectionCmd,
  nthFor,
  links,
  loose,
  q,
  DEFAULT_READ_BUDGET,
} from '../read.js';
import { rank, blockText, pageText, words, matchWeight, frontmatterEnd, STOPWORDS } from '../search.js';

/**
 * Match a page by title. Exact beats prefix beats substring, for the same
 * reason section lookup works that way: a brain holding both "Ledger" and
 * "Ledger Migration Notes" must still be able to return the first one.
 *
 * The exact title is tried as written before anything looser, so a printed
 * command always opens the page it names. Only then is the title compared the
 * way a person types it — case, accents and punctuation ignored — which is
 * what lets "Sixty Days - Summer" reach "Sixty Days — Summer".
 */
function findPage(pages, want) {
  const w = String(want).trim().toLowerCase();
  const exact = pages.filter((p) => p.title.toLowerCase() === w);
  if (exact.length) return { hit: exact[0], candidates: exact };
  const lw = loose(String(want).trim().replace(/^\[\[(.*)\]\]$/, '$1').replace(/\.md$/i, ''));
  if (!lw) return { hit: null, candidates: [] };
  const same = pages.filter((p) => loose(p.title) === lw);
  if (same.length) return { hit: same.length === 1 ? same[0] : null, candidates: same };
  const pre = pages.filter((p) => loose(p.title).startsWith(lw));
  if (pre.length === 1) return { hit: pre[0], candidates: pre };
  const sub = pages.filter((p) => loose(p.title).includes(lw));
  const pool = pre.length ? pre : sub;
  if (pool.length === 1) return { hit: pool[0], candidates: pool };
  return { hit: null, candidates: pool };
}

// ---- search ---------------------------------------------------------------

/** Pages whose best section is printed in full; the rest are listed, unread. */
const EXPAND = 3;
const LIST = 12;

/** The command that opens a block: its section, or the page for the top of it. */
function blockCmd(r, b) {
  if (!b?.head) return cmd(`read ${q(r.page.title)}`);
  return sectionCmd(r.page.title, b.head.text, nthFor(r.heads).get(b.head));
}

/** "  [has every word]", "  [has: a, b · lacks: c]", or nothing for one word. */
function coverage(r, terms) {
  if (terms.length < 2) return '';
  if (r.present.every(Boolean)) return '   [has every word]';
  const has = terms.filter((_, i) => r.present[i]).map((t) => t.word);
  const lacks = terms.filter((_, i) => !r.present[i]).map((t) => t.word);
  return `   [has: ${has.join(', ')} · lacks: ${lacks.join(', ')}]`;
}

/**
 * One result printed in full, in at most `room` characters of page text.
 *
 * A page short enough to print is printed whole: a section of a small page
 * saves nothing and leaves its neighbours one more call away. A longer page
 * gives the section that matched best, cut at a line where it has to be, with
 * the command for the rest.
 */
function expanded(r, n, terms, room) {
  const out = ['', `[${n}] ${r.page.title}${coverage(r, terms)}`, `    RUN:  ${cmd(`read ${q(r.page.title)}`)}`];
  const whole = pageText(r.lines);
  if (whole.length <= room) {
    out.push('    The whole page, as written:', '', whole, '');
    return out;
  }
  const b = r.best;
  const text = blockText(r.lines, b);
  let part = text;
  if (text.length > room) {
    let at = text.lastIndexOf('\n', room);
    if (at < room * 0.6) at = room;
    part = text.slice(0, at).replace(/\s+$/, '');
  }
  out.push(b.head ? '    The section that matched, as written:' : '    The top of the page, as written:');
  out.push('', part, '');
  if (part.length < text.length) {
    out.push(`    CUT at ${part.length} of ${text.length} chars. The rest of it:`);
    out.push(`    RUN:  ${blockCmd(r, b)}`);
  }
  const also = r.others.slice(0, 2);
  if (also.length) {
    out.push('    Also matched on this page:');
    for (const o of also) out.push(`    RUN:  ${blockCmd(r, o)}`);
  }
  return out;
}

/**
 * The search, rendered.
 *
 * The best-matching pages come back with the matching SECTION printed as
 * written, not a line torn out of it. An earlier shape of this — a line number
 * and a section name per hit — left the agent one more call from any answer,
 * and a librarian that prints excerpts gets answered from: a torn line reads
 * like the whole story and is not. A section is the smallest unit that is.
 * Everything past the first few is listed with its command and labelled
 * unread, so nothing printed can be mistaken for something that was not.
 *
 * And a search that finds nothing never ends the conversation. Through 1.2.0 a
 * miss said "Nothing in the brain matches. Say so plainly", which an agent
 * obeyed at once, after one try, with a query that had failed only because it
 * was a phrase. A miss now says what to try before saying no.
 */
function searchBody(pages, query, budget) {
  const { terms, results, searched } = rank(pages, query);
  const scope = `(searched ${searched} ${searched === 1 ? 'page' : 'pages'})`;
  const body = [];

  if (results.length === 0) {
    body.push(
      terms.length
        ? `TOTAL: 0 pages match ${q(query)} ${scope}. No page has any of these words, in any form.`
        : `TOTAL: 0 pages match ${q(query)} ${scope}. There is no word in it to look for.`,
    );
    body.push('');
    body.push('Before telling your user the brain does not have it:');
    body.push('  1. Search again with other words for the same thing: a name, a tool, a project.');
    body.push(`     RUN:  ${cmd(`read --search ${q('<other words>')}`)}`);
    body.push('  2. Look down every page by title.');
    body.push(`     RUN:  ${cmd('read')}`);
    body.push('If neither turns it up, say plainly that the brain does not record it.');
    body.push('Do not answer from memory.');
    return body;
  }

  const n = results.length;
  body.push(
    `TOTAL: ${n} ${n === 1 ? 'page matches' : 'pages match'} ${q(query)} ${scope}. ` +
      'Words match in any order and any form; best first.',
  );
  const anyAll = results.some((r) => r.present.every(Boolean));
  if (terms.length > 1 && !anyAll) {
    body.push(
      `No page has ${terms.length === 2 ? 'both words' : `all ${terms.length} words`}. ` +
        'The closest come first, each with the words it lacks.',
    );
  }

  // Everything below is held inside the read budget, the same number that
  // decides whether a page opens whole: a search is a read like any other.
  const size = (ls) => ls.reduce((a, l) => a + String(l).length + 1, 0);
  const RESERVE = 400; // the closing lines, and room to say a list was cut
  const FRAME = 350; // a printed result's own lines around its text
  let used = size(body);
  const cap = Math.max(600, Math.floor(budget / 5));

  // Printed in full: the best page always, and the next ones while they are
  // genuinely about the question — most of its weight, and a real fraction of
  // the best page's score. A page that shares one word of five is listed, not
  // printed; three thousand characters of it would be noise with authority.
  const shown = [];
  for (const r of results) {
    if (shown.length >= EXPAND) break;
    if (shown.length && (r.coverage < 0.5 || r.score < 0.25 * results[0].score)) break;
    // The best match's text is the most useful thing a search can return, so
    // it is never squeezed out by a tight budget; the ones after it are.
    const room = Math.min(cap, Math.max(shown.length ? 0 : 300, budget - RESERVE - used - FRAME));
    if (room < 300) break;
    const lines = expanded(r, shown.length + 1, terms, room);
    body.push(...lines);
    used += size(lines);
    shown.push(r);
  }

  const rest = [];
  for (const r of results.slice(shown.length)) {
    if (rest.length >= LIST) break;
    const lines = [`  ${r.page.title}${coverage(r, terms)}`, `    RUN:  ${blockCmd(r, r.best)}`];
    if (used + size(lines) > budget - RESERVE) break;
    rest.push(lines);
    used += size(lines);
  }
  if (rest.length) {
    body.push('');
    body.push(
      `NOT READ: ${n - shown.length} more ${n - shown.length === 1 ? 'page' : 'pages'} matched. ` +
        'Nothing of them is shown, so open one before saying what it holds.',
    );
    for (const lines of rest) body.push(...lines);
  }
  if (shown.length + rest.length < n) {
    body.push(`Showing ${shown.length + rest.length} of ${n}. Do NOT describe this list as complete.`);
  }

  body.push('');
  body.push(
    shown.length
      ? "The text printed above is the brain's own words: use it." +
          (rest.length ? ' The pages only listed, you have NOT read.' : '')
      : 'No page text is printed above. Open a page before saying what it holds.',
  );
  if (terms.length > 1 && !anyAll) {
    body.push(
      'If the words no page has are what the question is about, the brain does not',
      'record it: say so rather than answering from memory.',
    );
  }
  return body;
}

// ---- the catalog ------------------------------------------------------------

/** One line about a page: what the index says of it, else its own first sentence. */
function describe(page, fromIndex) {
  const listed = fromIndex.get(loose(page.title));
  if (listed) return listed;
  let text;
  try {
    text = readFileSync(page.path, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || /^#/.test(l) || /^[-*_]{3,}$/.test(l) || /^!\[/.test(l)) continue;
    const plain = l
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/^[-+>]\s+/, '');
    return plain.length > 100 ? plain.slice(0, 97).replace(/\s+\S*$/, '') + '…' : plain;
  }
  return '';
}

/** What the brain's own index says of each page, by name: `- [[Page]] — what it is — date`. */
function indexDescriptions(vault, seam) {
  const out = new Map();
  const p = join(vault, ...(seam?.index || 'index.md').split('/'));
  if (!existsSync(p)) return out;
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return out;
  }
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*[-*+]\s*\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*[—–:-]+\s*(.+?)\s*$/);
    if (!m) continue;
    const said = m[2].replace(/\s*[—–-]+\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
    if (said) out.set(loose(m[1]), said);
  }
  return out;
}

/**
 * Every page, grouped as the brain groups them, each with the command that
 * opens it. The map of the brain, for the moments search cannot serve: a
 * question with no distinctive word in it, or a search that came back empty
 * and has to be checked before anyone says "not recorded".
 *
 * Always complete. A catalog that dropped pages to fit a budget would make
 * them unreachable from the one place an agent goes to see what exists — so
 * when the descriptions do not fit, they go, and the titles stay.
 */
function catalogBody(vault, seam, pages, budget) {
  if (pages.length === 0) {
    const body = ['The brain has no pages yet. Nothing has been filed into it.'];
    if (exists(SYNC)) body.push(`  RUN:  ${cmd(SYNC)}`);
    return body;
  }
  const fromIndex = indexDescriptions(vault, seam);
  const order = Object.keys(seam?.categories || {});
  const groups = new Map();
  for (const p of pages) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  const names = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || String(a).localeCompare(String(b));
  });

  // Three ways to print it, most useful first; the first that fits is used,
  // and the last is used whatever its size, because it is the one that is
  // still complete when nothing else fits.
  const build = (mode) => {
    const all = `all ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}, every one listed`;
    const out =
      mode === 'compact'
        ? [
            `BRAIN: ${all}, by title only: too many to describe within one read.`,
            `Open any of them by its title, exactly as written:`,
            `  RUN:  ${cmd(`read ${q('<title>')}`)}`,
          ]
        : [`BRAIN: ${all}. Each RUN line opens that page.`];
    for (const name of names) {
      const ps = groups.get(name).slice().sort((a, b) => a.title.localeCompare(b.title));
      out.push('');
      out.push(`${name} (${ps.length})`);
      for (const p of ps) {
        if (mode === 'compact') {
          out.push(`  ${q(p.title)}`);
          continue;
        }
        out.push(`  RUN:  ${cmd(`read ${q(p.title)}`)}`);
        if (mode === 'described') {
          const what = describe(p, fromIndex);
          if (what) out.push(`        ${what}`);
        }
      }
    }
    out.push('');
    out.push('To find a thing without knowing which page holds it:');
    out.push(`  RUN:  ${cmd(`read --search ${q('<words>')}`)}`);
    return out;
  };

  for (const mode of ['described', 'titled']) {
    const out = build(mode);
    if (out.join('\n').length <= budget) return out;
  }
  return build('compact');
}

// ---- small helpers --------------------------------------------------------------

/** Headings that share a word with what was asked for, best first. */
function closestHeadings(heads, wanted) {
  const want = words(wanted)
    .filter((w) => !STOPWORDS.has(w.word))
    .map((w) => w.key);
  if (!want.length) return [];
  return heads
    .filter((h) => h.level > 1)
    .map((h) => {
      const have = words(h.text).map((w) => w.key);
      const shared = want.filter((k) => have.some((x) => matchWeight(k, x) > 0));
      return { h, n: shared.length };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.h);
}

/** The pages a page links to that exist, as commands — invisible in a map otherwise. */
function linkedBlock(page, text, pages) {
  const out = [];
  for (const name of links(text)) {
    const { hit } = findPage(pages, name);
    if (!hit || hit === page || out.some((l) => l.endsWith(q(hit.title)))) continue;
    out.push(`  RUN:  ${cmd(`read ${q(hit.title)}`)}`);
  }
  if (!out.length) return [];
  return ['', `LINKED FROM THIS PAGE: ${out.length} ${out.length === 1 ? 'page' : 'pages'}, none of them shown above.`, ...out];
}

export function read(values = {}, positionals = []) {
  // --at names a brain outright, so a broken pointer cannot mislead us and the
  // flag doubles as the way to keep working while the file is repaired.
  const cfg = configState();
  if (cfg.status === 'unreadable' && !expandPath(values.at)) {
    return {
      code: ERROR,
      state: { vault: null, self: 'read', brokenPointer: true },
      error: brokenConfig(cfg),
    };
  }
  const vault = resolveVault(values.at);
  const state = vaultState(vault, 'read');

  // A named path that holds no brain is not "no brain on this machine", and the
  // difference is the whole value of the flag. Without this, `read --at ~/typo
  // --search x` searched a directory that was not there, found nothing, and
  // printed "Nothing in the brain matches. Say so plainly; do not answer from
  // memory." — exit 0, stated with authority, having never opened a brain. A
  // retrieval failure that succeeds is the worst output this product can make.
  const asked = expandPath(values.at);
  if (asked && !vault) {
    const pointed = pointedVault();
    // Their own call, rebuilt without the flag, so an agent is handed one
    // working command rather than a second broken one.
    const retry = [cmd('read')];
    if (positionals[0]) retry.push(q(positionals[0]));
    if (values.search) retry.push(`--search ${q(values.search)}`);
    if (values.section) retry.push(`--section ${q(values.section)}`);
    if (values.nth) retry.push(`--nth ${values.nth}`);
    if (values.outline) retry.push('--outline');
    if (values.full) retry.push('--full');
    return {
      code: USAGE,
      state: vaultState(pointed, 'read'),
      error: noBrainAt(asked, pointed, retry.join(' ')),
    };
  }

  if (!vault) {
    return {
      code: ERROR,
      state,
      error: {
        message: 'No brain on this machine yet, so there is nothing to read.',
        fix: `RUN: ${cmd('init')}`,
      },
    };
  }

  const seam = readSeam(vault);
  const pages = allPages(vault, seam);
  const budget = seam?.guards?.maxReadChars ?? DEFAULT_READ_BUDGET;

  // ---- search ----------------------------------------------------------
  if (values.search) {
    return { code: OK, state, body: searchBody(pages, values.search, budget) };
  }

  // ---- the catalog, when nothing is named --------------------------------
  const want = positionals[0];
  if (!want) {
    return { code: OK, state, body: catalogBody(vault, seam, pages, budget) };
  }

  const { hit: page, candidates } = findPage(pages, want);
  if (!page) {
    if (candidates.length > 1) {
      const body = [`${candidates.length} pages match ${q(want)}. Pick one:`];
      for (const c of candidates.slice(0, 12)) body.push(`  RUN:  ${cmd(`read ${q(c.title)}`)}`);
      if (candidates.length > 12) body.push(`Showing 12 of ${candidates.length}. Do NOT describe this list as complete.`);
      return { code: OK, state, body };
    }
    // No page by that name. The next thing anyone would do is search for the
    // words, so the search is done here rather than handed back as homework.
    return {
      code: OK,
      state,
      body: [`No page is titled ${q(want)}. Searched the brain for those words instead.`, '', ...searchBody(pages, want, budget)],
    };
  }

  let text;
  try {
    text = readFileSync(page.path, 'utf8');
  } catch (e) {
    return { code: ERROR, state, error: { message: `Cannot read ${page.path}: ${e.message}` } };
  }
  const heads = headings(text);

  // ---- one section -----------------------------------------------------
  if (values.section) {
    const nth = values.nth ? Number(values.nth) : null;
    const { hit, candidates: cands } = findSection(heads, values.section, nth);
    if (!hit) {
      const body = [];
      if (cands.length === 0) {
        // Never a different section in its place: a confident answer from the
        // wrong section is the failure this file exists to prevent. Name the
        // likely ones, each with its command, and let the agent choose.
        body.push(`${page.title} has no section named ${q(values.section)}.`);
        const close = closestHeadings(heads, values.section);
        if (close.length) {
          const nths = nthFor(heads);
          body.push('Closest by their words:');
          for (const h of close) body.push(`  RUN:  ${sectionCmd(page.title, h.text, nths.get(h))}`);
        }
        body.push('Every section, each with its command:');
        body.push(`  RUN:  ${cmd(`read ${q(page.title)} --outline`)}`);
      } else {
        // Identical headings. Exactness cannot separate them, so hand over one
        // working command per candidate rather than a rule to apply.
        body.push(`${cands.length} sections match ${q(values.section)} on ${page.title}. Pick one:`);
        cands.forEach((c, i) => {
          body.push(`  ${i + 1}. ${c.text}   [line ${c.line + 1}]`);
          body.push(`     RUN:  ${sectionCmd(page.title, values.section, i + 1)}`);
        });
      }
      return { code: OK, state, body };
    }
    const slice = sliceSection(text, heads, hit);
    return {
      code: OK,
      state,
      body: [
        `${page.title} -> ${hit.text}`,
        `path: ${page.path}   (section only, ${slice.split('\n').length} lines of ${text.split('\n').length})`,
        '',
        slice,
      ],
    };
  }

  // ---- outline, asked for or imposed -----------------------------------
  const oversize = text.length > budget;
  if (values.outline || (oversize && !values.full)) {
    const body = [];
    body.push(`${page.title}   [${text.length} chars]`);
    body.push(`path: ${page.path}`);
    body.push('');
    if (oversize && !values.outline) {
      // Say plainly that this is not the page. An agent that mistakes an
      // outline for content answers from headings, which reads to the user
      // exactly like never having opened the page at all.
      body.push(
        `THIS IS NOT THE PAGE. ${text.length} chars is over the ${budget} read budget, so the body was NOT printed — what follows is a map.`,
      );
      body.push('Open every section the question touches. Reading more is cheap; a shallow answer is not.');
      body.push('');
    }
    body.push(...outlineBlock(page.title, text, heads));
    body.push('');
    body.push(`Whole page anyway:  ${cmd(`read ${q(page.title)} --full`)}`);
    // In a map, a `## Related` section is one heading with a size beside it:
    // the pages it links to are invisible, and a hub page is exactly the page
    // that gets mapped rather than printed. So the doorways are listed.
    body.push(...linkedBlock(page, text, pages));
    return { code: OK, state, body };
  }

  // ---- the page --------------------------------------------------------
  return {
    code: OK,
    state,
    body: [`${page.title}`, `path: ${page.path}   [${text.length} chars]`, '', text.replace(/\s+$/, '')],
  };
}
