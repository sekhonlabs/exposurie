// Tests for the shapes an export actually arrives in.
//
// A 1,164-conversation ChatGPT export sat in Downloads on the first machine
// somebody who did not build this ever installed it on, and the tool never saw
// it. Not a parse failure — the parser was correct and had never been given a
// chance to prove it. Two reasons, both about shape:
//
//   1. OpenAI delivered it ALREADY UNPACKED, into a dated folder, and
//      `findExports` only ever looked at `*.zip`.
//   2. Inside there was no `conversations.json`. It was split across
//      `conversations-000.json` ... `conversations-011.json`, and the sniffer
//      required that literal name.
//
// It reached the parser only because it was repackaged by hand first, and then
// read 1,157 of 1,164 with no error. **A reader nothing reaches is worth what a
// broken one is, and it is harder to notice, because everything it does report
// is right.**
//
// So these tests are about DISCOVERY, and they are written per shape rather
// than per vendor. Anthropic splits large accounts across numbered zips and
// anybody can unzip either vendor's download by hand, so the four shapes below
// are one bug with four faces — and fixing it for ChatGPT alone would have left
// the same hole open on the other side, which is exactly what happened the
// first time, when `batch-000N` was handled and `conversations-000.json` was not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-shapes-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  return h;
}

/** One ChatGPT conversation, as a tree with `current_node`, like the real thing. */
const gpt = (id, title, q, a) => ({
  title,
  conversation_id: id,
  create_time: 1756000000,
  update_time: 1756000100,
  current_node: 'n2',
  mapping: {
    n0: { id: 'n0', parent: null, children: ['n1'], message: null },
    n1: {
      id: 'n1',
      parent: 'n0',
      children: ['n2'],
      message: { id: 'n1', author: { role: 'user' }, create_time: 1756000000, content: { content_type: 'text', parts: [q] } },
    },
    n2: {
      id: 'n2',
      parent: 'n1',
      children: [],
      message: { id: 'n2', author: { role: 'assistant' }, create_time: 1756000050, content: { content_type: 'text', parts: [a] } },
    },
  },
});

/** One claude.ai conversation. */
const claude = (uuid, name, q, a) => ({
  uuid,
  name,
  created_at: '2026-08-20T10:00:00Z',
  updated_at: '2026-08-20T10:05:00Z',
  chat_messages: [
    { uuid: 'm1', sender: 'human', created_at: '2026-08-20T10:00:00Z', text: q, content: [{ type: 'text', text: q }] },
    { uuid: 'm2', sender: 'assistant', created_at: '2026-08-20T10:01:00Z', text: a, content: [{ type: 'text', text: a }] },
  ],
});

const write = (dir, name, value) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
};

/** Everything the sync staged, as one string. */
function stagedText(h) {
  const d = join(h, 'brain', '.exposurie', 'staged');
  if (!existsSync(d)) return '';
  return readdirSync(d)
    .map((b) => {
      const p = join(d, b, 'conversations.md');
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    })
    .join('\n');
}

// ------------------------------------------------------------------ the point
test('an unpacked ChatGPT export, split across numbered parts, is found and read whole', () => {
  // The exact shape that was invisible: a dated folder, no zip anywhere, and no
  // file called `conversations.json` in it.
  const h = home();
  const dir = join(h, 'Downloads', 'ChatGPT-2026-08-26');
  write(dir, 'conversations-000.json', [gpt('c1', 'Postgres', 'PART-ZERO: should we use postgres?', 'yes.')]);
  write(dir, 'conversations-001.json', [gpt('c2', 'Hiring', 'PART-ONE: how do i hire a first engineer?', 'slowly.')]);
  write(dir, 'chat.html', '<html>chatgpt</html>');

  const seen = run(h, ['init']).out;
  assert.match(seen, /chatgpt chats\s+export found/, 'init never saw the export');

  run(h, ['scaffold']);
  const synced = run(h, ['sync']).out;
  assert.match(synced, /2 from chatgpt/, 'the parts were not read as one corpus');

  const text = stagedText(h);
  assert.match(text, /PART-ZERO/, 'the first part never reached the brain');
  assert.match(text, /PART-ONE/, 'the second part never reached the brain — only one file was read');
});

test('an unpacked claude.ai export, split the same way, is found and read whole', () => {
  // Not symmetry for its own sake. Anthropic's numbered ZIPS were handled and
  // numbered FILES were not, and unzipping either vendor's download by hand
  // produces this. Fixing one vendor would have left the other half in place.
  const h = home();
  const dir = join(h, 'Downloads', 'data-2026-08-26');
  write(dir, 'conversations-000.json', [claude('u1', 'Ledger', 'CLAUDE-ZERO: why did we drop the ledger?', 'margins.')]);
  write(dir, 'conversations-001.json', [claude('u2', 'Naming', 'CLAUDE-ONE: what do we call it?', 'exposurie.')]);
  write(dir, 'users.json', [{ uuid: 'me' }]);

  assert.match(run(h, ['init']).out, /claude\.ai chats\s+2 conversations/, 'init counted an export it had found as empty');

  run(h, ['scaffold']);
  assert.match(run(h, ['sync']).out, /2 from claude\.ai/);
  const text = stagedText(h);
  assert.match(text, /CLAUDE-ZERO/);
  assert.match(text, /CLAUDE-ONE/);
});

test('the count init prints is of every part, not of the first one', () => {
  // init is where somebody is still standing next to the download and can ask
  // for it again. Reporting 1 conversation for a 12-part export is the version
  // of this bug that survives being found, because the export IS detected.
  const h = home();
  const dir = join(h, 'Downloads', 'data-2026-08-26');
  write(dir, 'conversations-000.json', [claude('u1', 'A', 'one', 'x')]);
  write(dir, 'conversations-001.json', [claude('u2', 'B', 'two', 'y')]);
  write(dir, 'conversations-002.json', [claude('u3', 'C', 'three', 'z')]);
  write(dir, 'users.json', [{ uuid: 'me' }]);

  assert.match(run(h, ['init']).out, /claude\.ai chats\s+3 conversations/);
});

test('parts are read in numeric order, not lexical', () => {
  // `conversations-10.json` sorts before `conversations-2.json` as a string.
  // OpenAI pads its numbers and nothing promises it always will, so the order a
  // person's history is written in should not rest on that.
  const h = home();
  const dir = join(h, 'Downloads', 'ChatGPT-export');
  write(dir, 'conversations-2.json', [gpt('c2', 'Second', 'ORDER-SECOND', 'b')]);
  write(dir, 'conversations-10.json', [gpt('c10', 'Tenth', 'ORDER-TENTH', 'c')]);
  write(dir, 'conversations-1.json', [gpt('c1', 'First', 'ORDER-FIRST', 'a')]);
  write(dir, 'chat.html', '<html>chatgpt</html>');

  run(h, ['scaffold']);
  run(h, ['sync']);
  const text = stagedText(h);
  for (const s of ['ORDER-FIRST', 'ORDER-SECOND', 'ORDER-TENTH']) {
    assert.match(text, new RegExp(s), `${s} never reached the brain`);
  }
  assert.ok(
    text.indexOf('ORDER-SECOND') < text.indexOf('ORDER-TENTH'),
    'part 10 was read before part 2 — the parts are being sorted as strings',
  );
});

// ------------------------------------------------------------- staying honest
test('a folder that is not an export is still not an export', () => {
  // The detector got broader, and broader is where guessing starts. Conversations
  // and nothing identifying them is refused, exactly as it always was for zips:
  // handing an export to the wrong reader is the failure the sniffer is shaped
  // around.
  const h = home();
  write(join(h, 'Downloads', 'some-project'), 'conversations-000.json', [{ whatever: true }]);
  write(join(h, 'Downloads', 'holiday-photos'), 'notes.txt', 'nothing to see');

  const out = run(h, ['init']).out;
  assert.doesNotMatch(out, /claude\.ai chats\s+\d+ conversations/, 'an unidentified folder was read as a claude export');
  assert.doesNotMatch(out, /chatgpt chats\s+export found/, 'an unidentified folder was read as a chatgpt export');
});

test('an export one folder deep is still found, and the search stops there', () => {
  // OpenAI's own delivery lands directly in Downloads; a person unzipping by
  // hand puts it one level down. Deeper than that is a disk search, which is a
  // different product.
  const h = home();
  const near = join(h, 'Downloads', 'exports', 'ChatGPT-2026-08-26');
  write(near, 'conversations-000.json', [gpt('c1', 'A', 'NEAR-ENOUGH', 'x')]);
  write(near, 'chat.html', '<html>chatgpt</html>');

  const far = join(h, 'Downloads', 'a', 'b', 'c', 'ChatGPT-2026-08-26');
  write(far, 'conversations-000.json', [gpt('c9', 'B', 'TOO-DEEP', 'y')]);
  write(far, 'chat.html', '<html>chatgpt</html>');

  run(h, ['scaffold']);
  run(h, ['sync']);
  const text = stagedText(h);
  assert.match(text, /NEAR-ENOUGH/, 'an export one folder deep was missed');
  assert.doesNotMatch(text, /TOO-DEEP/, 'the scan is walking the whole tree');
});

test('one bad part names itself, and does not take the export down as a whole', () => {
  // "The export is not valid JSON" about a folder holding twelve files is not
  // something a person can act on. The part is.
  const h = home();
  const dir = join(h, 'Downloads', 'data-2026-08-26');
  write(dir, 'conversations-000.json', [claude('u1', 'A', 'fine', 'x')]);
  write(dir, 'conversations-001.json', '{ this is not json');
  write(dir, 'users.json', [{ uuid: 'me' }]);

  run(h, ['scaffold']);
  const out = run(h, ['sync']).out;
  assert.match(out, /conversations-001\.json/, 'the failure did not name the part that failed');
});
