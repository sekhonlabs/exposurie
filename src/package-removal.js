// Taking the package itself off the machine, as part of `uninstall`.
//
// WHY THIS EXISTS. Leaving used to be two commands: `exposurie uninstall` took
// back what we wrote into the user's agent, and `npm uninstall -g` took the
// package off their PATH. The README printed both and explained the split.
//
// His ruling, 2026-08-30, reading that section: *"it shows exposurie uninstall
// as well as npm uninstall, i just clearly want one install, one sync and one
// uninstall command everywhere."*
//
// He is right, and it is the same defect as the npx one a day earlier: two ways
// to do one job, with the difference between them explained rather than
// removed. The design law says WE DECIDE, THE USER IS NEVER HANDED THE
// QUESTION -- and "which of these two lines do I still need to run" is exactly
// a question being handed over, at the one moment somebody has decided to stop
// trusting us and is least willing to read.
//
// THE GUARD, and it is the whole reason this is its own module. `npm uninstall
// -g` resolves ITS OWN global prefix, which has nothing to do with the sandbox
// HOME a test hands us. A test that spawns `uninstall` would therefore reach
// past its sandbox and delete the developer'''s real global install -- the suite
// eating the machine it runs on.
//
// So the package is removed ONLY when the `exposurie` we resolved on PATH sits
// beside an npm-installed copy of this package, checked against npm'''s own
// on-disk layout -- see npmOwns() below, which carries why that is a filesystem
// check and not a question put to npm. The safety property and the correctness
// property are the same check, which is why it is trustworthy rather than
// merely careful: a copy npm did not place is not a copy npm should be asked to
// remove.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE, UNINSTALL } from './install.js';

/**
 * Same spawn shape everywhere: npm is a `.cmd` shim on Windows, so it needs a
 * shell.
 *
 * ONE STRING, NOT AN ARRAY. Since Node 24, handing a shell an args array prints
 * a DEP0190 deprecation warning on stderr, because the array is only joined
 * with spaces and never escaped. 1.2.0 did exactly that, so `uninstall` -- the
 * one command typed with nobody watching -- printed a security warning about
 * itself on the way out. Nothing broke, and that is why no test saw it: it was
 * wrong but well-formed.
 *
 * The parts are all ours (a verb, a flag, the package name), so joining them is
 * safe today. The check makes it safe tomorrow too: anything that is not a
 * plain token is refused rather than handed to a shell, so a future caller
 * cannot pass a path or a user's string through here without being stopped.
 *
 * `timeout` is the caller's: a removal is quick and bounded, but an install
 * downloads, and killing npm halfway through writing a global install is how a
 * machine ends up with no working copy at all. npm bounds its own network waits.
 */
export function npm(args, { timeout = 120000 } = {}) {
  for (const a of args) {
    if (!/^[\w@./=-]+$/.test(a)) throw new Error(`npm: refusing to pass "${a}" through a shell`);
  }
  return spawnSync(['npm', ...args].join(' '), {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout,
  });
}

/**
 * Is the `exposurie` we resolved on PATH one that npm installed globally?
 *
 * Answered from the DISK LAYOUT rather than by asking npm, and the first
 * version did ask npm -- `npm prefix -g`, compared against the binary's own
 * directory. It was wrong in a way worth recording, because nothing about it
 * looked wrong:
 *
 *   npm SCRUBS ITS OWN OUTPUT. npm auth tokens are UUIDs, so @npmcli/redact
 *   replaces anything UUID-shaped with `***` -- including a UUID that is merely
 *   part of a directory path. `npm prefix -g` under such a path returns a
 *   string that is not a path at all, the comparison fails, and the package is
 *   silently left behind while the tool reports it did the right thing.
 *
 * It surfaced in a sandbox whose path carried a session UUID, but it is a real
 * user's bug too, and it is the class this project keeps meeting: TRUSTING A
 * TOOL'S HUMAN-READABLE OUTPUT AS DATA. The fix is not to parse it more
 * carefully; it is not to need it.
 *
 * The layout npm guarantees is enough, and it answers a sharper question than
 * the prefix ever did -- not "is this binary in the folder npm uses" but "is
 * this binary sitting next to an npm-installed copy of OUR package":
 *
 *   Windows   <prefix>\exposurie.cmd    + <prefix>\node_modules\@sekhon\exposurie
 *   POSIX     <prefix>/bin/exposurie    + <prefix>/lib/node_modules/@sekhon/exposurie
 *
 * THIS IS ALSO THE TEST GUARD, and that the two are one check is why it can be
 * trusted rather than merely reviewed. `npm uninstall -g` resolves its own
 * global prefix, which has nothing to do with a sandbox HOME -- so a test that
 * spawned `uninstall` would reach past its sandbox and delete the developer's
 * real install. A fake binary in a temp directory has no `node_modules` beside
 * it, so this returns false, nothing is spawned, and the suite cannot eat the
 * machine it runs on. A copy npm did not place is not a copy npm should be
 * asked to remove.
 */
export function npmOwns(binary, exists = existsSync) {
  if (!binary) return false;
  return Boolean(installedPackageDir(binary, exists));
}

/** Where npm put our package, for a binary npm placed. Null otherwise. */
export function installedPackageDir(binary, exists = existsSync) {
  if (!binary) return null;
  const dir = dirname(binary);
  const pkg = join(...PACKAGE.split('/'));
  for (const c of [join(dir, 'node_modules', pkg), join(dir, '..', 'lib', 'node_modules', pkg)]) {
    if (exists(c)) return resolve(c);
  }
  return null;
}

/**
 * Is the copy npm installed the same copy that is executing right now?
 *
 * ONLY UNINSTALL THE COPY YOU ARE RUNNING. That is the rule, it is the correct
 * rule on its own merits, and it is also the one that makes a test suite safe.
 *
 * WHAT IT COST TO LEARN. The first version guarded only on npm's layout, which
 * covers a spawned test handed a fake binary in a temp directory. It does not
 * cover a test that IMPORTS `uninstall()` and calls it with the real
 * environment -- there the binary is real, npm really did place it, and the
 * guard correctly says yes. `test/uninstall.test.js` does exactly that, so
 * `npm test` deleted the developer's own global install, and the next 93 tests
 * failed because `scaffold` refuses without one. The suite ate the machine it
 * was running on, which is the precise failure the guard existed to prevent,
 * arriving through the one door it did not cover.
 *
 * A checkout is not its installed copy, so running the suite from the repo now
 * declines by construction rather than by anyone remembering to inject a stub.
 *
 * `realpathSync` matters: a linked install (`npm link`, the developer's own
 * machine) points the installed path AT the checkout, and those two really are
 * the same copy. Resolving the link says so, which is right -- somebody who
 * linked it globally did install it globally, and `uninstall` should take it
 * back. Comparing the raw strings would call that foreign and leave it behind.
 */
export function runningCopy(pkgDir, real = realpathSync) {
  if (!pkgDir) return false;
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    return real(here) === real(pkgDir);
  } catch {
    // One of the two is gone mid-run. Not a reason to spawn a removal.
    return false;
  }
}

/**
 * Take the package off the machine.
 *
 * Returns what actually happened, never a promise about it — the caller prints
 * the truth, including the manual line when we declined or npm failed.
 *
 *   { action: 'absent'  }  nothing was installed
 *   { action: 'removed' }  npm removed it
 *   { action: 'foreign' }  a copy npm did not place; not ours to remove
 *   { action: 'failed', detail }  npm ran and refused
 */
export function removePackage(binary, run = npm, dirOf = installedPackageDir, same = runningCopy) {
  if (!binary) return { action: 'absent' };

  // THE SUITE SAYING IT IS A SUITE, and the reason a structural guard was not
  // enough. This repo is developed through `npm link`, so the installed copy IS
  // the checkout: the binary is real, npm really placed it, and realpath says
  // it really is the copy executing. Every honest check answers "yes, remove
  // it" -- and `npm test` therefore uninstalled the developer's own exposurie,
  // twice, after which 93 tests failed because `scaffold` refuses without one.
  //
  // Set in exactly one place, `test/test.env`, loaded by the `test` script. No
  // user has it and nothing in src/ ever sets it. It is deliberately the LAST
  // resort rather than the first line of this function: the structural guards
  // above still do the real work for everybody who is not this machine, and a
  // flag that short-circuits them entirely would hide their failures.
  if (process.env.EXPOSURIE_SKIP_PACKAGE_REMOVAL === '1') {
    return { action: 'foreign', reason: 'package removal is disabled in this environment' };
  }

  // The same guard, but one nobody has to REMEMBER. The flag above only
  // arrives through `test/test.env`, which only `npm test` loads — so running
  // a single file the ordinary way, `node --test test/uninstall.test.js`, or
  // calling the binary by hand while poking at output, walks straight back
  // into the uninstall this whole function is fenced against. That has now
  // happened three times: twice to `npm test` before the flag existed, and
  // once more during the 1.2.0 audit, from a hand-run `uninstall` in a loop
  // collecting sample output.
  //
  // `NODE_TEST_CONTEXT` is set by node:test itself and inherited by any child
  // it spawns, so it is true exactly when a test is what is asking, needs no
  // wiring in the suite, and cannot be forgotten. A real user never has it.
  // Additive on purpose: it can only ever decline to remove.
  //
  // `'0'` is the explicit opt-out, and package-removal.test.js is the one file
  // that sets it — the unit tests below this line inject their own npm runner,
  // so they touch nothing real and MUST reach the logic they are testing.
  // Spelled as a value rather than as `delete`, because the variable it would
  // have to delete belongs to the test runner rather than to us.
  if (process.env.NODE_TEST_CONTEXT && process.env.EXPOSURIE_SKIP_PACKAGE_REMOVAL !== '0') {
    return { action: 'foreign', reason: 'package removal is disabled under the test runner' };
  }

  const pkgDir = dirOf(binary);
  if (!pkgDir) {
    return { action: 'foreign', reason: `npm did not install the copy at ${dirname(binary)}` };
  }
  if (!same(pkgDir)) {
    return {
      action: 'foreign',
      reason: `the exposurie on your PATH is a different copy from the one running this command`,
    };
  }

  const r = run(['uninstall', '-g', PACKAGE]);
  if (r.error || r.status !== 0) {
    const detail = String(r.stderr || r.error?.message || '').trim().split('\n')[0] || 'npm exited non-zero';
    return { action: 'failed', detail };
  }
  return { action: 'removed' };
}

/**
 * The lines `uninstall` prints about the package.
 *
 * Every branch that is not a clean removal prints `UNINSTALL`, because the one
 * thing a person must never be left with is a machine in a state we described
 * wrongly. Telling somebody it is gone when it is not is worse than telling
 * them to run one more line.
 */
export function packageLines(result, binary, wrap, tilde) {
  const W = 74;
  const I = '  ';
  switch (result.action) {
    case 'removed':
      return wrap(
        `Removed, so nothing named exposurie is left on this machine. That was ` +
          `part of this command rather than a second one for you to remember.`,
        W,
        I,
      );
    case 'absent':
      return wrap(
        `Nothing to remove — there is no exposurie command on this PATH, so the ` +
          `package was never installed here.`,
        W,
        I,
      );
    case 'foreign':
      return [
        ...wrap(
          `Left alone, on purpose — ${result.reason}, so it is not ours to take ` +
            `away. That is usually a linked checkout or a copy you placed there ` +
            `yourself, and removing it is your call:`,
          W,
          I,
        ),
        '',
        `      ${UNINSTALL}`,
      ];
    default:
      return [
        ...wrap(
          `Everything above is done, but npm would not remove the package: ` +
            `${result.detail}. It is still at ${tilde(binary)}. Nothing else is ` +
            `affected — this is the last line, and it is yours:`,
          W,
          I,
        ),
        '',
        `      ${UNINSTALL}`,
      ];
  }
}
