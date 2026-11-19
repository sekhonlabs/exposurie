# Dates in the brain

`exposurie dates` answers "what happened when" from events your agent records
on purpose, each with its source. A page's `created` and `updated` dates are
available too, labelled as what they are: when the page was written, which is
usually the day of a sync, not when anything in it happened. Nothing is ever
guessed from an import date, a file name or a date mentioned in passing.

```sh
exposurie dates --on 2026-06-01
exposurie dates --from 2026-05 --to 2026-06 --search "parser"
exposurie dates --on 2026-06 --field updated --json
exposurie dates --field all --order asc --limit 50 --offset 50
```

`--on` takes a year, a month or a day. `--from` and `--to` set an inclusive
span and cannot be combined with `--on`. Matching is by overlap, so an event
known only to have happened in June matches a June day without claiming the
exact day is known; every result keeps the precision it was written with.

`--field` picks `events` (the default), `created`, `updated` or `all`. Results
come newest first (`--order asc` for oldest first), then by page and line, so
ties are stable. `--limit` is 50 by default and at most 500; when there are
more, the output prints the command for the next page.

`--search` takes words, in any order and any form, the way `read --search`
does: `parser streaming` and `streaming parsers` both find "Chose a streaming
parser". An event matches when its page title and summary hold every word.

## Recording events

On the page an event is about:

```markdown
## Dated events

- 2026-06-01 | decision | Chose a streaming parser. | [[Parser Evidence#Decision]]
- 2026-06-10..2026-06-15 | planned | Release window; completion unverified. | [[Release Plan]]
- 2026-05 | milestone | Prototype reported complete; exact day unknown. | [[Prototype Evidence]]
```

One line per event: date, kind, summary and one wiki link to its source,
separated by ` | `. Bullets may be `-`, `*` or `+`. A bullet indented under an
event is a note about it and is not read, unless it is written as an event.

- **Date:** `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or `start..end` built from those.
  It has to exist on a calendar.
- **Kind:** `event`, `decision`, `milestone`, `deadline`, `planned` or
  `correction`.
- **Source:** a page that exists, and a heading on it if one is named. It is
  checked by the rules `read` uses, so `[[Lang#C#]]` counts exactly when
  `exposurie read "Lang" --section "C#"` opens that section — and the command
  printed for every event is that one. A link an alias follows (`|text`) is
  fine. A title two pages share, or a heading two sections answer to, is not a
  source, because the command for it could open the wrong one.

A line that breaks any of these is left out and named, with its page and line,
so it can be fixed. Text output names the first few; `--json` lists them all.

Keep plans and reported outcomes qualified, keep a dated correction rather
than erasing the claim it corrects, and convert relative dates before writing.
If the day is unknown, write the month or the year.

Only lines under `## Dated events` count. An event inside a fenced code block
is an example, and one inside an HTML comment has been switched off; neither
counts. Page dates are read from front matter, quoted or not.

## What it reads, and what comes back

`dates` reads exactly the pages `read` does — every Markdown file under the
categories in `.exposurie/config.json`, renamed or nested — and writes nothing.
There is no date index to go stale: the pages are read on each call.

Text output gives each event with the command that opens its source and the
command that opens its page, and says how much of the brain is dated at all.
An empty answer says so and names a search to run next, because a brain that
dated nothing for June is not a brain that says nothing happened in June.

`--json` returns `operation`, `readOnly`, the `field`, `from`, `to`, `order`
and `search` asked for, `searchWords`, `pages`, `total`, `limit`, `offset`,
`coverage`, `items`, every one of the `warnings`, the `vault` and `exit`. Each
item carries its date as written (`dateText`, `date`, `dateEnd`, `precision`),
the page's `title`, `path` and `line`, and for an event its `kind`, `summary`,
`source`, and the `sourceTitle` and `sourceSection` that link resolved to.
`coverage` counts events across the whole brain, before any filter.
