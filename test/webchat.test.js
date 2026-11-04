// The claude.ai export.
//
// These are rules rather than behaviour checks, and each was verified by
// breaking the thing it guards and watching this file go red. The class they
// all belong to is the one this product keeps rediscovering: an export that
// reads as nothing looks exactly like an export with nothing in it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

const CLI = new URL('../bin/exposurie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function home() {
  const h = mkdtempSync(join(tmpdir(), 'exposurie-web-'));
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

/**
 * Build a real zip, by hand, from the format up.
 *
 * A fixture made with a zip library would test that library. This writes the
 * bytes the reader has to parse, so a mistake in the reader shows up here
 * rather than in a user's export six months from now.
 */
function zip(path, files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 14); // crc, unchecked by this reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, body);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
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

const chat = (name, turns, updated = '2026-08-01T00:00:00Z') => ({
  uuid: `uuid-${name}`,
  name,
  summary: '',
  created_at: updated,
  updated_at: updated,
  chat_messages: turns.map(([sender, text], i) => ({
    uuid: `m-${name}-${i}`,
    text,
    content: [{ type: 'text', text }],
    sender,
    created_at: updated,
    attachments: [],
    files: [],
  })),
});

// A real claude.ai export carries users.json beside conversations.json, and the
// detector identifies an archive by what is in it rather than by its name. A
// fixture without it is not a Claude export, so it should not be treated as one.
const putExport = (h, files, file = 'data-test.zip') =>
  zip(join(h, 'Downloads', file), { 'users.json': '[]', ...files });

const stagedText = (h) => {
  const dir = join(h, 'brain', '.exposurie', 'staged');
  const batch = readdirSync(dir).sort().pop();
  return {
    dir: join(dir, batch),
    conversations: readFileSync(join(dir, batch, 'conversations.md'), 'utf8'),
    manifest: readFileSync(join(dir, batch, 'MANIFEST.md'), 'utf8'),
  };
};

// ---------------------------------------------------------------------------

test('a web chat reaches the brain, with no local sessions anywhere', () => {
  // The case the product was built without: somebody who has only ever used
  // claude.ai. They have no transcripts, and for a whole release the tool told
  // them there was nothing to do.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([
      chat('Leaving my job', [
        ['human', 'I am thinking about quitting to build this full time.'],
        ['assistant', 'What is holding you back?'],
      ]),
    ]),
  });

  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.equal(r.code, 0, r.out);

  const { conversations } = stagedText(h);
  assert.match(conversations, /quitting to build this full time/, 'the chat never arrived');
  assert.match(r.out, /from claude\.ai/, 'the output does not say where it came from');
});

test('init offers sync to someone whose only material is the export', () => {
  // Gating the sync step on local sessions is what made the export a dead end:
  // the zip is right there, the count is non-zero, and the plan said nothing.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([chat('Anything', [['human', 'hello there friend']])]),
  });
  run(h, ['scaffold']);

  const r = run(h, ['init']);
  assert.match(r.out, /RUN:\s+exposurie sync/, 'init never offered to read the export');
});

test('a conversation listed with no text is reported, not counted as read', () => {
  // Found on the first real export this was pointed at: 66 of 93 chats arrived
  // with messages and not one word in them, because the export was split across
  // numbered zips and only the first had been downloaded. Treated as "nothing
  // said", four months of someone's life would be marked read and skipped
  // forever.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([
      chat('Real one', [['human', 'this one has words in it']]),
      {
        uuid: 'uuid-hollow',
        name: '',
        summary: '',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
        chat_messages: [
          { uuid: 'h1', text: '', content: [], sender: 'human', created_at: '2026-03-01T00:00:00Z' },
        ],
      },
    ]),
  });

  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.match(r.out, /EXPORT INCOMPLETE/, 'a short export was not reported');

  const { manifest } = stagedText(h);
  assert.match(manifest, /batch-000/, 'the manifest does not explain the split export');

  // and it must not be recorded as read
  const state = JSON.parse(readFileSync(join(h, 'brain', '.exposurie', 'state.json'), 'utf8'));
  const keys = Object.keys(state.pendingBatch?.files || {});
  assert.ok(
    !keys.includes('claude.ai:uuid-hollow'),
    'a conversation with no text was marked as read; a fuller export would never revisit it',
  );
});

test('the same chat in two exports is taken once', () => {
  // Every export is a full snapshot. Keyed by anything but the conversation's
  // own uuid, a person who exported twice gets their brain written from two
  // copies of every chat.
  const h = home();
  const convs = JSON.stringify([chat('Only once', [['human', 'a single distinctive sentence']])]);
  putExport(h, { 'conversations.json': convs }, 'data-old.zip');
  putExport(h, { 'conversations.json': convs }, 'data-new.zip');

  run(h, ['scaffold']);
  run(h, ['sync']);

  const { conversations } = stagedText(h);
  const hits = (conversations.match(/a single distinctive sentence/g) || []).length;
  assert.equal(hits, 1, `the same conversation was staged ${hits} times`);
});

test('what claude.ai remembers is read, and read before the chats', () => {
  // memories.json is the most concentrated file in the archive — prose already
  // distilled about the person. Reading only conversations.json leaves it on
  // the floor.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([chat('Some chat', [['human', 'ordinary talk here']])]),
    'memories.json': JSON.stringify([
      { conversations_memory: 'They are building a lease analyzer and study late.', project_memories: {} },
    ]),
  });

  run(h, ['scaffold']);
  const r = run(h, ['sync']);

  const { dir } = stagedText(h);
  assert.ok(existsSync(join(dir, 'standing.md')), 'standing context was never written');
  assert.match(readFileSync(join(dir, 'standing.md'), 'utf8'), /lease analyzer/);

  const plan = r.out.slice(r.out.indexOf('DO THESE IN ORDER'));
  assert.ok(
    plan.indexOf('standing.md') < plan.indexOf('conversations.md'),
    'the chats are read before the context that makes them legible',
  );
});

test('an attachment body never reaches the brain', () => {
  // A pasted document is a file. Files are a separate, unbuilt capability, and
  // folding their contents in here would ship it by accident.
  const h = home();
  const c = chat('With a paste', [['human', 'what do you make of this?']]);
  c.chat_messages[0].attachments = [
    { file_name: 'lease.txt', file_size: 40, file_type: 'txt', extracted_content: 'RENT-STABILIZED-CLAUSE-42' },
  ];
  putExport(h, { 'conversations.json': JSON.stringify([c]) });

  run(h, ['scaffold']);
  run(h, ['sync']);

  const { conversations } = stagedText(h);
  assert.match(conversations, /what do you make of this/, 'the question was dropped too');
  assert.ok(
    !conversations.includes('RENT-STABILIZED-CLAUSE-42'),
    'an attached file body was ingested as if it were conversation',
  );
});

test('a web chat can be excluded by title, because it has no folder', () => {
  // Without this there is no handle at all: someone with a chat they do not
  // want in their brain could exclude it on their machine and not on the web,
  // and the list would look like it was working.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([
      chat('Therapy notes', [['human', 'PRIVATE-MATERIAL-HERE']]),
      chat('Work thing', [['human', 'a normal work question']]),
    ]),
  });
  run(h, ['scaffold']);

  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.excludeConversations = ['Therapy'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  run(h, ['sync']);
  const { conversations } = stagedText(h);
  assert.ok(!conversations.includes('PRIVATE-MATERIAL-HERE'), 'an excluded web chat was staged');
  assert.match(conversations, /a normal work question/, 'the exclusion took everything with it');
});

test('an unreadable export is named, and does not take the sync down', () => {
  // A half-downloaded zip is a normal thing to happen to a person, and it is
  // indistinguishable from "you have no web chats" unless we say so.
  const h = home();
  writeFileSync(join(h, 'Downloads', 'data-broken.zip'), Buffer.from('PK not really a zip at all'));

  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.notEqual(r.code, 2, `the command crashed: ${r.out}`);
  assert.match(r.out, /EXPORT UNREADABLE|UNREADABLE/i, 'a broken export was swallowed silently');
});

test('an encrypted entry is refused rather than read as empty', () => {
  // The reader must never let "we could not open it" pass for "it was empty".
  const h = home();
  const path = putExport(h, { 'conversations.json': JSON.stringify([chat('x', [['human', 'hi']])]) });
  const buf = readFileSync(path);
  // On the record for conversations.json specifically — the entry that actually
  // gets read. Setting it on whichever record happens to be first tests nothing.
  let cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cd !== -1) {
    const nameLen = buf.readUInt16LE(cd + 28);
    if (buf.toString('utf8', cd + 46, cd + 46 + nameLen) === 'conversations.json') {
      buf.writeUInt16LE(buf.readUInt16LE(cd + 8) | 0x1, cd + 8);
      break;
    }
    cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd + 1);
  }
  writeFileSync(path, buf);

  run(h, ['scaffold']);
  const r = run(h, ['sync']);
  assert.match(r.out, /encrypted|UNREADABLE/i, 'an encrypted entry was reported as no conversations');
});

test('a batch fills up instead of stopping at the first short chat', () => {
  // Newest-first plus a hard stop meant one 2,900-character conversation at the
  // top of the list ended the batch, and a person with a year of history got a
  // first run holding almost nothing. Seen on a real export.
  const h = home();
  const big = 'y'.repeat(80000);
  putExport(h, {
    'conversations.json': JSON.stringify([
      chat('Tiny but newest', [['human', 'short one']], '2026-08-20T00:00:00Z'),
      chat('Enormous', [['human', big]], '2026-08-19T00:00:00Z'),
      chat('Also small', [['human', 'SECOND-SMALL-ONE']], '2026-08-18T00:00:00Z'),
      chat('Small again', [['human', 'THIRD-SMALL-ONE']], '2026-08-17T00:00:00Z'),
    ]),
  });

  run(h, ['scaffold']);
  const cfgPath = join(h, 'brain', '.exposurie', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.guards.batchChars = 20000;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  run(h, ['sync']);
  const { conversations } = stagedText(h);
  assert.match(conversations, /SECOND-SMALL-ONE/, 'the batch stopped at the first oversized chat');
  assert.match(conversations, /THIRD-SMALL-ONE/, 'the batch stopped at the first oversized chat');
  assert.ok(!conversations.includes(big), 'a session over budget was staged anyway');
});

test('a chat unchanged since the last sync is not staged again', () => {
  // A web conversation has no byte offset — an export is a snapshot, not an
  // append-only file — so updated_at is the resumption key.
  const h = home();
  putExport(h, {
    'conversations.json': JSON.stringify([chat('Steady', [['human', 'REPEATED-SENTENCE']])]),
  });
  run(h, ['scaffold']);
  run(h, ['sync']);

  // Write a page so the cutoff is allowed to move, then close the batch.
  writeFileSync(join(h, 'brain', 'wiki', 'entities', 'Someone.md'), '# Someone\n', 'utf8');
  run(h, ['sync', '--done']);

  const second = run(h, ['sync']);
  assert.match(second.out, /NOTHING NEW/, 'an unchanged conversation was staged a second time');
});
