#!/usr/bin/env node
// Entry point. Thin on purpose: parse, dispatch, render, exit.
//
// There is exactly one writer to stdout (render) and one place the exit code is
// chosen, so the output contract cannot be bypassed by a command author. The
// command table lives in src/commands/registry.js, which is also what the help
// text and the tests read — a command exists in one place or not at all.

import { parseArgs } from 'node:util';
import { render } from '../src/output.js';
import { ERROR, USAGE, footer } from '../src/exit-codes.js';
import { COMMANDS, NAMES, versionResult } from '../src/commands/registry.js';
import { cmd } from '../src/install.js';
import { refreshOurs } from '../src/refresh.js';

// The parsed flags, hoisted so the one writer below can consult them rather
// than re-reading argv. Null until parsing succeeds, and null forever if it
// throws — which is exactly the case the fallback down there covers.
let parsedValues = null;

// What finishing an update changed, if this run did it. See below.
let refreshed = null;

// The three commands that must not ride the refresh: `scaffold` writes the
// same files and stamps the version itself, `uninstall` is taking them away,
// and `update` does it at the one moment it is right to -- in the new copy,
// after npm has run, never in the old one before.
const NO_REFRESH = new Set(['scaffold', 'uninstall', 'update']);

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        at: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
        done: { type: 'boolean' },
        abort: { type: 'boolean' },
        section: { type: 'string' },
        nth: { type: 'string' },
        search: { type: 'string' },
        outline: { type: 'boolean' },
        full: { type: 'boolean' },
        because: { type: 'string' },
      },
    });
  } catch (e) {
    return { code: USAGE, error: { message: e.message, fix: `RUN: ${cmd('help')}` } };
  }

  parsedValues = parsed.values;

  // Named `asked` rather than `cmd`, because `cmd` is now the imported helper
  // that spells a command the way it works on this machine — and a local const
  // of the same name shadowed it here, turning every usage error into a crash.
  const asked = parsed.positionals[0] ?? 'init';
  const entry = COMMANDS[asked];
  if (!entry) {
    return {
      code: USAGE,
      error: {
        message: `No command named "${asked}". This version has: ${NAMES.join(', ')}.`,
        fix: `RUN: ${cmd('help')}`,
      },
    };
  }

  // AN UPDATE FINISHES ITSELF. npm replaces the package and nothing else, so a
  // copy that finds the machine set up by an older release brings its own files
  // outside the brain up to match before doing what it was asked -- however it
  // got updated. See src/refresh.js. It rides every command, `--help` and
  // `--version` included, because the first thing a person runs after updating
  // is often exactly those.
  //
  // It is a passenger, and a passenger must never crash the trip: a refresh
  // that throws costs nothing but its own work, which the next command retries.
  if (!NO_REFRESH.has(asked)) {
    try {
      refreshed = refreshOurs();
    } catch {
      refreshed = null;
    }
  }
  // `--help` is a question, and a question must never be able to perform an
  // action. The flag used to be consulted only when nothing was named —
  // `positionals[0] ?? (values.help ? 'help' : 'init')` — so a command name won
  // and the flag was parsed and then dropped. `exposurie sync --help` ran a real
  // sync; on the first install on somebody else's machine it staged a batch the
  // agent then had to go and clean up. Asking what a command does cost the user
  // the command. Answering the question BEFORE dispatch makes that impossible
  // for every command in the table, including ones this version does not have
  // yet — a new command cannot reintroduce it by forgetting to check a flag.
  //
  // It sits AFTER the unknown-name check on purpose. A name that is not a
  // command is a usage error whatever else is on the line, and exit 0 with a
  // help page would tell an agent its typo worked.
  if (parsed.values.help) return COMMANDS.help.run(parsed.values, parsed.positionals);

  // `--version` is the same kind of thing as `--help` — a question — so it is
  // answered in the same place, under the same two rules, and for the same
  // reason: a question that can reach a command can perform an action.
  //
  // It was not a flag at all until 1.1.0. `parseArgs` rejected it, which is
  // safe — exit 2, nothing ran, the fix printed — but it is a wrong answer to a
  // reasonable question, and the person asking it is usually somebody checking
  // whether they have the release that fixed the thing that bit them. That is
  // the audience this product now actually has.
  //
  // Below `--help` on purpose. If somebody asks both, they are lost rather than
  // curious, and the help text is the better answer to being lost.
  if (parsed.values.version) return versionResult(parsed.values.at);

  return entry.run(parsed.values, parsed.positionals.slice(1));
}

let result;
try {
  result = main(process.argv.slice(2));
} catch (e) {
  result = {
    code: ERROR,
    error: { message: e.stack || e.message, fix: 'This is a bug in exposurie. Nothing was written.' },
  };
}

// Asked as a parsed flag, not by scanning argv for the string. The scan also
// matched a `--json` that was somebody's DATA — `read --search "--json"` hands
// that word to `--search`, and the search then answered in a format nobody
// asked for. Falls back to the scan only when parsing itself failed, which is
// the one case where there are no parsed values to consult.
const wantsJson = parsedValues ? Boolean(parsedValues.json) : process.argv.includes('--json');

// What the refresh changed is said, every time it changes anything. Files of
// the user's were edited -- a block in their instructions file, at least -- and
// an edit made without a word is what makes somebody stop trusting a tool with
// their files. Said once: the stamp moves, so the next run has nothing to say.
if (refreshed?.rows.length) {
  const said = [
    `UPDATED TO ${refreshed.to}`,
    `  This machine was set up by ${refreshed.from}, so this release brought its`,
    '  own files outside your brain up to match. Your brain was not touched.',
    ...refreshed.rows.map(([client, what]) => `  ${client.padEnd(12)}  ${what}`),
  ];
  const body = Array.isArray(result.body) ? result.body : result.body ? [result.body] : [];
  result = { ...result, body: [...said, ...(body.length ? ['', ...body] : [])] };
  if (result.json) {
    result.json = {
      ...result.json,
      refreshed: { from: refreshed.from, to: refreshed.to, files: refreshed.changed },
    };
  }
}

if (result.passthrough) {
  // `update` handing over to the release it just installed. That process
  // rendered its own report through ITS copy of this file, so it is written
  // as it came -- re-rendering it here would put the old release's skeleton
  // around the new release's words.
  process.stdout.write(result.passthrough.stdout);
  if (result.passthrough.stderr) process.stderr.write(result.passthrough.stderr);
} else if (wantsJson) {
  // ALWAYS JSON once it has been asked for. This used to be
  // `wantsJson && result.json`, so a command with no structured payload — the
  // librarian among them — answered a machine caller with prose at exit 0.
  // That is the worst shape a failure can take here: valid-looking, silent,
  // and only discovered by whatever was parsing it. docs/output-contract.md
  // promises every command that returns data supports the flag, so the
  // guarantee is made structurally rather than command by command, and a
  // command added later cannot forget to keep it.
  const payload = result.json
    ? { ...result.json, exit: result.code }
    : {
        exit: result.code,
        ok: result.code === 0,
        error: result.error ? { message: result.error.message, fix: result.error.fix ?? null } : null,
        // The full human rendering, so nothing this command said is lost just
        // because it has no structured form yet.
        text: render(result) + footer(result.code),
      };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  process.stdout.write(render(result) + footer(result.code) + '\n');
}

// `process.exitCode`, not `process.exit()`. On Windows a write to a TTY is
// asynchronous, and `process.exit()` does not wait for it — so exiting on the
// line after the write can truncate the output on the one platform this was
// built on. Setting the code lets Node drain stdout and exit on its own. Every
// command here is synchronous and holds nothing open, so there is nothing to
// keep the loop alive once the write lands.
process.exitCode = result.passthrough ? result.passthrough.code : result.code;
