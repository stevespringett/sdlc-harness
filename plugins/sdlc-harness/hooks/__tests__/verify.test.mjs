// Tests for verify.mjs. It records green only when the tree is known clean,
// the push judge is installed and proven, and the testCommand in HEAD's tree
// passes; the record is keyed by that tree and that testCommand, as the judge
// reads it.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { greenKey, proveHooks } from '../lib.mjs';

const VERIFY = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), 'sdlc-verify-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

function repo(testCommand = 'true') {
  const root = mkdtempSync(join(BASE, 'r-'));
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
  const dir = join(root, 'repo');
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env });
  mkdirSync(join(dir, '.sdlc-harness'));
  writeFileSync(join(dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ testCommand }));
  git('add', '.');
  git('commit', '-q', '-m', 'GH-1: init');
  return { root, env, dir, git };
}

const verify = (r) => spawnSync(process.execPath, [VERIFY, '--quiet'], { cwd: r.dir, env: r.env, encoding: 'utf8' });
const greens = (r) => {
  const d = join(r.dir, '.git', 'sdlc-harness', 'green');
  return existsSync(d) ? readdirSync(d) : [];
};

describe('verify', () => {
  test('green is recorded under the tree and the testCommand in it, after the judge is installed and proven', () => {
    const r = repo('true');
    const out = verify(r);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(greens(r), [greenKey(r.git('rev-parse', 'HEAD^{tree}'), 'true')]);
    assert.equal(proveHooks(r.dir, { env: r.env }).ok, true);
  });

  test('a failing testCommand records nothing', () => {
    const r = repo('false');
    assert.notEqual(verify(r).status, 0);
    assert.deepEqual(greens(r), []);
  });

  test('a dirty tree records nothing', () => {
    const r = repo('true');
    writeFileSync(join(r.dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ testCommand: 'true', x: 1 }));
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /uncommitted/);
    assert.deepEqual(greens(r), []);
  });

  test('a git status that fails records nothing, never reading as clean', () => {
    const r = repo('true');
    writeFileSync(join(r.dir, '.git', 'index'), 'not an index');
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /could not read/);
    assert.deepEqual(greens(r), []);
  });

  test('a judge that cannot be installed records nothing, and says why', () => {
    const r = repo('true');
    writeFileSync(join(r.env.XDG_DATA_HOME, 'sdlc-harness'), 'a file where the directory goes\n');
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /push judge/);
    assert.deepEqual(greens(r), []);
  });

  test('tests that change a tracked file record nothing', () => {
    const r = repo('echo changed > .sdlc-harness/sdlc.json');
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /changed tracked files/);
    assert.deepEqual(greens(r), []);
  });

  test('tests that move HEAD record nothing', () => {
    const r = repo('echo x > new.txt && git add new.txt && git commit -q -m moved');
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /HEAD moved/);
    assert.deepEqual(greens(r), []);
  });

  test('a repo whose hooks path points elsewhere after the install records nothing', () => {
    const r = repo('touch ran && git config --local core.hooksPath /tmp/elsewhere && rm ran');
    const out = verify(r);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /push judge/);
    assert.deepEqual(greens(r), []);
  });
});
