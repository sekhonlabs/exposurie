// After an update: bring what exposurie wrote OUTSIDE the brain up to the
// version that is now installed.
//
// WHY THIS EXISTS. npm replaces the package and nothing else. Setup wrote three
// kinds of file outside the brain -- a pointer block in each agent's global
// instructions file, a slash command, a skill -- and every one of them is ours:
// the README's own table files them under "in the package, we update it".
//
// `sync` already rewrites all three on every run, so after an update they did
// catch up -- at the next sync, and silently. Until then every `read` ran under
// the old release's pointer, and nothing ever said that files of the user's had
// just been edited. This makes the catching-up happen on the FIRST command after
// an update, whichever command that is, and makes it say what it changed.
//
// HOW IT KNOWS. `scaffold` stamps the version that set this machine up into the
// machine config. A copy that finds an OLDER stamp has just been updated, by
// whatever route -- `exposurie update`, the install line typed again, a blanket
// `npm update -g` -- and that is the only signal it needs. No network.
//
// THE RULES IT KEEPS
//
//   - Only ours. The brain's pages, schema, procedures and settings are theirs,
//     and an update never writes a byte of them.
//   - Only a setup that is still live. If nothing of ours is left outside the
//     brain -- uninstalled, or taken out by hand -- an update is not consent to
//     put it back. Setting up is `scaffold`'s job, not this one's.
//   - Only forward. A stamp NEWER than this copy means somebody went back to an
//     older release, and rewriting newer files with older text is not an update.
//   - Only when the command it would name exists -- the gate `scaffold` keeps,
//     because the pointer names `exposurie` and a pointer naming nothing fails
//     silently.
//   - It says what it changed. A file of theirs edited without a word is the
//     thing that makes a person stop trusting a tool with their files.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { configState, configPath, tilde } from './context.js';
import { contextFiles, pointer, reachAll, START } from './reach.js';
import { surfaces, surfacesAll } from './surfaces.js';
import { installState } from './install.js';
import { version } from './version.js';

/**
 * -1, 0 or 1, comparing release numbers part by part.
 *
 * Numeric, because a string comparison puts 1.10.0 BEFORE 1.9.0, and this
 * answer decides whether files get rewritten. A missing or unreadable version
 * reads as 0.0.0: the oldest thing there is, which is what a config written
 * before stamps existed actually is.
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v || '0')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Is anything of ours still outside the brain? A pointer block, or a whole file. */
export function setupLive(home = homedir()) {
  const block = contextFiles(home).some((c) => {
    try {
      return existsSync(c.file) && readFileSync(c.file, 'utf8').includes(START);
    } catch {
      return false;
    }
  });
  return block || surfaces(home).some((s) => existsSync(s.file));
}

/** What happened to each file, in words a person reads. */
const VERB = { created: 'added', updated: 'updated' };

/**
 * Bring ours up to this version, if an older one set this machine up.
 *
 * Returns { from, to, changed, rows, skipped }:
 *   from     the version stamped on this machine, or null with no setup at all
 *   to       this copy's version
 *   changed  { client, kind, action, file } for every file that actually changed
 *   rows     the same, as [label, what] for a person to read
 *   skipped  null when it ran, otherwise the reason it did nothing
 *
 * Cheap enough to call before every command: one small JSON read, and the
 * common answer -- "already current" -- returns before touching anything else.
 */
export function refreshOurs({ home = homedir() } = {}) {
  const to = version();
  const cs = configState();
  if (cs.status !== 'ok') return { from: null, to, changed: [], rows: [], skipped: 'no setup on this machine' };

  const from = cs.config.version || '0.0.0';
  if (compareVersions(from, to) >= 0) return { from, to, changed: [], rows: [], skipped: 'already current' };

  // Not stamped, on purpose: the work is still owed, and the next command that
  // can do it will.
  const install = installState();
  if (!install.permanent) return { from, to, changed: [], rows: [], skipped: 'exposurie is not on PATH' };
  const vault = cs.config.vault;
  if (!vault || !existsSync(vault)) {
    return { from, to, changed: [], rows: [], skipped: 'the brain this machine was set up for is not there' };
  }

  const changed = [];
  if (setupLive(home)) {
    for (const c of reachAll({ home, text: pointer(install.invocation) })) {
      if (VERB[c.action]) changed.push({ client: c.id, kind: 'pointer', action: c.action, file: c.file });
    }
    for (const c of surfacesAll({ home, vault, cmd: install.invocation })) {
      if (VERB[c.action]) changed.push({ client: c.id, kind: c.kind, action: c.action, file: c.file });
    }
  }
  const rows = changed.map((c) => [c.client, `${c.kind} ${VERB[c.action]}   ${tilde(c.file)}`]);

  // Stamped even when nothing was live to refresh: the answer to "is there
  // anything of ours to bring up to date" will not change until `scaffold`
  // runs, and `scaffold` stamps on its own.
  //
  // A stamp that cannot be written costs one repeat of the work above on the
  // next command, and that work is idempotent -- an unchanged file reports
  // `unchanged` and prints nothing. So a failure here is swallowed rather than
  // allowed to fail a `read` the person actually asked for.
  try {
    writeFileSync(configPath(), JSON.stringify({ ...cs.config, version: to }, null, 2) + '\n', 'utf8');
  } catch {
    // See above.
  }
  return { from, to, changed, rows, skipped: null };
}
