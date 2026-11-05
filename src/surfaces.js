// The two surfaces a person and an agent can REACH FOR, as opposed to the one
// they are handed on every message.
//
// reach.js writes a pointer into each client's global instructions file. That
// file is paid for on every message of every project forever, so the pointer is
// a few hundred bytes and carries a pointer rather than content. It has to be
// small, and small is the whole reason it can only ever name one command.
//
// A skill and a slash command invert that arithmetic. A skill's DESCRIPTION is
// always-loaded and its body is not; a command costs nothing at all until a
// person types it. So the procedure that never fitted in the pointer fits here,
// and it fits at full length.
//
// WHY THIS EXISTS AT ALL. It was item 3 of the first outside install, and only
// half of it got fixed. The report said the slash command was never installed;
// the finding underneath was that THERE IS NONE. What shipped in August fixed
// the pointer that named a missing command, and left the missing command.
//
// It was not buildable before that fix either, which is the part worth keeping.
// A skill body's one useful line is `RUN: exposurie sync`, and for a whole
// release the documented way in left nothing of that name on PATH — so a skill
// written then would have failed exactly the way the pointer did: correct prose
// naming a command that is not there, erroring never, running never. Making the
// permanent install the documented path is what made this surface possible.
//
// THE DIVISION OF LABOUR, so no two of the three do the same job:
//
//   pointer   always-loaded, every message   RETRIEVAL. `read --search`.
//   skill     description always-loaded      THE SYNC PROCEDURE, agent-invoked
//                                            when the user asks for it in words.
//   command   nothing until typed            THE SYNC PROCEDURE, user-invoked,
//                                            one token, no explaining.
//
// The skill deliberately does NOT trigger on "a question about the user" — the
// pointer already fires there, on every message, and a second always-loaded
// trigger for one job is the context budget being spent twice for nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { invocation } from './install.js';

/**
 * Where each client keeps the things a person or a model can reach for.
 *
 * Same table discipline as `contextFiles` in reach.js, and the same invariant
 * behind it: every target is markdown, so a path we guessed wrong writes prose
 * nothing reads rather than corrupting a config another tool depends on. A
 * client whose ROOT is absent is skipped entirely, so an entry costs nothing on
 * a machine without that client.
 *
 * `verified` means the directory was OBSERVED on a real machine — not that the
 * client is documented to read it. Two of these were observed here, with other
 * people's skills already living in them; the rest are the client's convention
 * and say so in the output.
 *
 * OpenCode has a row in reach.js and none here on purpose. There, four clients
 * are three conventions because `AGENTS.md` is a filename several of them
 * genuinely share, so an entry for OpenCode is an informed guess. Here there is
 * nothing to inform it: no shared convention, no observed directory, no name to
 * run ahead to. Guessing a path with no basis is invention rather than running
 * ahead of confirmation, and the two are not the same thing.
 */
export function surfaces(home = homedir()) {
  const claude = join(home, '.claude');
  const cursor = join(home, '.cursor');
  const codex = join(home, '.codex');

  return [
    // Observed here: ~/.claude/skills holds around sixty skills belonging to
    // other tools, in exactly this shape — a directory per skill, SKILL.md
    // inside it, name and description in frontmatter.
    s('claude-code', 'Claude Code', claude, 'skill', join(claude, 'skills', 'exposurie', 'SKILL.md'), true),
    s('claude-code', 'Claude Code', claude, 'command', join(claude, 'commands', COMMAND_FILE)),

    // Observed here: ~/.cursor/skills, same shape as Claude Code's, with real
    // skills already in it. Cursor's own built-ins sit beside it in
    // skills-cursor, which is theirs and is not written to.
    s('cursor', 'Cursor', cursor, 'skill', join(cursor, 'skills', 'exposurie', 'SKILL.md'), true),
    s('cursor', 'Cursor', cursor, 'command', join(cursor, 'commands', COMMAND_FILE)),

    // Codex keeps user prompts rather than skills, and one file is one slash
    // command. So Codex gets the typed surface and not the model-invoked one —
    // the row that does not exist is more honest than a skills directory
    // invented to make the table look symmetrical.
    s('codex', 'Codex', codex, 'command', join(codex, 'prompts', COMMAND_FILE)),
  ];
}

/**
 * What the user types.
 *
 * `/exposurie sync` is what was asked for and no client can deliver it: a space
 * separates the command from its arguments in all three, so the second word
 * would arrive as an argument to a command called `exposurie`. The hyphen is
 * the closest thing that is one token in every one of them.
 *
 * It is deliberately not `/exposurie`. The tool has six commands and a slash
 * command named after the whole product that runs one of them is a lie by
 * omission — the name says what it does, which is the only thing a person
 * scanning a list of commands has to go on.
 */
export const COMMAND_NAME = 'exposurie-sync';
const COMMAND_FILE = `${COMMAND_NAME}.md`;

function s(id, name, root, kind, file, verified = false) {
  if (!/\.(md|mdc)$/.test(file)) {
    throw new Error(`surfaces: ${id} target must be markdown, got ${file}`);
  }
  return { id, name, root, kind, file, verified };
}

/**
 * The procedure both documents point at, as a path this machine can open.
 *
 * Built with join rather than by concatenating a separator, because the first
 * version of this file did concatenate one and produced
 * `C:\Users\...\brain/.exposurie/sync.md` on Windows — a path that happens to
 * work and reads as though nobody ran it. The product ships for two platforms
 * and half of its own path handling exists because of exactly this.
 */
const procedureAt = (vault) => join(vault, '.exposurie', 'sync.md');

/**
 * The note saying this file is not the reader's, and where the file that IS
 * theirs lives.
 *
 * Both documents are rewritten on every scaffold, because both name the
 * invocation that works on this machine and the brain's location, and a stale
 * copy of either is the silent-failure class this product keeps finding in
 * itself. That makes them the opposite of everything scaffold copies into the
 * brain, which becomes the user's and is never overwritten — so each file says
 * which kind it is, and points at the one that takes edits.
 *
 * It sits at the BOTTOM of both. A person who just typed the command wants to
 * know what it does, and a note about file ownership above the steps is the
 * product's own rule 2 failing in a new place: the thing that matters gets read
 * second.
 */
const ownership = (vault) => [
  '---',
  '',
  'This file is written by exposurie and rewritten whenever `exposurie',
  'scaffold` runs, so edits here do not survive. The procedure itself is',
  'yours and is never overwritten:',
  '',
  `    ${procedureAt(vault)}`,
];

/**
 * The typed surface. A person types this, having decided to, and is watching
 * when it runs — which makes it the one place in the product where a human
 * reads our words before an agent acts on them.
 *
 * So it opens by saying what is about to happen. Not for warmth: this command
 * reads the user's own conversations, and a person who cannot tell from the
 * file what it does has to take that on faith. The trust in a tool like this
 * comes from being legible at the moment somebody chose to run it.
 *
 * The steps are numbered rather than written as prose, and the loop is a step
 * of its own, because that exact distinction is defect 2 of the first outside
 * install: the instruction to continue was a sentence under the plan block, and
 * rule 2 of our own output contract says what happens to those. It was skipped,
 * and a backlog of 165 sessions drained only because a human typed "continue"
 * seven times.
 */
export function commandDoc(cmd = 'exposurie', vault = '~/brain') {
  return [
    '---',
    'description: Fold new conversations into the external brain, and curate it',
    '---',
    '',
    'Sync the external brain: read what is new since the last run — the',
    'conversations on this machine, and any web exports — and write them into',
    'the wiki as pages. Nothing leaves this machine, and nothing is deleted.',
    '',
    `1. RUN: ${cmd} sync`,
    '   It reports what is new and stages it. If it reports nothing new, say so',
    '   and stop — that is a complete answer, not a failure.',
    '',
    '2. READ: the procedure, and follow it.',
    `       ${procedureAt(vault)}`,
    '   That file is the authority on how pages get written. Step 1 prints the',
    "   brain's real location if it has moved since this file was written.",
    '',
    '3. GO BACK TO 1 until it reports nothing new.',
    '   A batch is sized to your context, never to the history, so a backlog',
    '   arrives as several of them. Do not stop after one, and do not ask',
    '   whether to continue — finishing is the job.',
    '',
    'Exit 10 is not a failure. It means a step needs the person who typed this,',
    'and the step says what to ask them.',
    '',
    ...ownership(vault),
  ].join('\n');
}

/**
 * The model-invoked surface, for a person who asks in words instead of typing.
 *
 * The description is the only part of this file that is always loaded, so it is
 * written the way the pointer was: CONDITIONS FIRE, STATEMENTS DO NOT. "The
 * user has an external brain" is a fact the model has no moment to act on;
 * "when they ask you to remember something" is a moment.
 *
 * What it must NOT say is anything about answering questions from the brain.
 * The pointer already fires on that, on every message, and paying the
 * always-loaded budget twice for one job is the thing the budget rule exists
 * to prevent.
 */
export function skillDoc(cmd = 'exposurie', vault = '~/brain') {
  return [
    '---',
    'name: exposurie',
    'description: >-',
    '  Fold new conversations into the user\'s external brain and curate it. Use',
    '  when they ask to sync, file, update or catch up their brain, when they',
    '  tell you to remember something for later, or when they ask what has not',
    '  been filed yet. Runs on this machine only.',
    '---',
    '',
    '# Syncing the external brain',
    '',
    'The user has an external brain — a wiki of their own work, decisions,',
    'people and projects, written from their own conversations. It is here:',
    '',
    `    ${vault}`,
    '',
    'This skill is how new material gets into it.',
    '',
    '## The procedure',
    '',
    `1. RUN: ${cmd} sync`,
    '   It reports what is new and stages it. Nothing new is a complete answer.',
    '',
    '2. READ: the procedure, and follow it.',
    `       ${procedureAt(vault)}`,
    '   It is the authority on how pages get written. Do not improvise one',
    '   when that file is sitting there.',
    '',
    '3. GO BACK TO 1 until it reports nothing new.',
    '   Batches are sized to your context, not to the history. Do not stop',
    '   after one, and do not ask whether to continue.',
    '',
    '## What this is not for',
    '',
    'Answering a question ABOUT the user is a different job with a different',
    'command, and the instruction for it is already in your context on every',
    'message:',
    '',
    `    ${cmd} read --search "<topic or project>"`,
    '',
    'Reach for that directly rather than syncing first. Reading needs nothing',
    'to have been synced today.',
    '',
    ...ownership(vault),
  ].join('\n');
}

const body = (kind, cmd, vault) =>
  kind === 'skill' ? skillDoc(cmd, vault) : commandDoc(cmd, vault);

/**
 * Write one. These files are ours end to end — no line of the user's is in
 * them — so unlike the pointer there is no block to splice and nothing to
 * preserve. Rewritten rather than topped up, for the reason `ownership` gives.
 */
export function put(path, text) {
  const had = existsSync(path);
  if (had && readFileSync(path, 'utf8') === text) return { action: 'unchanged' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { action: had ? 'updated' : 'created' };
}

/**
 * Take one back out, and the folder we made for it if that folder is ours.
 *
 * The two kinds differ and the difference decides this. A skill lives in a
 * folder of its own — `skills/exposurie/` — which we created, which holds
 * nothing but our file, and which is litter once that file is gone. A command
 * is one file dropped into `commands/`, and THAT folder is the client's: it is
 * where every other command the user writes will go.
 *
 * So pruning is per-row rather than automatic. The first version pruned the
 * parent of whatever it deleted, which quietly removed `~/.claude/commands/`
 * whenever it happened to be empty — reaching a level up, into a directory we
 * did not make, over a folder that costs nothing to leave. Small, and exactly
 * the class of overreach that makes a person stop trusting a tool with their
 * files.
 *
 * rmdir on a non-empty directory throws, which is the guard wanted even on the
 * folder that IS ours: if something else has appeared in it, it is no longer
 * only ours to remove.
 */
export function drop(path, pruneDir = false) {
  if (!existsSync(path)) return { action: 'absent' };
  rmSync(path);
  if (pruneDir) {
    try {
      rmdirSync(dirname(path));
    } catch {
      // Something else is in there. The file is gone, which is what was
      // promised, and the folder is now somebody else's business.
    }
  }
  return { action: 'removed' };
}

/**
 * Every surface every client on this machine can offer, installed.
 *
 * Skipped when the client's root is absent, for the same reason reach.js skips
 * one: creating `~/.cursor` on a machine with no Cursor is littering in
 * somebody's home directory to no effect.
 */
export function surfacesAll({ home = homedir(), vault = '~/brain', cmd = invocation() } = {}) {
  return surfaces(home)
    .filter((c) => existsSync(c.root))
    .map((c) => ({ ...c, ...put(c.file, body(c.kind, cmd, vault)) }));
}

export function unsurfaceAll({ home = homedir() } = {}) {
  return surfaces(home)
    .filter((c) => existsSync(c.root))
    .map((c) => ({ ...c, ...drop(c.file, c.kind === 'skill') }));
}
