// The tool works out the setup and speaks to THAT setup.
//
// The rule, in the owner's words: never generalise — do not ask a Codex user
// for a claude.ai export, do not print three operating systems' install
// commands to somebody who is on one of them, do not tell a person to pick
// their vault folder when we know where it is.
//
// Each of these was verified by breaking the thing it guards and watching it
// fail. They exist because the opposite shipped: for a whole release, every
// user on earth was asked for a claude.ai export — including people with no
// Claude account, for whom the request could never resolve and therefore
// reprinted at the top of every command, forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import { STEPS, lines, unresolved } from '../src/pending.js';
import { readChatGptExport } from '../src/extract/chatgpt.js';

const CLI = new URL('../bin/exposurie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-setup-'));
  mkdirSync(join(h, 'Downloads'), { recursive: true });
  return h;
}

function run(h, args) {
  const opts = { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, APPDATA: join(h, 'AppData', 'Roaming'), LOCALAPPDATA: join(h, 'AppData', 'Local') } };
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], opts), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

/** A machine with Codex on it and no trace of Claude. */
function codexMachine() {
  const h = home();
  const dir = join(h, '.codex', 'sessions', '2026', '08', '25');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rollout-2026-08-25T00-00-00-abc.jsonl'),
    [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'a', cwd: '/w/app', source: 'cli' } }),
      JSON.stringify({
        timestamp: 't',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a real question about my project' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );
  return h;
}

/** A machine with Claude Code on it and no trace of OpenAI. */
function claudeMachine() {
  const h = home();
  const dir = join(h, '.claude', 'projects', 'thing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'a.jsonl'),
    JSON.stringify({
      type: 'user',
      cwd: '/w/app',
      timestamp: '2026-08-25T00:00:00Z',
      message: { content: [{ type: 'text', text: 'a real question about my project' }] },
    }) + '\n',
    'utf8',
  );
  return h;
}

const client = (id, present = true, readable = true) => ({ id, present, readable });

// -------------------------------------------------------------- who gets asked

test('a Codex user is never asked for a claude.ai export', () => {
  const ctx = { clients: [client('codex')], exports: [], chatgptExports: [] };
  const ids = unresolved(ctx).map((s) => s.id);
  assert.ok(
    !ids.includes('claude-web-export'),
    'a Codex user was asked for a Claude export that may not exist — and it can never resolve',
  );
});

test('a Codex user IS asked for their ChatGPT export', () => {
  const ctx = { clients: [client('codex')], exports: [], chatgptExports: [] };
  const ids = unresolved(ctx).map((s) => s.id);
  assert.ok(ids.includes('chatgpt-web-export'), 'their entire web history was left out with no ask');
});

test('a Claude Code user is asked for claude.ai and not for ChatGPT', () => {
  const ctx = { clients: [client('claude-code')], exports: [], chatgptExports: [] };
  const ids = unresolved(ctx).map((s) => s.id);
  assert.ok(ids.includes('claude-web-export'));
  assert.ok(!ids.includes('chatgpt-web-export'), 'a Claude user got an OpenAI errand');
});

test('an export that already exists is never asked for again', () => {
  const ctx = { clients: [client('codex')], exports: [], chatgptExports: [{ path: 'x.zip' }] };
  const ids = unresolved(ctx).map((s) => s.id);
  assert.ok(!ids.includes('chatgpt-web-export'), 'the ask ignored the file sitting on disk');
});

test('the whole first run of a Codex machine mentions no Claude errand', () => {
  const h = codexMachine();
  const r = run(h, ['init']);
  assert.ok(!/claude\.ai in your browser/i.test(r.out), 'the Claude export walkthrough was printed to a Codex user');
  assert.match(r.out, /chatgpt\.com/i, 'the ChatGPT export was never offered');
});

// ------------------------------------------------------------ os-specific text

test('install instructions name one platform — the one being used', () => {
  const said = lines(STEPS.obsidian, { vault: '/x/brain' }).join('\n');
  const managers = ['winget', 'brew', 'flatpak'].filter((m) => said.includes(m));
  assert.equal(
    managers.length,
    1,
    `${managers.length} package managers printed; the user has to filter, and the agent has to guess`,
  );
});

test('the user is shown the path to their own brain, not told to find it', () => {
  const said = lines(STEPS.obsidian, { vault: '/Users/someone/brain' }).join('\n');
  assert.ok(said.includes('/Users/someone/brain'), 'the brain folder was never named');
  assert.match(said, /graph/i, 'nothing tells them how to actually see the thing');
});

test('the step that cannot fail comes before the step that can', () => {
  // On a real machine the old order — install first, open the folder only "if
  // Obsidian will not install" — cost a Homebrew hang, a killed process, a
  // blocked browser download and a manual install, all before the person had
  // seen one page of their own brain. The folder was openable the entire time.
  const said = lines(STEPS.obsidian, { vault: '/x/brain' }).join('\n');
  const opensFolder = said.search(/open|explorer|xdg-open/);
  const installs = said.search(/brew|winget|flatpak/);
  assert.ok(opensFolder > -1 && installs > -1, 'both halves must be present');
  assert.ok(opensFolder < installs, 'the guaranteed win must come first');
});

test('installing is ONE attempt, with no routing around a block', () => {
  // An agent told to install software keeps trying routes until one works. That
  // is right almost everywhere and wrong here: the thing being retried is
  // optional and the person is watching it happen.
  const said = lines(STEPS.obsidian, { vault: '/x/brain' }).join('\n');
  assert.match(said, /ONE attempt/, 'nothing bounds the retrying');
  assert.match(said, /STOP/, 'no instruction to give up cleanly');
});

test('a placeholder is never quoted into the shape of a runnable command', () => {
  // `init` renders steps before any brain exists. The missing-path fallback was
  // the literal words "the brain folder", substituted into the open command and
  // quoted: `explorer "the brain folder"`. That parses, it runs, and it fails —
  // a command naming nothing, which is the exact defect class this whole pass
  // is about, reintroduced inside the fix for it.
  const said = lines(STEPS.obsidian, {}).join('\n');
  assert.ok(!/["'][^"']*the brain folder[^"']*["']/.test(said), 'a placeholder was quoted as a path');
});

test('init names the brain it is about to create, not a blank', () => {
  const h = codexMachine();
  const out = run(h, ['init']).out;
  const planned = join(h, 'brain');
  assert.ok(out.includes(planned), 'the pending step never named the planned brain path');
});

test('the Obsidian step is done FOR the user, not read out at them', () => {
  // Every line of it is addressed to the agent — "open their brain for them",
  // "walk them in" — so it belongs in the channel that means that. It shipped
  // under "RELAY THESE EXACTLY, do not paraphrase".
  assert.ok(STEPS.obsidian.onYes, 'must be an action the agent takes');
  assert.ok(!STEPS.obsidian.verbatim, 'must not be words read aloud to a person');
});

// ------------------------------------------------------------------- chatgpt

function chatgptZip(path, conversations, extra = {}) {
  const files = {
    'conversations.json': JSON.stringify(conversations),
    'chat.html': '<html></html>',
    ...extra,
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    chunks.push(local, nameBuf, body);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...chunks, cdBuf, eocd]));
  return path;
}

/** A conversation in ChatGPT's real shape: a tree, keyed by node id. */
function gptConversation(title, turns) {
  const mapping = {};
  let parent = null;
  let last = null;
  turns.forEach(([role, text], i) => {
    const id = `${title}-${i}`;
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        create_time: 1700000000 + i,
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    };
    if (parent) mapping[parent].children.push(id);
    parent = id;
    last = id;
  });
  return {
    title,
    create_time: 1700000000,
    update_time: 1700000100,
    conversation_id: `conv-${title}`,
    current_node: last,
    mapping,
  };
}

test('a ChatGPT export is identified by its contents, whatever it is called', () => {
  const h = codexMachine();
  // A name that matches no pattern anyone would guess.
  chatgptZip(join(h, 'Downloads', 'a7f3e9b2-1c4d.zip'), [
    gptConversation('Quitting', [['user', 'DISTINCTIVE-CHATGPT-SENTENCE'], ['assistant', 'ok']]),
  ]);

  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.match(r.out, /from chatgpt/i, `the export was never picked up:\n${r.out}`);
});

test('ChatGPT tool work and hidden text are not conversation', () => {
  const conv = gptConversation('Mixed', [['user', 'the real question']]);
  const extra = {
    id: 'x-tool',
    parent: 'Mixed-0',
    children: [],
    message: {
      id: 'x-tool',
      author: { role: 'tool' },
      create_time: 1700000005,
      content: { content_type: 'execution_output', parts: ['TOOL-OUTPUT-TEXT'] },
      metadata: {},
    },
  };
  const hiddenNode = {
    id: 'x-hidden',
    parent: 'x-tool',
    children: [],
    message: {
      id: 'x-hidden',
      author: { role: 'assistant' },
      create_time: 1700000006,
      content: { content_type: 'text', parts: ['HIDDEN-FROM-THE-USER'] },
      metadata: { is_visually_hidden_from_conversation: true },
    },
  };
  conv.mapping['x-tool'] = extra;
  conv.mapping['x-hidden'] = hiddenNode;
  conv.current_node = 'x-hidden';

  const dir = mkdtempSync(join(tmpdir(), 'exposurie-gpt-'));
  const p = chatgptZip(join(dir, 'export.zip'), [conv]);
  const r = readChatGptExport(p);
  assert.ok(r.ok, r.error);
  const text = r.sessions.flatMap((s) => s.turns.map((t) => t.text)).join(' ');
  assert.ok(text.includes('the real question'));
  assert.ok(!text.includes('TOOL-OUTPUT-TEXT'), 'tool output was ingested as conversation');
  assert.ok(!text.includes('HIDDEN-FROM-THE-USER'), 'text the person never saw was ingested');
});

test('custom instructions become standing context, not a turn repeated forever', () => {
  // The same block hangs off every conversation in the account. Inline, it
  // would be written into a brain several hundred times.
  const a = gptConversation('One', [['user', 'first question']]);
  const b = gptConversation('Two', [['user', 'second question']]);
  for (const c of [a, b]) {
    const id = `${c.title}-ci`;
    c.mapping[id] = {
      id,
      parent: null,
      children: [`${c.title}-0`],
      message: {
        id,
        author: { role: 'user' },
        create_time: 1699999999,
        content: { content_type: 'text', parts: ['I AM A SOLO FOUNDER BUILDING X'] },
        metadata: { is_user_system_message: true },
      },
    };
    c.mapping[`${c.title}-0`].parent = id;
  }

  const dir = mkdtempSync(join(tmpdir(), 'exposurie-gpt-'));
  const r = readChatGptExport(chatgptZip(join(dir, 'export.zip'), [a, b]));
  assert.ok(r.ok, r.error);
  const turns = r.sessions.flatMap((s) => s.turns.map((t) => t.text)).join(' ');
  assert.ok(!turns.includes('I AM A SOLO FOUNDER'), 'custom instructions were repeated as conversation');
  assert.equal(r.instructions.length, 1, 'the same block was kept twice');
  assert.match(r.standing?.memory || '', /SOLO FOUNDER/);
});

test('an export we cannot parse is a reported bug, never an empty account', () => {
  // The whole safety story for a reader written without a real file to check
  // against: if the shape is wrong, the first person to run it must see a
  // named failure rather than a brain that quietly contains nobody.
  const dir = mkdtempSync(join(tmpdir(), 'exposurie-gpt-'));
  const alien = [{ title: 'x', update_time: 1, mapping: { n: { id: 'n', message: null } }, current_node: 'n' }];
  const r = readChatGptExport(chatgptZip(join(dir, 'export.zip'), alien));
  assert.equal(r.ok, false, 'an unreadable export passed as an empty one');
  assert.match(r.error, /bug in exposurie/i, 'the failure does not say whose fault it is');
});

test('a half-downloaded export is reported, not made invisible', () => {
  // Identifying exports by content means a corrupt zip matches nothing and
  // disappears — and the sync then says "nothing has changed" with the file
  // sitting in Downloads.
  const h = codexMachine();
  writeFileSync(join(h, 'Downloads', 'data-cut-short.zip'), Buffer.from('PK truncated'));
  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.match(r.out, /UNREADABLE/i, `a broken export vanished:\n${r.out}`);
});
