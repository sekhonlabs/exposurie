// Putting the newest release on the machine, as part of `update`.
//
// The counterpart of package-removal.js, with the same guards for the same
// reason. `npm install -g` resolves npm's OWN global prefix, which has nothing
// to do with a sandbox HOME, so a test that reached a real install would put
// the package onto the developer's machine -- the suite reaching past its
// sandbox, the failure package-removal.js already paid for three times. So the
// package is only ever replaced when npm placed the `exposurie` on PATH and it
// is the very copy that is running. Anything else is reported, with the line to
// type, and left alone.
//
// It updates exactly what `uninstall` would remove. A copy npm did not place is
// not a copy npm should be asked to replace.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PACKAGE } from './install.js';
import { npm, installedPackageDir, runningCopy } from './package-removal.js';

/**
 * What npm actually put on disk, read from the file.
 *
 * Never from this process: the running copy's version is the OLD one, and
 * `version()` reads package.json lazily, so after npm has replaced the folder
 * even this process would report the new number. The caller takes its "before"
 * reading first, and this is the "after".
 */
export function installedManifest(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The first line of npm's complaint that says something, for the person to read. */
function firstLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /error/i.test(l)) || lines[0] || '';
}

/**
 * Replace the package with the newest release.
 *
 * Returns what happened, never a promise about it:
 *
 *   { action: 'absent' }                             no exposurie on PATH
 *   { action: 'foreign', reason }                    not npm's copy, or not this one
 *   { action: 'installed', dir, manifest }           npm ran; manifest is what is on disk now
 *   { action: 'failed', dir, detail, permission }    npm ran and refused
 *
 * `permission` is true when npm was refused write access to its own global
 * folder -- on macOS and Linux that is a prefix owned by root, which only a
 * person can get past, because nothing here ever prompts for a password.
 */
export function updatePackage(
  binary,
  run = npm,
  dirOf = installedPackageDir,
  same = runningCopy,
  manifestOf = installedManifest,
) {
  if (!binary) return { action: 'absent' };

  // The same two guards as removal, each under its own name: one set by the
  // suite's env file, one set by node:test itself and inherited by everything
  // it spawns, so running a single test file by hand cannot reach npm either.
  // '0' is the explicit opt-out for the unit tests, which inject their own
  // runner and touch nothing real.
  if (process.env.EXPOSURIE_SKIP_PACKAGE_UPDATE === '1') {
    return { action: 'foreign', reason: 'package updates are disabled in this environment' };
  }
  if (process.env.NODE_TEST_CONTEXT && process.env.EXPOSURIE_SKIP_PACKAGE_UPDATE !== '0') {
    return { action: 'foreign', reason: 'package updates are disabled under the test runner' };
  }

  const pkgDir = dirOf(binary);
  if (!pkgDir) {
    return { action: 'foreign', reason: `npm did not install the copy at ${dirname(binary)}` };
  }
  if (!same(pkgDir)) {
    return {
      action: 'foreign',
      reason: 'the exposurie on your PATH is a different copy from the one running this command',
    };
  }

  // No timeout: this downloads, and killing npm halfway through rewriting a
  // global install is how a machine ends up with no working copy at all.
  const r = run(['install', '-g', PACKAGE], { timeout: 0 });
  if (r.error || r.status !== 0) {
    const text = String(r.stderr || r.error?.message || '');
    return {
      action: 'failed',
      dir: pkgDir,
      detail: firstLine(text) || 'npm exited non-zero',
      permission: /\bEACCES\b/.test(text),
    };
  }
  return { action: 'installed', dir: pkgDir, manifest: manifestOf(pkgDir) };
}
