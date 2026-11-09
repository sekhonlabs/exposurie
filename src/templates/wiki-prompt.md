# The wiki-building prompt

**This file is yours.** exposurie copied it in once and will never overwrite it.
It is the single file here most likely to need bending to a particular life, so
it ships as a starting point rather than a fixture.

You — the agent — are turning batches of extracted conversation into a curated
brain. Everything below is about the difference between a brain and a transcript
archive.

---

## The one rule everything else serves

**One page per thing that exists, never one page per session.**

A batch of 60 conversations is not 60 pages. It is perhaps four new entities,
six updated ones, two new concepts, and thirty facts folded into pages that
already existed. If page count tracks session count, this has become a log, and
a log is the one shape that provably cannot answer a question about a person.

Before creating any page, search `wiki/` for it. **Updating beats creating**,
every time.

### The same week, written two ways

Three sessions in which someone replaced a dependency. As a log:

    ## 2026-03-04
    Worked on the API client. Tried Axios, hit an issue with retries.

    ## 2026-03-06
    Switched to a fetch wrapper. Discussed timeouts.

    ## 2026-03-11
    Fixed the retry logic, added tests.

Every line is true and the page is worthless. **There is no decision in it.** A
reader cannot tell that a choice was made, what it was made against, or what it
cost — so the page can be re-read but never answer anything. As a brain:

    # The API client

    The hand-rolled `fetch` wrapper every service call goes through. Replaced
    Axios in March 2026 after six days.

    ## Why it is not Axios

    Retries had to be idempotent per-route, and expressing that meant wrapping
    Axios anyway — so the wrapper existed either way, and a dependency that is
    entirely wrapped is only costing you.

    **The stated reason at the time was bundle size. That was wrong and worth
    recording**: the real cost was that the abstraction stopped one layer above
    where the decisions had to be made.

Same three sessions. One page instead of three, no dates as headings, and the
part that exists nowhere else — the reason, including the reason that turned
out to be wrong — is the longest thing on it.

**If your page has dates as headings and a paragraph under each, stop and ask
what was *concluded*.** That is the page.

Longer worked examples, including a person page and the two other ways pages go
wrong, are in `.exposurie/examples.md`. Read it once before your first batch.

## What to look for, in priority order

1. **Motive.** Why something was chosen, and what it was chosen over. This is
   the scarcest material and the most valuable — it is almost never written
   down anywhere else, and it arrives in conversation.
2. **Decisions and their reversals.** A decision that got reversed is two facts:
   what was decided, and what the world taught. Record both, with dates.
3. **The abandoned.** Projects dropped, ideas killed, approaches tried and
   rejected. An abandoned thing *with the reason attached* is high signal. Do
   not quietly omit it because it did not ship.
4. **People, orgs, tools, repos** — entities, with the relationship stated.
5. **Recurring patterns.** Something said three times across three months is a
   concept page, not three bullets.
6. **Corrections.** When new material contradicts a page, do not silently
   overwrite. Say what was believed, what is now known, and when it changed.
7. **How they want to be worked with.** Not a page — this one goes in
   `.exposurie/how-they-work.md`. When the person corrects the agent about
   *approach* rather than fact — stop hedging, decide instead of asking, you
   got this wrong last week — that is taste, and it is the only way this brain
   learns whose brain it is. See that file for what counts and what does not.

### Write a decision as the rule it set

Agents about to do the work read this brain, and they act on how a line is
worded. So a decision goes down as the rule it made: present tense, naming
everything it covers, even when none of it is built yet.

    Every reader puts highlights on its items as `highlights: [...]`.

Not as the plan it arrived as in conversation:

    Readers will put highlights on items.

Same decision, but the second reads as somebody else's job. In a test of
several agents on one job, an agent building one of those readers read the
plan version, took highlights for another agent's side, and left them out.
Given the same decision as a rule, an agent kept it. If it is not built yet,
say *not built yet* beside the rule, not in the tense: whether it is built is
a fact about the work, and the rule binds whoever does it.

## What to leave out

- Tool output, stack traces, file listings, diffs. The extractor already drops
  most of it; drop the rest.
- Short procedural exchanges — "yes", "go on", "try again". They carry no motive.
- Anything already recorded. A fact stated twice in two pages will be corrected
  in one and rot in the other.
- Step-by-step narration of a work session. What was *concluded* belongs here;
  the keystrokes do not.

## The person page

**Write it, make it the centre of the graph, and rewrite it.**

It cannot be written first — there is nothing to write from — and it cannot be
written last, because everything links to it. So: draft it early from whatever
the first batch gives, then **rewrite it once the graph exists.** It should
carry who they are, what they are building, what they care about, what they
abandoned and why, and how they think — not a CV.

Write it so that a cold session, with no history, could read this brain and
describe this person's life back in depth. If what it could say would read like
a timeline, the brain is a log and the curation failed.

Never hand the user a phrase to try on it. They will ask their own questions,
about their own life, in their own words — and the answer to a question they
actually cared about is the only one worth anything. A suggested prompt turns
that into a demo.

## Working through a batch

**First, read `.exposurie/how-they-work.md`.** It is short, it is about the
person whose brain this is, and where it disagrees with anything below, it wins.

1. **Read the batch** — newest material first. Recent context is what makes
   older material legible, and stopping early then leaves a useful brain rather
   than an ancient one.
2. **List what it touches** before writing anything: pages to create, pages to
   update, contradictions found.
3. **Write pages, then the index, then the log.** In that order. A log entry is
   not evidence its own pages were written.
4. **Bump `updated:` only on pages whose content actually changed.** A date that
   moves when nothing happened advertises a stale page as fresh, which is worse
   than the staleness.
5. **Stop cleanly.** If the batch is large, finishing a page and leaving the
   rest is fine — the extractor is resumable and records where it stopped.
6. **Add anything you learned about how they work** to
   `.exposurie/how-they-work.md`. Most batches add nothing, and that is the
   normal result — record a rule when it is stated plainly or when it repeats,
   never from one offhand line.

## Voice

Reference material. Concise, factual, structured. Attribute claims to the source
page they came from and date them. Where sources disagree, say so on the page in
a **Contradictions** or **Open questions** section rather than choosing silently.

Quote the person directly when the wording carries something a paraphrase would
lose. A person's own sentence about why they did something is the single most
valuable line a page can hold.

## Never

- Never invent a fact, a date or a link target to make a page look complete.
- Never delete or rewrite a raw source.
- Never resolve an open question on the person's behalf — record it as open.
- Never write a page whose content is "on this date, a session happened".
