// `exposurie sync` — find what is new, stage it, and never lose it.
//
// Sync is deliberately two halves. The deterministic half is here: find what is
// new, apply the exclusion gate, read conversation out of the transcripts, and
// write a batch. The other half — folding it into pages — is an LLM job, and it
// lives as a procedure file in the brain, so no client's skill format is
// load-bearing and the user can change how their own brain gets written.
//
// Three properties this has to have, and each is a decision:
//
//   NEWEST FIRST, AND RESUMABLE. History is not truncated, because "we only
//   read the last 30 days" is a quality compromise. Instead it is ORDERED, in
//   bounded batches, with the remainder reported. The first run costs the user
//   real quota on their own plan, and one long unbounded job at minute one —
//   before they have any reason to trust this — is how a tool gets uninstalled.
//
//   THE CUTOFF MOVES LAST. It is the only record of what has been read, so
//   advancing it before the pages exist turns an interrupted sync into
//   permanent, silent data loss.
//
//   AND IT MOVES ON EVIDENCE, NOT ON A CLAIM. `--done` checks that the brain
//   actually changed. Nobody ticks a box, and an agent cannot close a batch by
//   assuming it worked.
//
// AND IT CURATES, EVERY TIME. This is the one command a person types after
// setup, so everything that makes the brain better lives inside it rather than
// beside it. Curation is not a phase that starts once the brain is a mess — by
// then the mess IS the brain — so it runs from the very first batch onward, on
// exactly one path per invocation: after `--done`, when pages have just been
// written, and on the nothing-new path, so that typing the command when there
// is no new material still leaves the brain better than it found it.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';

import { detect, brokenConfig, noBrainAt } from '../context.js';
import { block, planBlock, wrap, bytes, shrink } from '../output.js';
import { OK, ERROR, USAGE } from '../exit-codes.js';
import { describe } from '../extract/transcript.js';
import { readExports, renderStanding } from '../extract/webchat.js';
import { readChatGptExports } from '../extract/chatgpt.js';
import { findNewFiles, renderFiles } from '../extract/files.js';
import { redact } from '../extract/redact.js';
import { conversationExcluded } from '../extract/exclude.js';
import { stillBeingWritten } from '../extract/live.js';
import { invocation, cmd } from '../install.js';
import { reachAll, pointer } from '../reach.js';
import { surfacesAll } from '../surfaces.js';
import { curate, report } from '../curate.js';
import { unresolved, mirror, stepCtx } from '../pending.js';
import { readSeam, readState, statePath, vaultState, categoryDirs } from '../vault.js';

const DEFAULT_BATCH_CHARS = 120000;

const stagedDir = (vault) => join(vault, '.exposurie', 'staged');

/**
 * One file, one name.
 *
 * A transcript's identity here is its path, and a path is not unique: a symlink,
 * a junction, or a home directory pointed somewhere else all give the same file
 * two names, and the resume offsets are keyed by name. Reported from the first
 * outside install, where an agent isolating one client by faking `HOME` had the
 * same conversation staged twice — once under each name.
 *
 * The workaround that surfaced it does not matter. This is wrong on its own:
 * `~/.claude` symlinked onto another drive is an ordinary thing to do, and the
 * cost of getting it wrong is a person's own words written into their brain
 * twice.
 *
 * Falls back to the path it was given, because a file that cannot be resolved
 * is a file that will fail to be read a moment later, with a better message.
 */
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
const iso = () => new Date().toISOString();
const stamp = () => iso().replace(/[:.]/g, '-').slice(0, 19);

function writeState(vault, state) {
  mkdirSync(join(vault, '.exposurie'), { recursive: true });
  writeFileSync(statePath(vault), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * The working directory of a session, without reading the session.
 *
 * Exclusion is a gate: a conversation the user excluded must not be loaded at
 * all. Claude Code lines carry `cwd` at the top level; Codex carries it inside
 * session_meta or turn_context payloads. The head of the file answers it, and
 * an excluded transcript is never read past its first 64 KB.
 */
function peekCwd(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    // NOT just the first line. A transcript opens with mode/system lines that
    // carry no `cwd`, so reading one line makes exclusion silently never fire —
    // the user sets a denylist, nothing is excluded, and nothing says so.
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd) return o.cwd;
        if (o.type === 'session_meta' || o.type === 'turn_context') {
          const cwd = o.payload?.cwd;
          if (typeof cwd === 'string' && cwd) return cwd;
        }
      } catch {
        // a line split by the read boundary; keep looking
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Newest activity in the brain's pages, so "did the writing happen" is answerable. */
function newestPageWrite(vault, seam) {
  let newest = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        try {
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {}
      }
    }
  };
  for (const d of categoryDirs(vault, seam)) walk(d);
  for (const f of ['index.md', 'log.md']) {
    const p = join(vault, f);
    if (existsSync(p)) {
      try {
        newest = Math.max(newest, statSync(p).mtimeMs);
      } catch {}
    }
  }
  return newest;
}

/**
 * The curator, run as a stage of this command rather than as a command.
 *
 * It applies the two lossless fixes without asking — bumping a date git proves
 * is wrong, and wrapping a first plain mention in brackets — and reports
 * everything that needs a judgement. Both halves of that were asked for at once
 * and pull against each other productively: lossless, and unattended.
 *
 * The subtlety is in what our own edits mean to the cutoff. `--done` advances
 * only when the brain changed since the batch was staged, which is how an
 * interrupted sync re-stages rather than losing material. A date the curator
 * bumped is a change to the brain that is NOT the pages being written, so it
 * would forge exactly that evidence — and a batch would be marked read that
 * nothing ever read. So when a batch is pending, the watermark moves with our
 * own edits and the evidence check keeps meaning what it says.
 */
function curateStage(vault, seam) {
  const result = curate(vault, seam, { fix: true });
  if (result.fixed.length) {
    const state = readState(vault) || {};
    if (state.pendingBatch) {
      writeState(vault, {
        ...state,
        pendingBatch: { ...state.pendingBatch, pagesAt: newestPageWrite(vault, seam) },
      });
    }
  }
  return {
    body: report(result, vault),
    json: {
      pages: result.pages,
      links: result.links,
      fixed: result.fixed,
      broken: result.broken,
      notice: result.notice,
      retired: result.suppressed,
    },
  };
}

const noBrain = () => ({
  code: ERROR,
  state: { vault: null, self: 'sync' },
  error: {
    message: 'There is no brain on this machine yet, so there is nowhere to put anything.',
    fix: `RUN: ${cmd('scaffold')}`,
  },
});

// --------------------------------------------------------------------- stage
function stage(vault, d) {
  const seam = readSeam(vault) || {};
  const state = readState(vault) || { files: {} };
  const seen = state.files || {};
  const budget = seam.guards?.batchChars || DEFAULT_BATCH_CHARS;

  // Candidates: readable clients only, and only transcripts with unread bytes.
  const candidates = [];
  const clientErrors = [];
  // Two names for one transcript become one candidate. Deduped by the resolved
  // path rather than the listed one, so an aliased client folder cannot put the
  // same conversation in a batch twice.
  const takenPaths = new Set();
  for (const c of d.clients) {
    if (!c.readable || !c.present || typeof c.sessions === 'function') continue;
    for (const raw of c.files) {
      const f = canonical(raw);
      if (takenPaths.has(f)) continue;
      let size;
      try {
        size = statSync(f).size;
      } catch {
        continue;
      }
      // Both keys, on purpose. Offsets recorded before this fix are under the
      // name that was listed, and a brain that has been synced for weeks must
      // not re-stage its whole history because the key got better.
      const from = seen[f]?.bytes ?? seen[raw]?.bytes ?? 0;
      if (size <= from) continue;
      takenPaths.add(f);
      candidates.push({
        kind: 'transcript',
        path: f,
        client: c.id,
        // The reader comes from the client table rather than being assumed, so
        // a rollout is never handed to a parser written for another format.
        read: c.read,
        size,
        from,
        // On this machine, and still being appended to while we read it. The
        // in-flight gate needs to tell that apart from an export snapshot.
        local: true,
        sortAt: statSync(f).mtimeMs,
      });
    }
  }

  // Clients that keep conversations in a database rather than in files. Same
  // resumption contract as a web chat: a row has no byte offset, so freshness
  // is the key.
  for (const c of d.clients) {
    if (!c.readable || !c.present || typeof c.sessions !== 'function') continue;
    const { sessions, error } = c.sessions(c.root);
    if (error) clientErrors.push({ client: c.name, error });
    for (const s of sessions) {
      const prior = seen[s.path];
      if (prior && prior.updatedAt && prior.updatedAt === s.updatedAt) continue;
      candidates.push({
        kind: 'webchat', // "already a session, not a path" — the same handling
        path: s.path,
        client: c.id,
        session: s,
        local: true,
        sortAt: Date.parse(s.updatedAt || s.endedAt || '') || 0,
      });
    }
  }

  // The claude.ai export, which is the other half of a person — and for most
  // people the larger half. Measured on one real account: 264 KB of their own
  // words on the web against 166 KB across every local session. Somebody who
  // has never opened a terminal has the first number and a zero.
  //
  // It is read here rather than by a command of its own because it is the same
  // job: material in, conversation out. A second command would also be a second
  // thing to remember, and forgetting is what this product is against.
  //
  // ONE HONEST DIFFERENCE from a transcript, and it is a property of zips
  // rather than a decision: a conversation's title cannot be known without
  // decompressing the single file that holds every conversation, so the
  // exclusion gate cannot run before the read the way it does for transcripts.
  // It still runs before anything is staged, redacted, or written to disk.
  const claude = readExports(d.exports.map((e) => e.path));
  const gpt = readChatGptExports((d.chatgptExports || []).map((e) => e.path));
  // One list. Which service a conversation came from decides nothing after this
  // point — it is all somebody talking, and the brain does not have a Claude
  // half and an OpenAI half.
  const web = {
    sessions: [...claude.sessions, ...gpt.sessions],
    standing: claude.standing || gpt.standing,
    exports: claude.exports + gpt.exports,
    failed: [
      ...claude.failed,
      ...gpt.failed,
      // Archives that never even opened, so no reader ever saw them.
      ...(d.brokenExports || []).map((e) => ({ path: e.path, error: e.error })),
    ],
    duplicates: claude.duplicates + gpt.duplicates,
    skippedEmpty: claude.skippedEmpty + gpt.skippedEmpty,
    emptyBodies: claude.emptyBodies,
  };
  for (const s of web.sessions) {
    const prior = seen[s.path];
    // A web chat has no byte offset — an export is a snapshot, not an
    // append-only file — so `updated_at` is the resumption key. Unchanged since
    // the last read means skip it whole rather than stage it twice.
    if (prior && prior.updatedAt && prior.updatedAt === s.updatedAt) continue;
    candidates.push({
      kind: 'webchat',
      path: s.path,
      client: 'claude.ai',
      session: s,
      // An export is a snapshot of conversations already finished elsewhere.
      local: false,
      sortAt: Date.parse(s.updatedAt || s.endedAt || '') || 0,
    });
  }

  // Newest first, across both sources: recent context is what makes older
  // material legible, and a sync that stops early then leaves a useful brain
  // rather than an ancient one.
  candidates.sort((a, b) => b.sortAt - a.sortAt);

  // The gate runs over everything first, not inside the batching loop. It is a
  // policy about what may be opened at all, so it cannot depend on where a
  // batch happens to stop — and "still waiting" would otherwise count sessions
  // that are never going to be read.
  const included = [];
  const excluded = [];
  const deferred = [];
  const eligible = [];
  for (const cand of candidates) {
    // In flight before excluded, and before anything is opened. This is the
    // conversation somebody is having RIGHT NOW — most often the one running
    // this very command, plus every subagent it spawned. Reading it makes the
    // tool material to itself, which on a real full drain returned batch after
    // batch of "duplication from the active setup task".
    //
    // It is a DEFERRAL, not the exclusion gate: nothing is lost, the next sync
    // takes it once the conversation has actually ended.
    const live = stillBeingWritten(cand);
    if (live) {
      deferred.push({ path: cand.path, why: live });
      continue;
    }
    const identity =
      cand.kind === 'webchat'
        ? { cwd: null, title: cand.session.project }
        : { cwd: peekCwd(cand.path) };
    const hit = conversationExcluded(identity, seam);
    if (hit) excluded.push({ path: cand.path, why: hit });
    else eligible.push(cand);
  }

  // Files the person put in their brain. Noticed here rather than in a command
  // of its own, for the same reason as everything else: there is one command.
  const rawFiles = findNewFiles(vault, seam, seen);

  const empty = [];
  let chars = 0;
  let redactions = {};

  for (const cand of eligible) {
    const s = cand.kind === 'webchat' ? cand.session : cand.read(cand.path, cand.from);
    if (!s || s.turns.length === 0) {
      // Nothing said in it. Real: 16 of 127 sessions on a measured corpus, and
      // 6 of 93 conversations on a measured export.
      empty.push({
        path: cand.path,
        readTo: cand.kind === 'webchat' ? (s ? s.readTo : 0) : cand.size,
        updatedAt: cand.kind === 'webchat' ? cand.session.updatedAt : undefined,
      });
      continue;
    }

    // Whole sessions only — half a conversation is worse than none, because the
    // half that explains why is usually the half that gets cut. So a session
    // that would blow the budget is left for a batch of its own, and the first
    // session always goes in, or a brain with one enormous session never
    // progresses.
    //
    // It SKIPS rather than stops, and that difference is worth the line: with a
    // stop, one short conversation at the top of the list ends the batch, and a
    // person with a year of history gets a first run holding a single 2,900
    // character chat. That happened on the first real export this was pointed
    // at. Order is still newest-first; what changes is that a big session
    // defers itself instead of ending everyone else's turn.
    if (included.length > 0 && chars + s.chars > budget) continue;

    const r = redact(s.turns.map((t) => t.text).join('\n'));
    if (r.count) {
      for (const [k, n] of Object.entries(r.found)) redactions[k] = (redactions[k] || 0) + n;
      for (const t of s.turns) t.text = redact(t.text).text;
    }

    included.push({ ...s, client: cand.client });
    chars += s.chars;
  }

  // Files alone are a batch. Without this, somebody who only ever drops PDFs in
  // their brain gets "nothing has changed since the last sync" while the folder
  // fills up — the same dead end the claude.ai export used to be.
  if (included.length === 0 && rawFiles.files.length === 0) {
    // The deferral gets its own sentence, and it comes first. Somebody whose
    // only new material is the conversation they are in the middle of would
    // otherwise be told "nothing has changed" while they are visibly changing
    // it — which reads as the tool being broken, and is the same silence this
    // whole file is written against.
    const why = deferred.length && eligible.length === 0
      ? `Nothing finished since the last sync. ${deferred.length} conversation${deferred.length === 1 ? ' is' : 's are'} still ` +
        `going — including this one — and ${deferred.length === 1 ? 'it comes' : 'they come'} on the next sync, once ` +
        `${deferred.length === 1 ? 'it has' : 'they have'} ended. Nothing is lost.`
      : eligible.length === 0
      ? (excluded.length ? `Nothing new outside your exclude list, which held back ${excluded.length} session${excluded.length === 1 ? '' : 's'}.` : 'Nothing on this machine has changed since the last sync.')
      : `${eligible.length} transcript${eligible.length === 1 ? '' : 's'} changed, but none held any conversation — ` +
        'they were tool work with nothing said.';

    // An export that would not open has to be reported HERE too, and this is
    // the path where it matters most: when the export is the only material a
    // person has, a failure to read it lands on "nothing has changed since the
    // last sync" — which is not merely unhelpful, it is false. The bug was
    // real, and it is the house failure class exactly: silence that reads as a
    // clean result.
    const trouble = [];
    for (const f of web.failed) {
      trouble.push(['EXPORT UNREADABLE', `${basename(f.path)} — ${f.error}`]);
    }
    if (web.emptyBodies) {
      trouble.push([
        'EXPORT INCOMPLETE',
        `${web.emptyBodies.count} chats listed with no text in them` +
          (web.emptyBodies.from
            ? ` (${web.emptyBodies.from.slice(0, 10)} to ${web.emptyBodies.to.slice(0, 10)})`
            : ''),
      ]);
    }
    // Sessions with nothing in them are still finished with, or they are
    // re-examined forever.
    if (empty.length) {
      const next = { ...state, files: { ...seen } };
      for (const e of empty) {
        next.files[e.path] = { bytes: e.readTo, updatedAt: e.updatedAt, at: iso() };
      }
      next.lastSyncUtc = iso();
      next.unfiled = 0;
      writeState(vault, next);
    }
    // Nothing new is not nothing to do. The brain still drifts — links break
    // when a page is renamed, an index goes out of date, a date lies about
    // freshness — so the one command a person types still curates.
    const c = curateStage(vault, seam);
    return {
      code: OK,
      state: { ...vaultState(vault, 'sync'), unfiled: 0 },
      body: [
        ...block('NOTHING NEW', [['result', 'nothing to stage'], ...trouble]),
        '',
        ...wrap(why, 74, '  '),
        ...(web.failed.length
          ? [
              '',
              ...wrap(
                'That export could not be opened, so nothing was taken from it. This is ' +
                  'usually a download that stopped early — ask them to download it again, ' +
                  'or to request a fresh export. Nothing already in the brain is affected.',
                74,
                '  ',
              ),
            ]
          : []),
        '',
        ...c.body,
      ],
      json: {
        staged: 0,
        candidates: candidates.length,
        excluded: excluded.length,
        deferred: deferred.length,
        empty: empty.length,
        exports: {
          found: web.exports,
          failed: web.failed.map((f) => ({ path: f.path, error: f.error })),
        },
        curate: c.json,
      },
    };
  }

  const id = stamp();
  const dir = join(stagedDir(vault), id);
  mkdirSync(dir, { recursive: true });

  const rows = included.map(describe);
  const rawTotal = included.reduce((n, s) => n + s.rawBytes, 0);
  const remaining = eligible.length - included.length - empty.length;

  // Standing context goes in front of the batch, not into the queue behind it.
  // It is what claude.ai already knows about the person plus the instructions
  // they wrote for their own projects — small, already distilled, and the thing
  // that makes a year of conversation legible on the first read rather than the
  // fifth. Written on every batch, because a batch is read on its own.
  const standingText = renderStanding(web.standing);
  if (standingText) writeFileSync(join(dir, 'standing.md'), standingText, 'utf8');

  const hasFiles = rawFiles.files.length > 0;
  if (hasFiles || rawFiles.unreadable.length || rawFiles.excluded.length) {
    writeFileSync(join(dir, 'files.md'), renderFiles(rawFiles, vault), 'utf8');
  }

  // A batch can be files only, and then there is no conversation page to write.
  // Writing an empty one would put a heading in front of nothing and make the
  // plan read like something went wrong.
  if (included.length > 0) {
    writeFileSync(join(dir, 'conversations.md'), renderConversations(id, included), 'utf8');
  }
  writeFileSync(
    join(dir, 'MANIFEST.md'),
    renderManifest(id, rows, { excluded, deferred, empty, remaining, chars, rawTotal, redactions, web }),
    'utf8',
  );

  // Recorded, not applied: these offsets become the cutoff only once the pages
  // exist. An abandoned sync must re-stage the same material, not skip it.
  const pending = {
    id,
    stagedAt: iso(),
    files: {},
    sessions: included.length,
    rawFiles: rawFiles.files.length,
  };
  for (const s of included) {
    pending.files[s.path] = { bytes: s.readTo, updatedAt: s.updatedAt, at: iso() };
  }
  for (const e of empty) {
    pending.files[e.path] = { bytes: e.readTo, updatedAt: e.updatedAt, at: iso() };
  }
  // A document has no byte offset — it is not append-only — so size and
  // modification time are what say "this exact file was already handed over".
  for (const f of rawFiles.files) {
    pending.files[f.key] = { size: f.size, mtime: f.mtime, at: iso() };
  }
  writeState(vault, {
    ...state,
    files: seen,
    pendingBatch: { ...pending, pagesAt: newestPageWrite(vault, seam) },
    unfiled: remaining,
  });

  const fromWeb = included.filter((s) => s.surface === 'claude.ai' || s.surface === 'chatgpt').length;
  const fromMachine = included.length - fromWeb;

  // A batch can be conversation, files, or both. Printing "0 sessions, 0 chars,
  // 0 from this machine" to somebody whose brain is entirely documents makes a
  // working sync read like a failed one.
  const summary = [['batch', id]];
  if (included.length > 0 || remaining > 0) {
    summary.push(
      ['sessions', `${included.length} staged${remaining > 0 ? `, ${remaining} still waiting` : ''}`],
      // Where a batch came from is not decoration: someone who has only ever
      // used the web should see their own life in this line, not a zero.
      [
      'from',
      // Named, not lumped. "3 from the web" tells somebody nothing about their
      // own setup; "3 from claude.ai" is a fact about them.
      [
        `${fromMachine} on this machine`,
        ...['claude.ai', 'chatgpt']
          .map((svc) => {
            const n = included.filter((s) => s.surface === svc).length;
            return n ? `${n} from ${svc}` : null;
          })
          .filter(Boolean),
      ].join(', '),
    ],
      [
        'conversation',
        `${chars.toLocaleString('en-US')} chars` +
          (rawTotal > 0
            ? `, out of ${bytes(rawTotal)} of transcript${shrink(rawTotal, chars)}`
            : ''),
      ],
    );
  }
  if (hasFiles || rawFiles.unreadable.length) {
    summary.push([
      'files',
      `${rawFiles.files.length} waiting to be read` +
        (rawFiles.remaining > 0 ? `, ${rawFiles.remaining} after that` : '') +
        (rawFiles.unreadable.length ? `, ${rawFiles.unreadable.length} not readable` : ''),
    ]);
  }
  if (standingText) {
    summary.push([
      'standing',
      `what claude.ai already knows${web.standing?.projects?.length ? `, plus ${web.standing.projects.length} project brief${web.standing.projects.length === 1 ? '' : 's'}` : ''}`,
    ]);
  }
  if (excluded.length) summary.push(['excluded', `${excluded.length} by your exclude list`]);
  if (deferred.length) {
    summary.push(['still going', `${deferred.length} not finished — next sync takes ${deferred.length === 1 ? 'it' : 'them'}`]);
  }
  if (empty.length) summary.push(['no conversation', `${empty.length} skipped`]);
  if (web.duplicates) {
    summary.push(['already had', `${web.duplicates} chats repeated across your exports`]);
  }
  if (web.emptyBodies) {
    summary.push([
      'EXPORT INCOMPLETE',
      `${web.emptyBodies.count} chats listed with no text in them` +
        (web.emptyBodies.from ? ` (${web.emptyBodies.from.slice(0, 10)} to ${web.emptyBodies.to.slice(0, 10)})` : ''),
    ]);
  }
  if (Object.keys(redactions).length) {
    summary.push(['redacted', Object.entries(redactions).map(([k, n]) => `${n} ${k}`).join(', ')]);
  }
  // An export that would not open is reported here rather than swallowed. A
  // half-downloaded zip is a normal thing to happen to a person, and it is
  // indistinguishable from "you have no web chats" unless we say so.
  for (const f of web.failed) {
    summary.push(['EXPORT UNREADABLE', `${basename(f.path)} — ${f.error}`]);
  }
  for (const e of clientErrors) {
    summary.push([`${e.client.toUpperCase()} UNREADABLE`, e.error]);
  }

  return {
    code: OK,
    state: { ...vaultState(vault, 'sync'), unfiled: remaining },
    body: [
      ...block('STAGED', summary),
      '',
      ...planBlock([
        ...(standingText ? [{ read: join(dir, 'standing.md') }] : []),
        ...(included.length > 0 ? [{ read: join(dir, 'conversations.md') }] : []),
        ...(hasFiles
          ? [
              {
                read: join(dir, 'files.md'),
                note:
                  `${rawFiles.files.length} file${rawFiles.files.length === 1 ? '' : 's'} are ` +
                  `waiting in the brain. That page lists them; OPEN EACH ONE — exposurie ` +
                  `does not read documents, it finds them and hands them to you.`,
              },
            ]
          : []),
        {
          read: join(vault, '.exposurie', 'how-they-work.md'),
          note:
            'Their taste, in their own words, collected from their own corrections. ' +
            'Read it before the prompt: where the two disagree, this one wins.',
        },
        { read: join(vault, '.exposurie', 'wiki-prompt.md') },
        {
          write: 'Fold this batch into the brain, following the prompt above. Update ' +
            'existing pages before creating new ones, then update index.md and ' +
            'append one entry to log.md.',
        },
        { run: cmd('sync --done') },
      ]),
      '',
      ...wrap(
        'The last step is what moves the cutoff, and it refuses to move if the brain ' +
          'did not change — so an interrupted sync re-stages this material rather ' +
          'than losing it.',
        74,
        '  ',
      ),
    ],
    json: {
      batch: id,
      dir,
      staged: included.length,
      fromMachine,
      fromWeb,
      remaining,
      chars,
      rawBytes: rawTotal,
      excluded: excluded.length,
      deferred: deferred.length,
      empty: empty.length,
      redactions,
      standing: !!standingText,
      files: {
        staged: rawFiles.files.length,
        remaining: rawFiles.remaining,
        unreadable: rawFiles.unreadable.length,
        excluded: rawFiles.excluded.length,
      },
      exports: {
        found: web.exports,
        duplicates: web.duplicates,
        failed: web.failed.map((f) => ({ path: f.path, error: f.error })),
      },
    },
  };
}

// ---------------------------------------------------------------------- done
/**
 * Throw a staged batch away.
 *
 * Reported from the first outside install: a batch staged by accident had no
 * way out. Running `sync` again only stages a second one beside it, and
 * `--done` refuses to close it — correctly, since the pages were never
 * written — so the folder and the pending record sit there permanently, and
 * an agent reading the brain finds two staged batches with nothing to say which
 * is live.
 *
 * The reason this is safe to offer at all is the same property that makes
 * `--done` strict: THE CUTOFF ONLY EVER MOVES ON EVIDENCE. A batch that was
 * never closed never advanced anything, so discarding it cannot lose a
 * conversation — every session in it is still unread and comes back on the
 * next sync. That is stated in the output, because a person about to discard
 * something needs to know what it costs before they believe it costs nothing.
 *
 * It removes the staged folder and the pending record. It does not touch the
 * cutoff, and it does not touch a single page.
 */
function abort(vault) {
  const state = readState(vault) || {};
  const batch = state.pendingBatch;

  if (!batch) {
    return {
      code: ERROR,
      state: vaultState(vault, 'sync'),
      error: {
        message: 'There is no staged batch, so there is nothing to discard.',
        fix: `RUN: ${cmd('sync')}`,
      },
    };
  }

  const dir = join(stagedDir(vault), batch.id);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return {
      code: ERROR,
      state: vaultState(vault, 'sync'),
      error: {
        message: `Batch ${batch.id} could not be removed (${e.message}). Nothing was changed.`,
        fix: `DELETE it yourself: ${dir}`,
      },
    };
  }

  const next = { ...state, unfiled: 0 };
  delete next.pendingBatch;
  writeState(vault, next);

  return {
    code: OK,
    state: vaultState(vault, 'sync'),
    body: [
      ...block('DISCARDED', [
        ['batch', batch.id],
        ['sessions', `${batch.sessions ?? 0} unstaged`],
        ['cutoff', 'not moved'],
        ['pages', 'not touched'],
      ]),
      '',
      ...wrap(
        `Nothing is lost. The cutoff only ever moves on \`sync --done\`, and this ` +
          `batch never got there — every conversation in it is still unread, and ` +
          `comes back the next time you sync.`,
        74,
        '  ',
      ),
    ],
    json: { aborted: batch.id, sessions: batch.sessions ?? 0 },
  };
}

function done(vault) {
  const seam = readSeam(vault) || {};
  const state = readState(vault) || {};
  const batch = state.pendingBatch;

  if (!batch) {
    return {
      code: ERROR,
      state: vaultState(vault, 'sync'),
      error: {
        message: 'There is no staged batch waiting, so there is no cutoff to move.',
        fix: `RUN: ${cmd('sync')}`,
      },
    };
  }

  const now = newestPageWrite(vault, seam);
  if (!(now > (batch.pagesAt || 0))) {
    return {
      code: ERROR,
      state: vaultState(vault, 'sync'),
      error: {
        message:
          `Batch ${batch.id} is still staged and nothing in the brain has changed since ` +
          `it was staged, so the pages were not written. The cutoff has NOT moved and ` +
          `the material is still there — read the batch, write the pages, then run this again.`,
        fix: 'READ: .exposurie/staged/' + batch.id + '/conversations.md',
      },
      json: { advanced: false, batch: batch.id },
    };
  }

  const files = { ...(state.files || {}), ...batch.files };
  const next = { ...state, files, lastSyncUtc: iso(), unfiled: state.unfiled ?? 0 };
  delete next.pendingBatch;
  writeState(vault, next);

  // Pages have just been written, which is the moment the brain is most likely
  // to have drifted: new pages nothing links to, links to pages that were never
  // created, index entries missing. Curating here rather than later is the
  // whole reason it is a stage — a brain curated only once the mess exists is a
  // brain where the mess got there first.
  const c = curateStage(vault, seam);

  return {
    code: OK,
    state: { ...vaultState(vault, 'sync'), unfiled: next.unfiled },
    body: [
      ...block('FILED', [
        ['batch', batch.id],
        // Say what was actually in it. A batch of documents reporting
        // "0 sessions now marked as read" describes a sync that did nothing.
        ...(batch.sessions > 0 ? [['sessions', `${batch.sessions} now marked as read`]] : []),
        ...(batch.rawFiles > 0 ? [['files', `${batch.rawFiles} now marked as read`]] : []),
        ['still waiting', String(next.unfiled ?? 0)],
      ]),
      '',
      ...c.body,
      '',
      ...planBlock([
        { read: join(vault, '.exposurie', 'how-they-work.md') },
        { read: join(vault, '.exposurie', 'curate.md') },
        {
          write:
            'Act on the findings above, then do the half no checker can: two pages ' +
            'that disagree, a claim a newer session superseded, an idea now named on ' +
            'several pages that deserves its own. Scope it to the pages this batch ' +
            'touched — that keeps it cheap and continuous rather than a rescue ' +
            'operation later. If this batch showed you something about how they ' +
            'want to be worked with, add it to how-they-work.md; most batches ' +
            'show nothing and that is the normal result.',
        },
        // THE LOOP, as a numbered step. It was a sentence of prose below the
        // plan — "Run sync again for the next batch" — and rule 2 of the output
        // contract says exactly what happens to those: an instruction buried in
        // prose is an instruction skipped. It was. On a real first run the
        // agent filed batch one of twenty-eight, reported "158 sessions
        // remained queued", and stopped to ask whether to go on; the backlog
        // only drained because the person typed "get each and every session"
        // and then "continue" six times.
        //
        // Two things wrong with that, and the second is the real one. The tool
        // knew there were 158 left and left the arithmetic to a human. And it
        // turned a decision WE own into a question billed to the user — the
        // first sync IS the drain, and they asked for it by running the command.
        ...(next.unfiled > 0
          ? [
              {
                run: cmd('sync'),
                note:
                  `${next.unfiled} conversation${next.unfiled === 1 ? '' : 's'} still unread. Go straight ` +
                  `on to the next batch and keep repeating this whole cycle — stage, read, write, ` +
                  `--done — until nothing is waiting. Do NOT stop to ask whether to continue: ` +
                  `reading their history IS what this command does, and they asked for it by ` +
                  `running it. Tell them where it got to at the end, not before every batch.`,
              },
            ]
          : []),
      ]),
    ],
    json: { advanced: true, batch: batch.id, remaining: next.unfiled ?? 0, curate: c.json },
  };
}

export function sync({ done: isDone, abort: isAbort, at } = {}) {
  // Opposites. Guessing which one they meant is how a batch gets closed by
  // somebody trying to throw it away.
  if (isDone && isAbort) {
    return {
      code: USAGE,
      error: {
        message: '--done and --abort are opposites: one closes a batch, the other throws it away.',
        fix: `RUN: ${cmd('sync --done')}   (or --abort, but not both)`,
      },
    };
  }
  const d = detect({ at });
  // An unreadable pointer is not a machine without a brain. Saying "RUN:
  // exposurie scaffold" here sends the user to build a second one.
  if (d.configError) {
    return {
      code: ERROR,
      state: { vault: null, self: 'sync', brokenPointer: true },
      error: brokenConfig(d.configError),
    };
  }
  // Named a path with no brain in it. Falling through to `noBrain()` here would
  // say "there is no brain on this machine" to somebody whose brain is fine and
  // whose path was wrong, and `--at` was dropped entirely before this: the flag
  // was accepted and the batch went to the pointer's brain, silently.
  if (d.askedVault && !d.vault) {
    return {
      code: USAGE,
      state: vaultState(d.pointedVault, 'sync'),
      error: noBrainAt(
        d.askedVault,
        d.pointedVault,
        cmd(`sync${isDone ? ' --done' : ''}${isAbort ? ' --abort' : ''}`),
      ),
    };
  }
  if (!d.vault) return noBrain();

  // Bring the reminder files in line with what is still owed — here, on the ONE
  // command a person types repeatedly.
  //
  // `init` and `scaffold` mirror too, and for a whole release they were the only
  // ones that did. Both are typed ONCE, at setup. So a user who completed a step
  // afterwards and then lived in the normal loop never reaped at all: the step
  // vanished from the output exactly as designed, while the file stayed in their
  // brain reading "Waiting on you" under a line promising it would delete itself.
  //
  // The bug was fixed everywhere except the command where it bites. Found by
  // reading a transcript rather than by any test, which is why the placement is
  // the fix and not the call: this is the recurring command, so this is where
  // "disappears by itself" has to actually happen.
  //
  // It costs nothing extra — `detect()` has already run, and it sits before the
  // dispatch so both the staging and the `--done` path are covered by one call.
  mirror(d.vault, unresolved(stepCtx(d)));

  // Same argument, applied to the pointer. It is written once at scaffold, and
  // scaffold is typed once — so a pointer written by an older release keeps
  // whatever it said then, forever, however the machine has changed since. And
  // a client installed
  // after setup is never reached at all, because nothing revisits the question.
  //
  // inject() compares bytes and reports `unchanged` without writing, so on the
  // overwhelmingly common path this reads four small files and touches none.
  reachAll({ text: pointer(invocation()) });

  // And the same for the skill and the slash command, which are written at
  // scaffold for exactly the same reasons and go stale in exactly the same two
  // ways — an invocation spelled the way an older release spelled it, and a
  // brain that has since moved.
  //
  // The second half of that argument is the stronger one here. A client the
  // user installs AFTER setup gets no pointer until this line runs, and it gets
  // no slash command either — so somebody who adds Cursor next month would go
  // on typing nothing, with the feature installed and invisible. put() compares
  // bytes the way inject() does, so the common path writes nothing.
  surfacesAll({ vault: d.vault, cmd: invocation() });

  if (isAbort) return abort(d.vault);
  return isDone ? done(d.vault) : stage(d.vault, d);
}

// ------------------------------------------------------------------ rendering
function renderConversations(id, sessions) {
  const out = [
    `# Staged conversation — ${id}`,
    '',
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}, newest first.`,
    '',
    'This is conversation only. Tool calls, tool output, thinking, file contents',
    'and injected context were dropped before this file was written — none of it',
    'carries motive, and motive is what a brain is for.',
    '',
  ];
  sessions.forEach((s, i) => {
    const m = describe(s);
    out.push('---', '');
    out.push(`## ${i + 1} of ${sessions.length} — ${m.project}`);
    out.push('');
    out.push(
      `*${(m.startedAt || '').slice(0, 16).replace('T', ' ')} to ` +
        `${(m.endedAt || '').slice(0, 16).replace('T', ' ')} · ${m.surface} · ` +
        `${m.humanTurns} from them, ${m.turns - m.humanTurns} in reply*`,
    );
    out.push('');
    for (const t of s.turns) {
      out.push(t.role === 'user' ? '**THEM:**' : '**AGENT:**');
      out.push('');
      out.push(t.text);
      out.push('');
    }
  });
  return out.join('\n');
}

function renderManifest(id, rows, extra) {
  const out = [
    `# Batch ${id}`,
    '',
    'What this batch is made of, and what was left out of it. Kept as the record',
    'of where the pages came from — the conversation itself is in',
    '`conversations.md`.',
    '',
    '## Included',
    '',
    '| project | surface | when | turns | chars |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.project} | ${r.surface} | ${(r.startedAt || '').slice(0, 10)} | ` +
        `${r.humanTurns} + ${r.turns - r.humanTurns} | ${r.chars.toLocaleString('en-US')} |`,
    ),
    '',
    `**${extra.chars.toLocaleString('en-US')} characters of conversation**` +
      (extra.rawTotal > 0
        ? `, read out of ${bytes(extra.rawTotal)} of transcript.`
        : '.'),
    '',
  ];
  const web = extra.web || { exports: 0, failed: [], duplicates: 0 };
  if (web.exports > 0) {
    out.push('## From claude.ai', '');
    out.push(
      `${web.exports} export${web.exports === 1 ? '' : 's'} read. Web conversations carry no ` +
        'working directory, so they are identified by their title. Attachments were ' +
        'not opened: a pasted document is a file, and what was said about it is the ' +
        'part that carries motive.',
      '',
    );
    if (web.duplicates) {
      out.push(
        `${web.duplicates} conversation${web.duplicates === 1 ? '' : 's'} appeared in more than ` +
          'one export and were taken once, from the newest.',
        '',
      );
    }
  }
  if (web.emptyBodies) {
    out.push('## Your export is missing text', '');
    out.push(
      `${web.emptyBodies.count} conversation${web.emptyBodies.count === 1 ? '' : 's'} in the ` +
        'export arrived with messages but no words in them — no title, no summary, ' +
        'nothing said' +
        (web.emptyBodies.from
          ? `, covering ${web.emptyBodies.from.slice(0, 10)} to ${web.emptyBodies.to.slice(0, 10)}.`
          : '.'),
      '',
      'This is almost always a **split export**. Anthropic breaks a large account ' +
        'into numbered zips — `batch-0000`, `batch-0001` and so on — and the email ' +
        'carries a link for each. If only the first was downloaded, the rest of the ' +
        'history is listed in it but lives in the others.',
      '',
      '**Worth telling them, because they can fix it:** check the export email for ' +
        'more download links, or request a fresh export. Drop any further zips in ' +
        'Downloads and run sync again — nothing needs redoing, and nothing already ' +
        'filed is lost.',
      '',
      'These conversations were NOT marked as read. They will be picked up the ' +
        'moment an export arrives with their text in it.',
      '',
    );
  }
  if (web.failed?.length) {
    out.push('## Exports that would not open', '');
    for (const f of web.failed) out.push(`- \`${basename(f.path)}\` — ${f.error}`);
    out.push('', 'Nothing was taken from these. The rest of the batch is unaffected.', '');
  }
  if (extra.excluded.length) {
    out.push('## Excluded by your list', '');
    out.push('Only the head of each was read, far enough to find which folder it', '');
    out.push('belonged to. None of what was said in them was loaded.', '');
    for (const e of extra.excluded) out.push(`- \`${basename(e.path)}\` — ${e.why}`);
    out.push('');
  }
  if (extra.deferred?.length) {
    out.push('## Still going — held for the next sync', '');
    out.push('These conversations had not finished when this batch was staged, so', '');
    out.push('nothing in them was read. Half a conversation is worse than none: the', '');
    out.push('half explaining why is usually the half not written yet. They are not', '');
    out.push('excluded and nothing is lost — the next sync takes them.', '');
    for (const e of extra.deferred) out.push(`- \`${basename(e.path)}\` — ${e.why}`);
    out.push('');
  }
  if (extra.empty.length) {
    out.push('## Nothing said in them', '');
    out.push(`${extra.empty.length} transcript${extra.empty.length === 1 ? '' : 's'} changed but held no conversation — tool work only.`, '');
  }
  if (Object.keys(extra.redactions).length) {
    out.push('## Redacted', '');
    for (const [k, n] of Object.entries(extra.redactions)) out.push(`- ${n} × \`${k}\``);
    out.push('', 'Secrets are removed on the way in, so they never reach a page.', '');
  }
  if (extra.remaining > 0) {
    out.push('## Still waiting', '');
    out.push(`${extra.remaining} session${extra.remaining === 1 ? '' : 's'} have not been read yet. They are next, newest first.`, '');
  }
  return out.join('\n');
}
