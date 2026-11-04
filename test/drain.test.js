// Tests for the first run reading ALL of it.
//
// THE BUG THESE PIN. A batch is bounded so it fits in the AGENT's context — it
// was never a limit on how much of a person's history gets read. The loop is
// what makes those two different things, and the loop was a sentence of prose
// under the plan: "Run sync again for the next batch."
//
// Rule 2 of the output contract says what happens to those — an instruction
// buried in prose is an instruction skipped — and it was. On a real first run
// over 165 sessions the agent filed the newest seven, reported that 158
// remained, and stopped to ask whether to continue. The backlog only drained
// because the person typed "get each and every session" and then "continue" six
// more times. Every batch after the first was material they had already asked
// for, and the tool turned a decision it owns into a question it billed to them.
//
// So: the continuation is a NUMBERED STEP, it says not to ask, and it stops
// appearing the moment nothing is waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'exposurie.js');

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** A machine with `n` finished sessions, each big enough to matter to the budget. */
function machine(n, charsEach = 58000) {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-drain-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  const dir = join(h, '.claude', 'projects', 'thing');
  mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - 3600 * 1000);
  for (let s = 0; s < n; s += 1) {
    const body = 'a decision about the project '.repeat(Math.ceil(charsEach / 29));
    const p = join(dir, `s${s}.jsonl`);
    writeFileSync(
      p,
      [
        JSON.stringify({
          type: 'user', cwd: 'C:/w', sessionId: `s${s}`, timestamp: `2026-08-2${s % 9}T10:01:00Z`,
          message: { role: 'user', content: [{ type: 'text', text: `SESSION-${s} ${body}` }] },
        }),
        JSON.stringify({
          type: 'assistant', cwd: 'C:/w', sessionId: `s${s}`, timestamp: `2026-08-2${s % 9}T10:02:00Z`,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    utimesSync(p, past, past);
  }
  return h;
}

/** Write a page, so `--done` sees the brain actually changed. */
let page = 0;
function wrotePages(h) {
  page += 1;
  writeFileSync(join(h, 'brain', 'wiki', 'entities', `P${page}.md`), `# P${page}\n\nfrom a batch\n`, 'utf8');
}

test('a batch is bounded, and says how much is left over', () => {
  const h = machine(5);
  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.match(r.out, /still waiting/, 'the remainder was never reported');
});

test('REGRESSION: finishing a batch hands back a NUMBERED step to do the next one', () => {
  const h = machine(5);
  run(h, ['scaffold']);
  run(h, ['sync']);
  wrotePages(h);
  const r = run(h, ['sync', '--done']);

  // Numbered, inside DO THESE IN ORDER — not a sentence below it.
  assert.match(r.out, /^\s+\d+\. RUN:\s+exposurie sync$/m, 'continuing was not an ordered step');
  assert.match(r.out, /Do NOT stop to ask whether to continue/, 'the agent was left to decide');
});

test('the loop step disappears the moment nothing is waiting', () => {
  // Otherwise the arrow stops meaning anything, which is the same rule the
  // state line follows: a nudge that fires on nothing teaches an agent to skip
  // every nudge.
  const h = machine(1);
  run(h, ['scaffold']);
  run(h, ['sync']);
  wrotePages(h);
  const r = run(h, ['sync', '--done']);

  assert.match(r.out, /still waiting\s+0/, 'this fixture should drain in one batch');
  assert.ok(!/^\s+\d+\. RUN:\s+exposurie sync$/m.test(r.out), 'told to loop with nothing left to read');
});

test('END TO END: following the plan drains everything, with nobody asked', () => {
  // The whole point. Drive it exactly as an agent following the printed steps
  // would, and assert that every session lands without a human intervening.
  const h = machine(5);
  run(h, ['scaffold']);

  const seen = new Set();
  let guard = 0;
  for (;;) {
    const staged = run(h, ['sync']);
    const m = staged.out.match(/(\d+) staged/);
    if (!m || Number(m[1]) === 0) break;
    for (const s of staged.out.matchAll(/SESSION-(\d+)/g)) seen.add(s[1]);

    // The staged batch names the sessions it holds; read them from the file too
    // so this counts what actually reached disk rather than what was summarised.
    const dir = staged.out.match(/staged[\\/]([\dT:-]+)/);
    if (dir) {
      const conv = join(h, 'brain', '.exposurie', 'staged', dir[1], 'conversations.md');
      try {
        for (const s of readFileSync(conv, 'utf8').matchAll(/SESSION-(\d+)/g)) seen.add(s[1]);
      } catch {}
    }

    wrotePages(h);
    run(h, ['sync', '--done']);
    guard += 1;
    assert.ok(guard < 20, 'the loop did not terminate');
  }

  assert.ok(guard > 1, 'this fixture must take more than one batch, or it proves nothing');
  assert.deepEqual([...seen].sort(), ['0', '1', '2', '3', '4'], 'the drain lost sessions');

  const last = run(h, ['sync']);
  assert.match(last.out, /NOTHING NEW/, 'the drain never reported itself finished');
});

test('the procedure file tells the agent to go back, not to stop', () => {
  const h = machine(1);
  run(h, ['scaffold']);
  const proc = readFileSync(join(h, 'brain', '.exposurie', 'sync.md'), 'utf8');
  assert.match(proc, /GO BACK TO 1/, 'the loop is missing from the procedure the agent follows');
  assert.match(proc, /without asking/i, 'the procedure leaves continuing up for debate');
});

test('init frames the first sync as repeating, not as one batch', () => {
  // init only offers `sync` once there is a brain to sync into, so the step
  // being checked here does not exist before scaffold — which is right, and is
  // why this scaffolds first rather than asserting against a fresh machine.
  const h = machine(2);
  run(h, ['scaffold']);
  const r = run(h, ['init']);
  assert.match(r.out, /RUN:\s+exposurie sync/, 'sync was never offered');
  assert.match(r.out, /THIS REPEATS/, 'the first run reads as a single batch');
});
