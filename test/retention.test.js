// Tests for the retention step — the one that is not about getting more
// material, but about not losing what is already there.
//
// Claude Code deletes its own transcripts after `cleanupPeriodDays`, default
// 30. That is a fact about the machine, not about this tool, and it was found
// the only way it could be: by pointing the reader at three real project
// folders and finding no transcripts in any of them, on a machine whose oldest
// surviving file was 29 days old.
//
// The step therefore has to be right about three things, and each is a test:
// it must NOT fire where the deletion does not happen, it must resolve from
// disk rather than from a claim, and the edit must be the agent's rather than
// something read aloud to a person.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { STEPS, unresolved } from '../src/pending.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function home({ settings, sessions = true } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-retain-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  if (sessions) {
    mkdirSync(join(h, '.claude', 'projects', 'work'), { recursive: true });
    writeFileSync(
      join(h, '.claude', 'projects', 'work', 'a.jsonl'),
      JSON.stringify({
        type: 'user',
        cwd: 'C:/w',
        sessionId: 's',
        timestamp: '2026-08-20T10:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'a real typed sentence about a decision' }] },
      }) + '\n',
      'utf8',
    );
  }
  if (settings !== undefined) {
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  return h;
}

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const claude = [{ id: 'claude-code', present: true, readable: true }];

// ------------------------------------------------------------ it fires
test('a Claude Code user is told their history is being deleted', () => {
  const h = home();
  const r = run(h, ['init']);
  assert.match(r.out, /claude-code-retention/);
  assert.match(r.out, /deleting your history every 30 days/);
});

test('the edit is the agent\'s to make, not something read out to the user', () => {
  // The distinction is the point. Reading JSON instructions aloud turns a
  // one-key edit the agent could do in a second into homework for a person who
  // may never have opened a settings file.
  const h = home();
  const r = run(h, ['init']);
  assert.match(r.out, /IF THEY SAY YES, DO IT YOURSELF — do not read this out/);
  assert.match(r.out, /"cleanupPeriodDays": 3650/);

  // And it is asked, never assumed. This changes software we do not own.
  assert.match(r.out, /ASK YOUR USER/);
});

// ------------------------------------------------------------ it stops
test('it resolves from the file, and only at a real retention window', () => {
  // Detected, never marked — the rule the whole catalog runs on. A step that
  // could be closed by an agent saying so is a step that gets closed wrongly.
  const step = STEPS['claude-code-retention'];
  assert.equal(step.resolved({ retention: { days: 30 } }), false);
  assert.equal(step.resolved({ retention: { days: 90 } }), false, '90 days still loses a year of history');
  assert.equal(step.resolved({ retention: { days: 365 } }), true);
  assert.equal(step.resolved({ retention: { days: 3650 } }), true);
  assert.equal(step.resolved({}), false, 'an unknown setting is not a solved one');
});

test('once the setting is raised, the step disappears from the real command', () => {
  const h = home({ settings: { cleanupPeriodDays: 3650 } });
  const r = run(h, ['init']);
  assert.equal(/claude-code-retention/.test(r.out), false, 'the step nagged a user who had already fixed it');
});

test('the default is read as 30, not as unlimited', () => {
  // The trap in the file: an absent key and an unlimited window look identical,
  // and are opposite. Reading absence as "no cleanup configured" would silence
  // this for every user who has never touched their settings — which is most
  // of them, and exactly the people losing history.
  const h = home({ settings: { model: 'opus' } });
  const r = run(h, ['init']);
  assert.match(r.out, /claude-code-retention/, 'a settings file without the key was read as safe');
});

// ------------------------------------------------------- it stays quiet
test('a user with no Claude Code is never warned about Claude Code', () => {
  // The cries-wolf failure, in the one part of the product that talks to a
  // person: a step that cannot resolve reprints at the top of every command
  // forever. Codex and Cursor keep history on their own terms.
  const step = STEPS['claude-code-retention'];
  assert.equal(step.applies({ clients: [{ id: 'codex', present: true }] }), false);
  assert.equal(step.applies({ clients: [{ id: 'claude-code', present: false }] }), false);
  assert.equal(step.applies({ clients: claude }), true);

  const open = unresolved({ clients: [{ id: 'codex', present: true }], retention: { days: 30 } }, [
    'claude-code-retention',
  ]);
  assert.deepEqual(open, []);
});
