// `exposurie update` — the newest release, and everything it owns brought up to
// match it.
//
// TYPED BY A PERSON, IN A TERMINAL, like `uninstall`. Setup is the agent's job,
// because it reads the machine and walks the person through steps. Updating is
// not that: it replaces software on their machine, and on macOS and Linux it can
// need a password that only a person can type. So it is theirs, it speaks to
// them in plain second person, and it works the same when an agent runs it.
//
//   exposurie update
//
// One install, one update, one uninstall. Before this command an update was the
// install line typed again, which replaces the package and nothing else: the
// pointer, the slash command and the skill that setup wrote outside the brain
// stayed as the old release wrote them until the next sync rewrote them,
// silently. Now the new release brings them up to match straight away, and the
// report says what it changed.
//
// IT RUNS IN TWO PROCESSES, because the copy running this command is the old
// one. Its code is already in memory, and once npm has replaced the folder,
// nothing that happens next should be decided by code that is no longer
// installed. So it installs, then hands the rest to the copy that just arrived:
// the same command, in a fresh process, told which version it came from. The
// new copy rewrites its own files and writes the report, so the report always
// describes the release the person now has.
//
// THE HANDOFF IS A PROMISE TO EVERY LATER RELEASE. Code shipped today will one
// day run `update` and hand over to code that does not exist yet -- through the
// `bin` named in that release's package.json, with HANDOFF set. Every release
// after this one must keep answering that call, and test/update.test.js pins
// the shape of it.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { OK, ERROR, HUMAN } from '../exit-codes.js';
import { installState, INSTALL, cmd } from '../install.js';
import { updatePackage, installedManifest } from '../package-update.js';
import { refreshOurs, compareVersions } from '../refresh.js';
import { resolveVault, tilde } from '../context.js';
import { block, wrap } from '../output.js';
import { vaultState } from '../vault.js';
import { version } from '../version.js';

/** What the old copy tells the new one. The name never changes. */
export const HANDOFF = 'EXPOSURIE_UPDATED_FROM';

const W = 74;
const I = '  ';

/** The files a refresh changed, as rows for a person and as data for a script. */
function changedLines(r, intro) {
  if (!r.rows.length) return [];
  return ['', ...wrap(intro, W, I), ...block('', r.rows).filter((l) => l.trim() !== '')];
}

const changedJson = (r) => r.changed.map(({ client, kind, action, file }) => ({ client, kind, action, file }));

/**
 * `updater` is npm's half and `refresher` the rewrite of our own files, both
 * injectable so a test can stand in for a registry, and for a machine, without
 * either being touched. Nothing outside the suite passes them.
 */
export function update({ json = false } = {}, { updater = updatePackage, refresher = refreshOurs } = {}) {
  const from = process.env[HANDOFF];
  if (from) return finish(from);

  // Read BEFORE npm runs. version() reads package.json from disk each time, so
  // once npm has replaced the folder even this process would report the new
  // number -- and "1.3.0 -> 1.3.0" would be printed over a real update.
  const was = version();
  const install = installState();
  const vault = resolveVault();
  const state = vaultState(vault, 'update');
  const r = updater(install.binary);

  if (r.action === 'installed') {
    const now = r.manifest?.version;
    if (!now) {
      return {
        code: ERROR,
        state,
        error: {
          message:
            `npm reported success, but the package it left at ${tilde(r.dir)} cannot be ` +
            `read, so there is no way to tell which release you have.`,
          fix: `RUN: ${INSTALL}`,
        },
        json: { updated: false, from: was, detail: 'installed package unreadable' },
      };
    }
    if (compareVersions(now, was) === 0) return current(was, state, refresher);
    return handOff(r, was, now, json, state);
  }
  return notUpdated(r, was, state);
}

/**
 * The new copy's half: bring its own files up to match, and report.
 *
 * Runs in the process the old copy started, so everything here -- the refresh,
 * the wording, the state line -- is the release that just arrived.
 */
function finish(from) {
  const to = version();
  const vault = resolveVault();
  const r = refreshOurs();

  const nothing =
    r.skipped && r.skipped !== 'already current'
      ? `Nothing it wrote outside your brain was brought up to date: ${r.skipped}.`
      : `Nothing it wrote outside your brain needed changing.`;

  const body = [
    'UPDATED',
    `  ${from} -> ${to}`,
    ...(r.rows.length
      ? changedLines(r, 'It brought its own files outside your brain up to match:')
      : ['', ...wrap(nothing, W, I)]),
    '',
    'YOUR BRAIN IS UNTOUCHED',
    ...(vault ? [`  ${tilde(vault)}`, ''] : []),
    ...wrap(
      `Its pages, schema and procedures are yours, and an update never rewrites ` +
        `them. Your agent keeps working exactly as before, with the new release.`,
      W,
      I,
    ),
  ];

  return {
    code: OK,
    state: vaultState(vault, 'update'),
    body,
    json: { updated: true, from, to, refreshed: changedJson(r) },
  };
}

/** npm installed the release this copy already is. */
function current(was, state, refresher = refreshOurs) {
  // Still worth a refresh: somebody who updated by typing the install line,
  // and then ran this before anything else, has files from the older release
  // and a stamp that says so. This copy IS the installed one, so it can do it.
  const r = refresher();
  return {
    code: OK,
    state,
    body: [
      'ALREADY UP TO DATE',
      `  ${was} is the newest release.`,
      ...changedLines(r, 'It did bring its own files outside your brain up to match it:'),
    ],
    json: { updated: false, version: was, current: true, refreshed: changedJson(r) },
  };
}

/** The entry point a release names for itself, so a moved file cannot strand an update. */
function binOf(manifest) {
  const bin = manifest?.bin;
  if (typeof bin === 'string') return bin;
  return bin?.exposurie || join('bin', 'exposurie.js');
}

function handOff(r, was, now, json, state) {
  const child = spawnSync(process.execPath, [join(r.dir, binOf(r.manifest)), 'update', ...(json ? ['--json'] : [])], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, [HANDOFF]: was },
  });

  if (!child.error && child.stdout) {
    return { passthrough: { stdout: child.stdout, stderr: child.stderr || '', code: child.status ?? OK } };
  }

  // npm did its part and the new release is installed. What did not happen is
  // the new copy rewriting its own files -- and every command it runs checks
  // for exactly that first, so this is finished by the next one, not lost.
  const detail = String(child.stderr || child.error?.message || 'it printed nothing').trim().split('\n')[0];
  return {
    code: ERROR,
    state,
    error: {
      message:
        `npm installed ${now}, but the new copy could not finish the update: ${detail}. ` +
        `Nothing is broken. The next exposurie command you or your agent run ` +
        `finishes it.`,
      fix: `RUN: ${cmd('--version')}`,
    },
    json: { updated: true, from: was, to: now, finished: false, detail },
  };
}

function notUpdated(r, was, state) {
  if (r.action === 'absent') {
    return {
      code: HUMAN,
      state,
      body: [
        'NOT UPDATED',
        ...wrap(
          `There is no exposurie command on this PATH, so there is no installed copy ` +
            `to update. This one line installs the newest release:`,
          W,
          I,
        ),
        '',
        `      RUN: ${INSTALL}`,
      ],
      json: { updated: false, version: was, reason: 'not installed' },
    };
  }

  if (r.action === 'foreign') {
    return {
      code: HUMAN,
      state,
      body: [
        'NOT UPDATED',
        ...wrap(
          `Left alone, on purpose — ${r.reason}, so it is not ours to replace. That ` +
            `is usually a linked checkout or a copy placed there by hand. If you do ` +
            `want the newest release from npm, this is the line:`,
          W,
          I,
        ),
        '',
        `      RUN: ${INSTALL}`,
      ],
      json: { updated: false, version: was, reason: r.reason },
    };
  }

  // npm ran and refused. Say which release is on disk now rather than
  // asserting that nothing changed: npm usually rolls back, and "usually" is
  // not something to print as a fact.
  const onDisk = r.dir ? installedManifest(r.dir)?.version : null;
  const still =
    onDisk && compareVersions(onDisk, was) === 0
      ? `You still have ${was}; nothing was replaced.`
      : onDisk
        ? `The copy on disk now says ${onDisk}.`
        : `Run \`exposurie --version\` to see which release you have.`;

  if (r.permission && process.platform !== 'win32') {
    return {
      code: HUMAN,
      state,
      body: [
        'NEEDS YOUR PASSWORD',
        ...wrap(
          `npm is not allowed to write to its global folder on this machine (${r.detail}). ` +
            `That folder belongs to an administrator, and nothing here ever asks for a ` +
            `password. ${still} Type this yourself:`,
          W,
          I,
        ),
        '',
        `      RUN: sudo ${INSTALL}`,
        '',
        ...wrap(
          `Then run any exposurie command and it finishes the rest itself: the new ` +
            `release brings its own files up to match the first time it runs.`,
          W,
          I,
        ),
      ],
      json: { updated: false, version: was, reason: 'permission', detail: r.detail },
    };
  }

  return {
    code: ERROR,
    state,
    error: {
      message:
        `npm could not update the package: ${r.detail}. ${still} If npm could not ` +
        `reach the registry, run this again once it can; typing ${INSTALL} ` +
        `yourself does the same thing.`,
      fix: `RUN: ${cmd('update')}`,
    },
    json: { updated: false, version: was, reason: 'npm failed', detail: r.detail },
  };
}
