#!/usr/bin/env node
// The watch lock: one GitHub watcher per repo.
//
// An interactive session claims the lock before it starts `/loop`; a second
// session in the same repo is told who holds it and starts no loop. The lock
// lives in the shared .git directory (worktrees share it) and is never
// committed. It holds the pid of the Claude Code session (see ownerPid), a
// session id, and a heartbeat; the loop refreshes the heartbeat every tick, so
// a lock whose heartbeat is older than STALE_MS, or whose session process is
// gone, is stale and may be claimed over.
//
// Usage: node watch.mjs claim | heartbeat | release [--hook]
//   claim      prints "claimed" (exit 0), "claimed (already held by this session)"
//              (exit 0, do not start a second loop), or "held by <session> since
//              <time>" (exit 1)
//   heartbeat  refreshes the timestamp of a lock this session holds (exit 0)
//   release    removes the lock this session holds (exit 0)
//   --hook     the command runs as a Claude Code hook: the repo comes from the
//              hook's stdin JSON (`cwd`), as in session-start.mjs
//
// Identity: the Claude Code session, never this child process. The Bash tool
// sets CLAUDE_PID and CLAUDE_CODE_SESSION_ID in its environment; when they are
// absent (a hook, a test) the nearest ancestor named `claude` stands in, and
// failing that the parent process.
//
// Runs only inside a repo with .sdlc-harness/sdlc.json; anywhere else it exits
// 0 and prints nothing, so a SessionEnd hook costs nothing in other projects.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { NAME, gitCommonDir, loadConfig, repoRoot, sh } from './lib.mjs';

export const STALE_MS = 30 * 60 * 1000;

/**
 * The process that owns the watch: the nearest ancestor named `claude`, the
 * Claude Code session itself. Every call of this script is a fresh child
 * (a hook, or a Bash tool command under its own shell), so its own pid is
 * useless as an identity; the session's pid is the same on every call and
 * dies with the session, which is exactly what a stale check wants. Outside
 * a session (the tests) the parent pid stands in.
 */
export function ownerPid(start = process.ppid, env = process.env) {
  // A stale CLAUDE_PID in an exported environment names a dead session; only
  // a live one counts, otherwise the ancestry walk decides.
  const fromEnv = Number(env.CLAUDE_PID);
  if (Number.isInteger(fromEnv) && fromEnv > 1 && pidAlive(fromEnv)) return fromEnv;
  let pid = start;
  for (let hops = 0; hops < 12 && pid > 1; hops++) {
    // macOS prints argv[0] as invoked, so a claude started by path shows a path.
    const comm = sh(`ps -o comm= -p ${pid}`);
    if (comm && basename(comm.trim()) === 'claude') return pid;
    const parent = Number(sh(`ps -o ppid= -p ${pid}`));
    if (!Number.isInteger(parent) || parent <= 1) break;
    pid = parent;
  }
  return start;
}

function lockPath(root) {
  return join(gitCommonDir(root), NAME, 'watch.lock');
}

function readLock(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else: alive.
    return Boolean(err) && err.code === 'EPERM';
  }
}

function sessionId(pid, env = process.env) {
  return env.SDLC_HARNESS_WATCH_SESSION || env.CLAUDE_CODE_SESSION_ID || `${hostname()}:${pid}`;
}

function isStale(lock, now) {
  const beat = Date.parse(lock.heartbeat || lock.since || '');
  if (!Number.isFinite(beat) || now - beat > STALE_MS) return true;
  return !pidAlive(lock.pid);
}

function write(p, lock) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(lock)}\n`);
}

/**
 * Claim the lock for this process. Returns { ok: true, lock } when claimed
 * (fresh, stale, or already ours) or { ok: false, lock } when another live
 * session holds it.
 */
export function claim(root, { now = Date.now(), pid = ownerPid(), session = sessionId(pid) } = {}) {
  const p = lockPath(root);
  const existing = readLock(p);
  const stamp = new Date(now).toISOString();
  if (existing && existing.pid !== pid && !isStale(existing, now)) {
    return { ok: false, lock: existing };
  }
  const again = Boolean(existing && existing.pid === pid);
  const lock = { pid, session, since: again ? existing.since : stamp, heartbeat: stamp };
  write(p, lock);
  return { ok: true, again, lock };
}

/** Refresh the heartbeat of a lock this process holds; false when it does not. */
export function heartbeat(root, { now = Date.now(), pid = ownerPid() } = {}) {
  const p = lockPath(root);
  const existing = readLock(p);
  if (!existing || existing.pid !== pid) return false;
  write(p, { ...existing, heartbeat: new Date(now).toISOString() });
  return true;
}

/** Remove the lock this process holds; false when it holds none. */
export function release(root, { pid = ownerPid() } = {}) {
  const p = lockPath(root);
  const existing = readLock(p);
  if (!existing || existing.pid !== pid) return false;
  unlinkSync(p);
  return true;
}

function hookCwd() {
  // Only a hook pipes JSON on stdin; a Bash tool command must never block on it.
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    return input.cwd || null;
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = (args.find((a) => !a.startsWith('--')) || '').trim();
  const cwd = (args.includes('--hook') && hookCwd()) || process.cwd();
  const root = repoRoot(cwd);
  if (!root || !loadConfig(root)) return 0;
  if (cmd === 'claim') {
    const r = claim(root);
    if (r.ok) {
      // A session that claims twice (the hook re-fires after a compaction or
      // /clear) is told so, and must not start a second loop.
      console.log(r.again ? 'claimed (already held by this session)' : 'claimed');
      return 0;
    }
    console.log(`held by ${r.lock.session} since ${r.lock.since}, last seen ${r.lock.heartbeat}`);
    return 1;
  }
  if (cmd === 'heartbeat') {
    console.log(heartbeat(root) ? 'heartbeat' : 'not held by this session');
    return 0;
  }
  if (cmd === 'release') {
    console.log(release(root) ? 'released' : 'not held by this session');
    return 0;
  }
  console.error('usage: watch.mjs claim | heartbeat | release [--hook]');
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('watch.mjs')) {
  process.exit(main());
}
