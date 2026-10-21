// Tests for the git pre-push judge (decision 0005). Every case is a real
// `git push` to a bare origin in a temp directory, with the judge installed as
// the repo's pre-push hook, so git itself hands the judge the shas it sends.
// The machine's own git config never takes part: HOME, XDG_CONFIG_HOME, and
// XDG_DATA_HOME point into the temp directory and the system config is off.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingKeyword, greenKey, gitEnv } from '../git-pre-push.mjs';

const JUDGE = fileURLToPath(new URL('../git-pre-push.mjs', import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), 'sdlc-judge-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

function envFor(root) {
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
  return env;
}

function git(t, cwd, ...args) {
  return execFileSync('git', args, { cwd, env: t.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function push(t, ...args) {
  const r = spawnSync('git', ['push', '-q', ...args], { cwd: t.repo, env: { ...t.env, ...(t.pushEnv || {}) }, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

function commitFile(t, path, body, message = `GH-1: change ${path}`) {
  const full = join(t.repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(t, t.repo, 'add', '--', path);
  git(t, t.repo, 'commit', '-q', '-m', message);
}

function markerDir(t, kind) {
  const common = git(t, t.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return join(common, 'sdlc-harness', kind);
}

/** Record green for a commit's tree, as verify.mjs does. */
function green(t, rev = 'HEAD') {
  const tree = git(t, t.repo, 'rev-parse', `${rev}^{tree}`);
  let cmd = '';
  try {
    cmd = JSON.parse(git(t, t.repo, 'cat-file', '-p', `${rev}:.sdlc-harness/sdlc.json`)).testCommand || '';
  } catch {}
  mkdirSync(markerDir(t, 'green'), { recursive: true });
  writeFileSync(join(markerDir(t, 'green'), greenKey(tree, cmd)), 'test\n');
}

function go(t, id) {
  mkdirSync(markerDir(t, 'go'), { recursive: true });
  writeFileSync(join(markerDir(t, 'go'), id), 'test\n');
}

/** A trunk repo with one pushed commit and the judge installed as pre-push. */
function scratch({ sdlc = {}, seed = true } = {}) {
  const root = mkdtempSync(join(BASE, 'repo-'));
  const t = { root, env: envFor(root), origin: join(root, 'origin.git'), repo: join(root, 'repo') };
  git(t, root, 'init', '-q', '--bare', '-b', 'main', t.origin);
  git(t, root, 'init', '-q', '-b', 'main', t.repo);
  git(t, t.repo, 'remote', 'add', 'origin', t.origin);
  const cfg = { integration: 'trunk', defaultBranch: 'main', testCommand: 'npm test', protectedPaths: ['db/'], ...sdlc };
  commitFile(t, '.sdlc-harness/sdlc.json', JSON.stringify(cfg, null, 2), 'GH-1: init');
  if (seed) git(t, t.repo, 'push', '-q', 'origin', 'main');
  const hooks = join(root, 'judge-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\nexec "${process.execPath}" "${JUDGE}" "$@"\n`);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  git(t, t.repo, 'config', 'core.hooksPath', hooks);
  return t;
}

function refused(r, re) {
  assert.notEqual(r.status, 0, `push went through; stderr: ${r.stderr}`);
  assert.match(r.stderr, /push refused/);
  if (re) assert.match(r.stderr, re);
}
function accepted(r) {
  assert.equal(r.status, 0, `push was refused: ${r.stderr}`);
}
const remoteMain = (t) => git(t, t.origin, 'rev-parse', 'main');

describe('green record', () => {
  test('a green commit pushed to main goes through', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
    assert.equal(remoteMain(t), git(t, t.repo, 'rev-parse', 'HEAD'));
  });

  test('a commit with no green record is refused', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    refused(push(t, 'origin', 'HEAD:main'), /No green record/);
  });

  test('the commit sent is judged, not HEAD: red:main is refused while HEAD is green', () => {
    const t = scratch();
    git(t, t.repo, 'checkout', '-q', '-b', 'red');
    commitFile(t, 'red.txt', 'red\n');
    git(t, t.repo, 'checkout', '-q', 'main');
    commitFile(t, 'ok.txt', 'ok\n');
    green(t);
    refused(push(t, 'origin', 'red:main'), /No green record/);
  });

  test('a moved tracking ref changes nothing: git hands the judge the remote sha (update-ref)', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    commitFile(t, 'db/schema.sql', 'create table x();\n');
    git(t, t.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    refused(push(t, 'origin', 'HEAD:main'), /No green record|protected/);
  });

  test('the green key follows the testCommand in the tree sent, so a changed testCommand can ship', () => {
    const t = scratch();
    commitFile(t, '.sdlc-harness/sdlc.json', JSON.stringify({ integration: 'trunk', defaultBranch: 'main', testCommand: 'npm run test:all', protectedPaths: ['db/'] }), 'GH-2: new test command');
    go(t, 'GH-2');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a green record under another testCommand does not count', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    const tree = git(t, t.repo, 'rev-parse', 'HEAD^{tree}');
    mkdirSync(markerDir(t, 'green'), { recursive: true });
    writeFileSync(join(markerDir(t, 'green'), greenKey(tree, 'true')), 'x\n');
    refused(push(t, 'origin', 'HEAD:main'), /No green record/);
  });

  test('SDLC_HARNESS_HOOK_BYPASS is ignored', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    t.pushEnv = { SDLC_HARNESS_HOOK_BYPASS: '1' };
    refused(push(t, 'origin', 'HEAD:main'), /No green record/);
  });

  test('an up-to-date push needs nothing', () => {
    const t = scratch();
    accepted(push(t, 'origin', 'main'));
  });
});

describe('history is never rewritten or removed', () => {
  function diverged() {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
    git(t, t.repo, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(t, 'b.txt', 'b\n');
    green(t);
    return t;
  }
  for (const args of [['-f', 'origin', 'HEAD:main'], ['-qf', 'origin', 'HEAD:main'], ['--force-with-lease', 'origin', 'HEAD:main'], ['origin', '+HEAD:main']]) {
    test(`a force push is refused: git push ${args.join(' ')}`, () => {
      const t = diverged();
      const before = remoteMain(t);
      refused(push(t, ...args), /not a fast-forward|rewrite/);
      assert.equal(remoteMain(t), before);
    });
  }

  test('deleting the default branch is refused', () => {
    const t = scratch();
    refused(push(t, 'origin', ':main'), /delete/);
  });

  test('deleting any other ref is refused too (decision 0005)', () => {
    const t = scratch({ sdlc: { integration: 'github-flow' } });
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main:other');
    refused(push(t, 'origin', '--delete', 'other'), /delete/);
  });

  // Another clone moves the remote, so the remote tip is not held locally.
  function movedElsewhere(t) {
    const other = join(t.root, 'other');
    git(t, t.root, 'clone', '-q', t.origin, other);
    git(t, other, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(other, 'f.txt'), 'f\n');
    git(t, other, 'add', 'f.txt');
    git(t, other, 'commit', '-q', '-m', 'GH-1: f');
    git(t, other, 'tag', '-a', 't1', '-m', 't');
    git(t, other, 'push', '-q', '--no-verify', 'origin', 'feature', 't1');
    git(t, other, 'checkout', '-q', 'main');
    writeFileSync(join(other, 'm.txt'), 'm\n');
    git(t, other, 'add', 'm.txt');
    git(t, other, 'commit', '-q', '-m', 'GH-2: m');
    git(t, other, 'push', '-q', '--no-verify', 'origin', 'main');
    git(t, t.origin, 'config', 'receive.denyDeleteCurrent', 'ignore');
  }
  for (const ref of ['refs/heads/feature', 'refs/tags/t1', 'refs/heads/main']) {
    test(`deleting ${ref} is refused when its remote tip is not held locally`, () => {
      const t = scratch();
      movedElsewhere(t);
      refused(push(t, 'origin', `:${ref}`), /delete/);
      assert.match(git(t, t.origin, 'show-ref'), new RegExp(ref.replace(/\//g, '\\/')));
    });
  }

  test('a new branch whose tip deletes .sdlc-harness/sdlc.json is still judged as the repo it leaves', () => {
    const t = scratch();
    git(t, t.repo, 'checkout', '-q', '-b', 'sneaky');
    git(t, t.repo, 'rm', '-q', '.sdlc-harness/sdlc.json');
    commitFile(t, 'db/k', 'k\n', 'GH-1: sneaky');
    refused(push(t, 'origin', 'sneaky'), /trunk/);
    assert.doesNotMatch(git(t, t.origin, 'show-ref'), /sneaky/);
  });

  test('a force push over a remote tip not held here, whose commit deletes .sdlc-harness/sdlc.json, is still judged', () => {
    const t = scratch();
    movedElsewhere(t);
    git(t, t.repo, 'rm', '-q', '.sdlc-harness/sdlc.json');
    commitFile(t, 'cfg.txt', `key=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`, 'GH-1: leave');
    const before = remoteMain(t);
    refused(push(t, '--force', 'origin', 'HEAD:main'));
    assert.equal(remoteMain(t), before);
  });

  test('with no config readable anywhere, a repo that was managed is refused', () => {
    const t = scratch();
    movedElsewhere(t);
    for (const r of git(t, t.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean)) git(t, t.repo, 'update-ref', '-d', r);
    git(t, t.repo, 'rm', '-q', '.sdlc-harness/sdlc.json');
    commitFile(t, 'cfg.txt', 'x\n', 'GH-1: leave');
    const before = remoteMain(t);
    refused(push(t, '--force', 'origin', 'HEAD:main'), /cannot read|managed/);
    assert.equal(remoteMain(t), before);
  });

  // A github-flow repo whose remote keeps a branch from before adoption
  // (legacy, no config), with main then moved by another clone.
  function preAdoption() {
    const t = scratch({ seed: false, sdlc: { integration: 'github-flow' } });
    git(t, t.repo, 'rm', '-q', '-r', '.sdlc-harness');
    git(t, t.repo, 'commit', '-q', '-m', 'init');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main', 'main:legacy');
    commitFile(t, '.sdlc-harness/sdlc.json', JSON.stringify({ integration: 'github-flow', defaultBranch: 'main', testCommand: 'true', protectedPaths: ['db/'] }), 'GH-1: adopt');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main');
    git(t, t.repo, 'fetch', '-q', 'origin');
    const legacy = git(t, t.repo, 'rev-parse', 'origin/legacy');
    const other = join(t.root, 'other');
    git(t, t.root, 'clone', '-q', t.origin, other);
    writeFileSync(join(other, 'm.txt'), 'm\n');
    git(t, other, 'add', 'm.txt');
    git(t, other, 'commit', '-q', '-m', 'GH-2: m');
    git(t, other, 'push', '-q', '--no-verify', 'origin', 'main');
    git(t, t.repo, 'checkout', '-q', '-B', 'evil', legacy);
    commitFile(t, 'db/k.sql', `k=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`, 'x');
    return t;
  }

  test('a push by URL onto a branch from before adoption is judged by the tracking refs it still has', () => {
    const t = preAdoption();
    const before = git(t, t.origin, 'rev-parse', 'legacy');
    refused(push(t, t.origin, 'HEAD:legacy'), /AWS access key|db\/k\.sql/);
    assert.equal(git(t, t.origin, 'rev-parse', 'legacy'), before);
  });

  test('with the tracking refs deleted, a local branch that carries the config still marks the repo managed', () => {
    const t = preAdoption();
    for (const r of git(t, t.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean)) git(t, t.repo, 'update-ref', '-d', r);
    const before = git(t, t.origin, 'rev-parse', 'legacy');
    refused(push(t, '--force', 'origin', 'HEAD:legacy'), /AWS access key|db\/k\.sql/);
    assert.equal(git(t, t.origin, 'rev-parse', 'legacy'), before);
  });

  test('--mirror, which deletes what the local repo lacks, is refused', () => {
    const t = scratch();
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main:stray');
    refused(push(t, '--mirror', 'origin'), /mirror/);
    assert.match(git(t, t.origin, 'show-ref'), /refs\/heads\/stray/);
  });

  test('a remote set to mirror is refused, since git deletes for it without telling the hook', () => {
    const t = scratch();
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main:stray');
    git(t, t.repo, 'config', 'remote.origin.mirror', 'true');
    refused(push(t, 'origin'), /mirror/);
    assert.match(git(t, t.origin, 'show-ref'), /refs\/heads\/stray/);
  });

  test('a mirror push through a git alias is refused', () => {
    const t = scratch();
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main:stray');
    for (const r of git(t, t.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean)) git(t, t.repo, 'update-ref', '-d', r);
    git(t, t.repo, 'config', 'alias.pm', 'push --mirror');
    const r = spawnSync('git', ['pm', 'origin'], { cwd: t.repo, env: t.env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mirror/);
    assert.match(git(t, t.origin, 'show-ref'), /refs\/heads\/stray/);
  });

  test('a ref that is neither a branch nor a tag is refused', () => {
    const t = scratch();
    refused(push(t, 'origin', 'HEAD:refs/notes/x'), /neither a branch nor a tag/);
  });

  test('a new branch on a trunk repo is refused', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    refused(push(t, 'origin', 'HEAD:feature'), /trunk/);
  });

  test('a new branch on a github-flow repo is judged and goes through when clean', () => {
    const t = scratch({ sdlc: { integration: 'github-flow' } });
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    accepted(push(t, 'origin', 'HEAD:gh-1'));
  });
});

describe('secrets', () => {
  const KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

  test('a key on an added line is refused', () => {
    const t = scratch();
    commitFile(t, 'cfg.txt', `key=${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('a key added in one commit and removed in the next is refused', () => {
    const t = scratch();
    commitFile(t, 'cfg.txt', `key=${KEY}\n`);
    commitFile(t, 'cfg.txt', 'key=redacted\n');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('an added line that starts with ++ is read', () => {
    const t = scratch();
    commitFile(t, 'notes.md', `++ ${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('an added line that starts with ++ b/ is read, not taken for a file header', () => {
    const t = scratch();
    commitFile(t, 'notes.md', `first\n++ b/x ${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('a key in a commit message is refused', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n', `GH-1: rotate ${KEY}`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /commit message/);
  });

  test('a key in a file marked binary is still found', () => {
    const t = scratch();
    commitFile(t, '.gitattributes', '*.bin binary\n');
    commitFile(t, 'blob.bin', `\0\x01${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test("the repo's own diff config hides nothing (color, external diff, noprefix, relative, inter-hunk context)", () => {
    const t = scratch();
    for (const [k, v] of [['color.ui', 'always'], ['diff.external', 'true'], ['diff.noprefix', 'true'], ['diff.relative', 'true'], ['diff.interHunkContext', '50'], ['core.quotePath', 'true'], ['diff.renames', 'copies']]) git(t, t.repo, 'config', k, v);
    commitFile(t, 'sub/cfg.txt', `key=${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('a replace ref cannot show the judge a clean commit in place of the one sent', () => {
    const t = scratch();
    commitFile(t, 'cfg.txt', 'clean\n');
    const clean = git(t, t.repo, 'rev-parse', 'HEAD');
    git(t, t.repo, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(t, 'cfg.txt', `key=${KEY}\n`);
    git(t, t.repo, 'replace', 'HEAD', clean);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('a key on the last line of a 1.5 MB change is found', () => {
    const t = scratch();
    const filler = Array.from({ length: 30000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    commitFile(t, 'big.txt', `${filler}\nkey=${KEY}\n`);
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('one 1.3 MB line with a database URL prefix is judged in seconds, not minutes', () => {
    const t = scratch();
    commitFile(t, 'one.txt', `postgres://${'u'.repeat(1_300_000)}\n`);
    green(t);
    const started = Date.now();
    accepted(push(t, 'origin', 'HEAD:main'));
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  });

  test('editing a file that already holds a match, on another line, goes through', () => {
    const t = scratch();
    const url = 'postgres://' + 'u:p@localhost/db';
    commitFile(t, 'server/.env.example', `DATABASE_URL=${url}\nPORT=1\n`);
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'HEAD:main');
    commitFile(t, 'server/.env.example', `DATABASE_URL=${url}\nPORT=2\n`);
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a merge that brings in a match already on the remote goes through (a pull with merge)', () => {
    const t = scratch();
    const other = join(t.root, 'other');
    git(t, t.root, 'clone', '-q', t.origin, other);
    writeFileSync(join(other, 't.js'), `u = "${'postgres://' + 'u:p@h/db'}"\n`);
    git(t, other, 'add', 't.js');
    git(t, other, 'commit', '-q', '-m', 'GH-5: fixture');
    git(t, other, 'push', '-q', '--no-verify', 'origin', 'main');
    commitFile(t, 'a.txt', 'd\n', 'GH-6: d');
    git(t, t.repo, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a conflict resolution that keeps a fixture line already on the remote goes through', () => {
    const t = scratch();
    commitFile(t, 'f.js', '1\n2\n3\n4\nfive\n6\n', 'GH-6: f');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'HEAD:main');
    const other = join(t.root, 'other');
    git(t, t.root, 'clone', '-q', t.origin, other);
    writeFileSync(join(other, 'f.js'), `1\n2\n3\n4\nu = "${'postgres://' + 'u:p@h/db'}"\nB\n6\n`);
    git(t, other, 'commit', '-q', '-am', 'GH-6: fixture');
    git(t, other, 'push', '-q', '--no-verify', 'origin', 'main');
    commitFile(t, 'f.js', '1\n2\n3\n4\nA\n6\n', 'GH-6: A');
    assert.notEqual(spawnSync('git', ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], { cwd: t.repo, env: t.env }).status, 0, 'the pull must conflict');
    writeFileSync(join(t.repo, 'f.js'), `1\n2\n3\n4\nu = "${'postgres://' + 'u:p@h/db'}"\nAB\n6\n`);
    git(t, t.repo, 'add', 'f.js');
    git(t, t.repo, 'commit', '-q', '--no-edit');
    const shown = git(t, t.repo, 'diff-tree', '-p', '-U0', '--cc', 'HEAD');
    assert.match(shown, /^\+ u = /m, 'the fixture line is shown, from one side only');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a key a merge resolution adds is still found', () => {
    const t = scratch();
    git(t, t.repo, 'checkout', '-q', '-b', 'side');
    commitFile(t, 's.txt', 's\n', 'GH-6: side');
    git(t, t.repo, 'checkout', '-q', 'main');
    commitFile(t, 'm.txt', 'm\n', 'GH-6: main');
    git(t, t.repo, 'merge', '-q', '--no-commit', 'side');
    writeFileSync(join(t.repo, 'r.txt'), `key=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`);
    git(t, t.repo, 'add', 'r.txt');
    git(t, t.repo, 'commit', '-q', '--no-edit');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /AWS access key/);
  });

  test('renaming a file that holds a match goes through', () => {
    const t = scratch();
    commitFile(t, 't.js', `u = "${'postgres://' + 'u:p@h/db'}"\n`, 'GH-5: fixture');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'HEAD:main');
    git(t, t.repo, 'mv', 't.js', 't2.js');
    git(t, t.repo, 'commit', '-q', '-m', 'GH-7: rename');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a read that fails refuses the push, never reading as no change', () => {
    const t = scratch();
    commitFile(t, 'cfg.txt', 'clean\n');
    green(t);
    const blob = git(t, t.repo, 'rev-parse', 'HEAD:cfg.txt');
    rmSync(join(t.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    // git's diff reads a clean work tree file in place of its blob, so the
    // file goes too, and the read must reach the missing object.
    rmSync(join(t.repo, 'cfg.txt'));
    const line = `refs/heads/main ${git(t, t.repo, 'rev-parse', 'HEAD')} refs/heads/main ${remoteMain(t)}\n`;
    const r = spawnSync(process.execPath, [JUDGE, 'origin', t.origin], { cwd: t.repo, env: t.env, input: line, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not read/);
  });

  test("the judge's own reads drop GIT_CONFIG_* from the environment", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_CONFIG_PARAMETERS: "'diff.external'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/x', GIT_CONFIG_GLOBAL: '/dev/null' });
      const env = gitEnv();
      assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG')), []);
      assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    }
  });

  test('a change past the size ceiling refuses the push with the reason', () => {
    const t = scratch();
    commitFile(t, 'big.txt', 'y'.repeat(4096) + '\n');
    green(t);
    t.pushEnv = { SDLC_HARNESS_JUDGE_MAX_BYTES: '1024' };
    refused(push(t, 'origin', 'HEAD:main'), /ceiling|could not read/);
  });

  test('the ceiling can be lowered for a test but never raised', () => {
    const t = scratch();
    commitFile(t, 'big.txt', 'y'.repeat(4096) + '\n');
    green(t);
    t.pushEnv = { SDLC_HARNESS_JUDGE_MAX_BYTES: String(1024 ** 4) };
    accepted(push(t, 'origin', 'HEAD:main'));
  });
});

describe('closing keywords (only an approver closes an issue)', () => {
  test('the GitHub closing forms are read as closing, in any case, with or without a colon', () => {
    for (const line of ['Fixes #12', 'fix #12', 'Fixed: #12', 'closes acme/web#3', 'CLOSED #4', 'Resolves https://github.com/acme/web/issues/5', 'resolve GH-6', 'GH-7: tidy up, fixes #7']) {
      assert.ok(closingKeyword(line), line);
    }
  });

  test('naming an issue without a closing keyword is not closing', () => {
    for (const line of ['GH-12: fix the parser', 'Refs #12', 'the fix for #12 is next', 'suffix #1', 'prefixes #2', 'Closes the drawer on escape', 'fixes a race in the queue', 'Fix utf-8 decoding', 'fixes sha-1 lookup', 'close http-2 streams']) {
      assert.equal(closingKeyword(line), null, line);
    }
  });

  test("the prefix form is the config's own prefix only", () => {
    assert.ok(closingKeyword('fixes WEB-3', 'WEB'));
    assert.equal(closingKeyword('fixes GH-3', 'WEB'), null);
    assert.ok(closingKeyword('fixes #3', 'WEB'), 'the # form is always closing');
  });

  test('long runs of spaces are read in time proportional to their length', () => {
    const start = Date.now();
    for (const pad of [' '.repeat(200_000), '\t'.repeat(200_000), ': '.repeat(100_000)]) closingKeyword(`fix${pad}`);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
    assert.ok(closingKeyword(`Fixes${' '.repeat(50_000)}#12`), 'the spaces collapse, the phrase is still read');
  });

  test('a commit message with a closing keyword is refused and named', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n', 'GH-12: parse dates\n\nFixes #12');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /closing keyword[\s\S]*"Fixes #12"/);
  });

  test('a closing keyword anywhere in the commits sent refuses the push, not only at the tip', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n', 'GH-12: first\n\nresolves acme/web#12');
    commitFile(t, 'b.txt', 'b\n', 'GH-12: second');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /closing keyword/);
  });

  test('a commit that names the issue plainly goes through', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n', 'GH-12: fix the parser\n\nRefs #12');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('a closing keyword on a github-flow branch is refused too: the PR would close the issue on merge', () => {
    const t = scratch({ sdlc: { integration: 'github-flow' } });
    commitFile(t, 'a.txt', 'a\n', 'GH-3: x\n\nCloses #3');
    green(t);
    refused(push(t, 'origin', 'HEAD:gh-3'), /closing keyword/);
  });
});

describe('protected paths', () => {
  test('a protected path with no recorded go is refused', () => {
    const t = scratch();
    commitFile(t, 'db/schema.sql', 'create table x();\n', 'GH-7: table');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /db\/schema\.sql/);
  });

  test('a protected path with a go for a ticket in the range goes through', () => {
    const t = scratch();
    commitFile(t, 'db/schema.sql', 'create table x();\n', 'GH-7: table');
    go(t, 'GH-7');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
  });

  test('the issue prefix comes from the config: a go under another prefix does not apply', () => {
    const t = scratch({ sdlc: { issuePrefix: 'WEB' } });
    commitFile(t, 'db/schema.sql', 'x\n', 'GH-7: table');
    go(t, 'GH-7');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /No WEB-n in the commits sent/);
  });

  test('an issuePrefix that is not letters and digits refuses the push', () => {
    const t = scratch({ sdlc: { issuePrefix: '.*' }, seed: false });
    green(t);
    refused(push(t, 'origin', 'main'), /issuePrefix/);
  });

  test('a protected file added and removed within the range still counts', () => {
    const t = scratch();
    commitFile(t, 'db/tmp.sql', 'x\n', 'GH-7: add');
    git(t, t.repo, 'rm', '-q', 'db/tmp.sql');
    git(t, t.repo, 'commit', '-q', '-m', 'GH-7: remove');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /db\/tmp\.sql/);
  });

  test('moving a file out of a protected path is a change there', () => {
    const t = scratch();
    commitFile(t, 'db/keep.sql', 'x\n', 'GH-7: add');
    go(t, 'GH-7');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
    mkdirSync(join(t.repo, 'moved'));
    git(t, t.repo, 'mv', 'db/keep.sql', 'moved/keep.sql');
    git(t, t.repo, 'commit', '-q', '-m', 'GH-8: move');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /db\/keep\.sql/);
  });

  test('a protected path with a non-ASCII name is still protected', () => {
    const t = scratch();
    commitFile(t, 'db/é.sql', 'x\n', 'GH-7: accent');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /db\/é\.sql/);
  });

  test('.sdlc-harness/ is always protected, and the config judged is the one already on the remote', () => {
    const t = scratch();
    commitFile(t, '.sdlc-harness/sdlc.json', JSON.stringify({ integration: 'trunk', defaultBranch: 'main', testCommand: 'npm test', protectedPaths: [] }), 'GH-9: loosen');
    commitFile(t, 'db/schema.sql', 'x\n', 'GH-9: table');
    green(t);
    refused(push(t, 'origin', 'HEAD:main'), /\.sdlc-harness\/sdlc\.json[\s\S]*db\/schema\.sql|db\/schema\.sql[\s\S]*\.sdlc-harness/);
  });
});

describe('several refs, tags, and new remotes', () => {
  test('one refused ref stops the whole push', () => {
    const t = scratch({ sdlc: { integration: 'github-flow' } });
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    git(t, t.repo, 'checkout', '-q', '-b', 'red');
    commitFile(t, 'r.txt', 'r\n');
    const before = remoteMain(t);
    refused(push(t, 'origin', 'main', 'red'));
    assert.equal(remoteMain(t), before);
  });

  test('an annotated tag whose message holds a key is refused', () => {
    const t = scratch();
    git(t, t.repo, 'tag', '-a', 'v1', '-m', `release ${'AKIA' + 'ABCDEFGHIJKLMNOP'}`);
    refused(push(t, 'origin', 'v1'), /tag message/);
  });

  test('a tag on a commit the remote already has goes through', () => {
    const t = scratch();
    git(t, t.repo, 'tag', '-a', 'v1', '-m', 'release 1');
    accepted(push(t, 'origin', 'v1'));
  });

  test('a tag on a commit the remote lacks is judged like a branch', () => {
    const t = scratch();
    commitFile(t, 'a.txt', 'a\n');
    git(t, t.repo, 'tag', 'v2');
    refused(push(t, 'origin', 'v2'), /No green record/);
  });

  test('moving an existing tag is refused', () => {
    const t = scratch();
    git(t, t.repo, 'tag', 'v1');
    accepted(push(t, 'origin', 'v1'));
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    git(t, t.repo, 'tag', '-f', 'v1');
    refused(push(t, 'origin', '+refs/tags/v1'), /tag|rewrite|not a fast-forward/);
  });

  test('the first push to an empty remote is judged in full', () => {
    const t = scratch({ seed: false });
    commitFile(t, 'cfg.txt', `key=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`);
    commitFile(t, 'cfg.txt', 'clean\n');
    green(t);
    refused(push(t, 'origin', 'main'), /AWS access key/);
  });

  test('first adoption: a remote without .sdlc-harness/sdlc.json is judged by the config the push brings', () => {
    const t = scratch({ seed: false });
    git(t, t.repo, 'rm', '-q', '-r', '.sdlc-harness');
    git(t, t.repo, 'commit', '-q', '-m', 'plain');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main');
    commitFile(t, '.sdlc-harness/sdlc.json', JSON.stringify({ testCommand: 'false', protectedPaths: ['db/'] }), 'adopt');
    commitFile(t, 'db/s.sql', `k=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`, 'adopt db');
    const r = push(t, 'origin', 'main');
    refused(r, /No green record/);
    assert.match(r.stderr, /AWS access key/);
    assert.match(r.stderr, /db\/s\.sql/);
  });

  test('a key in the root commit of a first push is found', () => {
    const t = scratch({ seed: false });
    writeFileSync(join(t.repo, 'cfg.txt'), `key=${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`);
    git(t, t.repo, 'add', '-A');
    git(t, t.repo, 'commit', '-q', '--amend', '-m', 'GH-1: root');
    go(t, 'GH-1');
    green(t);
    assert.equal(git(t, t.repo, 'rev-list', '--count', 'HEAD'), '1');
    refused(push(t, 'origin', 'main'), /AWS access key/);
  });

  test('the first push to an empty remote goes through when clean and green', () => {
    const t = scratch({ seed: false });
    go(t, 'GH-1');
    green(t);
    accepted(push(t, 'origin', 'main'));
  });
});

describe('repos the SDLC does not manage, and chaining', () => {
  test('a repo with no .sdlc-harness/sdlc.json pushes untouched', () => {
    const t = scratch();
    git(t, t.repo, 'rm', '-q', '-r', '.sdlc-harness');
    git(t, t.repo, 'commit', '-q', '-m', 'unmanage');
    git(t, t.repo, 'push', '-q', '--no-verify', 'origin', 'main');
    commitFile(t, 'a.txt', `${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`);
    accepted(push(t, 'origin', 'main'));
  });

  test('a fast-forward in a repo never managed asks the remote nothing more', () => {
    const root = mkdtempSync(join(BASE, 'plain-'));
    const t = { root, env: envFor(root), origin: join(root, 'o.git'), repo: join(root, 'r') };
    git(t, root, 'init', '-q', '--bare', '-b', 'main', t.origin);
    git(t, root, 'init', '-q', '-b', 'main', t.repo);
    git(t, t.repo, 'remote', 'add', 'origin', t.origin);
    commitFile(t, 'x', 'x\n', 'i');
    git(t, t.repo, 'push', '-q', 'origin', 'main');
    const hooks = join(root, 'judge-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\nexec "${process.execPath}" "${JUDGE}" "$@"\n`);
    chmodSync(join(hooks, 'pre-push'), 0o755);
    git(t, t.repo, 'config', 'core.hooksPath', hooks);
    commitFile(t, 'x', 'y\n', 'y');
    const trace = join(root, 'trace.txt');
    t.pushEnv = { GIT_TRACE: trace };
    accepted(push(t, 'origin', 'main'));
    assert.equal((readFileSync(trace, 'utf8').match(/ls-remote/g) || []).length, 0);
  });

  test("after its checks pass, the judge runs the repo's own pre-push with the same stdin", () => {
    const t = scratch();
    const common = git(t, t.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const out = join(t.root, 'chained.txt');
    writeFileSync(join(common, 'hooks', 'pre-push'), `#!/bin/sh\necho "$1 $2" > "${out}"\ncat >> "${out}"\nexit 1\n`);
    chmodSync(join(common, 'hooks', 'pre-push'), 0o755);
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    const r = push(t, 'origin', 'HEAD:main');
    assert.notEqual(r.status, 0, 'the chained hook refused, so the push must fail');
    const seen = readFileSync(out, 'utf8');
    assert.match(seen, /^origin /);
    assert.match(seen, /HEAD [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}/);
  });

  test('the chained hook is not run when the judge refuses', () => {
    const t = scratch();
    const common = git(t, t.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const out = join(t.root, 'chained.txt');
    writeFileSync(join(common, 'hooks', 'pre-push'), `#!/bin/sh\ntouch "${out}"\n`);
    chmodSync(join(common, 'hooks', 'pre-push'), 0o755);
    commitFile(t, 'a.txt', 'a\n');
    refused(push(t, 'origin', 'HEAD:main'));
    assert.equal(existsSync(out), false);
  });

  test('a chain that comes back to the judge ends there instead of running in a circle', () => {
    const t = scratch();
    const common = git(t, t.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    // The repo's own pre-push runs the judge again, as another tool's hooks
    // directory would when it records this one as its previous path.
    const count = join(t.root, 'count.txt');
    writeFileSync(join(common, 'hooks', 'pre-push'), `#!/bin/sh\necho x >> "${count}"\nexec "${process.execPath}" "${JUDGE}" "$@"\n`);
    chmodSync(join(common, 'hooks', 'pre-push'), 0o755);
    commitFile(t, 'a.txt', 'a\n');
    green(t);
    accepted(push(t, 'origin', 'HEAD:main'));
    assert.equal(readFileSync(count, 'utf8'), 'x\n');
  });
});
