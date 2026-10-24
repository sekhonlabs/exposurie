# The output contract

Every byte this tool prints is written for a **model** to act on, with a person
somewhere behind it. That single fact decides the whole format.

Nearly every CLI on npm assumes a human is watching the screen. This one assumes
a model is reading the output and a person is somewhere behind it. The chain is
always **tool -> agent -> human**, never tool -> human.

Everything else in the product is built against this document.

---

## The four rules

### 1. Nothing ever prompts

When an agent runs a command there is **nobody at the keyboard**. A tool that
waits for stdin does not get stdin — it hangs, and the agent looks frozen with
no error to report.

So the product has no prompts, no `[Y/n]`, no confirmations, no spinners waiting
on a keypress. Input needed from a person is *requested* through a pending step
and the process **exits immediately**.

> Enforced by test, not by convention: `contract.test.js` greps all shipped
> source for `readline`, `process.stdin`, `prompt(`, `inquirer`. Adding one
> fails the suite.

### 2. Every actionable line opens with a verb in caps

`RUN:` · `ASK YOUR USER:` · `TELL YOUR USER:` · `READ:` · `WRITE THE PAGES.`

An instruction buried in prose is an instruction skipped. The keyword is the
signal that this line is for *doing*, not for reading.

### 3. Print the command, never the concept

Not "open the page" — the exact argv that opens it. A wikilink is a human
convention; a command is a thing the agent can execute. If output mentions
something the agent might want next, it carries the literal invocation.

### 3b. Never print a command the tool does not have

A corollary of rule 3, and it needed its own line because it was broken first.
`init` printed `RUN: exposurie scaffold` while no such command existed, so an
agent following the plan hit "no such command" and had nothing to do with that.

**An agent taught once that the plan is not to be trusted does not un-learn it
when the command ships.** So the command table lives in one place —
`src/commands/registry.js` — the dispatcher and the help text both read it, and
a test greps every plan the tool can print and asserts each named command is in
it. Where the build genuinely stops, output says so in words instead of naming
a command that would fail.

### 3c. There is one command name, and setup refuses until it exists

The sibling of 3b, and the one that has been broken three times.

`exposurie sync` is the right thing to print on a machine where the package is
installed and **the wrong thing everywhere else** — with nothing on PATH the
line names nothing and fails by never running. A correct command for the wrong
machine is indistinguishable, on the page, from a correct one.

There were two possible answers, and the product has now given both. Until
2026-08-29 it carried a **second, longer invocation** and printed whichever one
resolved. That guaranteed the line ran; it did not guarantee the line was worth
running, since every lookup then paid a package resolve — and a retrieval that
is slow is a retrieval that stops being tried, which is the same failure
arriving later.

**The answer now is one name, and a refusal.** `exposurie` is the only spelling,
everywhere, on every machine. `scaffold` will not write the pointer, the skill
or the slash command until that command is really on PATH: it exits `10`, writes
nothing, and names the one install line. `init` reports the same thing first.

Commands still go through `cmd()` in `src/install.js` rather than being written
as literals:

```js
cmd('sync --done')   // "exposurie sync --done", always
```

`cmd()` no longer resolves anything, and it is kept anyway — it is the seam that
makes *no printed command is a literal* a mechanical rule a test can enforce
rather than a habit anyone has to remember.

**Why this is a rule and not a habit.** It was fixed in `reach.js` on
2026-08-28, where the bug was reported, and the same literal stayed in
thirty-three other places. It came back on 2026-08-29 in `uninstall` — the one
command a person types with no agent to notice "command not found" for them.
Fixing the reported site and not the class is what makes a bug recur.

It is now a property test rather than a review item. `test/invocation.test.js`
asserts three things: `scaffold` on a bare PATH writes **nothing**; every
command that must name one names `exposurie`; and no output, and no file written
into the brain, ever contains a second invocation form again. A site added later
is covered without anyone remembering this page exists.

> Two of those sites were invisible to a source grep — `` `exposurie ${DECLINE}` ``
> builds the name from a variable, and `bin/` is not `src/`. The test looks at
> output, which is why it found them.

### 3d. Never print a command that will not run

The third sibling, and the last one to be found. 3b says the command must
**exist**; this says it must **work when pasted**. A command that exists and is
spelled so that a shell mis-parses it fails worse than one that does not exist,
because it does not fail — it succeeds at something else.

`init` printed:

```
RUN: exposurie scaffold --at C:\Users\Priya Sharma\brain
```

An agent running that line built the brain at `C:\Users\Priya`, reported
success, and exited 10 — the code that means *nothing failed*. On Windows a
space in the home directory is ordinary, so the first command of the product was
wrong on a large share of the machines it had never run on.

The quoting helper existed and had been applied rigorously — to **titles**,
which is where spaces had been noticed. Paths, which carry spaces far more
often, were interpolated bare. So `q()` now sits beside `cmd()` in
`src/install.js`, because spelling a command and quoting its arguments are one
concern and separating them is what let this survive four releases.

The test does not check the one site. It runs every command on a home directory
whose name contains a space, takes every `RUN:` line printed, and fails if that
path appears anywhere outside quotes — then tokenises the printed `scaffold`
line the way a shell would, runs it, and asserts the brain landed where the
message said. **The next unquoted argument is caught wherever it is printed.**

### 4. The directive rides the output

Anything the agent must keep doing is attached to output it is **already
reading**, never to documentation we hope it read once. This costs nothing until
the tool is used, and it is the only mechanism here with field proof behind it.

---

## Output the tool writes rather than prints

Three files reach an agent without ever appearing on stdout, and **every rule
above applies to all of them.** They are output; the only difference is that
they are read later.

| what | where | loaded |
|---|---|---|
| the pointer | each client's global instructions file | every message, every project |
| the skill | `<client>/skills/exposurie/SKILL.md` | its description always; its body when reached for |
| the slash command | `<client>/commands/exposurie-sync.md` | only when a person types it |

That third column is the whole design. The pointer is paid for constantly, so it
carries a pointer and never content. The other two are paid for on use, so the
procedure that could never fit in the pointer lives there at full length.

Three consequences, each of which has already been a bug somewhere in this
codebase:

- **Rule 3b applies.** A `RUN:` line in a file is a plan like any other, and it
  fails the same way when it names a command the machine does not have. These
  name the *resolved* invocation, never a hardcoded `exposurie`.
- **Rule 2 applies, and this is where it was learned.** The loop that drains a
  backlog is a numbered step in both files, never a sentence underneath one.
- **Two always-loaded surfaces must not do one job.** A skill's description is
  paid for exactly like the pointer. The pointer owns retrieval, so the skill
  triggers on syncing and says so, and the two never bid for the same moment.

The one register that differs: the slash command is the only thing this product
writes that **a person reads directly**, having just typed it. So it opens by
saying plainly what is about to happen — it is about to read their own
conversations, and somebody who cannot tell that from the file is being asked to
take it on faith.

---

## The skeleton

Position is load-bearing. An agent can rely on order, so the order never varies:

```
<state line>          always first, even on error

FOR YOUR USER — n pending    only when a human owes something

ERROR                        only on failure

<command body>               the actual answer

EXIT n — <what that means in words>
```

Blank line between blocks, the exit line included — it is a block like any
other, and run together with the body it reads as the body's last sentence. No
colour, no box drawing, no spinners — they cost tokens and survive nothing.

**Prose wraps; commands do not.** Anything a person will hear or read is wrapped
before printing, because a terminal hard-wrapping a relayed sentence mid-word is
the last place to be sloppy. A `FIX:` line is the exception — it carries a
command, and a wrapped command is a broken command — so it is printed as-is and
a test pins every fix short enough to fit.

---

## Exit codes

| code | name | meaning |
|---|---|---|
| `0` | OK | did the thing; nothing outstanding |
| `1` | ERROR | actually broke; an `ERROR` block explains it |
| `2` | USAGE | no such command or bad flags |
| `10` | HUMAN | **a step needs a person. Nothing failed.** |

`10` is the important one. Without it, "waiting on your user" is indistinguishable
from "crashed", and an agent that cannot tell them apart either panics or ignores
both.

**Staleness never gets a code.** A brain that has not synced in nine days still
works, and a command that exits non-zero over it teaches agents the number is
noise. The nudge rides the state line instead. A warning that fails the run over
a non-problem gets muted, and a muted check is worth nothing on the day
something is actually wrong.

---

## The state line

Printed first by every command, always.

```
exposurie  61 pages · 6 sessions unfiled · last sync 9d ago · backup never
           -> RUN: exposurie sync
```

This is **the retention mechanism**, not decoration. v1 sync is manual, so the
trigger is an agent choosing to nudge — and an agent that has to *remember* will
not. Attaching the number to output the agent already reads makes forgetting
structurally impossible.

Two constraints keep the arrow meaningful:

- It appears **only when earned** — unfiled sessions, or 7+ days since a sync. A
  healthy brain gets no arrow.
- It **never advertises the command it is already inside.** A `sync` run does not
  tell you to run `sync`. A nudge that fires during its own target teaches an
  agent the arrow is decoration.

---

## Pending human steps

Two things a user's agent genuinely cannot do: request their claude.ai export
(no API — it needs their browser session and their inbox), and decide what is
too private to ingest.

Every such step declares five fields, and the split between two of them is the
whole design:

| field | rule |
|---|---|
| `title` | short label |
| `why` | why a person is needed — the agent may explain this freely |
| `ask` | **the agent's own voice.** Tone should match the conversation already happening. |
| `verbatim` | **relayed exactly.** Never paraphrased, never summarised. |
| `resolved(ctx)` | a predicate over detected state |

`ask` and `verbatim` look redundant and are not. "Ask your user to export their
claude.ai data" gets paraphrased into something a non-technical person cannot
act on — so the click path does not get to be paraphrased, while the framing
around it should adapt to the person.

**Done is detected, never marked.** `resolved()` reads the disk. Nobody ticks a
box, and an agent cannot close a step by assuming it worked.

**Steps are mirrored to disk** at `<brain>/.exposurie/pending/<id>.md`. Auto mode
blows past the terminal; a file is still there tomorrow. The file deletes itself
once detection says the step is done.

**Steps repeat until resolved.** Every command re-reports every open step at the
top of its output. The failure being prevented is not "the user was never asked"
— it is "the step got buried and nothing ever came back to it."

**Steps never block.** Every rendering says so in those words.

---

## What a search prints

A search is where an agent decides what the user's life says, so its output
carries three directives at the points they matter (rule 4):

- **Text, or a command, never a torn line.** The best matches are printed as
  the brain wrote them: a short page whole, a long one as the section that
  matched. Everything else is a title and the command that opens it, under
  `NOT READ`. A one-line excerpt reads like the whole story and is not, so the
  output contains nothing an agent could answer from that it has not been
  handed in full.
- **What each result lacks.** `[has: … · lacks: …]` on every result of a
  several-word query. When no page has every word, the output says so, and
  closes by saying what a missing word means: if it is the point of the
  question, the brain does not record it.
- **A miss is a next step, not a verdict.** Zero results names two moves —
  other words, and `exposurie read` for every page by title — before the line
  that says not to answer from memory. The old miss said *"Nothing in the brain
  matches. Say so plainly"*, and agents obeyed it after one try with a query
  that had failed only because it was a phrase.

All of it is held inside `maxReadChars`, the same budget that decides whether a
page opens whole: a search is a read like any other.

---

## `--help`

`--help` is a **question**, and a question never performs an action. It is
answered by the dispatcher before any command runs, so `exposurie <anything>
--help` prints the same help and leaves the machine byte-for-byte as it found
it.

It used to be consulted only when no command was named, so the name won and the
flag was parsed and then dropped — `exposurie sync --help` staged a real batch,
and the agent that asked had to go and clean up work it never meant to start.
Asking what a command does cost the user the command. Answering before dispatch
means a command added later cannot reintroduce this by forgetting to check a
flag.

One thing deliberately does **not** get this treatment: a name that is not a
command is still `USAGE`, flag or no flag. Exit `0` with a help page would tell
an agent its typo worked, and the error already names every command there is —
which is the answer to the question it was asking.

---

## `--at`

`--at <path>` names a brain **outright**, and it wins over the pointer. That is
the whole reason the flag exists: a wrong or unreadable pointer must not be able
to send a command at a brain the user did not name, and it is how somebody keeps
working while that file is being repaired.

It is deliberately **not a fallback**. A path holding no brain is refused, by
name, at `USAGE` — it never quietly degrades into the pointer's brain, because
acting on a brain nobody named is the failure the flag exists to prevent. The
refusal names both paths and prints the caller’s own command rebuilt without the
flag, so the next step is one line.

This was broken for the life of the product, in silence. `detect()` took no
arguments while `decline` and `uninstall` both called it as `detect({ at })`, and
`sync` never forwarded the flag at all, so three commands accepted a path and
acted on a different brain. The sharpest symptom was in `read`:
`read --at ~/typo --search x` answered *"Nothing in the brain matches. Say so
plainly; do not answer from memory."* at exit `0`, having never opened a brain.
**A retrieval failure that succeeds is the worst output this tool can produce.**

Two commands deliberately do not follow the rule, and both look like the bug from
outside:

- **`init` and `scaffold` call `detect()` with no argument.** They ask the other
  question — which brain already *exists* — because one brain per person is
  enforced against the pointer, not against a flag. Honouring `--at` there would
  make `d.vault` equal the asked path and the second-brain guard could never fire.
- **`uninstall` never refuses.** Leaving must always finish. `--at` there only
  decides which folder gets *named*; nothing is read from it or written to it, so
  refusing over a wrong path would strand our blocks in somebody’s client files at
  the exact moment they asked to be rid of them. It says the path was empty and
  gets on with it.

---

## `--json`

Every command that returns data supports `--json`. Default output stays prose,
because a model reads it fine and it costs fewer tokens than the same content in
braces and quotes. JSON is for programmatic callers, not for the agent.

**`--json` always yields JSON.** A command with a structured payload returns it,
plus `exit`. A command without one — `read` and `help` today — returns the
envelope below rather than falling back to prose:

```json
{
  "exit": 0,
  "ok": true,
  "error": null,
  "text": "…the complete prose rendering, footer included…"
}
```

The guarantee is made once, in `bin/exposurie.js`, rather than command by
command, so a command added later cannot forget to keep it. That matters
because of how it failed: the writer said `wantsJson && result.json`, so a
caller that asked for JSON and hit a command without a payload got prose **at
exit 0** — well-formed, plausible, and unparseable. Nothing raised it, because
nothing that goes wrong quietly ever does.

A command that grows a real payload later simply sets `json`, and its callers
see the shape improve; `exit` is present either way, so parsing it never has to
branch on which kind of command it asked.

---

## Adding a command

1. Return `{ code, state, pending, body, json }` — never write to stdout yourself.
   There is exactly one writer (`render`) and one place the exit code is chosen,
   so the contract cannot be bypassed by a command author.
2. Set `state.self = '<your command>'` so the nudge does not point at you.
3. Anything a person must do goes in the `STEPS` catalog in `pending.js` — never
   inline, so all human-facing wording stays reviewable in one place.
4. Add a test that pins whatever rule your command could break.
5. If it acts on a brain, resolve it through `detect({ at })` or `resolveVault(at)`
   — never off the pointer directly, or `--at` becomes a flag you accept and
   ignore. That is not hypothetical: see `--at` above.
