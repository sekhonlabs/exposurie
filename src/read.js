// The librarian: finding a page, and reaching every point inside it.
//
// This is the half of the product an agent touches most. Writing a brain happens
// on a sync; READING it happens on every question the user ever asks, so the
// cost and the failure modes here are paid continuously.
//
// The guarantee this file exists to provide, and it is the whole design:
//
//   EVERY SECTION OF EVERY PAGE IS REACHABLE IN ONE COMMAND, AND THE TOOL
//   PRINTS THAT COMMAND RATHER THAN EXPECTING THE AGENT TO CONSTRUCT IT.
//
// Both halves are load-bearing, and the second half was learned the hard way
// from the reference implementation this is descended from. That tool guards
// large pages by printing an outline instead of the body — correct, because a
// 51 KB page on a context that re-pays every turn is a real cost. But its
// outline prints headings and character counts and NOT the invocation that
// fetches each one. The agent has to assemble `-Section "..."` itself from a
// heading it has only seen rendered.
//
// That is rule 3 of the output contract ("print the command, never the
// concept") broken at exactly the moment the agent most needs the command: it
// has just been told the thing it asked for was withheld. A guard that
// withholds content and then makes the reader guess the way back to it is not
// a guard, it is a maze.
//
// So: the guard stays, and every line of the outline carries its literal argv.
//
// The unit changed too, and that correction came from the owner of the brain
// this was designed against: "theres not a hard rule like 300 lines, it can be
// even 500, but what matters more is whether we are able to access each and
// every point of brain." Lines were always a proxy. What actually decides
// whether a page opens is how many CHARACTERS a retrieval will spend, and what
// actually matters is not that pages stay small but that nothing becomes
// unreachable. Those are different goals and only the second one is real.

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { categoryEntries } from './vault.js';
import { cmd, q } from './install.js';

/**
 * How much a single read may spend before the body is replaced by an outline.
 *
 * Not a limit on how long a page may BE. A page may be any length its subject
 * deserves; this only decides whether one command returns the whole thing or
 * returns a map plus the commands to fetch each part.
 */
export const DEFAULT_READ_BUDGET = 16000;

// `q` now lives beside `cmd` in install.js — the two are one concern, and
// keeping them apart is what let printed PATHS go unquoted for four releases
// while printed TITLES were quoted rigorously right here. Re-exported so this
// stays the import site it has always been.
//
// Imported as well as re-exported, deliberately: a bare `export { q } from`
// forwards the name to importers without binding it in THIS module, so
// `sectionCmd` below — which is right there — stopped being able to see it.
export { q };

/** The exact argv that returns one section. The tool prints this; agents never build it. */
export function sectionCmd(title, heading, nth) {
  const base = cmd(`read ${q(title)} --section ${q(heading)}`);
  return nth ? `${base} --nth ${nth}` : base;
}

/**
 * Every markdown file in the brain, as { title, path, category }.
 *
 * Reads the seam's category paths rather than hardcoding folder names, because
 * a user who renames `entities` to `people` must not silently lose half their
 * brain to a search that still looks in the old place.
 */
export function allPages(vault, seam) {
  const out = [];
  const walk = (dir, category) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, category);
      else if (e.name.endsWith('.md')) out.push({ title: basename(e.name, '.md'), path: p, category });
    }
  };
  for (const c of categoryEntries(vault, seam)) walk(c.dir, c.name);
  return out;
}

/** Accent- and case-blind form of any text. "Inês" and "ines" are one word. */
export function fold(s) {
  return String(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * A name as a person types it rather than as it is spelled: accents, case and
 * every run of punctuation gone. A hyphen typed for an em-dash, "Ines" for
 * "Inês", `[[brackets]]` copied from a page — all the same name.
 *
 * Only ever a SECOND try. Every command this tool prints carries the exact
 * name, and the exact match is tried first, so two names that fold together
 * ("C++ Notes", "C Notes") can never make a printed command ambiguous.
 */
export function loose(s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The pages a page links to, by name, in the order they first appear. */
export function links(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    const name = m[1].trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/**
 * Headings, in document order, with the line they start on.
 *
 * Fenced code blocks are skipped. A `# comment` inside a shell example is not a
 * section, and treating it as one produces an outline advertising a section
 * that does not exist — the precise failure this file exists to prevent, just
 * arriving from the other direction.
 */
export function headings(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = l.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  }
  return out;
}

/**
 * Resolve a section name to exactly one heading.
 *
 * Exact match beats substring, always. Without that rule a page holding both
 * "Related" and "...three unrelated columns" cannot return the first one,
 * because the query is a substring of both — measured on a real 67-page brain,
 * where two pages hit exactly this.
 *
 * Identical repeated headings are the case exactness cannot settle, so they get
 * `--nth`. Returning the first silently would make every later one unreachable
 * while looking like it worked, and looking like it worked is the property that
 * makes a retrieval bug expensive.
 */
export function findSection(heads, query, nth) {
  const want = String(query).trim().toLowerCase();
  const exact = heads.filter((h) => h.text.trim().toLowerCase() === want);
  let pool = exact.length ? exact : heads.filter((h) => h.text.toLowerCase().includes(want));
  // Typed loosely — a hyphen for the em-dash, no accent. Tried only after the
  // name as written has missed, so no printed command can land here.
  if (pool.length === 0 && loose(query)) {
    const lw = loose(query);
    const same = heads.filter((h) => loose(h.text) === lw);
    pool = same.length ? same : heads.filter((h) => loose(h.text).includes(lw));
  }
  if (pool.length === 0) return { hit: null, candidates: [] };
  if (pool.length === 1) return { hit: pool[0], candidates: pool };
  if (nth && pool[nth - 1]) return { hit: pool[nth - 1], candidates: pool };
  return { hit: null, candidates: pool };
}

/** The body of one section: its heading through the next heading of equal or higher rank. */
export function sliceSection(text, heads, hit) {
  const lines = String(text).split(/\r?\n/);
  const idx = heads.indexOf(hit);
  let end = lines.length;
  for (let i = idx + 1; i < heads.length; i++) {
    if (heads[i].level <= hit.level) {
      end = heads[i].line;
      break;
    }
  }
  return lines.slice(hit.line, end).join('\n').replace(/\s+$/, '');
}

/**
 * The `--nth` each heading needs, or null when its name is unique.
 *
 * ONE definition, shared by the outline that PRINTS these commands and the
 * curator that CHECKS them. Two copies of this rule is two rules, and the
 * checker would then be validating its own opinion rather than the librarian's
 * behaviour — which is the same as no check at all.
 *
 * Counted over EVERY heading, including the H1 that never gets listed, because
 * the counter has to see exactly what findSection sees. Counting only the
 * listed ones was wrong in one entirely ordinary shape: a page with a section
 * named after itself — `# Cadence` with a `## Cadence` further down. The H1 is
 * not listed, so the H2 looked unique, so no `--nth` was printed, so the
 * command matched two headings and returned neither. Nothing errored and the
 * outline looked complete; the section had simply left the brain. Found by the
 * curator's reachability pass, which is the entire reason that pass exists.
 */
export function nthFor(heads) {
  const key = (h) => h.text.trim().toLowerCase();
  const counts = new Map();
  for (const h of heads) counts.set(key(h), (counts.get(key(h)) || 0) + 1);
  const seen = new Map();
  const out = new Map();
  for (const h of heads) {
    const k = key(h);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    out.set(h, counts.get(k) > 1 ? n : null);
  }
  return out;
}

/**
 * The outline: what an agent gets instead of a body it may not spend.
 *
 * Every line carries the command that fetches it. This is the file's reason for
 * existing, so it is not conditional, not abbreviated for wide pages, and not
 * dropped when the list is long — a long list is exactly when guessing gets
 * expensive.
 *
 * Sizes are printed because the next decision an agent makes is which sections
 * to spend on, and it cannot make that decision without them.
 */
export function outlineBlock(title, text, heads) {
  const out = [];
  // The H1 is the page's own title, not a section inside it. Listing it offers
  // a --section that spans the entire page -- an "open this part" command that
  // returns the whole thing, which is the guard defeating itself.
  //
  // It is dropped from what gets LISTED, never from what gets measured: section
  // bounds are computed against the full heading list, because a section that
  // ends at an H1 must still end there and not run to the foot of the file.
  const nth = nthFor(heads);
  for (const h of heads) {
    if (h.level <= 1) continue; // counted by nthFor, deliberately not listed
    const size = sliceSection(text, heads, h).length;
    const indent = '  '.repeat(Math.max(0, h.level - 1));
    out.push(`${indent}${h.text}   [${size} chars]`);
    out.push(`${indent}  ${sectionCmd(title, h.text, nth.get(h))}`);
  }
  return out;
}

