// Tests for the push judge's install. Everything happens under a temp HOME,
// XDG_CONFIG_HOME, and XDG_DATA_HOME with the system config off, so the
// machine's own git config is never read or written.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks, proveHooks, globalHooksDir, localHooksDir, prePushShim, CHAINED_HOOKS } from '../lib.mjs';

const LIB = fileURLToPath(new URL('../lib.mjs', import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), 'sdlc-install-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

function world() {
  const root = mkdtempSync(join(BASE, 'w-'));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  for (const d of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]) mkdirSync(d, { recursive: true });
  const w = { root, env, origin: join(root, 'origin.git'), repo: join(root, 'repo') };
  git(w, root, 'init', '-q', '--bare', '-b', 'main', w.origin);
  git(w, root, 'init', '-q', '-b', 'main', w.repo);
  git(w, w.repo, 'remote', 'add', 'origin', w.origin);
  mkdirSync(join(w.repo, '.sdlc-harness'));
  writeFileSync(join(w.repo, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ integration: 'trunk', defaultBranch: 'main', testCommand: 'true' }));
  git(w, w.repo, 'add', '.');
  git(w, w.repo, 'commit', '-q', '-m', 'GH-1: init');
  git(w, w.repo, 'push', '-q', 'origin', 'main');
  return w;
}

function git(w, cwd, ...args) {
  return execFileSync('git', args, { cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000 }).trim();
}
function tryGit(w, cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: w.env, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}
function redCommit(w, cwd = w.repo) {
  writeFileSync(join(cwd, `f-${Math.random().toString(36).slice(2)}.txt`), 'x\n');
  git(w, cwd, 'add', '.');
  git(w, cwd, 'commit', '-q', '-m', 'GH-1: red');
}

describe('install', () => {
  test('sets the repo and global hooks paths to the harness directories, and proves it', () => {
    const w = world();
    const { globalDir, localDir } = installHooks(w.repo, { env: w.env });
    assert.equal(globalDir, globalHooksDir(w.env));
    assert.equal(localDir, localHooksDir(w.repo, w.env));
    assert.match(localDir, /\/sdlc-harness\/hooks$/);
    assert.equal(git(w, w.repo, 'config', '--local', 'core.hooksPath'), localDir);
    assert.equal(git(w, w.repo, 'config', '--global', 'core.hooksPath'), globalDir);
    for (const dir of [globalDir, localDir]) {
      assert.ok(existsSync(join(dir, 'git-pre-push.mjs')));
      assert.equal(readFileSync(join(dir, 'pre-push'), 'utf8'), prePushShim(dir, process.execPath, { local: dir === localDir }));
      for (const name of CHAINED_HOOKS) assert.ok(existsSync(join(dir, name)), name);
    }
    assert.deepEqual(proveHooks(w.repo, { env: w.env }), { ok: true, dir: localDir });
  });

  test('a red push is refused once installed', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    redCommit(w);
    const r = tryGit(w, w.repo, 'push', '-q', 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No green record/);
  });

  test('a worktree made after the install is judged', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    const wt = join(w.root, 'wt');
    git(w, w.repo, 'worktree', 'add', '-q', '-b', 'gh-1', wt);
    redCommit(w, wt);
    const r = tryGit(w, wt, 'push', '-q', 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No green record/);
  });

  test('a clone made after the install is judged through the global hooks path', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    const clone = join(w.root, 'clone');
    git(w, w.root, 'clone', '-q', w.origin, clone);
    assert.equal(tryGit(w, clone, 'config', '--local', 'core.hooksPath').status, 1);
    redCommit(w, clone);
    const r = tryGit(w, clone, 'push', '-q', 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No green record/);
  });

  // Node runs the judge at its real path, so a symlink in the hooks path (macOS's
  // /var, a linked home or XDG_DATA_HOME) must not make it skip its checks.
  test('a judge reached through a symlinked hooks path still judges', () => {
    const w = world();
    const { globalDir } = installHooks(w.repo, { env: w.env });
    const link = join(w.root, 'linked-hooks');
    symlinkSync(globalDir, link);
    git(w, w.root, 'config', '--global', 'core.hooksPath', link);
    const clone = join(w.root, 'clone');
    git(w, w.root, 'clone', '-q', w.origin, clone);
    redCommit(w, clone);
    const r = tryGit(w, clone, 'push', '-q', 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No green record/);
  });

  test("the repo's own hooks still run, through the chain", () => {
    const w = world();
    const mark = join(w.root, 'pre-commit-ran');
    writeFileSync(join(w.repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${mark}"\n`);
    chmodSync(join(w.repo, '.git', 'hooks', 'pre-commit'), 0o755);
    installHooks(w.repo, { env: w.env });
    redCommit(w);
    assert.ok(existsSync(mark));
  });

  test('a hooks path set before the install keeps running, globally and per repo', () => {
    const w = world();
    const before = join(w.root, 'old-hooks');
    mkdirSync(before);
    const mark = join(w.root, 'old-commit-msg-ran');
    writeFileSync(join(before, 'commit-msg'), `#!/bin/sh\ntouch "${mark}"\n`);
    chmodSync(join(before, 'commit-msg'), 0o755);
    git(w, w.repo, 'config', '--global', 'core.hooksPath', before);
    installHooks(w.repo, { env: w.env });
    assert.equal(readFileSync(join(globalHooksDir(w.env), 'previous-hooks-path'), 'utf8').trim(), before);
    assert.equal(readFileSync(join(localHooksDir(w.repo, w.env), 'previous-hooks-path'), 'utf8').trim(), before);
    redCommit(w);
    assert.ok(existsSync(mark));
  });

  test('a chain that circles back through another tool\'s hooks directory runs each hook once and ends', () => {
    const w = world();
    const { localDir } = installHooks(w.repo, { env: w.env });
    // Another tool installed the same way records this directory as its
    // previous path while this one records the other.
    const other = join(w.root, 'other-tool-hooks');
    mkdirSync(other);
    const count = join(w.root, 'other-ran');
    writeFileSync(join(other, 'pre-commit'), `#!/bin/sh\necho x >> "${count}"\nexec "${join(localDir, 'pre-commit')}" "$@"\n`);
    chmodSync(join(other, 'pre-commit'), 0o755);
    writeFileSync(join(localDir, 'previous-hooks-path'), `${other}\n`);
    redCommit(w);
    assert.equal(readFileSync(count, 'utf8'), 'x\n');
  });

  test('a circling chain whose other link spawns the next instead of exec-ing it still ends', () => {
    const w = world();
    const { localDir } = installHooks(w.repo, { env: w.env });
    const other = join(w.root, 'other-tool-hooks');
    mkdirSync(other);
    const count = join(w.root, 'other-ran');
    // No exec: each pass would see a new $PPID, so the guard cannot rest on it.
    writeFileSync(join(other, 'pre-commit'), `#!/bin/sh\necho x >> "${count}"\n"${join(localDir, 'pre-commit')}" "$@"\n`);
    chmodSync(join(other, 'pre-commit'), 0o755);
    writeFileSync(join(localDir, 'previous-hooks-path'), `${other}\n`);
    redCommit(w);
    assert.equal(readFileSync(count, 'utf8'), 'x\n');
  });

  test("a repo's own earlier hooks path is kept as the one it chains to", () => {
    const w = world();
    git(w, w.repo, 'config', '--local', 'core.hooksPath', '.husky');
    installHooks(w.repo, { env: w.env });
    assert.equal(readFileSync(join(localHooksDir(w.repo, w.env), 'previous-hooks-path'), 'utf8').trim(), '.husky');
  });

  test('installing twice changes nothing and never chains a directory to itself', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    installHooks(w.repo, { env: w.env });
    assert.equal(readFileSync(join(globalHooksDir(w.env), 'previous-hooks-path'), 'utf8'), '');
    assert.equal(readFileSync(join(localHooksDir(w.repo, w.env), 'previous-hooks-path'), 'utf8'), '');
  });

  test('a changed judge is replaced on the next install', () => {
    const w = world();
    const { localDir } = installHooks(w.repo, { env: w.env });
    writeFileSync(join(localDir, 'git-pre-push.mjs'), 'process.exit(0);\n');
    assert.equal(proveHooks(w.repo, { env: w.env }).ok, false);
    assert.match(proveHooks(w.repo, { env: w.env }).reason, /differs/);
    installHooks(w.repo, { env: w.env });
    assert.equal(proveHooks(w.repo, { env: w.env }).ok, true);
  });

  test('two installs at once leave a whole judge', async () => {
    const w = world();
    const script = `import { installHooks } from ${JSON.stringify(LIB)}; installHooks(${JSON.stringify(w.repo)});`;
    const runs = Array.from({ length: 4 }, () => new Promise((res) => spawn(process.execPath, ['--input-type=module', '-e', script], { env: w.env, stdio: 'ignore' }).on('exit', res)));
    const codes = await Promise.all(runs);
    assert.deepEqual(codes, [0, 0, 0, 0]);
    assert.equal(proveHooks(w.repo, { env: w.env }).ok, true);
  });
});

describe('session start installs the judge', () => {
  const SESSION_START = fileURLToPath(new URL('../session-start.mjs', import.meta.url));
  const start = (w, cwd, flag = '--repo') => spawnSync(process.execPath, [SESSION_START, flag], { input: JSON.stringify({ cwd }), env: w.env, encoding: 'utf8' });

  test('the repo output installs the judge in a managed repo', () => {
    const w = world();
    const r = start(w, w.repo);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /NOT installed/);
    assert.equal(proveHooks(w.repo, { env: w.env }).ok, true);
  });

  test('the rules and principles outputs install nothing: the judge installs once per session start', () => {
    const w = world();
    for (const flag of ['--rules', '--principles']) start(w, w.repo, flag);
    assert.equal(tryGit(w, w.repo, 'config', '--global', 'core.hooksPath').status, 1);
    assert.equal(tryGit(w, w.repo, 'config', '--local', 'core.hooksPath').status, 1);
  });

  test('says so, and still starts, when the install fails', () => {
    const w = world();
    writeFileSync(join(w.env.XDG_DATA_HOME, 'sdlc-harness'), 'a file where the directory goes\n');
    const r = start(w, w.repo);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Push judge: NOT installed/);
  });

  test('touches nothing in a repo the SDLC does not manage', () => {
    const w = world();
    const other = join(w.root, 'other');
    git(w, w.root, 'init', '-q', other);
    start(w, other);
    assert.equal(tryGit(w, other, 'config', '--global', 'core.hooksPath').status, 1);
  });
});

describe('proof', () => {
  test('fails before any install', () => {
    const w = world();
    assert.match(proveHooks(w.repo, { env: w.env }).reason, /not set/);
  });

  test('fails when the repo points its hooks somewhere else', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    git(w, w.repo, 'config', '--local', 'core.hooksPath', join(w.root, 'elsewhere'));
    assert.match(proveHooks(w.repo, { env: w.env }).reason, /not the sdlc-harness hooks directory/);
  });

  test('fails when the shim does not run the judge', () => {
    const w = world();
    const { localDir } = installHooks(w.repo, { env: w.env });
    writeFileSync(join(localDir, 'pre-push'), '#!/bin/sh\nexit 0\n');
    assert.match(proveHooks(w.repo, { env: w.env }).reason, /does not run/);
  });

  test('fails when the node the shim names is gone', () => {
    const w = world();
    installHooks(w.repo, { env: w.env, node: join(w.root, 'no-node') });
    assert.match(proveHooks(w.repo, { env: w.env }).reason, /node .* is gone/);
  });
});

describe('a missing node', () => {
  // git is in /usr/bin and /bin; node is not, on this machine and in CI's.
  const noNode = (w) => ({ ...w.env, PATH: '/usr/bin:/bin' });

  test('the shim runs the judge with the node on PATH when the one it names is gone', () => {
    const w = world();
    installHooks(w.repo, { env: w.env, node: join(w.root, 'no-node') });
    redCommit(w);
    const r = tryGit(w, w.repo, 'push', '-q', 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No green record/);
  });

  test('with no node at all, a managed repo refuses with the reason', () => {
    const w = world();
    installHooks(w.repo, { env: w.env, node: join(w.root, 'no-node') });
    redCommit(w);
    const r = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: w.repo, env: noNode(w), encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /node is not at/);
  });

  test('with no node at all, a managed repo refuses even from a commit that deletes its config', () => {
    const w = world();
    installHooks(w.repo, { env: w.env, node: join(w.root, 'no-node') });
    git(w, w.repo, 'rm', '-q', '.sdlc-harness/sdlc.json');
    git(w, w.repo, 'commit', '-q', '-m', 'GH-1: leave');
    const r = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: w.repo, env: noNode(w), encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /node is not at/);
  });

  test("with no node at all, a repo the SDLC does not manage passes through to its own hook", () => {
    const w = world();
    installHooks(w.repo, { env: w.env, node: join(w.root, 'no-node') });
    const origin = join(w.root, 'plain.git');
    const plain = join(w.root, 'plain');
    git(w, w.root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(w, w.root, 'init', '-q', '-b', 'main', plain);
    git(w, plain, 'remote', 'add', 'origin', origin);
    const mark = join(w.root, 'own-pre-push-ran');
    writeFileSync(join(plain, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch "${mark}"\n`);
    chmodSync(join(plain, '.git', 'hooks', 'pre-push'), 0o755);
    redCommit(w, plain);
    const r = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: plain, env: noNode(w), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(mark));
  });
});

describe('uninstall', () => {
  const UNINSTALL = fileURLToPath(new URL('../uninstall-hooks.mjs', import.meta.url));

  test('restores the hooks paths set before the install, and git runs no judge after', () => {
    const w = world();
    const before = join(w.root, 'old-hooks');
    mkdirSync(before);
    git(w, w.repo, 'config', '--global', 'core.hooksPath', before);
    git(w, w.repo, 'config', '--local', 'core.hooksPath', '.husky');
    installHooks(w.repo, { env: w.env });
    const r = spawnSync(process.execPath, [UNINSTALL], { cwd: w.repo, env: w.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(w, w.repo, 'config', '--global', 'core.hooksPath'), before);
    assert.equal(git(w, w.repo, 'config', '--local', 'core.hooksPath'), '.husky');
  });

  test('unsets what was not set before', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    const r = spawnSync(process.execPath, [UNINSTALL], { cwd: w.repo, env: w.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(tryGit(w, w.repo, 'config', '--global', 'core.hooksPath').status, 1);
    assert.equal(tryGit(w, w.repo, 'config', '--local', 'core.hooksPath').status, 1);
    redCommit(w);
    assert.equal(tryGit(w, w.repo, 'push', '-q', 'origin', 'HEAD:main').status, 0);
  });

  test('leaves a hooks path someone set after the install alone', () => {
    const w = world();
    installHooks(w.repo, { env: w.env });
    git(w, w.repo, 'config', '--global', 'core.hooksPath', join(w.root, 'mine'));
    spawnSync(process.execPath, [UNINSTALL], { cwd: w.repo, env: w.env, encoding: 'utf8' });
    assert.equal(git(w, w.repo, 'config', '--global', 'core.hooksPath'), join(w.root, 'mine'));
  });
});
