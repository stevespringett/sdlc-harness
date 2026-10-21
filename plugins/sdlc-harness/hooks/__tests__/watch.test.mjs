// Tests for the watch lock. Each case runs in a throwaway git repo carrying
// .sdlc-harness/sdlc.json, because the lock lives in the shared .git dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim, heartbeat, release, ownerPid, STALE_MS } from '../watch.mjs';

const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));

// The owner every child of this test process resolves to: a claude ancestor
// when the tests run inside a Claude Code session, this process otherwise.
// A "stranger" is a live process that is not that owner: our parent, the
// test runner, serves in both cases.
const OWNER = ownerPid(process.pid, process.env);
const STRANGER = process.ppid;
// The CLI runs with the identity the Bash tool would give it: this test
// process stands in for the Claude Code session.
const AS_ME = { CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: 'session-me' };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-watch-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, '.sdlc-harness'));
  writeFileSync(join(dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ integration: 'trunk', testCommand: 'true' }));
  return dir;
}

const lockFile = (dir) => join(dir, '.git', 'sdlc-harness', 'watch.lock');
const readLock = (dir) => JSON.parse(readFileSync(lockFile(dir), 'utf8'));
const run = (dir, cmd, env = {}) => spawnSync(process.execPath, [WATCH, cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

test('claim on an empty repo writes the lock with the session identity from the environment', () => {
  const dir = repo();
  const r = run(dir, 'claim', AS_ME);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'claimed');
  const lock = readLock(dir);
  assert.equal(lock.session, 'session-me');
  assert.equal(lock.pid, process.pid, 'CLAUDE_PID, not the child');
  assert.ok(Date.parse(lock.heartbeat) > 0);
});

test('a second session claiming through the CLI is refused while the first is alive', () => {
  const dir = repo();
  assert.equal(run(dir, 'claim', AS_ME).stdout.trim(), 'claimed');
  const other = run(dir, 'claim', { CLAUDE_PID: String(STRANGER), CLAUDE_CODE_SESSION_ID: 'session-other' });
  assert.equal(other.status, 1);
  assert.match(other.stdout.trim(), /^held by session-me since .+, last seen .+$/);
  assert.equal(readLock(dir).session, 'session-me');
  assert.equal(run(dir, 'heartbeat', { CLAUDE_PID: String(STRANGER) }).stdout.trim(), 'not held by this session');
  assert.equal(run(dir, 'release', { CLAUDE_PID: String(STRANGER) }).stdout.trim(), 'not held by this session');
  assert.ok(existsSync(lockFile(dir)));
});

test('release --hook takes the repo from the hook JSON on stdin', () => {
  const dir = repo();
  assert.equal(run(dir, 'claim', AS_ME).stdout.trim(), 'claimed');
  const r = spawnSync(process.execPath, [WATCH, 'release', '--hook'], {
    cwd: tmpdir(), encoding: 'utf8', input: JSON.stringify({ cwd: dir, session_id: 'x' }),
    env: { ...process.env, ...AS_ME }
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'released');
  assert.ok(!existsSync(lockFile(dir)));
});

test('claim, heartbeat, and release from three separate commands agree on one owner', () => {
  // Every CLI call is a fresh child process; the identity has to be the
  // session above them (here: this test process, since no claude ancestor
  // exists), or the second and third commands would see a stranger's lock.
  const dir = repo();
  assert.equal(run(dir, 'claim', { SDLC_HARNESS_WATCH_SESSION: 'cli' }).stdout.trim(), 'claimed');
  const first = readLock(dir);
  assert.equal(first.pid, OWNER, 'the lock names the session above the child, not the child');
  const beat = run(dir, 'heartbeat');
  assert.equal(beat.status, 0);
  assert.equal(beat.stdout.trim(), 'heartbeat');
  assert.ok(Date.parse(readLock(dir).heartbeat) >= Date.parse(first.heartbeat));
  assert.equal(run(dir, 'claim', { SDLC_HARNESS_WATCH_SESSION: 'cli' }).stdout.trim(), 'claimed (already held by this session)', 'the same session re-claims and is told so');
  assert.equal(readLock(dir).since, first.since);
  const rel = run(dir, 'release');
  assert.equal(rel.stdout.trim(), 'released');
  assert.ok(!existsSync(lockFile(dir)));
});

test('a live lock held by another process refuses with held by and exit 1', () => {
  const dir = repo();
  // A lock whose owner is a live process other than the one above the child:
  // the parent of this test runner.
  const first = claim(dir, { pid: STRANGER, session: 'first', now: Date.now() });
  assert.equal(first.ok, true);
  const r = run(dir, 'claim', { SDLC_HARNESS_WATCH_SESSION: 'second' });
  assert.equal(r.status, 1);
  assert.match(r.stdout.trim(), /^held by first since .+, last seen /);
  assert.equal(readLock(dir).session, 'first', 'the lock is unchanged');
});

test('a lock whose heartbeat is older than the stale window is claimed over', () => {
  const dir = repo();
  claim(dir, { pid: STRANGER, session: 'old', now: Date.now() - STALE_MS - 1000 });
  const r = run(dir, 'claim', { SDLC_HARNESS_WATCH_SESSION: 'new' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'claimed');
  assert.equal(readLock(dir).session, 'new');
});

test('a fresh lock whose process is gone is claimed over', () => {
  const dir = repo();
  claim(dir, { pid: 2147483000, session: 'ghost', now: Date.now() });
  const r = claim(dir, { pid: process.pid, session: 'live' });
  assert.equal(r.ok, true);
  assert.equal(readLock(dir).session, 'live');
});

test('a fresh lock one minute short of the window still holds', () => {
  const dir = repo();
  claim(dir, { pid: STRANGER, session: 'first', now: Date.now() - STALE_MS + 60_000 });
  const r = run(dir, 'claim', { SDLC_HARNESS_WATCH_SESSION: 'second' });
  assert.equal(r.status, 1);
});

test('claiming again from the same process keeps since and refreshes the heartbeat', () => {
  const dir = repo();
  const t0 = Date.now() - 5 * 60_000;
  claim(dir, { pid: process.pid, session: 'me', now: t0 });
  const again = claim(dir, { pid: process.pid, session: 'me', now: t0 + 60_000 });
  assert.equal(again.ok, true);
  assert.equal(again.again, true);
  assert.equal(again.lock.since, new Date(t0).toISOString());
  assert.equal(again.lock.heartbeat, new Date(t0 + 60_000).toISOString());
});

test('heartbeat refreshes only a lock this process holds', () => {
  const dir = repo();
  const t0 = Date.now() - 10 * 60_000;
  claim(dir, { pid: process.pid, session: 'me', now: t0 });
  assert.equal(heartbeat(dir, { pid: process.pid, now: t0 + 60_000 }), true);
  assert.equal(readLock(dir).heartbeat, new Date(t0 + 60_000).toISOString());
  assert.equal(heartbeat(dir, { pid: process.pid + 1, now: t0 + 120_000 }), false);
  assert.equal(readLock(dir).heartbeat, new Date(t0 + 60_000).toISOString(), 'a stranger cannot refresh it');
});

test('release removes only a lock this process holds', () => {
  const dir = repo();
  claim(dir, { pid: process.pid, session: 'me' });
  assert.equal(release(dir, { pid: process.pid + 1 }), false);
  assert.ok(existsSync(lockFile(dir)));
  assert.equal(release(dir, { pid: process.pid }), true);
  assert.ok(!existsSync(lockFile(dir)));
  assert.equal(release(dir, { pid: process.pid }), false);
});

test('outside an SDLC repo the script prints nothing and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-nowatch-'));
  execFileSync('git', ['init', '-q', dir]);
  const r = run(dir, 'claim');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.ok(!existsSync(lockFile(dir)));
});

test('ownerPid prefers a live CLAUDE_PID and otherwise returns its start when there is nothing above it', () => {
  assert.equal(ownerPid(1, {}), 1);
  assert.equal(ownerPid(1, { CLAUDE_PID: String(process.pid) }), process.pid);
  assert.equal(ownerPid(1, { CLAUDE_PID: '2147483000' }), 1, 'a dead CLAUDE_PID is ignored');
  assert.equal(ownerPid(1, { CLAUDE_PID: 'nope' }), 1);
});

// Session-start watch text: it names the repo's area, the inbox and owner
// checks, and the per-area limit; a watching repo with no area, or with a
// config that cannot approve, is told to run no watch.
const SESSION_START = fileURLToPath(new URL('../session-start.mjs', import.meta.url));
const GOOD = { approvers: ['octo-lead'], agent: 'acme-bot', tracker: { repo: 'acme/tracker' } };
function sessionText(cfg) {
  const dir = repo();
  writeFileSync(join(dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ integration: 'trunk', testCommand: 'true', ...cfg }));
  // Session start installs the push judge, so it runs with a home of its
  // own: the machine's git config is never written.
  const home = mkdtempSync(join(tmpdir(), 'sdlc-watch-home-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), GIT_CONFIG_NOSYSTEM: '1' };
  const r = spawnSync('node', [SESSION_START, '--repo'], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env });
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('session start names the area the watch serves, the inbox, and the owner check', () => {
  const out = sessionText({ ...GOOD, area: 'web' });
  assert.match(out, /GitHub watch for area "web" in acme\/tracker/);
  assert.match(out, /tracker\.mjs" inbox` marks mine: true/);
  assert.match(out, /policy\.mjs" owner/);
  assert.match(out, /leave its notification unread/);
  assert.match(out, /never another area's/);
  assert.match(out, /watch\.mjs" claim/);
});

test('session start states the per-area limit from the config', () => {
  assert.match(sessionText({ ...GOOD, area: 'web' }), /limit 5, counting only issues\s+area "web" owns/);
  assert.match(sessionText({ ...GOOD, area: 'web', inFlightLimit: 2 }), /limit 2, counting only issues\s+area "web" owns/);
});

test('a watching repo with no area is told to start no loop', () => {
  const out = sessionText(GOOD);
  assert.match(out, /Watch: off\./);
  assert.match(out, /names no area/);
  assert.doesNotMatch(out, /watch\.mjs" claim/);
});

test('a repo with watch false prints no watch text', () => {
  const out = sessionText({ ...GOOD, watch: false, area: 'web' });
  assert.doesNotMatch(out, /Watch:/);
});

test('an area that is not a lowercase name is told to start no loop', () => {
  const out = sessionText({ ...GOOD, area: 'Web Team' });
  assert.match(out, /Watch: off\./);
  assert.match(out, /"Web Team"/);
  assert.doesNotMatch(out, /watch\.mjs" claim/);
});

test('a config whose agent is also an approver runs no watch and says why', () => {
  const out = sessionText({ ...GOOD, area: 'web', approvers: ['acme-bot'] });
  assert.match(out, /Watch: off\./);
  assert.match(out, /also an approver/);
  assert.doesNotMatch(out, /watch\.mjs" claim/);
});
