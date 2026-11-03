// Tests for updating: `exposurie update`, and the refresh every release does
// on its first run after an update.
//
// The failure these exist for is quiet. npm replaces the package and nothing
// else, so before this, the pointer, the slash command and the skill that setup
// wrote outside the brain stayed as the old release wrote them until the next
// sync rewrote them -- silently, and after every `read` in between had run
// under the old pointer. Every test that
// checks a refresh therefore starts from a machine that looks exactly like
// one an older release set up -- an older stamp, and wording that is not this
// release's -- because a refresh that is only ever tested against files that
// are already current is a refresh that has only been tested doing nothing.
//
// What must hold:
//
//   1. an update brings OURS up to date, says so once, and never again
//   2. it never writes a byte of the brain
//   3. it only goes forward, only on a live setup, only with the command there
//   4. `update` replaces only the copy npm placed and that is running
//   5. the old copy hands over to the new one, and that handoff stays answerable

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareVersions } from '../src/refresh.js';
import { updatePackage } from '../src/package-update.js';
import { update, HANDOFF } from '../src/commands/update.js';
import { NAMES } from '../src/commands/names.js';
import { helpText } from '../src/commands/registry.js';
import { START } from '../src/reach.js';
import { version } from '../src/version.js';

// The unit tests below inject their own npm runner, so they must reach the
// logic they test. Children spawned by this file set the guard back to '1'.
process.env.EXPOSURIE_SKIP_PACKAGE_UPDATE = '0';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');
const V = version();
const OLD = 'Every result names the exact next command.';
const STALE = 'Wording from a release older than this one.';

/** A machine with two clients, exposurie "installed" as a file npm did not place. */
function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-update-'));
  for (const d of ['.claude', '.codex', 'Downloads', 'fakebin']) mkdirSync(join(h, d), { recursive: true });
  writeFileSync(join(h, 'fakebin', process.platform === 'win32' ? 'exposurie.cmd' : 'exposurie'), '', 'utf8');
  return h;
}

function env(h, { onPath = true, extra = {} } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const p = (onPath ? join(h, 'fakebin') + sep : '') + dirname(process.execPath);
  return {
    ...process.env,
    HOME: h,
    USERPROFILE: h,
    PATH: p,
    Path: p,
    EXPOSURIE_SKIP_PACKAGE_UPDATE: '1',
    EXPOSURIE_SKIP_PACKAGE_REMOVAL: '1',
    ...extra,
  };
}

function run(h, args, opts = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: env(h, opts) }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const CLAUDE = (h) => join(h, '.claude', 'CLAUDE.md');
const CONFIG = (h) => join(h, '.exposurie', 'config.json');
const stamp = (h) => JSON.parse(readFileSync(CONFIG(h), 'utf8')).version;

/** Set up with this release, then make the machine look like an older one did it. */
function olderSetup(h, { older = '1.0.0' } = {}) {
  const vault = join(h, 'brain');
  run(h, ['scaffold', '--at', vault]);
  const cfg = JSON.parse(readFileSync(CONFIG(h), 'utf8'));
  writeFileSync(CONFIG(h), JSON.stringify({ ...cfg, version: older }, null, 2), 'utf8');
  const text = readFileSync(CLAUDE(h), 'utf8');
  assert.ok(text.includes(OLD), 'the pointer no longer carries the line this test edits');
  writeFileSync(CLAUDE(h), text.replace(OLD, STALE), 'utf8');
  return vault;
}

/** Every file in the brain, hashed -- so "untouched" means byte-identical, not "still there". */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex') + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

// ------------------------------------------------------ the refresh
test('the first command after an update brings our files up to date, and says so once', () => {
  const h = home();
  olderSetup(h);

  const first = run(h, ['read']);
  assert.match(first.out, new RegExp(`UPDATED TO ${V.replace(/\./g, '\\.')}`));
  assert.match(first.out, /set up by 1\.0\.0/);
  assert.match(first.out, /claude-code\s+pointer updated/);
  const text = readFileSync(CLAUDE(h), 'utf8');
  assert.ok(text.includes(OLD) && !text.includes(STALE), 'the pointer still carries the older wording');
  assert.equal(stamp(h), V, 'the stamp did not move, so this would repeat forever');

  const second = run(h, ['read']);
  assert.doesNotMatch(second.out, /UPDATED TO/, 'the notice repeated after the work was done');
});

test('it rides --version too, which is what a person runs to check an update', () => {
  const h = home();
  olderSetup(h);
  const r = run(h, ['--version']);
  assert.match(r.out, /UPDATED TO/);
  assert.match(r.out, /VERSION/);
});

test('a refresh never writes a byte of the brain', () => {
  const h = home();
  const vault = olderSetup(h);
  const before = snapshot(vault);
  run(h, ['read']);
  assert.deepEqual(snapshot(vault), before);
});

test('it only goes forward: a newer stamp means somebody went back, and nothing is rewritten', () => {
  const h = home();
  olderSetup(h, { older: '99.0.0' });
  const r = run(h, ['read']);
  assert.doesNotMatch(r.out, /UPDATED TO/);
  assert.ok(readFileSync(CLAUDE(h), 'utf8').includes(STALE), 'an older release rewrote newer files');
  assert.equal(stamp(h), '99.0.0');
});

test('a setup somebody took apart is not put back by an update', () => {
  // An update is not consent to reinstall what somebody removed. This is the
  // machine a 1.2.0 uninstall left behind: every pointer and file gone, but the
  // config still there with its old stamp -- so the next install of the package
  // must not read that stamp as "bring the pointers up to date".
  const h = home();
  olderSetup(h);
  run(h, ['uninstall']);
  mkdirSync(dirname(CONFIG(h)), { recursive: true });
  writeFileSync(CONFIG(h), JSON.stringify({ vault: join(h, 'brain'), version: '1.0.0' }), 'utf8');

  const r = run(h, ['read']);
  assert.doesNotMatch(r.out, /UPDATED TO/);
  const pointerBack = existsSync(CLAUDE(h)) && readFileSync(CLAUDE(h), 'utf8').includes(START);
  assert.equal(pointerBack, false, 'an update put the pointer back');
  assert.equal(existsSync(join(h, '.codex', 'AGENTS.md')), false, 'an update recreated a file uninstall removed');
  assert.equal(stamp(h), V, 'nothing live to refresh, so the stamp should still move');
});

test('it waits for the command to exist, because the pointer names it', () => {
  const h = home();
  olderSetup(h);
  const r = run(h, ['read'], { onPath: false });
  assert.doesNotMatch(r.out, /UPDATED TO/);
  assert.ok(readFileSync(CLAUDE(h), 'utf8').includes(STALE));
  assert.equal(stamp(h), '1.0.0', 'the work is still owed, so the stamp must not move');
});

test('--json says what the refresh changed, and stays JSON', () => {
  const h = home();
  olderSetup(h);
  const r = run(h, ['--version', '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.refreshed.from, '1.0.0');
  assert.equal(j.refreshed.to, V);
  assert.ok(j.refreshed.files.some((f) => f.client === 'claude-code' && f.kind === 'pointer'));
});

test('versions compare as numbers, so 1.10.0 is newer than 1.9.0', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.3.0'), -1);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(compareVersions(undefined, '0.0.1'), -1, 'a missing stamp is the oldest thing there is');
});

// ------------------------------------------------------ update, the command
test('update is a command, and help puts it where a person will look', () => {
  assert.ok(NAMES.includes('update'));
  const help = helpText().join('\n');
  assert.match(help, /UPDATING\n {2}exposurie update\n/);
  assert.match(help, /Type it yourself/);
});

test('it never replaces a copy npm did not place, and hands over the line instead', () => {
  const h = home();
  run(h, ['scaffold', '--at', join(h, 'brain')]);
  const r = run(h, ['update']);
  assert.equal(r.code, 10);
  assert.match(r.out, /NOT UPDATED/);
  assert.match(r.out, /RUN: npm install -g @sekhon\/exposurie/);
});

test('npm is asked for exactly one thing: the package, globally, with no timeout', () => {
  const calls = [];
  const r = updatePackage(
    '/x/bin/exposurie',
    (args, opts) => (calls.push([args, opts]), { status: 0, stdout: '', stderr: '' }),
    () => '/x/lib/node_modules/@sekhon/exposurie',
    () => true,
    () => ({ version: '9.9.9' }),
  );
  assert.deepEqual(calls, [[['install', '-g', '@sekhon/exposurie'], { timeout: 0 }]]);
  assert.equal(r.action, 'installed');
  assert.equal(r.manifest.version, '9.9.9');
});

test('a copy npm did not place, or a different copy, is refused before npm runs', () => {
  const never = () => assert.fail('npm ran');
  assert.equal(updatePackage(null, never).action, 'absent');
  assert.equal(updatePackage('/x/exposurie', never, () => null).action, 'foreign');
  assert.equal(updatePackage('/x/exposurie', never, () => '/x/pkg', () => false).action, 'foreign');
});

test('a root-owned global folder is reported as needing a person, not as a crash', () => {
  const r = updatePackage(
    '/x/bin/exposurie',
    () => ({ status: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir\n' }),
    () => '/x/pkg',
    () => true,
  );
  assert.equal(r.action, 'failed');
  assert.equal(r.permission, true);
  assert.match(r.detail, /EACCES/);
});

// ------------------------------------------------------ the handoff
/** A stand-in for a release that does not exist yet, installed where npm would put it. */
function fakeRelease(script, v = '9.9.9') {
  const dir = mkdtempSync(join(tmpdir(), 'exposurie-release-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'next.js'), script, 'utf8');
  const manifest = { version: v, bin: { exposurie: 'bin/next.js' } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
  return { dir, manifest };
}

test('the old copy hands over to the new one, through the bin the NEW release names', () => {
  const rel = fakeRelease(
    `process.stdout.write('from=' + process.env.${HANDOFF} + ' args=' + process.argv.slice(2).join(','));`,
  );
  const r = update({}, { updater: () => ({ action: 'installed', ...rel }) });
  assert.ok(r.passthrough, 'nothing was handed over');
  assert.equal(r.passthrough.stdout, `from=${V} args=update`);
  assert.equal(r.passthrough.code, 0);

  const j = update({ json: true }, { updater: () => ({ action: 'installed', ...rel }) });
  assert.match(j.passthrough.stdout, /args=update,--json/, '--json was not passed on');
});

test('a new copy that cannot finish is reported, and the next command finishes it', () => {
  const rel = fakeRelease(`process.exit(3);`);
  const r = update({}, { updater: () => ({ action: 'installed', ...rel }) });
  assert.equal(r.code, 1);
  assert.match(r.error.message, /npm installed 9\.9\.9/);
  assert.match(r.error.message, /next exposurie command/);
});

test('npm installing the release you already have says so, and hands nothing over', () => {
  const rel = fakeRelease(`throw new Error('should not run');`, V);
  const r = update({}, { updater: () => ({ action: 'installed', ...rel }) });
  assert.equal(r.passthrough, undefined);
  assert.match(r.body.join('\n'), new RegExp(`ALREADY UP TO DATE\\n {2}${V.replace(/\./g, '\\.')} is the newest`));
});

test('THE PROMISE: a release answers the handoff -- it refreshes, reports, and leaves the brain alone', () => {
  // The call every older release will make to this one. If this test has to
  // change shape, every copy already installed out there breaks on update.
  const h = home();
  const vault = olderSetup(h);
  const before = snapshot(vault);

  const r = run(h, ['update'], { extra: { [HANDOFF]: '1.0.0' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`UPDATED\\n {2}1\\.0\\.0 -> ${V.replace(/\./g, '\\.')}`));
  assert.match(r.out, /claude-code\s+pointer updated/);
  assert.match(r.out, /YOUR BRAIN IS UNTOUCHED/);
  assert.ok(readFileSync(CLAUDE(h), 'utf8').includes(OLD));
  assert.deepEqual(snapshot(vault), before);

  const j = JSON.parse(run(h, ['update', '--json'], { extra: { [HANDOFF]: '1.0.0' } }).out);
  assert.equal(j.updated, true);
  assert.equal(j.from, '1.0.0');
  assert.equal(j.to, V);
});

// ------------------------------------------------------ the npm spawn itself
test('npm is spawned without the DEP0190 warning 1.2.0 printed during uninstall', () => {
  const mod = pathToFileURL(join(ROOT, 'src', 'package-removal.js')).href;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { npm } from '${mod}'; const r = npm(['--version']); process.stdout.write(String(r.status));`],
    { encoding: 'utf8' },
  );
  assert.equal(r.stdout, '0', `npm --version did not run: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /DEP0190/);
});

test('nothing that is not a plain token is ever handed to the shell', async () => {
  const { npm } = await import('../src/package-removal.js');
  assert.throws(() => npm(['install', '-g', 'x; echo pwned']), /refusing/);
  assert.throws(() => npm(['install', 'a b']), /refusing/);
});

// ------------------------------------------------------ uninstall's half
test('uninstall takes the machine config too, so "every byte" is true', () => {
  const h = home();
  run(h, ['scaffold', '--at', join(h, 'brain')]);
  assert.ok(existsSync(CONFIG(h)));
  const r = run(h, ['uninstall']);
  assert.match(r.out, /machine config\s+removed/);
  assert.equal(existsSync(CONFIG(h)), false, 'the config survived uninstall, as it did in 1.2.0');
  assert.equal(existsSync(dirname(CONFIG(h))), false, 'the empty folder we made was left behind');
  assert.ok(existsSync(join(h, 'brain', 'CLAUDE.md')), 'the brain was touched');
});

test('the way back names a brain that is not in the default place', () => {
  const h = home();
  const vault = join(h, 'my notes');
  run(h, ['scaffold', '--at', vault]);
  const r = run(h, ['uninstall']);
  assert.match(r.out, /exposurie scaffold --at "~[\\/]my notes"/);
});
