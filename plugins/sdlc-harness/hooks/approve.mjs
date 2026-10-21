#!/usr/bin/env node
// Records an approver's "go" for an agent-needs-go ticket so git's pre-push
// judge (git-pre-push.mjs) lets a push that changes a protected path through.
//
// Only run this after an approver's own GitHub account has replied "go" on the
// plan comment of that issue. The skill that calls it must quote the comment it
// saw. An approver may also run it from a terminal.
//
// Usage: node approve.mjs GH-123 ["quoted go comment"]

import { loadConfig, repoRoot, writeMarker } from './lib.mjs';

const id = (process.argv[2] || '').trim();
const note = process.argv.slice(3).join(' ');
const root = repoRoot(process.cwd());
if (!root) {
  console.error('[approve] not inside a git repo');
  process.exit(1);
}
const cfg = loadConfig(root);
if (!cfg) {
  console.error('[approve] this repo has no .sdlc-harness/sdlc.json');
  process.exit(1);
}
const prefix = cfg.issuePrefix || 'GH';
if (!new RegExp(`^${prefix}-\\d+$`).test(id)) {
  console.error(`usage: approve.mjs ${prefix}-123 ["quoted go comment"]`);
  process.exit(1);
}
const p = writeMarker(root, 'go', id, note ? `note=${JSON.stringify(note)}` : '');
console.log(`[approve] recorded go for ${id} at ${p}`);
