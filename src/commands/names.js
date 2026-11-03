// The names of every command this version actually has.
//
// A leaf module that imports nothing, on purpose. The renderer needs to ask
// "does this command exist?" before it points an agent at one, and asking the
// command table directly would import the commands, which import the renderer.
//
// registry.js asserts at load that its table matches this list exactly, so the
// two cannot drift apart quietly — adding a command without listing it here
// fails immediately and loudly rather than at the moment output goes wrong.

export const NAMES = ['init', 'scaffold', 'sync', 'read', 'decline', 'update', 'uninstall', 'help'];

/** The sync command, named once. The state line points here when it exists. */
export const SYNC = 'sync';

/** The decline command, named once. The pending block points here the same way. */
export const DECLINE = 'decline';

export const exists = (name) => NAMES.includes(name);
