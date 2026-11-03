// What is actually on this machine.
//
// Client paths are HARDCODED, deliberately. "Let the agent work out where
// Cursor keeps its config" is exactly the latent-space guess this tool exists
// to refuse: the agent supplies the identity, the package supplies the action.
//
// Every path below was read off a real machine on 2026-08-22 rather than
// recalled. Where a layout was seen but its file format was not, the client is
// marked `readable: false` and REPORTED as such — a client we cannot parse yet
// is a known gap, not a silent omission.

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { readTranscript } from './extract/transcript.js';
import { readRollout } from './extract/codex.js';
import { openArchive, isConversationsPart } from './extract/archive.js';
import { cursorRoot, readCursorSessions, countCursorSessions, cursorMtime } from './extract/cursor.js';
import { SIGNATURE as CHATGPT_SIGNATURE } from './extract/chatgpt.js';
import { expandPath, isVault, DEFAULT_VAULT } from './vault.js';
import { cmd, q } from './install.js';

const HOME = homedir();

// Claude Code's own default, stated in its binary: "Number of days to retain chat
// transcripts before automatic cleanup (default: 30)."
const DEFAULT_RETENTION = 30;

// Long enough that nobody meets this again. Their docs suggest 3650 for ~10
// years, so this is their number rather than one we invented.
export const KEEP_YEARS_DAYS = 3650;
const SEP = String.fromCharCode(92); // backslash, written this way to survive shell heredocs

/** Recursively collect files matching a predicate. Depth-capped; never throws. */
function walk(dir, match, depth = 6, acc = []) {
  if (depth < 0 || !existsSync(dir)) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // permissions, junctions, a folder that vanished mid-walk
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, match, depth - 1, acc);
    else if (match(e.name)) acc.push(p);
  }
  return acc;
}

const isJsonl = (n) => n.endsWith('.jsonl');

/**
 * Every client, with the reader that backs its claim.
 *
 * `read` lives here on purpose. Codex was marked `readable: true` for a whole
 * release with no reader of its own: the Claude Code parser was pointed at a
 * completely different file format, returned zero turns from every rollout, and
 * the sync marked all three sessions read. Nothing errored, the session count
 * was correct, and the conversations simply were not there.
 *
 * With the reader in the table, `readable: true` and "there is a function that
 * reads it" are the same statement, and a test can check the two agree.
 */
export const CLIENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    root: join(HOME, '.claude'),
    readable: true,
    find: (root) => walk(join(root, 'projects'), isJsonl),
    read: readTranscript,
  },
  {
    id: 'codex',
    name: 'Codex',
    root: join(HOME, '.codex'),
    readable: true,
    // sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
    find: (root) => walk(join(root, 'sessions'), (n) => n.startsWith('rollout-') && isJsonl(n)),
    read: readRollout,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    // NOT `~/.cursor`. That folder holds extensions and per-project scaffolding,
    // and its `agent-transcripts` directories are empty — the previous version
    // of this entry counted them and reported "2 found, NO READER YET", which
    // was an honest statement about a reader we lacked and a wrong one about
    // what was there. The conversations are in Cursor's app data, in SQLite.
    root: cursorRoot() || join(HOME, '.cursor'),
    readable: true,
    // Its unit is a row in a database, not a file on disk, so it yields
    // sessions directly rather than paths for someone else to open.
    find: () => [],
    sessions: readCursorSessions,
    count: countCursorSessions,
    mtime: cursorMtime,
  },
];

/**
 * Chat exports, left where the browser put them.
 *
 * Identified by what is INSIDE the zip, not by its name. Anthropic's download
 * is reliably `data-*.zip`; OpenAI's is not reliably anything, and a filename
 * rule would either miss every ChatGPT export or claim unrelated archives. The
 * two are told apart by their contents with no ambiguity:
 *
 *   claude.ai   conversations.json + users.json / projects/
 *   ChatGPT     conversations.json + chat.html
 *
 * This costs a central-directory read per zip and never inflates anything —
 * the index sits at the end of the file, so it is the same small read whether
 * the archive is 5 MB or 5 GB.
 */
/** Names Anthropic and OpenAI actually give their downloads. */
const LOOKS_LIKE_AN_EXPORT = [/^data-.*\.zip$/i, /chatgpt/i, /^conversations.*\.zip$/i];

/**
 * Whose export is this, from what is inside it.
 *
 * A pure function over member names, so it can be run against a directory
 * listing as cheaply as against a zip index. That is what makes an unpacked
 * export detectable without walking it first.
 *
 * A directory lists `projects` where a zip index lists `projects/`, so both
 * forms are accepted. Same export, two containers, one answer.
 */
function classify(names, filename) {
  // Numbered parts count. Requiring the literal `conversations.json` is what
  // made a 1,164-conversation export invisible on the first machine somebody
  // else installed this on: OpenAI had split it across `conversations-000.json`
  // through `conversations-011.json`.
  if (!names.some(isConversationsPart)) return null;
  if (names.includes(CHATGPT_SIGNATURE)) return 'chatgpt';
  const holds = (d) => names.some((n) => n === d || n.startsWith(d + '/'));
  if (names.includes('users.json') || names.includes('memories.json') || holds('projects') || holds('design_chats')) {
    return 'claude';
  }
  // Anthropic's download is reliably named this way. It is a weaker signal
  // than a marker file, which is why it is last rather than first — but a
  // stripped-down export that carries only `conversations.json` is still
  // theirs, and refusing it would lose a whole history over a missing
  // `users.json`. The extension is optional because the same download, once
  // unzipped, is a folder called `data-2026-08-26`.
  if (/^data-.*(\.zip)?$/i.test(filename)) return 'claude';
  // Conversations and nothing that identifies them. Do not guess: handing an
  // export to the wrong reader is the failure this function is shaped around.
  return null;
}

/**
 * Open one candidate, classify it, and record it if it is an export.
 *
 * Opened exactly once. A zip index and a directory listing are both cheap, and
 * neither inflates or parses anything — the whole detection pass costs one
 * read of the end of each archive.
 */
function take(path, filename, out) {
  let archive;
  try {
    archive = openArchive(path);
  } catch (e) {
    // An archive that will not open is only OUR problem if it was plausibly an
    // export. Reporting every corrupt file in someone's Downloads folder is
    // noise; saying nothing about a half-downloaded `data-*.zip` is the silent
    // failure this product keeps finding, moved down a layer — the file is
    // sitting right there and the tool says "nothing has changed".
    if (LOOKS_LIKE_AN_EXPORT.some((re) => re.test(filename))) {
      out.push({ path, size: 0, kind: 'broken', error: e.message || String(e) });
    }
    return;
  }
  try {
    const kind = classify(archive.names(), filename);
    if (kind) out.push({ path, size: archive.size || 0, kind });
  } finally {
    archive.close();
  }
}

/**
 * How far below Downloads and Desktop an unpacked export may sit.
 *
 * One level below the folder itself is where OpenAI's own delivery lands; the
 * recursion allows one wrapper folder beyond that, for the person who unzipped
 * by hand into somewhere of their own choosing. Each level costs one `readdir`
 * per folder and opens nothing, so it is cheap — but it is bounded, because
 * "search this disk for an export" is a different product.
 */
const MAX_EXPORT_DEPTH = 1;

function scanForExports(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile()) {
      if (/\.zip$/i.test(e.name)) take(p, e.name, out);
      continue;
    }
    if (!e.isDirectory()) continue;

    // A folder whose OWN listing carries a conversations file is an export.
    // Deciding that off the shallow listing is what keeps this affordable:
    // nothing is opened, walked or parsed until a folder has announced itself.
    let inside;
    try {
      inside = readdirSync(p);
    } catch {
      continue;
    }
    if (inside.some(isConversationsPart)) take(p, e.name, out);
    // An export does not contain another export, so this only descends into
    // folders that are not one.
    else scanForExports(p, depth - 1, out);
  }
}

export function findExports() {
  const out = [];
  for (const d of [join(HOME, 'Downloads'), join(HOME, 'Desktop')]) {
    if (!existsSync(d)) continue;
    scanForExports(d, MAX_EXPORT_DEPTH, out);
  }
  return out;
}

/**
 * Is Obsidian on this machine?
 *
 * Nothing in the product needs it — the brain is plain Markdown and the agent
 * reads the files. It is here because seeing the graph is the moment most
 * people start believing the thing is real, and that moment is the whole
 * retention problem.
 *
 * Detected, never marked. The step it gates was in the catalog for a release
 * with every caller hardcoding `false`, which meant it could never resolve: had
 * it ever been shown, it would have asked forever and taught the user that the
 * tool does not notice when they do what it asks. "Done is detected" is not a
 * style preference — without a detector, a step is a nag.
 *
 * The config folder is the signal rather than the binary: it appears when
 * Obsidian is first RUN, and an installed-but-never-opened copy has not
 * actually got the person to their graph.
 */
const OBSIDIAN_PATHS = [
  join(HOME, 'AppData', 'Roaming', 'obsidian'), // Windows
  join(HOME, 'Library', 'Application Support', 'obsidian'), // macOS
  join(HOME, '.config', 'obsidian'), // Linux
  join(HOME, '.var', 'app', 'md.obsidian.Obsidian'), // Linux, flatpak
];

export function obsidianInstalled() {
  return OBSIDIAN_PATHS.some((p) => existsSync(p));
}

export const configPath = () => join(HOME, '.exposurie', 'config.json');

/**
 * The machine config: the one file outside the brain that says where it is.
 *
 * 1.2.0 left it behind while printing "that is every byte exposurie wrote
 * outside your brain" -- a false sentence in the one command that runs with
 * nobody watching, found by taking the tool off a real machine and looking.
 * It is ours end to end, so it goes, and so does the folder we made for it if
 * nothing else has moved in.
 *
 * It lives here rather than in uninstall.js for the reason reach.js and
 * surfaces.js hold their own removals: uninstall.js contains no code that can
 * delete a file at all, which is what lets a test promise it cannot reach the
 * brain. This deletes one path, fixed above, and nothing else.
 */
export function removeMachineConfig() {
  const file = configPath();
  if (!existsSync(file)) return { action: 'absent', file };
  rmSync(file);
  try {
    rmdirSync(dirname(file));
  } catch {
    // Something else is in there, so the folder is no longer only ours.
  }
  return { action: 'removed', file };
}

/**
 * The pointer file, and an HONEST answer about it.
 *
 * This used to be one try/catch returning null, which made a corrupt config
 * indistinguishable from a machine that has no brain. Every command then said
 * "no brain yet -> RUN: exposurie init" — a dead end, since init cannot repair
 * JSON. Worse than useless, in fact: following that advice into `scaffold`
 * builds a SECOND brain at the default path while the real one sits elsewhere,
 * still named by the file nothing said was broken.
 *
 * A hand-edit or a bad merge is all it takes. So absent and unreadable are now
 * different answers, and every command that would act on the difference asks.
 */
export function configState() {
  const path = configPath();
  if (!existsSync(path)) return { status: 'absent', path, config: null };

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { status: 'unreadable', path, config: null, reason: e.code || 'could not be opened' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: 'unreadable', path, config: null, reason: String(e.message) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unreadable', path, config: null, reason: 'not a JSON object' };
  }
  return { status: 'ok', path, config: parsed };
}

export function readConfig() {
  const s = configState();
  return s.status === 'ok' ? s.config : null;
}

/** The brain this machine points at, or null. The pointer only, no guessing. */
export function pointedVault() {
  const cfg = readConfig();
  return cfg?.vault && existsSync(cfg.vault) ? cfg.vault : null;
}

/**
 * Which brain a COMMAND should act on.
 *
 * `--at` names a brain OUTRIGHT and wins over the pointer. That is the whole
 * reason the flag exists: a wrong or unreadable pointer must not be able to send
 * a command at a brain the user did not name, and it is how you keep working
 * while that file is being repaired.
 *
 * It is deliberately NOT a fallback. A path holding no brain resolves to null
 * and the caller says so, naming the path — it never quietly degrades into the
 * pointer's brain, because acting on a brain somebody did not name is the exact
 * failure the flag exists to prevent. `read --at ~/typo --search x` used to
 * answer "nothing in the brain matches", which is a retrieval failure wearing
 * the shape of an answer.
 *
 * The default-path fallback at the end is not the same question and is why this
 * is not `detect().vault`: with the pointer file simply missing, a brain sitting
 * at `~/brain` is still readable, and reading the right brain is a safe way to
 * be wrong. `detect` deliberately does not do this — see there.
 */
export function resolveVault(at) {
  const asked = expandPath(at);
  if (asked) return isVault(asked) ? asked : null;
  return pointedVault() ?? (existsSync(DEFAULT_VAULT) ? DEFAULT_VAULT : null);
}

/**
 * One error for "you named somewhere, and there is no brain there".
 *
 * Shared for the same reason `brokenConfig` is: every command that takes `--at`
 * can be handed a path that is not a brain, and the wrong thing to do is
 * identical in all of them — carry on against a different brain. It names the
 * path they gave AND the one this machine points at, because the useful next
 * move is almost always the second one.
 *
 * `retry` is the caller's OWN command rebuilt without the flag, and it is a
 * parameter rather than `exposurie <name>` because two of the three callers take
 * required arguments: `RUN: exposurie decline` on its own is a usage error, so
 * printing it would answer a broken command with another one. Rule 3 asks for
 * the exact argv, and the only code that can produce it is the code that was
 * handed the arguments.
 */
export function noBrainAt(asked, pointed, retry) {
  return {
    message:
      `You named ${tilde(asked)} with --at and there is no brain there. Nothing ` +
      `was read and nothing was written. \`--at\` names a brain outright, so it is ` +
      `never quietly replaced by the one this machine points at — running against ` +
      `a brain you did not name is what this flag exists to prevent.`,
    fix: pointed
      ? `RUN: ${retry}   (the same thing without --at, against ${tilde(pointed)})`
      : `RUN: ${cmd(`scaffold --at ${q(asked)}`)}   (this machine has no brain anywhere yet)`,
  };
}

/**
 * One error, shared by every command that would otherwise act on a wrong
 * assumption. It names the file, says what is wrong with it, and states the
 * consequence — the reason to stop is not tidiness, it is that continuing
 * orphans a brain.
 */
export function brokenConfig(state) {
  return {
    message:
      `The pointer telling exposurie where the brain lives could not be read ` +
      `(${state.reason}). Nothing was changed, and nothing here is lost. Until ` +
      `it is valid, a corrupt pointer cannot be told apart from a machine with ` +
      `no brain at all — and creating a new one would orphan the brain you have.`,
    fix: `EDIT: ${state.path}   (JSON, holding {"vault": "<path to your brain>"})`,
  };
}

/**
 * How long this machine keeps its transcripts before deleting them.
 *
 * The premise of this tool was that it reads what a person has. It does not:
 * Claude Code deletes its own transcripts after `cleanupPeriodDays`, default
 * 30, and everything older is gone before exposurie is ever installed. Measured
 * on the machine this was built on — 164 transcripts, none older than 29 days,
 * and sessions the brain had already filed in early July no longer existed.
 *
 * Nothing here writes that file. It is machine-parsed and belongs to another
 * vendor: break it and their setup fails silently, with us the last to touch
 * it. We read it, and the person's own agent changes it if they say yes.
 *
 * Returns days, or `null` when nothing is configured — which means the default
 * is in force, not that retention is unlimited. Those look identical in the
 * file and are opposite in effect.
 */
export function retentionDays() {
  const p = join(HOME, '.claude', 'settings.json');
  if (!existsSync(p)) return { configured: false, days: DEFAULT_RETENTION, path: p };
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))?.cleanupPeriodDays;
    if (typeof v === 'number' && v > 0) return { configured: true, days: v, path: p };
  } catch {
    // Unreadable settings mean we cannot tell, and a guess here would either
    // nag someone who is already safe or reassure someone who is not.
    return { configured: false, days: null, path: p };
  }
  return { configured: false, days: DEFAULT_RETENTION, path: p };
}

/** One call, everything a command needs to decide what to print. */
export function detect({ at } = {}) {
  const exports = findExports();
  const clients = CLIENTS.map((c) => {
    const present = existsSync(c.root);
    const files = present ? c.find(c.root) : [];
    // A client whose conversations are not files counts them its own way.
    const count = present && c.count ? c.count(c.root) : files.length;
    return { ...c, present, count, files };
  });

  const cfg = configState();
  const config = cfg.config;

  // `--at` wins over the pointer, and does not fall back to it — see
  // `resolveVault`. Two call sites passed `{ at }` here for the whole life of
  // the product while this function took no arguments at all, so `decline` and
  // `uninstall` accepted the flag, discarded it, and acted on the pointer's
  // brain: `uninstall --at <anywhere>` printed "YOUR BRAIN IS UNTOUCHED" over a
  // path the user had not named. Passing an argument to a function that takes
  // none is silent in JavaScript, which is why it survived tests that all
  // happened to point `--at` at the same brain the pointer named.
  const askedVault = expandPath(at);
  const pointed = pointedVault();
  const vault = askedVault ? (isVault(askedVault) ? askedVault : null) : pointed;

  return {
    home: HOME,
    clients,
    exports: exports.filter((e) => e.kind === 'claude'),
    chatgptExports: exports.filter((e) => e.kind === 'chatgpt'),
    brokenExports: exports.filter((e) => e.kind === 'broken'),
    obsidianInstalled: obsidianInstalled(),
    retention: retentionDays(),
    config,
    configStatus: cfg.status,
    configError: cfg.status === 'unreadable' ? cfg : null,
    vault,
    // What they NAMED, kept apart from what was found, so a caller can tell
    // "you named somewhere empty" from "this machine has no brain".
    askedVault,
    pointedVault: pointed,
    // Only what we can actually parse counts toward the number we promise on.
    sessions: clients.filter((c) => c.readable).reduce((n, c) => n + c.count, 0),
  };
}

/** Shorten a path for display without lying about where it is. */
export function tilde(p) {
  if (!p || !p.startsWith(HOME)) return p;
  return '~' + p.slice(HOME.length).split(SEP).join('/');
}
