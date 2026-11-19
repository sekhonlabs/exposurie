# This brain — schema

This folder is an external memory built and maintained by a coding agent. If you
are an agent reading this: **you write and maintain the wiki layer.** Read this
file fully before touching anything in here.

**This file is yours.** exposurie copied it in once and will never overwrite it.
Change it when the shape of your life stops fitting the shape below — a
researcher's brain and a founder's brain want different page types, and that is
expected rather than a problem.

## The three layers

1. **Raw sources** — `raw/`. Whatever was dropped in: articles, papers,
   transcripts, exports, clippings. **Immutable. Read them, never edit, rename
   or delete them.**
2. **The wiki** — `wiki/`, plus `index.md` and `log.md`. The agent owns this
   layer entirely: create, update, cross-reference, keep consistent.
3. **The schema** — this file, plus the procedure files under `.exposurie/`.
   Owned by the person whose brain this is. Note changes in the log.

## Layout

```
<brain>/
├── CLAUDE.md          ← this schema
├── AGENTS.md          ← pointer here, for agents that read that name instead
├── index.md           ← content catalog (the agent maintains)
├── log.md             ← append-only activity log (the agent maintains)
├── raw/               ← immutable sources
├── wiki/
│   ├── sources/       ← one page per ingested source
│   ├── entities/      ← people, orgs, products, tools, places, repos
│   ├── concepts/      ← ideas, topics, themes, techniques, decisions
│   └── syntheses/     ← comparisons, analyses, answers worth keeping
└── .exposurie/        ← procedure and config. Yours to edit; see config.json.
```

The four categories are deliberately few, and they survive a widening of scope:
a service is an entity, an architecture decision is a concept, a pull request is
a source. If a fifth category is genuinely needed, add it — and add it to
`.exposurie/config.json` in the same edit, or search stops seeing it.

## Page conventions

- **Filenames:** natural language, Title Case, so links read cleanly in prose —
  `Rate Limiting.md`, not `rate-limiting.md`. Source pages mirror the source's
  title.
- **Links:** `[[Page Name]]`. Link liberally; the graph is how a person sees the
  shape of what they know. When citing a raw source, link its wiki source page,
  not the raw file.
- **Frontmatter on every wiki page:**

```yaml
---
type: source | entity | concept | synthesis
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---
```

  Source pages also get `source_file:` and `source_kind: article | paper | video
  | podcast | transcript | chat | note | other`.

- **Voice:** reference material — concise, factual, structured. Attribute claims
  to their source page. When two sources disagree, say so in a short
  **Contradictions** or **Open questions** section rather than silently picking
  a side.
- **Absolute dates always.** "Last week" is meaningless to a page read in a
  year. Convert on the way in.
- **Dated events:** when a source dates something that happened, was decided
  or is planned, add a line under `## Dated events` on the page it is about:
  `- 2026-06-01 | decision | What happened. | [[Source Page#Section]]`. Date:
  `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `start..end`. Kind: event, decision,
  milestone, deadline, planned or correction. The linked page and heading must
  exist; `exposurie dates` names any line it skips.
- **One page is one thing.** Split a page when it has stopped being one subject
  — never because it crossed a line count. There is no length limit here on
  purpose: what matters is that every point of the brain can still be reached,
  and a long page whose every section opens in one command is fine. Retrieval
  returns sections, not just pages.

## What belongs in here

**A curated library, not a dump.** But curation sorts **signal from noise, never
the personal from the impersonal.**

- "Dump" means unfiltered logging: whole transcripts pasted in, the same fact
  recorded twice, volume for its own sake, one page per session.
- **Motive is the highest-signal material this can hold.** The reason behind a
  decision outranks the decision. So does the road not taken — an abandoned idea
  with its reason attached is worth more than a shipped one without.
- **Never decline something on the grounds that it is personal.** That material
  is systematically under-collected, because it arrives in conversation rather
  than in files, and it is the part that makes this a brain rather than an
  archive.

Curation is not an aesthetic preference. **A page that logs is a page nothing
can retrieve from** — retrieval returns titles and sections, so the curation
*is* the retrieval surface.

## Operations

### Ingest (new material arrives)

1. Read the source fully.
2. Write or update a page in `wiki/sources/` — summary, key claims, notable
   quotes, links to every entity and concept it touches.
3. Create or update the affected `entities/` and `concepts/` pages. **Prefer
   updating an existing page over creating a near-duplicate — search `wiki/`
   before creating anything.** Bump `updated:`. Flag contradictions with what is
   already recorded.
4. Update `index.md` — one line per page.
5. Append a log entry.

A single ingest touching 10–15 pages is normal.

### Query (a question gets asked)

1. Read `index.md` to locate pages, then read those pages. Search `wiki/` if the
   index is not enough. Fall back to `raw/` only for detail the pages lack.
2. Answer with links to the pages used.
3. If the answer was real synthesis — a comparison, an analysis, a connection
   nobody had made — offer to file it in `wiki/syntheses/` so it compounds.

### Sync

See `.exposurie/sync.md`. It is manual on purpose: run it when asked, never on a
schedule. **It is the only command there is after setup** — extraction, folding
and curation are all stages inside it.

### Curate

See `.exposurie/curate.md`. Runs inside every sync, from the first batch onward.
The tool does the graph half — dead links, index drift, stale dates, orphans,
unreachable sections — and applies only the two fixes that cannot lose anything.
The half that needs a reader is yours: contradictions, superseded claims, and
concepts named on several pages that have no page of their own.

## index.md

The catalog, by category. One line per page: link, one-line description, date.
Update whenever a page is created, renamed or deleted. **This is the retrieval
mechanism — an index that has drifted is worse than none.**

## log.md

Append-only, newest at the bottom. Every entry opens with a searchable header:

```
## [YYYY-MM-DD] ingest | Source title
## [YYYY-MM-DD] query | The question
## [YYYY-MM-DD] sync | What was folded in
## [YYYY-MM-DD] schema | What convention changed
```

Body: one to four bullets — what was done, which pages were created or updated.

**A log entry is not evidence its own pages were written.** Write the pages
first, log second.
