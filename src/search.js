// Search: finding the page that holds a thing, by the words an agent actually types.
//
// WHAT WAS WRONG, MEASURED. Through 1.2.0 a search was one case-insensitive
// substring match of the whole query. Agents do not search like that. They type
// a handful of keywords — "dead letter replay deliveries cleanup" — and a page
// can hold every one of those words without holding that exact string. Replayed
// against the brains in the public benchmark (github.com/sekhonlabs/exposurie-bench),
// 23 of the 61 searches agents ran came back with zero pages: 6 rightly, for
// things the brain was never told, and 17 only because they were several words.
// In the benchmark's long task, a fresh session after a sync searched
// three times, got zero three times, was told "Nothing in the brain matches. Say
// so plainly", and went on without four rules its brain held on pages whose
// titles contained the very words it had searched for. The sync had done its job.
// Retrieval threw it away.
//
// So a query is WORDS, not a phrase, and three more things follow from that:
//
//   ANY FORM OF A WORD. "google sheets" never found a page that said "a member
//   Google Sheet". Plurals, -ing, -ed and a trailing e are spelling, not meaning,
//   so both sides are reduced to the same key before comparing: sheet/sheets,
//   name/names/naming/named, deliveries/delivery, archive/archived/archiving.
//   British and American spellings meet too (colour/color, organisation/
//   organization, licence/license), because a brain is written by one person
//   and searched by an agent with the other habit. Accents are ignored both
//   ways, so "Ines" finds "Inês".
//
//   WHOLE WORDS. A short word matched as a substring lands inside unrelated
//   longer ones — "lor" is in "explorer" and "colour" — and the page that is
//   actually about the thing loses to the page that merely contains the
//   letters. Words are compared to words. The one loosening is deliberate: a
//   long query word also reaches words it begins ("deploy" -> "deployment",
//   "translat" -> "translation"), at half weight.
//
//   RANKED, AND HONEST ABOUT COVERAGE. A page holding every word comes before a
//   page holding some; a rare word counts for more than one on every page; a
//   word in the title counts for more than one in passing; and a page's length
//   is damped, because counting raw hits hands the top slot to whichever page is
//   biggest. Every result says which of the query's words it has and which it
//   lacks, so "no page has all of these" is something the agent is TOLD rather
//   than something it has to guess from an empty list.
//
// No index is kept on disk. A brain is a few hundred pages of plain Markdown;
// reading them on every search costs milliseconds, and an index is a second
// copy of the brain that can go stale without anything reporting it.

import { readFileSync } from 'node:fs';
import { headings, fold } from './read.js';

// ---- words --------------------------------------------------------------

/**
 * Words that carry no subject. Dropped from a QUERY so "how does the owner
 * name branches" asks for owner, name and branch — never from a page, where
 * they still separate one phrase from the next.
 */
export const STOPWORDS = new Set(
  (
    'a an the and or but nor of to in on at by for with from into onto over about as ' +
    'is are was were be been being am do does did done has have had having ' +
    'it its this that these those there here then than so such ' +
    'i me my mine we us our you your he him his she her they them their ' +
    'what which who whom whose when where why how ' +
    'not no any all some each every both either neither ' +
    'can could would should will shall may might must ' +
    'if else also just only very too more most much many up out off again still yet'
  ).split(' '),
);

const isVowel = (c) => c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u' || c === 'y';

/** Where the region after the first non-vowel following a vowel begins, scanning from `from`. */
function regionAfter(w, from) {
  for (let i = from + 1; i < w.length; i++) {
    if (!isVowel(w[i]) && isVowel(w[i - 1])) return i + 1;
  }
  return w.length;
}

/** A word ending vowel-consonant after a consonant (not w, x or y), or a two-letter vowel-consonant word. */
function endsShortSyllable(s) {
  const n = s.length;
  if (n === 2) return isVowel(s[0]) && !isVowel(s[1]);
  if (n < 3) return false;
  return !isVowel(s[n - 3]) && isVowel(s[n - 2]) && !isVowel(s[n - 1]) && !'wxy'.includes(s[n - 1]);
}

// Spelling that differs by habit rather than by word. Folded on both sides, so
// a fold only has to be consistent, never correct — "promise" becoming
// "promize" is harmless, because every "promise" becomes it. None of them
// touches a word's first four letters, which the quick pass in `rank` relies on.
const SPELLING = [
  [/^(.{3,})isation/, '$1ization'],
  [/^(.{3,})is(e|ed|es|ing|er|ers)$/, '$1iz$2'],
  [/^(.{3,})ys(e|ed|es|ing)$/, '$1yz$2'],
  [/^(.{3,})our(s|ed|ing|ite|ites|able|er|ers|ful|less)?$/, '$1or$2'],
  [/^licenc(e|es|ed|ing)$/, 'licens$1'],
  [/^(defen|offen|preten)c(e|es)$/, '$1s$2'],
  [/^(cent|theat)re(s)?$/, '$1er$2'],
  [/^(catalog|dialog|analog)ue(s)?$/, '$1$2'],
  [/^programme(s)?$/, 'program$1'],
];

const INVARIANT = new Set(['proceed', 'exceed', 'succeed', 'news']);

/**
 * The key two words are compared by: the word with its inflection removed.
 *
 * Plurals, -ed, -ing and a silent trailing e, and nothing more. Derivations are
 * kept apart on purpose — "deployment" is not "deploy", "worker" is not
 * "work" — because folding those together makes a search about one return
 * pages about the other. The prefix rule in `matchWeight` reaches derivations
 * at half weight instead, so they rank below the word itself.
 *
 * The rules are the inflectional half of the standard English stemmer (Porter's
 * second version), with one change: "deliveries" and "replied" become
 * "delivery" and "reply" rather than "deliveri" and "repli", so a key is still
 * a word a person could read in a test.
 */
export function stem(word) {
  let w = word;
  for (const [re, to] of SPELLING) w = w.replace(re, to);
  if (w.length <= 3 || /\d/.test(w) || INVARIANT.has(w)) return w;

  // Plurals and third person.
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') || w.endsWith('ied')) w = w.length > 4 ? w.slice(0, -3) + 'y' : w.slice(0, -1);
  else if (w.endsWith('us') || w.endsWith('ss')) {
    // status, bonus, class, process: the s is the word
  } else if (w.endsWith('s')) {
    const before = w.slice(0, -1);
    if (/[aeiouy]/.test(before.slice(0, -1))) w = before;
  }

  // Past tense and the -ing form.
  const r1 = regionAfter(w, 0);
  if (w.endsWith('eed')) {
    if (w.length - 3 >= r1) w = w.slice(0, -1);
  } else {
    const suf = w.endsWith('ing') ? 3 : w.endsWith('ed') ? 2 : 0;
    if (suf && /[aeiouy]/.test(w.slice(0, -suf))) {
      w = w.slice(0, -suf);
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(w)) w = w.slice(0, -1);
      else if (endsShortSyllable(w) && regionAfter(w, 0) >= w.length) w += 'e';
    }
  }

  // A trailing e that only spells: "archive" and "archived" meet at "archiv",
  // while "name" and "note" keep theirs, so they never meet "nam" or "not".
  const R1 = regionAfter(w, 0);
  const R2 = regionAfter(w, R1);
  if (w.endsWith('e') && w.length > 3) {
    const at = w.length - 1;
    if (at >= R2 || (at >= R1 && !endsShortSyllable(w.slice(0, -1)))) w = w.slice(0, -1);
  } else if (w.endsWith('ll') && w.length - 1 >= R2) {
    w = w.slice(0, -1);
  }
  return w.length >= 3 ? w : word;
}

// Letters and digits. Everything else — spaces, dashes, dots, quotes, the
// brackets of a [[link]] — separates words, so "ENG-447" is "eng" then "447".
const WORD = /[\p{L}\p{N}]+/gu;

/** Accents off, case kept: the form words are cut from. Once per page, not once per line. */
const unaccent = (s) => String(s).normalize('NFKD').replace(/\p{M}+/gu, '');

// The same few thousand words recur on every page of a brain, and stemming is
// the hot path of a search, so each word is stemmed once per process.
const STEMMED = new Map();

/** The keys of a text, in order, with each one's surface form folded. */
export function words(text, plain = false) {
  const out = [];
  for (const m of (plain ? String(text) : unaccent(text)).matchAll(WORD)) {
    const raw = m[0];
    let hit = STEMMED.get(raw);
    if (!hit) {
      // An acronym's plural — PRs, IDs, APIs, URLs. The s is the plural and
      // the rest is a name, which the stemmer would otherwise refuse to shorten.
      const lower = raw.toLowerCase();
      hit = /^[A-Z]{2,}s$/.test(raw)
        ? { word: lower, key: lower.slice(0, -1) }
        : { word: lower, key: stem(lower) };
      if (STEMMED.size > 200000) STEMMED.clear();
      STEMMED.set(raw, hit);
    }
    out.push(hit);
  }
  return out;
}

// ---- the query ------------------------------------------------------------

/**
 * A query's terms: its words minus stopwords, one term per distinct key, in
 * the order they were typed. A query of nothing but stopwords keeps them —
 * "who am I" has to be about something.
 */
export function parseQuery(query) {
  const all = words(query).filter((w) => w.key.length > 1 || /\d/.test(w.key));
  let kept = all.filter((w) => !STOPWORDS.has(w.word));
  if (kept.length === 0) kept = all;
  const terms = [];
  const seen = new Map();
  for (const w of kept) {
    if (seen.has(w.key)) continue;
    seen.set(w.key, terms.length);
    terms.push({ key: w.key, word: w.word });
  }
  return { query: String(query), terms };
}

/**
 * How strongly a word in a page answers one query term.
 *   1    the same key: sheet/sheets, name/naming.
 *   0.5  one begins the other: deploy/deployment, translat/translation. A long
 *        query word reaching the words it starts, or a long page word that a
 *        query word extends. Never for short or numeric keys, where a prefix
 *        is mostly coincidence.
 */
export function matchWeight(qKey, dKey) {
  if (qKey === dKey) return 1;
  if (/\d/.test(qKey) || /\d/.test(dKey)) return 0;
  if (qKey.length >= 5 && dKey.length > qKey.length && dKey.startsWith(qKey)) return 0.5;
  if (dKey.length >= 6 && qKey.length > dKey.length && qKey.startsWith(dKey)) return 0.5;
  return 0;
}

/**
 * What every page that could match a key must contain, for a cheap pass
 * before the real one: a page without it is never tokenised.
 *
 * The key's first letters, with a final e or y dropped first, because those
 * are the letters a key can have that its word does not — "voting" is keyed
 * "vote", "tried" is keyed "try". Nothing else a key changes reaches its first
 * four letters, which is what makes skipping a page on this safe. A test holds
 * that over every pair of words that match.
 */
export function probe(key) {
  return (key.length > 2 ? key.replace(/[ey]$/, '') : key).slice(0, 4);
}

// ---- pages ------------------------------------------------------------------

/** The first line after a leading `---` frontmatter block, or 0 when there is none. */
export function frontmatterEnd(lines) {
  if (!/^---\s*$/.test(lines[0] ?? '')) return 0;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) return i + 1;
  return 0;
}

/** The text of a page's `tags:` (and `aliases:`), which name what the page is about. */
function frontmatterTopics(lines, end) {
  const out = [];
  for (let i = 1; i < end - 1; i++) {
    const m = lines[i].match(/^\s*(tags|aliases)\s*:\s*(.*)$/i);
    if (m) out.push(m[2]);
  }
  return out.join(' ');
}

/**
 * A page cut into blocks: the top of the page (everything before its first
 * section, the H1 included), then each heading with its own text — up to the
 * next heading of ANY level, so a parent does not win just by containing its
 * children. A block is where a hit is reported and what gets shown.
 */
export function blocks(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = headings(text);
  const fm = frontmatterEnd(lines);
  const hs = heads.filter((h) => h.line >= fm);
  // A leading H1 is the page's own title, so it belongs to the top block, and
  // it is remembered by line: a `#` inside a code example is not a title.
  const h1 = hs.length && hs[0].level === 1 ? hs[0] : null;
  const first = h1 ? 1 : 0;
  const out = [{ head: null, h1, start: fm, end: first < hs.length ? hs[first].line : lines.length }];
  for (let i = first; i < hs.length; i++) {
    out.push({ head: hs[i], start: hs[i].line, end: i + 1 < hs.length ? hs[i + 1].line : lines.length });
  }
  return { lines, heads, fm, blocks: out };
}

/** The block's own text as written; the top block leaves out its H1, since the title already says it. */
export function blockText(lines, b) {
  const own = [];
  for (let i = b.start; i < b.end; i++) if (!(b.h1 && i === b.h1.line)) own.push(lines[i]);
  return own.join('\n').replace(/^\s+|\s+$/g, '');
}

/** Everything under the frontmatter, the title line left out: the page as a reader sees it. */
export function pageText(lines) {
  const body = lines.slice(frontmatterEnd(lines));
  const first = body.findIndex((l) => l.trim() !== '');
  if (first !== -1 && /^#\s/.test(body[first])) body.splice(first, 1);
  return body.join('\n').replace(/^\s+|\s+$/g, '');
}

// ---- ranking ------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;
const FIELD = { tags: 3, head: 2, body: 1 };
const TITLE = 2;
const PAIR = 0.5;

/**
 * Score every page against the query. Returns the matching pages best first,
 * each with which terms it has and the block that matched best.
 *
 * `pages` is [{ title, path }]; the text is read here, once per search.
 */
export function rank(pages, query) {
  const q = parseQuery(query);
  const T = q.terms.length;
  const docs = [];
  let chars = 0;
  for (const page of pages) {
    let text;
    try {
      text = readFileSync(page.path, 'utf8');
    } catch {
      continue;
    }
    chars += text.length;
    docs.push({ page, text });
  }
  if (T === 0) return { terms: q.terms, results: [], searched: docs.length };

  const avg = chars / Math.max(docs.length, 1);
  const probes = q.terms.map((t) => probe(t.key));
  const exact = new Map(q.terms.map((t, i) => [t.key, i]));
  const keyCache = new Map();

  const matched = [];
  for (const d of docs) {
    d.plain = unaccent(d.text);
    const folded = d.plain.toLowerCase() + '\n' + fold(d.page.title);
    if (!probes.some((p) => folded.includes(p))) continue;
    const m = scan(d, q, exact, keyCache);
    if (m.present.some(Boolean)) matched.push(m);
  }

  const N = docs.length;
  const idf = q.terms.map((_, i) => {
    const df = matched.filter((m) => m.present[i]).length;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  });
  const idfSum = idf.reduce((a, b) => a + b, 0) || 1;
  const wholeQuery = q.terms.map((t) => t.key).join(' ');

  for (const m of matched) {
    const norm = K1 * (1 - B + (B * m.text.length) / avg);
    let base = 0;
    let titled = 0;
    let covered = 0;
    for (let i = 0; i < T; i++) {
      const tf = FIELD.tags * m.tf.tags[i] + FIELD.head * m.tf.head[i] + FIELD.body * m.tf.body[i];
      base += (idf[i] * tf * (K1 + 1)) / (tf + norm);
      if (m.tf.title[i] > 0) titled += idf[i] * TITLE * Math.min(m.tf.title[i], 1);
      if (m.present[i]) covered += idf[i];
    }
    let pairs = 0;
    for (const [a, b] of m.pairs) pairs += PAIR * ((idf[a] + idf[b]) / 2);
    // The title IS the query: the page about exactly this.
    const named = m.titleKeys === wholeQuery ? idfSum * 3 : 0;
    m.coverage = covered / idfSum;
    m.score = (base + titled + pairs + named) * m.coverage * m.coverage;

    // The block to show: most of the query's weight, saturating per term so one
    // word repeated ten times cannot outrank a block that has them all.
    let best = null;
    for (const blk of m.blocks) {
      let s = 0;
      let c = 0;
      for (let i = 0; i < T; i++) {
        const tf = blk.tf[i];
        if (tf > 0) {
          s += idf[i] * (tf / (tf + 1));
          c += idf[i];
        }
      }
      s *= (c / idfSum) ** 2;
      if (s > 0 && (!best || s > best.score)) best = { ...blk, score: s };
    }
    // Two cases where the top of the page beats any section: the page matched
    // on its title or tags alone, with no block that says the word; and the
    // page's title already holds every word it matched, so the page IS the
    // thing asked about, and its opening says what that is better than a
    // section that merely repeats the name.
    const titleCovers = q.terms.every((_, i) => !m.present[i] || m.tf.title[i] > 0);
    m.best = !best || titleCovers ? { ...m.blocks[0], score: best?.score ?? 0 } : best;
    m.others = m.blocks
      .filter((b) => b.start !== m.best.start && b.head && b.tf.some((x) => x > 0))
      .map((b) => ({ ...b, score: b.tf.reduce((a, x, i) => a + (x > 0 ? idf[i] : 0), 0) }))
      .sort((a, b) => b.score - a.score);
  }

  matched.sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
  return { terms: q.terms, results: matched, searched: docs.length };
}

/** One pass over a page: term weights per field and per block, and adjacent pairs. */
function scan(d, q, exact, cache) {
  const T = q.terms.length;
  const zero = () => new Array(T).fill(0);
  const tf = { title: zero(), tags: zero(), head: zero(), body: zero() };
  const pairs = new Set();

  const weights = (key) => {
    let hit = cache.get(key);
    if (hit) return hit;
    hit = [];
    const i = exact.get(key);
    if (i !== undefined) hit.push([i, 1]);
    for (let j = 0; j < T; j++) {
      if (j === i) continue;
      const w = matchWeight(q.terms[j].key, key);
      if (w) hit.push([j, w]);
    }
    cache.set(key, hit);
    return hit;
  };

  // Adjacent query terms side by side in the page, in either order, with
  // stopwords between them ignored: "dead letters", "pull request".
  const run = (ws, into, blockTf, mult = 1) => {
    let prev = [];
    for (const w of ws) {
      const hit = weights(w.key);
      for (const [i, wt] of hit) {
        into[i] += wt;
        if (blockTf) blockTf[i] += wt * mult;
        for (const [p] of prev) if (Math.abs(p - i) === 1) pairs.add(p < i ? `${p},${i}` : `${i},${p}`);
      }
      if (hit.length) prev = hit;
      else if (!STOPWORDS.has(w.word)) prev = [];
    }
  };

  const titleWords = words(d.page.title);
  run(titleWords, tf.title, null);

  const { lines, heads, blocks: bs, fm } = blocks(d.text);
  // The same lines with accents already off, cut once; NFKD never adds or
  // removes a line break, so line i here is line i there.
  const plain = d.plain.split(/\r?\n/);
  run(words(frontmatterTopics(plain, fm), true), tf.tags, null);

  const out = [];
  for (const b of bs) {
    const btf = zero();
    if (b.head) run(words(plain[b.head.line].replace(/^#+\s+/, ''), true), tf.head, btf, FIELD.head);
    const first = b.head ? b.start + 1 : b.start;
    for (let i = first; i < b.end; i++) {
      const l = plain[i];
      if (b.h1 && i === b.h1.line) {
        run(words(l.replace(/^#\s+/, ''), true), tf.head, btf, FIELD.head);
        continue;
      }
      run(words(l, true), tf.body, btf);
    }
    out.push({ ...b, tf: btf });
  }

  const present = tf.title.map(
    (_, i) => tf.title[i] + tf.tags[i] + tf.head[i] + tf.body[i] > 0,
  );
  return {
    page: d.page,
    text: d.text,
    lines,
    heads,
    tf,
    present,
    pairs: [...pairs].map((s) => s.split(',').map(Number)),
    blocks: out,
    titleKeys: titleWords
      .filter((w) => !STOPWORDS.has(w.word))
      .map((w) => w.key)
      .join(' '),
  };
}
