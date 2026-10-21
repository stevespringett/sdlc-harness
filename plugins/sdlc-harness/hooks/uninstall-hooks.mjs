#!/usr/bin/env node
// Removes the push judge (decision 0005) from the repo this runs in, and
// globally: each core.hooksPath that still points at a harness hooks
// directory goes back to what it was before the install, or is unset. For a
// person at a keyboard; the Claude Code hook refuses it. A new Claude Code
// session in a managed repo installs the judge again.
//
// Usage: node uninstall-hooks.mjs    (inside a repo, or anywhere for the global path only)

import { repoRoot, uninstallHooks } from './lib.mjs';

try {
  const done = uninstallHooks(repoRoot(process.cwd()));
  console.log(done.length ? `[uninstall] ${done.join('; ')}` : '[uninstall] nothing pointed at the push judge');
} catch (e) {
  console.error(`[uninstall] ${e.message}`);
  process.exit(1);
}
