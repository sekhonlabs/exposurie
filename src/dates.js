// `exposurie dates`, at the disk: the pages `read` sees, as text, handed to the
// engine in dates-core.js.
//
// The page list is allPages(), the librarian's own, and nothing else. An
// earlier draft walked the brain with rules of its own, and they disagreed with
// read's at once: a category folder named `history` made `dates` refuse a brain
// that `read` opened fine, and pages under a subfolder named `raw` vanished
// from one and not the other. Two lists of pages are two answers to "what is in
// this brain", and the one that differs is always the one nobody checked.

import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { readSeam } from './vault.js';
import { allPages } from './read.js';
import { queryDatePages } from './dates-core.js';

/** Dated events and page dates in one brain. Reads its pages; writes nothing. */
export function queryDates(vault, options = {}) {
  const pages = [];
  const unreadable = [];
  const seen = new Set();
  for (const p of allPages(vault, readSeam(vault))) {
    // Two categories can name the same folder. A page met twice would be its
    // own namesake — an ambiguous source — and every event on it doubled.
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    // Forward slashes everywhere, so a path in an answer is the same string on
    // Windows as on the machine the brain is synced to.
    const path = relative(vault, p.path).split(sep).join('/');
    try {
      pages.push({ title: p.title, path, content: readFileSync(p.path, 'utf8') });
    } catch (e) {
      unreadable.push({ path, line: null, code: 'unreadable', message: `Cannot read this page (${e.code || e.message})` });
    }
  }
  const result = queryDatePages(pages, options);
  return { ...result, vault, warnings: [...unreadable, ...result.warnings] };
}
