// `exposurie uninstall` — take back everything this tool put on the machine.
//
// remove() in reach.js says it plainly: a pointer we cannot remove is a pointer
// we have imposed. It was written, it was correct, and for the whole life of
// the product nothing called it — so the honest version of "we own the failure
// path" had no command behind it.
//
// THE ONE COMMAND, AND IT IS THE USER'S. Every other command here talks to an
// agent, which is right when the agent is doing work on their behalf. Leaving
// is different: a person who wants this gone should not have to open a coding
// agent and ask it nicely. So this one is typed by a human, in a terminal, and
// speaks to that human — no "TELL YOUR USER", no relay, no plan for something
// else to execute. It works the same when an agent runs it, because plain
// second-person prose is the one register both can read.
//
//   exposurie uninstall
//
// It is the counterpart to `scaffold`, not a new recurring command: setup is
// typed once and teardown is typed once. What a person types over and over is
// still `sync`.
//
// THE RULE IT EXISTS TO KEEP: it removes what WE wrote, and never what the user
// did. Their brain is pages they and their agent authored, and it is the entire
// point of the tool — deleting it here would make uninstalling the most
// destructive thing exposurie can do, which is the opposite of why being able
// to leave builds any trust at all. The brain is reported, not touched, and the
// tool says where it is on the way out.

import { resolve } from 'node:path';

import { OK } from '../exit-codes.js';
import { unreachAll } from '../reach.js';
import { unsurfaceAll } from '../surfaces.js';
import { installState, cmd, q, INSTALL } from '../install.js';
import { removePackage, packageLines } from '../package-removal.js';
import { detect, tilde, removeMachineConfig } from '../context.js';
import { block, wrap } from '../output.js';
import { vaultState, DEFAULT_VAULT } from '../vault.js';

export function uninstall({ at } = {}) {
  const d = detect({ at });

  // Same dropped flag as `decline`: `{ at }` was passed to a parameterless
  // `detect()`, so this command was printing "YOUR BRAIN IS UNTOUCHED" over a
  // path the user had not named. The flag is honoured now.
  //
  // But it does NOT refuse the way `sync`, `read` and `decline` do, and the
  // suite is what said so: leaving must always finish. Here `--at` only decides
  // which folder gets NAMED — nothing is read from it and nothing is written to
  // it — so refusing over a wrong path would strand the pointer blocks in
  // somebody's client files at the exact moment they asked to be rid of them.
  // Refusing to let someone leave, over a cosmetic argument, is the worst thing
  // this command could do. It says the path was empty and gets on with it.
  const missingAsked = d.askedVault && !d.vault ? d.askedVault : null;

  // Two kinds of thing get taken back, and they come apart cleanly: a BLOCK
  // spliced out of a file the user owns, and a FILE that was only ever ours.
  // The second is the easier promise to keep — there is nothing around it to
  // preserve — which is why adding the skill and the command surfaces cost this
  // command a line of wiring rather than a mechanism.
  const results = [
    ...unreachAll().map((r) => ({ ...r, label: r.name })),
    ...unsurfaceAll().map((r) => ({ ...r, label: `${r.name} ${r.kind}` })),
    { ...removeMachineConfig(), label: 'machine config' },
  ];

  const removed = results.filter((r) => r.action === 'removed');
  const absent = results.filter((r) => r.action === 'absent');

  const rows = [];
  for (const r of removed) rows.push([r.label, `removed   ${tilde(r.file)}`]);
  // A client that was present with nothing of ours in it still gets a line.
  // Silence there reads as "it missed one", and the entire value of this
  // command is that you can see for yourself that it finished.
  for (const r of absent) rows.push([r.label, `nothing of ours was there`]);

  // Coming back means setup again, and without the machine config setup only
  // knows the default place to look. So the line names the brain it found
  // whenever that brain is somewhere else -- printed whole, so nobody has to
  // work out a flag on the day they decide to return.
  const back =
    d.vault && resolve(d.vault) !== resolve(DEFAULT_VAULT)
      ? `${cmd('scaffold')} --at ${q(tilde(d.vault))}`
      : cmd('scaffold');

  const body = [
    'UNINSTALLED',
    ...(rows.length
      ? block('', rows).filter((l) => l.trim() !== '')
      : ['  No supported client found — there was nothing to remove.']),
    '',
    ...wrap(
      `That is every byte exposurie wrote outside your brain. Where it had ` +
        `added a block to a file of yours, the block came out and nothing around ` +
        `it moved; where the whole file was ours — a skill, a slash command — ` +
        `the file is gone, and so is the folder it sat in if nothing else was ` +
        `in there.`,
      74,
      '  ',
    ),
    '',
    'YOUR BRAIN IS UNTOUCHED',
  ];

  if (d.vault) {
    body.push(
      `  ${tilde(d.vault)}`,
      '',
      ...wrap(
        `Plain Markdown, and a git repo with its own history. It opens in ` +
          `Obsidian, in any editor, in anything that reads text — with this tool ` +
          `gone and forever after. Nothing in there needs exposurie to be read.`,
        74,
        '  ',
      ),
      '',
      ...wrap(
        `If you want it gone, delete that folder yourself. This command will ` +
          `not, and no flag makes it: a tool that can erase the thing it spent ` +
          `months building for you is not one you should have trusted with it.`,
        74,
        '  ',
      ),
    );
  } else if (missingAsked) {
    body.push(
      ...wrap(
        `You named ${tilde(missingAsked)} with --at and there is no brain there, ` +
          `so there is nothing to name here. Everything above still happened: ` +
          `what exposurie wrote outside a brain is gone either way.`,
        74,
        '  ',
      ),
    );
  } else {
    body.push('  No brain found on this machine — there was nothing to keep.');
  }

  // ONE COMMAND, so this takes the package too.
  //
  // It used to print `npm uninstall -g` and leave that to the user, which made
  // leaving a two-command job with the difference between them explained. His
  // ruling, 2026-08-30: *"i just clearly want one install, one sync and one
  // uninstall command everywhere."* Handing somebody the question of which line
  // they still need is the thing the second design law exists to forbid, and it
  // is worst here -- the one command typed with no agent watching, by a person
  // who has already decided to stop reading us.
  //
  // Ordered deliberately: the pointers come out FIRST and the package last. If
  // npm fails we have still removed every byte we wrote into files the user
  // owns, which is the promise that matters; the reverse order could leave our
  // block in their CLAUDE.md with no command left to remove it.
  //
  // It reports what happened rather than what it attempted -- see
  // package-removal.js, which also carries the guard that stops a sandboxed
  // test from deleting the developer's own global install.
  const install = installState();
  const pkg = removePackage(install.binary);
  body.push(
    '',
    'THE PACKAGE',
    ...packageLines(pkg, install.binary, wrap, tilde),
    '',
    ...wrap(
      `Changed your mind later? \`${INSTALL}\`, then \`${back}\` — it ` +
        `picks up exactly where this left off, because what has been synced is ` +
        `recorded inside the brain, not in the tool.`,
      74,
      '  ',
    ),
  );

  return {
    code: OK,
    state: d.vault ? vaultState(d.vault, 'uninstall') : { vault: null, self: 'uninstall' },
    body,
    json: { removed: removed.map((r) => r.label), package: pkg.action },
  };
}
