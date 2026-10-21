#!/usr/bin/env node
// Runs the testCommand in HEAD's .sdlc-harness/sdlc.json and, only if it exits
// 0, records "green" for HEAD's tree under that testCommand. Git's pre-push
// judge (git-pre-push.mjs) checks that record for the tree each push sends.
//
// It records nothing unless:
//   - the working tree is known clean: a git status that fails is a refusal,
//     never an empty answer. The record must describe the commit that will be
//     pushed, not the commit plus what was still uncommitted;
//   - the push judge is installed for this repo and proven to be the one git
//     runs, before the tests and again after them, so every tree that ships is
//     judged on its way out.
//
// Usage: node verify.mjs            (from anywhere inside the repo)
//        node verify.mjs --quiet    (only print the summary line and the last 40 lines on failure)

import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, greenKey, installHooks, proveHooks, repoRoot, writeMarker } from './lib.mjs';

const fail = (lines, code = 1) => {
  for (const l of [].concat(lines)) console.error(l);
  process.exit(code);
};

/** Run git; its stdout, or a refusal naming what could not be read. */
function read(root, args, what) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) fail(`[verify] could not read ${what}: ${(r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]}. Nothing recorded.`);
  return r.stdout.trim();
}

const root = repoRoot(process.cwd());
if (!root) fail('[verify] not inside a git repo');

const dirty = read(root, ['status', '--porcelain', '--untracked-files=no'], 'the working tree status');
if (dirty) fail(['[verify] working tree has uncommitted changes. Commit first, then verify:', dirty]);

const tree = read(root, ['rev-parse', '--verify', 'HEAD^{tree}'], 'the tree at HEAD (make the first commit, then verify)');
const listed = read(root, ['ls-tree', '--name-only', 'HEAD', '--', CONFIG_FILE], "HEAD's file list");
if (!listed) fail(`[verify] no ${CONFIG_FILE} in HEAD, so this repo is not managed by the SDLC`);
let testCommand = '';
try {
  testCommand = JSON.parse(read(root, ['cat-file', 'blob', `HEAD:${CONFIG_FILE}`], `HEAD's ${CONFIG_FILE}`)).testCommand || '';
} catch {
  fail(`[verify] HEAD's ${CONFIG_FILE} is not JSON`);
}
if (!testCommand) fail(`[verify] HEAD's ${CONFIG_FILE} has no testCommand`);

function prove(when) {
  const p = proveHooks(root);
  if (!p.ok) fail([`[verify] the push judge is not the hook git runs here ${when}: ${p.reason}.`, '[verify] Nothing recorded. A new session reinstalls it; if it still fails, tell an approver.']);
}
try {
  installHooks(root);
} catch (e) {
  fail([`[verify] could not install the push judge: ${e.message}.`, '[verify] Nothing recorded, since git would not judge this push.']);
}
prove('before the tests');

const quiet = process.argv.includes('--quiet');
console.log(`[verify] running: ${testCommand}`);
const started = Date.now();
const res = spawnSync('sh', ['-c', testCommand], {
  cwd: root,
  stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const secs = Math.round((Date.now() - started) / 1000);

if (res.status !== 0) {
  if (quiet) {
    const tail = ((res.stdout || '') + (res.stderr || '')).split('\n').slice(-40).join('\n');
    console.error(tail);
  }
  fail(`[verify] RED after ${secs}s (exit ${res.status}). Nothing recorded.`, res.status || 1);
}

// The tests ran in this tree; it must still be the tree verified, and git
// must still run the judge.
if (read(root, ['status', '--porcelain', '--untracked-files=no'], 'the working tree status after the tests')) fail('[verify] the tests changed tracked files. Nothing recorded.');
if (read(root, ['rev-parse', '--verify', 'HEAD^{tree}'], 'the tree at HEAD after the tests') !== tree) fail('[verify] HEAD moved while the tests ran. Nothing recorded.');
prove('after the tests');

const p = writeMarker(root, 'green', greenKey(tree, testCommand), `cmd=${JSON.stringify(testCommand)} seconds=${secs}`);
console.log(`[verify] GREEN in ${secs}s. Recorded for tree ${tree.slice(0, 12)} at ${p}`);
