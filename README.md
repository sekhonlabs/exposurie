# exposurie

**An external brain your coding agent builds, curates and reads for you.**

You already have a good coding agent. You are probably using a fraction of it —
thinking in a web chat, having the chat write you a prompt, pasting that into an
agent that knows nothing about you. Or dragging one session out over hundreds of
messages so it doesn't forget, until compaction eats the middle of it.

The fix is not a bigger context window. It is putting the memory **outside** the
session, so you can open a fresh one every time and lose nothing.

`exposurie` sets that up and gets out of the way:

- **A brain made of plain Markdown** — a linked wiki of who you are, what you are
  building, what you decided and why. Yours, on your disk, readable without us.
- **Built by your own agent.** No servers, no API keys, no per-user cost, nothing
  metered. The LLM work runs on the subscription you already pay for.
- **Read back on demand.** Your agent retrieves pages when it needs them instead
  of carrying everything in every session.

> **What it does today.** The whole chain — `init`, `scaffold`, `sync`, `read`.
> Create a brain, fill it from Claude Code, Codex, Cursor, your claude.ai or
> ChatGPT export and your own documents in resumable batches, and open any page
> or any section of one in a single command. Curation runs inside every sync, and
> documents dropped in `raw/` are found and handed to your agent to open. Setup
> installs **`/exposurie-sync`** into your agent, so keeping the brain current is
> a slash command you type rather than a CLI you have to remember. The repo is
> public, so if something here is wrong, an issue is the right place to say so.

## Install

**One line. Paste it into the coding agent you already have open** — Claude
Code, Codex, Cursor — and it does the rest:

```
Set up exposurie for me: run `npm install -g @sekhon/exposurie`, then run `exposurie init` and follow exactly what it prints.
```

That is the whole install. Everything after it is your agent working, because
this tool is written to be read by one — see
[The unusual part](#the-unusual-part-this-cli-talks-to-your-agent-not-to-you).

If you would rather drive it yourself, the same two things in a terminal:

```bash
npm install -g @sekhon/exposurie
exposurie init
```

`exposurie --version` confirms which release you have **and whether it is really
installed**, which is the thing that decides whether any of the below works.

Requirements: **a coding agent.** That is the whole list — Node arrives with
Claude Code. Obsidian and your chat export are steps the tool walks your agent
through, not things you need to arrive with.

**The install is a real requirement, not a preference, and `scaffold` will not
run without it.** Your brain is reached from every project through a one-line
pointer that exposurie writes into your agent's global instructions, and that
pointer names a command. So does the `/exposurie-sync` slash command it installs
alongside it. Retrieval is the whole product, so a pointer naming a command that
does not exist is the tool not working — and it fails silently: nothing errors,
the line simply never gets run.

So setup declines rather than writing something it cannot stand behind. Run
`scaffold` with nothing installed and it writes no files at all, says why, and
names the one line that fixes it. `init` reports the same thing first, before
anything is created.

## The commands

| command | what it does |
|---|---|
| `init` | reports what is on this machine, and what to do about it |
| `scaffold` | creates the brain and copies in the files that become yours |
| `sync` | stages what is new, so your agent can fold it into the brain |
| `read` | opens a page or one section of it, lists every page, or finds a thing by its words |
| `decline` | records that you said no to a pending step, so it stops asking |
| `uninstall` | removes everything exposurie put on this machine, keeping your brain |

The first five are typed by **your agent**. `uninstall` is **yours** — see
[Leaving](#leaving). Every command prints the exact next command to run, and
`exposurie help` prints the whole list with its flags.

**There is one spelling of every command, on every machine.** `exposurie sync`
is what the tool prints, what goes in the pointer, and what lands in the files
it writes into your brain and your agent — there is no second form to translate
between and nothing for you to work out. That is what the install requirement
buys, and a test enforces it: the whole product is run on a machine with nothing
installed, and it fails if a second invocation form ever reappears in anything
the tool prints or writes.

You never have to type any of them to keep the brain current. Setup installs a
slash command in your agent, so **`/exposurie-sync`** does the whole thing —
see [What it writes outside your brain](#what-it-writes-outside-your-brain).

**Exit 0 means done. Exit 10 means a step needs a person — it does not mean
anything failed.** Agents: the full output spec is
[`docs/output-contract.md`](docs/output-contract.md).

## The unusual part: this CLI talks to your agent, not to you

Nearly every command-line tool assumes a human is watching the screen. This one
assumes **a model is reading the output and a person is somewhere behind it.**

You type one line into a session you already have open. Everything after that is
your agent working, and your agent is what talks to you. So the output is a task
list written for a model to execute:

```
exposurie  no brain yet

FOR YOUR USER — 1 pending
  [claude-web-export]  claude.ai chat export
    WHY: your claude.ai chats live on Anthropic servers, not on this
    disk, and there is no API for them — only you can request them.
    ASK YOUR USER / RELAY THESE EXACTLY / DONE WHEN / IF THEY SAY NO...

STATE
  brain        not created  (will go at ~/brain)
  claude-code  125 sessions   (~/.claude)
  codex        3 sessions   (~/.codex)
  cursor       2 sessions   (~/.cursor)
  web chats    not found

DO THESE IN ORDER
  1. RUN:  exposurie scaffold --at ~/brain
      Creates the brain and copies in the schema, the page templates and the
      prompt that writes pages — those become the user's, and are never
      overwritten. Writes nothing else and reads no transcripts.
  2. ASK YOUR USER, in your own words:
      "Your brain is being built from the sessions on this machine right
      now. Your claude.ai web chats are not on here — want to grab those
      too? It takes about a minute of clicking, then a wait."
      Do NOT wait for an answer. Continue to the next step.

SCOPE
  Conversation is read directly — Claude Code, Codex and Cursor on this
  machine, plus claude.ai and ChatGPT chats from an export. Files dropped
  in raw/ are FOUND and handed to you to open... Do not invent a command
  for any of that.

EXIT 10 — there is a step for your user. Nothing has failed.
```

*Abridged — the real output spells every step out in full.*

Four consequences fall out of that, and they are the design:

**Nothing ever prompts.** When an agent runs a command there is nobody at the
keyboard. A tool that waits for input does not get input — it hangs, and the
agent looks frozen. There are no `[Y/n]` prompts anywhere in this codebase, and
a test enforces it.

**"Waiting on a person" is not a failure.** It has its own exit code, `10`, so an
agent can tell it apart from a crash instead of panicking or ignoring both.

**Human steps repeat until done, and are detected rather than marked.** The one
or two things your agent genuinely cannot do for you — mainly requesting your
claude.ai export, which needs your browser and your inbox — get re-reported at
the top of every command until the file actually appears on disk. They never
block anything.

**It never names a command it does not have.** Where the build stops, the output
says so in words. An agent that follows a plan into "no such command" has
learned the plan is not worth following, and it does not un-learn that when the
command ships — so a test greps every plan the tool can print and checks each
command against the real command table.

The full spec is in [`docs/output-contract.md`](docs/output-contract.md).

## What is yours and what is ours

An npm package sits frozen in `node_modules` and nobody edits it. That is right
for machinery and wrong for the prose describing a person's life. So setup writes
to two places with two owners:

| **ours** — in the package, we update it | **yours** — copied into your brain, yours forever |
|---|---|
| the librarian (search, page, section) | the schema |
| the extractor (reading your transcripts) | the sync procedure |
| the curator's checks, and its two safe fixes | **the wiki-building prompt** |
| the pointer, the slash command and the skill | the curation procedure, and the findings you have retired |
| the config reader | page templates, worked examples, exclude list, every page you have |

The wiki-building prompt is the closest thing here to secret sauce, and it is
deliberately yours — a researcher's brain and a founder's brain want different
page types, and locking the one file that most needs to change is the wrong
trade. It ships as a starting point, not a fixture.

It does not ship alone. Rules produce median pages, so `.exposurie/examples.md`
carries the thing itself — a worked page, a person page, and the three ways a
page goes wrong — because the difference between a brain and an archive is
taste, and taste transfers by example far better than by instruction.

**And there is a third category, which is neither ours nor copied:**
`.exposurie/how-they-work.md` is written *by your agent, about you*. Ships
nearly empty, because its content cannot ship. See below.

**"Yours" is enforced, not promised.** `scaffold` never overwrites a file that
exists. Run it again and it tops up what is missing and prints what it left
alone, so a schema you have tuned cannot be silently replaced by a command that
looks idempotent. A test pins that.

**The two halves meet at one config file**, at `<brain>/.exposurie/config.json`.
The code hardcodes nothing about your folder layout — it reads the category
names from there. So if `wiki/people` suits you better, rename the folder, say
so in that file, and search follows you. Without that seam the failure is
silent: renaming a folder would make half the brain invisible with nothing
reporting it.

## What it writes outside your brain

A pointer for your agent, and a slash command for you — plus the same procedure
as a skill, for when you ask for a sync in words instead of typing it. All of it
comes back out in a single command.

### A pointer, so your agent knows the brain is there

Your agent can only use the brain if it knows the brain exists. So setup writes
one short block into the instructions file each agent already loads at the start
of every session:

| agent | file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Cursor | `~/.cursor/rules/exposurie.mdc` |

That block is **a pointer, never content.** It says a brain exists, that it is
authoritative about you, and gives the one command for searching it. It carries
no pages and no facts of yours, because it is paid for on every message in every
project forever — so it stays small enough to earn that.

### A slash command, so you can run the sync yourself

Type **`/exposurie-sync`** and your agent brings the brain up to date. You do
not have to remember the CLI, and you do not have to explain to your agent what
syncing your brain means.

| agent | the slash command you type | the skill your agent reaches for |
|---|---|---|
| Claude Code | `~/.claude/commands/exposurie-sync.md` | `~/.claude/skills/exposurie/SKILL.md` |
| Cursor | `~/.cursor/commands/exposurie-sync.md` | `~/.cursor/skills/exposurie/SKILL.md` |
| Codex | `~/.codex/prompts/exposurie-sync.md` | — |

The skill is the same procedure, reached when you ask for a sync in words rather
than typing the command. Codex keeps prompts rather than skills, so it gets the
typed half and not that one.

**These are whole files, ours end to end.** No line of yours is in them, so you
can open either and read exactly what it will do before you ever run it — which
matters more here than in most places, because what it does is read your own
conversations. Neither one holds the procedure: both point at
`.exposurie/sync.md` **inside your brain**, which is yours and is never
overwritten. Tune that one, not these — these two are rewritten by both
`scaffold` and `sync`, because both name your brain's location and the
invocation that works on your machine, and a stale copy of either is a file that
fails by never running. That refresh is also what reaches a client you install
*after* setup, which would otherwise never get a slash command at all.

Both `skills/` directories above were observed on a real machine, with other
tools' skills already living in them. The three command locations are each
client's documented convention and were **not** — and the output says so on the
line that writes them. A wrong guess there writes a markdown file nothing reads,
which is the reason every path this tool writes to is markdown and never a
config another tool parses.

**That is everything exposurie puts anywhere outside your brain folder.**
`uninstall` takes all of it back: the pointer block comes out and leaves those
files **byte-identical**, and the files that were only ever ours are deleted
outright — see [Leaving](#leaving).

## It works out your setup and talks to that

Two people run the same command and get different instructions, because they
have different lives on their disks.

|  | it finds | it asks them for | it never mentions |
|---|---|---|---|
| **Claude Code user** | `~/.claude` transcripts | their claude.ai export | ChatGPT |
| **Codex user** | `~/.codex` rollouts | their ChatGPT export | claude.ai |
| **Cursor user** | its SQLite chat store | their ChatGPT export | claude.ai |
| **Neither** | nothing local | their claude.ai export | — |

**v1 reads three coding agents — Claude Code, Codex and Cursor — on Windows and
macOS.** Claude Code and Codex use the same paths on both. Cursor does not, and
neither does Obsidian, so those are path tables rather than assumptions.

The rule underneath: **a step that a person can never complete is worse than no
step at all.** Asking a Codex user on a Mac for a claude.ai export produces a
request that cannot resolve, so it reprints at the top of every command forever
— and teaches them the tool does not notice what they do. So every human step
declares not only how it is *detected as done* but whether it *applies to this
person at all*.

The same rule runs down to the small things. Install instructions print the one
package manager for the OS you are on, not three with a note to pick. The step
that gets you into Obsidian names the exact folder your brain is in, because the
tool knows it and you should not have to go looking.

Exports are identified by **what is inside them**, never by their name —
Anthropic's is reliably `data-*.zip` and OpenAI's is reliably nothing, so a
filename rule would miss every ChatGPT export. The trade is that a corrupt
archive matches nothing and would vanish; so a zip that *looks* like an export
and will not open is reported as broken rather than silently skipped.

**An export does not have to be a zip, and `conversations.json` does not have to
be one file.** OpenAI ships large accounts already unpacked, split across
`conversations-000.json` … `conversations-011.json`; Anthropic splits across
numbered zips; and either one, unzipped by hand, is a folder. All four shapes
are read, because a folder is opened behind the same handle a zip is. Nothing
about that is a convenience: a 1,164-conversation export sat in Downloads on the
first machine somebody else installed this on, and the tool never saw it.

## Reading a claude.ai export, and what is actually in one

A chat export is not a side channel. Measured on one real account: **264 KB of
that person's own typed words on the web, against 166 KB across every Claude
Code session on their machine.** For anyone who has not spent a year in a
terminal, it is not 1.6x — it is all of it.

Four things come out of one zip, and only the first is chat:

- `conversations.json` — the chats.
- `memories.json` — what claude.ai has already worked out about you. Prose,
  already distilled, the highest signal per byte in the archive.
- `projects/*.json` — the instructions you wrote for your own projects.
- `design_chats/*.json` — the same shape as a conversation, under another name.

The last three are **standing context**: small, about you rather than about a
moment, and read *before* the batch rather than queued behind a year of history.
Reading only `conversations.json` would leave the two most concentrated files in
the archive on the floor.

Zip reading is ours, in about 200 lines against `node:zlib`, because one
container is not worth spending the zero-dependency property on. It opens a
single entry rather than the archive, so a 16 MB `conversations.json` is the
only thing ever decompressed.

**The finding that came out of pointing it at a real export:** 66 of 93
conversations arrived with messages and not one word of text in them — no title,
no summary, nothing. The file was named `batch-0000`. Anthropic splits a large
account across numbered zips and only the first had been downloaded. Nothing
about that is an error, which is the danger: the conversations are present, the
count looks right, and a reader treating them as "nothing said" would mark four
months of someone's life as read and never look again. They are reported and
left unread instead, so a fuller export picks them up.

**ChatGPT was different, and half of it still is.** Every other reader here was
written against a real file; that one was written against OpenAI's documented
shape, because there was no ChatGPT export on the machine it was built on. So
its safety was never confidence in the parse: an archive that holds
conversations and yields no words from any of them is reported as **a bug in
exposurie**, by name, rather than as an empty account.

The parse is now proven — a real 1,164-conversation export returned 1,157
readable and 7 genuinely empty, with no parse error. **Finding** that export is
the part that is not. OpenAI delivered it already unpacked into a dated folder,
split across `conversations-000.json` through `conversations-011.json`, and it
had to be repackaged by hand before anything here could see it. The reader
works; nothing was reaching it. That is a live defect, not a caveat.

## Cursor keeps its chats in SQLite, so we read SQLite

Cursor does not write transcript files. `~/.cursor/projects/*/agent-transcripts/`
looks exactly like it should hold them and is **empty**. It is a directory that
exists and stays unwritten, so counting it tells you nothing about whether a
person has any chats — which is exactly the trap it looks like.

The conversations are in `state.vscdb`, in a key/value table: `composerData:<id>`
for the conversation and its message *order*, `bubbleId:<composer>:<id>` for each
message. Everything else in a message is tool work — measured on a real
database, 443 messages held 103 with any text and 31 from the person.

So there is a SQLite reader here, in about 300 lines against no dependencies. It
is read-only and understands exactly enough to walk one table: the header, the
`sqlite_master` b-tree, table pages, the record format, **overflow chains** —
a conversation blob does not fit in one page, and ignoring the chain returns
truncated JSON that fails to parse and looks like a corrupt database rather than
like our bug — and the **write-ahead log**, because Cursor is usually running
and its newest conversations have not reached the main file yet.

Shelling out to a `sqlite3` binary would have been shorter and would have failed
on every machine without one, silently reporting that the person has no Cursor
history.

## Documents: it finds them, your agent opens them

`scaffold` creates a `raw/` folder. Put anything in it — a lease, lecture notes,
a contract, a PDF someone sent you — and the next sync finds it and hands it to
your agent to read.

**exposurie never parses a document and never inlines one.** That sounds like a
missing feature and is the opposite: "ingest PDFs with no dependencies" is a
hard problem, and it is *not this problem*. Your agent opens files natively —
Claude Code, Codex and Cursor all do. So the deterministic half is only ever
*notice what is new → gate it → point at it*, the same division as everywhere
else here. One rule, no size threshold to get wrong, and the model reads the
real bytes rather than our idea of them.

What follows from that:

- **The gate runs before anything is opened.** `excludeFiles` in your config
  matches anything in `raw/`, and a directory carrying its own `.git` is
  somebody's project rather than a page of a brain — deterministic, no
  configuration needed. Both had shipped already and were wired to nothing.
- **What is withheld is named.** Excluded files, and things nothing can read at
  all — archives, executables, video — are listed with the reason. A person who
  put a file in their brain should be told it was left alone, not left to assume
  it landed.
- **Files alone are a batch.** Somebody whose brain is entirely documents gets a
  sync that stages them, rather than "nothing has changed since the last sync"
  while the folder fills up.
- **A changed file comes back.** A document is not append-only, so there is no
  offset to resume from; size and modification time are what say "this exact file
  was already handed over".

## What sync actually reads

A transcript is mostly not conversation. Measured across a real 128 MB corpus of
127 Claude Code sessions: tool results, tool calls, attachments, file snapshots
and thinking are about 99% of the bytes. What a person and their agent actually **said** to
each other is around 1%. Dropping the rest is an **84× reduction that costs
nothing**, because none of it carries motive — and motive is the whole reason a
brain is worth having.

**The same doctrine, twice over.** Codex writes a completely different format
and had been listed as readable with no reader of its own: the Claude Code
parser was handed its rollouts, returned zero turns from every one, and the sync
marked them read. The session count was right the whole time. The reader now
lives *in* the client table, so "readable" and "there is a function that reads
it" are one statement — and a test holds them together.

The filter that matters most is not the obvious one. Text arrives wearing a
`user` role that no person typed — injected context, environment blocks, hook
output, slash-command echoes, tool results, subagent chatter — and on that same
corpus it outweighed the human's own words **nine to one**. A reader that trusts
`role: "user"` builds someone a brain mostly out of directory listings, and it
looks like it is working the entire time.

Three more things sync does because a first run happens before anyone has a
reason to trust it:

- **Whole sessions, newest first, up to a size budget — and it loops until the
  backlog is empty.** The budget sizes a batch to your *agent's context*, not to
  your history: nothing is truncated, it is *ordered*, and what did not fit is
  reported and comes next. Every batch hands back the command for the following
  one as a numbered step, and says not to stop and ask. The first sync reads all
  of it, which is the point of installing this — depth is the product, so the
  cost is disclosed rather than avoided.
- **Exclusion is a gate, not a cleanup.** Anything on your exclude list is never
  opened past the few KB needed to see which folder it belongs to. Filtering
  after the read is an apology, not a control.
- **The cutoff moves last, and on evidence.** `sync --done` refuses to advance
  if nothing in the brain changed, because that means the pages were not
  written. An interrupted sync re-stages its material rather than losing it.

Anything shaped like an API key is removed on the way in, and the count is
reported — a silent redaction is indistinguishable from a bug that ate a
paragraph.

## Your coding agent is deleting your history right now

Claude Code removes its own transcripts after **30 days** by default
(`cleanupPeriodDays`). That happens whether or not you install this, and it is
not a small amount: measured on the machine exposurie was built on, 164
transcripts existed and **not one was older than 29 days** — sessions from six
weeks earlier were simply gone.

So the honest version of what this tool does is not "it reads your whole
history." It is: **it is the only thing standing between your history and a
rolling deletion.**

The first run captures whatever still exists. To stop losing the rest, exposurie
asks — through your agent — whether it may set one key in your Claude Code
settings:

    "cleanupPeriodDays": 3650

Ten years instead of thirty days. exposurie does **not** write that file itself.
It is machine-parsed and belongs to another tool: corrupt it and Claude Code
stops reading its own settings, with us the last to have touched it. Your agent
makes the edit, after you say yes, and tells you it did.

It is asked rather than assumed because it changes how software we do not own
behaves on your disk. That is the one class of decision this tool will not make
for you.

## Nothing is sent anywhere, so the brain watches itself

exposurie has no telemetry, no endpoint, and no network code. Not "off by
default" — there is nothing in the package that could phone home, which is the
only version of that claim you can verify in one grep.

That leaves a real problem: if a brain turns into a pile of session logs, we
never find out. So the check runs where the brain is, and reports to the only
party who can judge it.

Every sync, the curator asks whether the brain has taken the **shape** of a log —
pages written as diaries, page count tracking session count, a graph with no
centre. It cannot tell you a page is good; nothing can. It can catch the failure
that otherwise arrives silent, and hand it to your agent to fix and tell you
about.

It never fixes those itself, and it is calibrated to be quiet: measured against a
carefully built 67-page brain, it reports one page — a timeline that is meant to
be a timeline — and that one is retirable.

## How the brain learns whose brain it is

A shipped prompt is somebody else's taste. It can say what is generally worth
recording; it cannot know what *you* consider signal, how you want to be written
to, or which of its defaults you would throw out.

Normally a brain learns that slowly — you read a bad page and say so. That takes
months and most people never do it.

**But you have been correcting an agent all along.** Stop hedging. Just pick one.
You got this wrong last week. Those corrections are taste, and they are already
in the transcripts this brain is built from. So the agent collects them into
`.exposurie/how-they-work.md` as it reads, and reads that file back before
writing pages and before curating — where it disagrees with the shipped prompt,
**your file wins.**

Two things it cannot overrule, because they are what make a brain trustworthy
rather than agreeable: it never invents a fact to satisfy a preference, and it
never deletes material because a preference makes it inconvenient.

A factual correction is not taste. "Wrong file", "that was renamed" — those are
facts, and they belong in the pages. The test is whether it would change how
*any* page is written.

## One command, and curation rides inside it

After setup there is **one command you ever type** — `/exposurie-sync`, in the
agent you already have open, not in a terminal. Everything that makes the brain
better is a stage of it rather than a sibling to it, and curation runs from the
very first batch — a brain that only gets curated once the mess exists is a
brain where the mess got there first.

The tool does the half a machine can decide: dead links, index drift, dates that
lie about freshness, pages nothing links to, sections the librarian cannot open.
It applies exactly two fixes without asking, both provably additive — bumping an
`updated:` date git proves is wrong, and wrapping a first plain mention in
`[[ ]]`. **It never deletes anything and never proposes deleting anything.**
Curation here means sorting signal from noise so the brain is *fetched* better,
never holding less.

Everything else is reported, because everything else needs a judgement: whether
a dead link wants a new page or a corrected spelling, what an index line should
say, where a long page should be cut. Two pages that disagree, a claim a newer
session superseded, a concept named on five pages that has none of its own — that
half is a procedure file in your brain, so you can change it.

Two things it deliberately does not do:

- **It has no page-size limit.** Length was always a proxy. What is actually
  checked is whether every point of the brain can still be *reached* — and the
  outline of a long page carries the exact command that opens each section, so a
  long page is fine. Size is reported as a number, never as a finding.
- **It lets a finding be retired.** Some findings are true and still correct to
  leave alone: a page title that is also an ordinary English word gets written
  in prose constantly, and linking it would draw an edge between unrelated
  things. Reported forever, those put a floor under the count — and a report
  that can never reach zero is a report nobody reads. The tool prints the exact
  line that retires one, and always prints how many are retired.

## Reading it back: words, not phrases

A brain is only as good as what your agent can find in it, so `read --search`
is built for the way agents actually search: a handful of keywords.

- **Words, in any order.** `dead letter replay deliveries cleanup` finds the page
  that holds those words, wherever they sit on it. Pages holding every word come
  first; a rare word counts for more than a common one, a word in the title for
  more than one in passing, and a long page does not win just by being long.
- **Any form of a word.** `sheets` finds "a member Google Sheet", `naming` finds
  "name", `organization` finds "organisation". Accents are ignored both ways.
- **Whole words.** `LOR` finds letters of recommendation, not "explorer".
- **The answer, not a pointer to it.** The best few pages come back as the brain
  wrote them — a short page whole, a long one as the section that matched, with
  the command for the rest. Everything else is listed with its command and marked
  unread, so nothing printed can pass for something that was not.
- **Honest about gaps.** Every result says which of your words it has and which
  it lacks. A search that finds nothing says what to try next — other words, or
  `exposurie read` on its own, which lists every page by title — before it says
  the brain does not have it.

**Why it changed.** Through 1.2.0 a search was one substring match of the whole
query. Replayed against the [public benchmark](https://github.com/sekhonlabs/exposurie-bench)'s
brains, 20 of the 61 searches agents actually ran came back empty — nearly all
of them because they were several words. In its long task, a fresh session after
a sync searched three times, got nothing three times, and went on without rules
its brain held on a page titled with the words it had searched for. The same 61
searches now come back empty 6 times, each one a question the brain was never
told the answer to.

## Platforms and clients

**Windows and macOS.** Claude Code, Codex and Cursor on both. claude.ai and
ChatGPT exports are platform-independent, and Obsidian is detected wherever it
is installed.

Every path this reads — each client's transcript store, Obsidian's vault
location — is a table read off a real machine rather than a guess, and both
platforms' branches are covered by the test suite.

## Privacy

Your brain is **local files on your disk.** Nothing is uploaded, there is no
account, and there is no server to send anything to.

What is written outside your brain folder is a short pointer block in each
agent's own instructions file, plus a slash command and a skill — none of which
carry any content of yours, and all of which `uninstall` removes. See
[What it writes outside your brain](#what-it-writes-outside-your-brain).

`exposurie` never creates a backup remote for you. It runs `git init` on your
brain so you get local history and undo, warns you that it lives on one disk, and
will push to a remote **you** configured. Creating that remote is a decision with
one irreversible failure mode — a visibility flag wrong once and every
conversation you have ever had with an AI is public — so it stays yours to make.

## Leaving

One command, and you can type it yourself — no agent involved:

```bash
exposurie uninstall
```

That is the whole command — one line, the same on every machine, and it finishes
the job rather than handing you a second one. This is the only command in the
product a person types with no agent watching, so it is the one place a name
that does not resolve would have nobody to notice it, and the one place a
half-finished job would have nobody to spot it.

It removes the pointer from every client it was written into, and deletes the
slash command and the skill. Your own instructions files come back
**byte-identical** — the block goes, the blank line above it goes, and a file
that only ever held our block is deleted rather than left empty. The command
and the skill were whole files of ours, so they go outright, along with the
`skills/exposurie/` folder we made for one of them. Your own commands, and the
`commands/` folder they live in, are not touched.

**It does not touch your brain, and no flag makes it.** Those are your pages,
in plain Markdown, in a git repo with its own history — they open in Obsidian,
in any editor, in anything that reads text, with this tool gone and forever
after. If you want them gone, delete the folder yourself. A tool that can erase
the thing it spent months building for you is not one you should have trusted
with it.

**The package goes too, in the same command.** `uninstall` removes what we wrote
into your agent *and* takes the package off your PATH, so there is nothing left
named exposurie and no second line to remember. It says which of those it did.

It removes the package only when npm installed it and only when that is the copy
you just ran — so a linked checkout, or a copy you put on your PATH yourself, is
reported and left alone rather than guessed at. In that one case it prints the
line for you, because being told a thing is gone when it is not is worse than
being handed a command.

Changed your mind later? Run `scaffold` again and it picks up exactly where you
left off — what has been synced is recorded inside the brain, not in the tool.

## Development

Source: **[github.com/sekhonlabs/exposurie](https://github.com/sekhonlabs/exposurie)**

```bash
git clone https://github.com/sekhonlabs/exposurie.git
cd exposurie
npm test
```

Zero runtime dependencies. Node 20+.

Some of these enforce rules rather than check behaviour, and each was verified
by breaking the thing it guards and watching it fail:

- a document is pointed at, never parsed and never inlined
- an excluded file is named but never opened
- every client that claims to be readable has a reader behind it
- the macOS branch of every path table resolves, exercised from Windows
- a macOS project path survives conversion out of Cursor with its leading slash
- the shipped executable has a unix shebang
- nothing in the shipped source can read stdin
- no personal data, private path or private tooling in any file in the repo
- `scaffold` cannot overwrite a file you have edited
- no output can name a command the tool does not have — printed on your screen
  or written into your agent as a skill or a slash command
- **no file is ever written naming a command your machine does not have** —
  setup refuses instead. The whole product is run on a PATH with nothing
  installed, and `scaffold` has to decline there, write nothing, and name the
  one line that fixes it
- **no printed command names a path with a space in it unquoted** — every
  command is run on a home directory whose name contains one, and every `RUN:`
  line it prints is checked. The printed `scaffold` line is then split the way a
  shell splits it and executed, and the brain has to land where the line said
- `--json` never answers with prose — a caller that asked for JSON gets JSON
  from every command, including the ones with nothing structured to say
- `uninstall` never removes a directory it did not create
- no two always-loaded surfaces spend your context budget on the same job
- text that only looks like something you typed never reaches your brain
- an excluded conversation is never opened, not merely dropped afterwards
- the sync cutoff moves on evidence that pages exist, never on a claim

## License

MIT — see [LICENSE](LICENSE).

*exposurie by sekhon*
