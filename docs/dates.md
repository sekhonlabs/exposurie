# Dates in the brain

`exposurie dates` queries explicit, sourced events in the curated wiki. Page
`created` and `updated` dates are available separately. It never guesses an
event's date from an import date, file path or date mentioned in ordinary prose.

```sh
exposurie dates --on 2026-06-01
exposurie dates --from 2026-05 --to 2026-06 --search parser
exposurie dates --on 2026-06 --field updated --json
exposurie dates --field all --order asc --limit 50 --offset 0 --json
```

The default field is `events`; `created`, `updated` and `all` label metadata
separately. `--on` accepts a year, month or day. `--from` and `--to` define an
inclusive interval; do not combine them with `--on`. Filtering uses overlap:
an event known only to have happened in June matches a June day without claiming
the exact day is known. Precision is retained in every result.

Ordering defaults to newest first, then path and line for stable ties. The
default limit is 50, maximum 500; `--offset` continues the result set. Topic
search matches title and summary as literal, case-insensitive text.

## Record events

Add meaningful dates to their canonical subject page:

```markdown
## Dated events

- 2026-06-01 | decision | Chose a streaming parser. | [[Parser Evidence#Decision]]
- 2026-06-10..2026-06-15 | planned | Planned release window; completion unverified. | [[Release Plan]]
- 2026-05 | milestone | Prototype reported complete; exact day unknown. | [[Prototype Evidence]]
```

Each event is one line: date, kind, summary and one existing wiki source link,
separated by ` | `. Supported kinds are `event`, `decision`, `milestone`,
`deadline`, `planned` and `correction`. Use `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or
`start..end`. Sources can name an existing heading and use wiki aliases.
Ambiguous page titles, missing headings, malformed entries and impossible
calendar dates produce warnings; they are excluded from results.

Keep plans and reported results qualified. Preserve dated corrections rather
than erasing the earlier claim. Convert relative dates using the user's context
and timezone before writing. A calendar day does not imply midnight UTC. If a
date is unknown, keep that uncertainty in prose.

Only entries under `## Dated events` count. Fenced examples, HTML comments and
other sections cannot introduce events or source headings. Metadata lookup
reads front matter, including quoted dates, independently of event lookup.

## Coverage and output

`--json` returns `operation`, `readOnly`, the selected field/range/order,
`pages`, `total`, `limit`, `offset`, `coverage`, `items`, `warnings` and `exit`.
Items include the original date text/precision, page path, title, line, kind,
summary and source. `coverage.events` and `coverage.pagesWithEvents` describe
structured coverage before filtering. Empty results can mean incomplete
coverage; search and read source pages before concluding nothing happened.

The query library reads configured curated categories without writing pages,
advancing conversation checkpoints or reading archives. It honours renamed
and nested categories, rejects escaped/protected paths and skips nested
symlinks. An explicitly configured source policy must exist as a regular file.

The local CLI and remote MCP tool use the same pure query engine. There is no
second date index to become stale. If the optional cloud mirror is configured,
a CLI miss can run one mirror refresh and repeat the local query. This may
replicate existing curated files; it never ingests new conversations. See
[cloud setup](cloud.md).
