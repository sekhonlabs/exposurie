// `exposurie scaffold` — create the brain, and hand over the half that is theirs.
//
// This is the first command that writes anything, and it has one rule above all
// others: IT NEVER OVERWRITES. Every file it copies in becomes the user's — a
// schema their agent tuned to their life is the goal, not drift — so a second
// run tops up what is missing and reports what it left alone. Clobbering a
// tuned schema on a re-run would destroy exactly the thing the ownership split
// exists to protect.
//
// It also never creates a backup remote. The asymmetry decides it: no backup
// and the disk dies is bad and known; we push and a visibility flag is wrong
// once and every conversation the user has ever had with an AI is public,
// irreversibly, and by our hand.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect, tilde, configPath, brokenConfig } from '../context.js';
import { installState, INSTALL, cmd } from '../install.js';
import { reachAll, pointer } from '../reach.js';
import { surfacesAll, COMMAND_NAME } from '../surfaces.js';
import { unresolved, mirror, stepCtx } from '../pending.js';
import { block, planBlock, wrap } from '../output.js';
import { OK, ERROR, HUMAN } from '../exit-codes.js';
import { version } from '../version.js';
import {
  DEFAULT_VAULT,
  expandPath,
  isVault,
  readSeam,
  writeSeam,
  seamDefaults,
  sha256,
  vaultState,
} from '../vault.js';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const SEP = String.fromCharCode(92);

// source in the package -> destination in the brain, and what it is for.
// Everything here becomes `theirs` the moment it is written; the package keeps
// no claim on it and never edits it again.
const COPY = [
  ['CLAUDE.md', 'CLAUDE.md', 'the schema'],
  ['AGENTS.md', 'AGENTS.md', 'schema pointer, for agents that read that name'],
  ['index.md', 'index.md', 'the catalog'],
  ['log.md', 'log.md', 'the activity log'],
  ['wiki-prompt.md', join('.exposurie', 'wiki-prompt.md'), 'how pages get written'],
  ['examples.md', join('.exposurie', 'examples.md'), 'what a good page looks like'],
  // The one file here the AGENT keeps writing rather than only reading. It
  // ships nearly empty because its content cannot ship: it is this person's own
  // corrections, mined from their own corpus, and it is how a schema that is
  // somebody else's taste becomes theirs without them having to write it.
  ['how-they-work.md', join('.exposurie', 'how-they-work.md'), 'their taste, learned from their own corrections'],
  ['sync.md', join('.exposurie', 'sync.md'), 'the sync procedure'],
  // The curator's half that needs a reader, and the record of what has already
  // been judged. Both are copied at SCAFFOLD rather than on first use, because
  // curation starts with the first batch — a brain only curated once the mess
  // exists is a brain where the mess got there first.
  ['curate.md', join('.exposurie', 'curate.md'), 'the curation procedure'],
  ['curate-allow.txt', join('.exposurie', 'curate-allow.txt'), 'findings judged correct as-is'],
  // The source file is `gitignore` with no dot, and it has to stay that way:
  // npm renames a `.gitignore` inside a published package to `.npmignore`, so
  // a dotted source file would simply not arrive on a user's machine — and the
  // brain would be missing its ignores with nothing reporting why.
  ['gitignore', '.gitignore', 'git ignores'],
];

const slash = (p) => p.split(SEP).join('/');

/** "Claude Code", "Claude Code and Cursor", "Claude Code, Cursor and Codex". */
const and = (xs) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

function dirs(seam) {
  return [
    '.exposurie',
    join('.exposurie', 'templates'),
    seam.raw,
    ...Object.values(seam.categories).map((rel) => join(...rel.split('/'))),
  ];
}

function git(vault, args) {
  return execFileSync('git', args, {
    cwd: vault,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

/**
 * Local history, and nothing beyond it.
 *
 * The common disaster is not a dead disk — it is an agent mangling a page, and
 * a first commit is the floor to undo back to. The commit deliberately does not
 * depend on a global git identity being configured, because failing there would
 * leave a repository with no restore point and an error about something the
 * user never asked for.
 */
function initGit(vault) {
  if (existsSync(join(vault, '.git'))) return 'already a repository — left alone';
  try {
    git(vault, ['init', '-q']);
  } catch {
    return 'git not found — no local history (nothing else is affected)';
  }
  try {
    git(vault, ['add', '-A']);
    try {
      git(vault, ['commit', '-q', '-m', 'brain: initial scaffold']);
    } catch {
      git(vault, [
        '-c',
        'user.name=exposurie',
        '-c',
        'user.email=exposurie@localhost',
        'commit',
        '-q',
        '-m',
        'brain: initial scaffold',
      ]);
    }
    return 'initialised, 1 commit — local only, no remote';
  } catch {
    return 'initialised, nothing committed yet';
  }
}

/** Write a file only if it is absent. Returns true when it actually wrote. */
function writeIfAbsent(path, text) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return true;
}

export function scaffold({ at } = {}) {
  const d = detect();
  const asked = expandPath(at);

  // The dangerous one. With an unreadable pointer we cannot see the brain that
  // already exists, so scaffolding would build a second at the default path and
  // leave the real one orphaned — holding everything, referenced by nothing.
  if (d.configError && !asked) {
    return {
      code: ERROR,
      state: { vault: null, self: 'scaffold', brokenPointer: true },
      error: brokenConfig(d.configError),
    };
  }

  const target = asked || d.vault || DEFAULT_VAULT;

  // One brain per person is a design decision, so a second location is almost
  // always a mistake rather than an intent. Refusing is recoverable; silently
  // re-pointing the config orphans a brain that still holds everything.
  if (d.vault && asked && asked !== d.vault) {
    return {
      code: ERROR,
      state: vaultState(d.vault, 'scaffold'),
      error: {
        message:
          `A brain already exists at ${tilde(d.vault)}, and a brain is meant to span ` +
          `everything rather than sit one per project. Nothing was written to ` +
          `${tilde(asked)}. To move it, move the folder yourself and then edit ` +
          `"vault" in ${tilde(configPath())}.`,
        // FIX is one short action on purpose: it is never wrapped, because
        // wrapping a command breaks it, and a test pins the length.
        fix: `RUN: ${cmd('scaffold')}   (tops up the brain that exists)`,
      },
    };
  }

  // THE INSTALL GATE. scaffold writes a pointer into every client's global
  // instructions naming the command that reads the brain, plus a skill and a
  // slash command that name it too — so that command has to be one that still
  // exists tomorrow. It used to be allowed to name a slower fallback form
  // instead, which meant scaffold could always proceed. That form is gone as of
  // 2026-08-29, so the guarantee moves here: rather than writing a pointer that
  // resolves slowly, we decline to write one at all until the real command is
  // on PATH.
  //
  // It is HUMAN and not ERROR, and the distinction is the whole output
  // contract: nothing failed and nothing is broken. One line typed by a person
  // is outstanding, and `init` has been saying so first for a release already.
  // Refusing here is what makes that step load-bearing rather than advisory.
  const install = installState();
  if (!install.permanent) {
    return {
      code: HUMAN,
      state: { vault: null, self: 'scaffold' },
      body: [
        'NOT INSTALLED — nothing was written',
        ...wrap(
          `There is no exposurie command on this PATH, and scaffold's whole job ` +
            `is writing files that name one: a pointer into every client's ` +
            `global instructions, a skill, and a slash command. Written now they ` +
            `would be correct prose naming a command that is not there — no ` +
            `error, ever, and retrieval simply never happens.`,
          74,
          '  ',
        ),
        '',
        '  ONE LINE, AND IT IS THE ONLY INSTALL STEP',
        `      RUN: ${INSTALL}`,
        '',
        ...wrap(
          `Then run scaffold again. Everything it writes is reversible in one ` +
            `command a person can type, which leaves their own files ` +
            `byte-identical and never touches the brain.`,
          74,
          '  ',
        ),
      ],
    };
  }

  const fresh = !isVault(target);
  const v = version();
  const seam = readSeam(target) || seamDefaults(v);

  mkdirSync(target, { recursive: true });
  for (const rel of dirs(seam)) mkdirSync(join(target, rel), { recursive: true });

  const created = [];
  const kept = [];
  const copied = { ...(seam.copied || {}) };

  for (const [src, dest, what] of COPY) {
    const text = readFileSync(join(TEMPLATES, src), 'utf8');
    if (writeIfAbsent(join(target, dest), text)) {
      created.push([slash(dest), `${what} — yours now`]);
      // Record what we wrote and what it looked like, so a later version can
      // tell "untouched, safe to offer an update" from "they tuned it". It is
      // never the basis for applying one.
      copied[slash(dest)] = { version: v, sha256: sha256(text) };
    } else {
      kept.push([slash(dest), 'already there, not touched']);
    }
  }

  let newTemplates = 0;
  const pages = readdirSync(join(TEMPLATES, 'pages'));
  for (const name of pages) {
    const text = readFileSync(join(TEMPLATES, 'pages', name), 'utf8');
    if (writeIfAbsent(join(target, '.exposurie', 'templates', name), text)) {
      copied[`.exposurie/templates/${name}`] = { version: v, sha256: sha256(text) };
      newTemplates += 1;
    }
  }
  if (newTemplates) {
    created.push([
      '.exposurie/templates/',
      `${newTemplates} page template${newTemplates === 1 ? '' : 's'} — yours now`,
    ]);
  } else {
    kept.push(['.exposurie/templates/', `${pages.length} page templates, not touched`]);
  }

  seam.copied = copied;
  seam.version = seam.version || v;
  if (!seam.created) seam.created = new Date().toISOString();
  writeSeam(target, seam);

  const gitStatus = initGit(target);

  // The pointer every later command reads to find the brain, from any folder.
  // Machine-level and ours; the seam config inside the brain is the user's.
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(
    configPath(),
    JSON.stringify({ vault: target, version: v, created: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );

  // The brain's own CLAUDE.md is the schema and it is large on purpose, but it
  // only loads inside the brain folder — and nobody works there. Without this,
  // a user's agent sitting in a code repo has no idea a brain exists.
  //
  // The pointer names `exposurie`, and the gate above is what earns the right
  // to write that unconditionally. A pointer naming a command nothing installed
  // is how retrieval died silently for a whole release — correct prose naming a
  // command that is not there, so it never errors and never runs.
  const reach = reachAll({ text: pointer(install.invocation) });

  // The other half of reaching the brain, and the half that belongs to the
  // person rather than to their agent. The pointer tells an agent the brain
  // exists on every message; these give the user one token to type when they
  // want it brought up to date, and give the agent a procedure too long to have
  // ever fitted in the pointer. Same table discipline and the same
  // skip-if-absent rule, on the opposite side of the context budget — the
  // reasoning is in surfaces.js.
  //
  // It takes the same invocation for the same reason the pointer does: a file
  // naming `exposurie` on a machine where nothing installed it is correct prose
  // naming a command that is not there, and it fails by never running.
  const surf = surfacesAll({ vault: target, cmd: install.invocation });

  const open = unresolved(stepCtx(d, target), [
    'claude-code-retention',
    'claude-web-export',
    'chatgpt-web-export',
    'obsidian',
  ]);
  // Now that a brain exists, an open step is mirrored to disk as well as
  // printed. Auto mode blows past a terminal; a file is still there tomorrow.
  // The same call clears the ones no longer owed — a second scaffold on a
  // machine where the user has since done a step must not re-litter the brain.
  mirror(target, open);

  // The seam is listed even though writeSeam always runs: it is the one file
  // both sides read, so a person editing folder names needs to know it is there.
  if (fresh) {
    created.push(['.exposurie/config.json', 'the seam — folder names, exclusions, guards']);
  } else {
    kept.push(['.exposurie/config.json', 'the seam — your settings kept, stamps refreshed']);
  }

  const rows = [['brain', tilde(target)], ...created, ['git', gitStatus]];

  const reachRows = reach.map((c) => [
    c.id,
    `${c.action} — ${tilde(c.file)}${c.verified ? '' : '   (location unconfirmed)'}`,
  ]);

  const surfRows = surf.map((c) => [
    `${c.id} ${c.kind}`,
    `${c.action} — ${tilde(c.file)}${c.verified ? '' : '   (location unconfirmed)'}`,
  ]);

  // Named separately from the rows because the relay line is about what the
  // PERSON can now do, and only the typed surface gives them anything. A skill
  // written into a client is still the agent's to reach for; telling a user
  // they can "type" one would be telling them something untrue.
  const typed = [...new Set(surf.filter((c) => c.kind === 'command').map((c) => c.name))];

  const body = [
    ...block(fresh ? 'CREATED' : 'TOPPED UP', rows),
    ...(kept.length ? ['', ...block('KEPT — yours, not touched', kept)] : []),
    '',
    'REACH — so the agent knows this exists from any folder',
    ...(reachRows.length
      ? block('', reachRows).filter((l) => l.trim() !== '')
      : ['  no supported client found — nothing written']),
    ...block('', [['names', `${install.invocation} read --search "<topic or project>"`]]).filter(
      (l) => l.trim() !== '',
    ),
    ...wrap(
      'A few hundred bytes per client, between exposurie markers, appended to a ' +
        'file that otherwise belongs to the user. The schema stays in the brain. ' +
        'It comes back out whenever they want, in one command they can type ' +
        `themselves — \`${install.invocation} uninstall\` — which leaves their ` +
        'own files byte-identical and never touches the brain.',
      74,
      '  ',
    ),
    '',
    'YOURS TO TYPE — the sync, without having to ask an agent for it',
    ...(surfRows.length
      ? block('', surfRows).filter((l) => l.trim() !== '')
      : ['  no supported client found — nothing written']),
    ...(typed.length
      ? [
          '',
          ...wrap(
            `TELL YOUR USER: they can type /${COMMAND_NAME} in ` +
              `${and(typed)} to sync their brain themselves, whenever they want ` +
              `it caught up. They do not have to explain what that means to you ` +
              `first, and they can read the file to see exactly what it does.`,
            74,
            '  ',
          ),
        ]
      : []),
    '',
    ...wrap(
      'These are whole files, ours end to end — not a block inside a file of ' +
        'theirs — so uninstall deletes them outright rather than editing around ' +
        'anything. What they run is `.exposurie/sync.md` inside the brain, which ' +
        'is the user\'s and is never overwritten.',
      74,
      '  ',
    ),
    '',
    'BACKUP',
    ...wrap(
      'This brain is on one disk. git gives local history and undo, which covers ' +
        'an agent mangling a page; it does not survive the disk dying. exposurie ' +
        'will never create a remote for you, because a visibility setting wrong ' +
        'once publishes every conversation the user has ever had with an AI.',
      74,
      '  ',
    ),
    '  TELL YOUR USER: their brain is local-only until they configure a remote.',
    '',
    ...planBlock([
      { read: join(target, 'CLAUDE.md') },
      { read: join(target, '.exposurie', 'wiki-prompt.md') },
      {
        read: join(target, '.exposurie', 'examples.md'),
        note:
          'Worked examples of a good page and three ways one goes wrong. Rules ' +
          'produce median pages; this is the part that transfers by example.',
      },
    ]),
    '',
    ...wrap(
      'Those belong to the user now, not to us. They are meant to be ' +
        'edited as the brain finds its shape, and exposurie will never overwrite ' +
        'them.',
      74,
      '  ',
    ),
  ];

  return {
    code: open.length ? HUMAN : OK,
    state: vaultState(target, 'scaffold'),
    pending: open.map((s) => ({ ...s, ctx: { vault: target, settings: d.retention?.path } })),
    body,
    json: {
      brain: target,
      fresh,
      created: created.map(([f]) => f),
      kept: kept.map(([f]) => f),
      git: gitStatus,
      config: configPath(),
      install: { permanent: install.permanent, invocation: install.invocation },
      reach: reach.map((c) => ({ id: c.id, file: c.file, action: c.action, verified: c.verified })),
      surfaces: surf.map((c) => ({
        id: c.id,
        kind: c.kind,
        file: c.file,
        action: c.action,
        verified: c.verified,
      })),
      command: COMMAND_NAME,
      pending: open.map((p) => p.id),
    },
  };
}
