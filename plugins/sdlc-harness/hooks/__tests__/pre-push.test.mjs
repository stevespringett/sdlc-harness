// Tests for the Claude Code hook (decisions 0003 and 0005). Git's own pre-push
// hook judges every push; this hook only refuses what would keep git from
// running it, would write to GitHub without git, or would take acceptance
// from the approver. It reads the words of each command git or gh runs, so
// text that only mentions these flags, in a grep or a path, runs untouched.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdict, commandsOf } from '../pre-push.mjs';

const HOOK = fileURLToPath(new URL('../pre-push.mjs', import.meta.url));
const PLAIN = mkdtempSync(join(tmpdir(), 'sdlc-hook-cwd-'));
after(() => rmSync(PLAIN, { recursive: true, force: true }));

function run(input) {
  const env = { ...process.env };
  delete env.SDLC_HARNESS_HOOK_BYPASS;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env });
  return { status: r.status, stderr: r.stderr };
}
// Commands run from a folder outside any repo, so no repo config takes part.
const bash = (command, cwd = PLAIN) => run({ tool_name: 'Bash', tool_input: { command }, cwd });

const REFUSED = [
  // Skipping git's hooks.
  'git push --no-verify origin HEAD:main',
  'git push --no-ver origin main',
  'git commit --no-verify -m x',
  "gi''t push --no-verify origin main",
  'git pu\\sh --no-verify origin main',
  // Pointing git at other hooks, or other config.
  'git -c core.hooksPath=/dev/null push origin main',
  'git -c core.hookspath=/tmp push origin main',
  'git -ccore.hooksPath=/x push origin main',
  'git --config-env=core.hooksPath=X push origin main',
  'git --config-env core.hooksPath=X push origin main',
  'git -c include.path=/tmp/x push origin main',
  'git -c includeIf.onbranch:main.path=/tmp/x push origin main',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin main',
  `export GIT_CONFIG_PARAMETERS="'core.hookspath'='/x'" && git push origin main`,
  'env GIT_CONFIG_GLOBAL=/dev/null git push origin main',
  'git config core.hooksPath /dev/null',
  "git config --global core.hooksPath ''",
  'git config --unset core.hooksPath',
  'git config --local --unset-all core.hooksPath',
  'git config include.path /tmp/x',
  'git config -e',
  'git config --global --edit',
  // Sending commits without the pre-push hook.
  'git send-pack origin main',
  'git http-push https://example.com/x.git main',
  'git push --recurse-submodules=on-demand origin main',
  // The same, inside another shell or a group.
  'sh -c "git push --no-verify origin main"',
  "bash -c 'git -c core.hooksPath=/x push origin main'",
  'eval "git push --no-verify origin main"',
  'cd ../handbook && git push --no-verify origin HEAD:main',
  '(git push --no-verify origin main)',
  'echo $(git push --no-verify origin main)',
  'true; git push --no-verify origin main',
  // Writing the judge, its shims, or the repo's config.
  'rm -rf .git/sdlc-harness/hooks',
  'rm ~/.local/share/sdlc-harness/hooks/pre-push',
  "echo 'process.exit(0)' > .git/sdlc-harness/hooks/git-pre-push.mjs",
  'cp /tmp/x .git/sdlc-harness/hooks/pre-push',
  'chmod -x /home/u/.local/share/sdlc-harness/hooks/pre-push',
  'rm -rf .git/sdlc-harness',
  'sed -i s/x/y/ .git/config',
  'echo "[core]" >> .git/config',
  'printf x | tee -a ../repo/.git/config',
  // GitHub writes that never go through git.
  'gh api -X POST repos/acme/x/git/refs',
  'gh api --method=PUT repos/acme/x/contents/a.txt',
  'gh api -XPATCH repos/acme/x/git/refs/heads/main',
  'gh api -X PATCH repos/acme/x/issues/12 -f state=closed',
  'gh api repos/acme/x/pulls -f title=t',
  'gh api repos/acme/x/pulls --raw-field title=t',
  'gh api repos/acme/x/contents/a --input body.json',
  "gh api graphql -f query='mutation { closeIssue(input: {}) { clientMutationId } }'",
  'gh api graphql -F q=x',
  'gh pr merge 1 --squash',
  'gh pr merge 1 --auto',
  'gh repo sync',
  // Only an approver closes an issue.
  'gh issue close 12',
  'gh issue close 12 --reason completed --repo acme/x',
  'gh issue delete 12 --yes',
  'gh issue transfer 12 acme/other',
  'sh -c "gh issue close 12"',
  // A pull request whose title or body would close an issue on merge.
  'gh pr create --title "GH-1: x" --body "Fixes #1"',
  'gh pr create -t x -b "closes acme/x#1"',
  'gh pr edit 3 --body "Resolved: #4"',
  'gh pr create --title="Fix #9" --body ok',
  'gh pr create --body-file -',
  'gh pr create --body-file /nonexistent/body.md',
  // Review round: a command after a shell keyword, a group, or a wrapper with values.
  'for i in 1; do git push --no-verify origin main; done',
  'if true; then git push --no-verify; fi',
  '{ git push --no-verify origin main; }',
  '! git push --no-verify origin main',
  'timeout 30 git push --no-verify origin main',
  'timeout -s KILL 30 gh issue close 12',
  'nice -n 5 git push --no-verify',
  'time -p git push --no-verify',
  'sudo -s git push --no-verify',
  'for i in 1; do gh issue close $i; done',
  // Review round: gh flags before the subcommand, aliases, and attached values.
  'gh issue -R acme/x close 12',
  'gh issue --repo=o/r close 12',
  'gh pr --repo o/r create --title "Fixes #12" --body ok',
  'gh pr create -t x "-bFixes #12"',
  'gh pr create "-tFixes #12" -b ok',
  'gh alias set ic "issue close"',
  "gh alias set pm 'pr merge'",
  'gh alias import aliases.yml',
  'gh issue develop 12',
  // Fix check: --repo before the top-level command, shell aliases, more wrappers.
  'gh -R acme/widget issue close 1',
  'gh --repo acme/widget pr merge 3',
  'gh --repo=acme/widget issue close 1',
  "gh alias set --shell cl 'gh issue close 1'",
  "gh alias set -s cl 'gh issue close 1'",
  'stdbuf -o L gh issue close 1',
  'env -C /tmp gh issue close 1',
  'env -S "gh issue close 1"',
  'xargs -a list.txt gh issue close',
  'read SDLC_HARNESS_CHAINED',
  'declare -x SDLC_HARNESS_PUSH_CHAINED',
  // Review round: bodies the shell builds cannot be read.
  'gh pr create --title t --body "$(cat body.md)"',
  'gh pr create --title t --body "$BODY"',
  'gh pr edit 3 --body "`cat body.md`"',
  // Review round: the chain guards' own variables.
  'SDLC_HARNESS_PUSH_CHAINED=1 git push origin main',
  "sh -c 'SDLC_HARNESS_CHAINED=pre-commit exec git commit -m x'",
  'export SDLC_HARNESS_CHAINED=pre-commit',
  // QA round: shells with combined flags.
  'bash -lc "git push --no-verify origin main"',
  "sh -xc 'git push --no-verify origin main'",
  "zsh -ec 'git -c core.hooksPath=/x push origin main'",
  'dash -c "git push --no-verify"',
  'bash -c -e "git push --no-verify"',
  'bash -c -o pipefail "git push --no-verify"',
  'bash -c +o pipefail -x -- "git push --no-verify"',
  'bash -e -c "git push --no-verify"',
  'bash --login -c "git push --no-verify"',
  // Aliases that skip hooks, set or passed for one command.
  'git config alias.p "push --no-verify"',
  'git config --global alias.ci "commit -n"',
  "git config alias.x '!git push --no-verify origin main'",
  `git -c alias.p="push --no-verify" p origin HEAD:main`,
  "git -c alias.p='!git push --no-verify' p",
  'git --attr-source HEAD -c core.hooksPath=/x push origin main',
  // commit -n is commit --no-verify.
  'git commit -n -m x',
  'git commit -anm x',
  // gh commands that write refs or repos.
  'gh release create v1 --target main',
  'gh release upload v1 a.tgz',
  'gh release delete v1',
  'gh repo create acme/x --private',
  'gh repo delete acme/x',
  'gh repo rename y',
  // Narrow check: -- after a shell's -c, commit's -o (no value), deploy keys.
  'sh -c -- "git push --no-verify origin main"',
  'git commit -o --no-verify a.txt',
  'gh repo deploy-key add key.pub',
  'gh repo deploy-key delete 1',
  // Moving the repo config away, and the uninstall, which a person runs.
  'mv .git/config /tmp/x',
  'node plugins/sdlc-harness/hooks/uninstall-hooks.mjs',
];

const ALLOWED = [
  // Narrow check: push -o takes a value; commit -o does not.
  'git push -o ci.skip origin main',
  'git commit -o a.txt -m x',
  'gh repo deploy-key list',
  // QA round: false refusals.
  'git commit -m "--no-verify is refused"',
  'git commit -m "GH-1: say --no-verify is refused"',
  'git commit -am "--no-verify"',
  'git commit --message="--no-verify" -q',
  'cp .git/config /tmp/x',
  'rsync .git/config /tmp/x',
  'gh api -X GET search/issues -f q=x',
  'gh api --method GET search/issues -F q=x',
  'git push -n origin main',
  'git log -n 5',
  'gh release view v1',
  'gh repo view acme/x',
  'git config alias.st status',
  "git config alias.lg 'log --oneline --graph'",
  'git push origin HEAD:main',
  'git push -q origin HEAD:main',
  'git -C ../handbook push origin HEAD:main',
  'git push --force origin x',
  'git commit -q -F /tmp/msg.txt',
  'git -c core.editor=true rebase --continue',
  'git -c user.name=x commit -m y',
  'git config --get core.hooksPath',
  'git config core.hooksPath',
  'git config --show-origin --get-all core.hooksPath',
  'git config user.name Test',
  'git log --grep=--no-verify',
  'grep -rn -- --no-verify .',
  "grep -n 'git -c core.hooksPath' README.md",
  'cat .git/config',
  'ls ~/.local/share/sdlc-harness/hooks',
  'echo GIT_CONFIG_COUNT is not set',
  'gh api repos/acme/x/pulls',
  'gh api -X GET repos/acme/x',
  'gh api notifications',
  'gh workflow run e2e.yml -f project=chromium',
  'gh run list --limit 3',
  'gh pr view 1',
  'npm test',
  // The plugin's own source shares the harness's name and is not the judge's copy.
  'git add plugins/sdlc-harness/hooks/git-pre-push.mjs',
  'grep -n hooksPath plugins/sdlc-harness/hooks/lib.mjs',
  'node plugins/sdlc-harness/hooks/verify.mjs --quiet',
  'node plugins/sdlc-harness/hooks/tracker.mjs read 123',
  // The issue writes the skills make.
  'gh issue comment 12 --body-file /tmp/c.md',
  'gh issue edit 12 --add-label status:in-progress --remove-label status:not-started',
  'gh issue edit 12 --add-assignee octo-lead --remove-assignee acme-bot',
  'gh issue create --title "Search is slow" --body-file body.md --label Defect',
  'gh issue list --search "fixes #12" --state all',
  'gh issue view 12 --comments',
  'gh issue reopen 12',
  'gh pr create --title "GH-1: parse dates" --body "Refs #1"',
  'gh pr create --title "GH-2: close the drawer on escape" --body "Fixes a race in the queue."',
  'gh label list --search area:',
  'timeout 300 npm test',
  'for f in a b; do echo $f; done',
  'gh alias set co "pr checkout"',
  'gh issue -R acme/x view 12',
];

describe('commands refused', () => {
  for (const c of REFUSED) {
    test(c, () => {
      const r = bash(c);
      assert.equal(r.status, 2, `ran: ${c}`);
      assert.match(r.stderr, /\[sdlc-harness\] refused/);
    });
  }
});

describe('commands that run untouched', () => {
  for (const c of ALLOWED) {
    test(c, () => {
      const r = bash(c);
      assert.equal(r.status, 0, `refused: ${c}\n${r.stderr}`);
    });
  }
});

describe('pull request bodies from a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-body-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'closes.md'), '## Summary\n\n- parse dates\n\nCloses #12\n');
  writeFileSync(join(dir, 'refs.md'), '## Summary\n\n- parse dates\n\nRefs #12\n');
  test('a body file that carries a closing keyword is refused, read from where the command runs', () => {
    const r = bash('gh pr create --title "GH-12: dates" --body-file closes.md', dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Closes #12/);
    assert.equal(bash(`gh pr edit 4 -F ${join(dir, 'closes.md')}`).status, 2);
  });
  test('a body file that names the issue plainly runs', () => {
    assert.equal(bash('gh pr create --title "GH-12: dates" --body-file refs.md', dir).status, 0);
  });
});

describe('issues and pull requests stay inside the allowed owners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-owners-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, '.sdlc-harness'));
  writeFileSync(join(dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ testCommand: 'true', tracker: { repo: 'acme/tracker', allowedOwners: ['acme', 'acme-labs'] } }));
  test('a --repo outside them is refused, in every form gh takes', () => {
    for (const c of ['gh issue create --repo evil/x --title t --body b', 'gh pr create -R other/x --title t --body b', 'gh issue create --repo=evil/x -t t -b b', 'gh issue create -Revil/x -t t -b b', 'gh issue -R evil/x create -t t -b b', 'gh -R evil/x issue create -t t -b b','GH_REPO=evil/x gh issue create -t t -b b', 'env GH_REPO=evil/x gh pr create -t t -b b', 'export GH_REPO=evil/x']) {
      const r = bash(c, dir);
      assert.equal(r.status, 2, c);
      assert.match(r.stderr, /outside the allowed owners/);
    }
  });
  test('a --repo inside them runs, in any case', () => {
    assert.equal(bash('gh issue create --repo acme/tracker --title t --body b', dir).status, 0);
    assert.equal(bash('gh issue create -R ACME-Labs/x --title t --body b', dir).status, 0);
  });
  test('with no config, the owner check does not apply', () => {
    assert.equal(bash('gh issue create --repo evil/x --title t --body b').status, 0);
  });
  test('a config that cannot be read refuses a --repo instead of passing it', () => {
    const bad = mkdtempSync(join(tmpdir(), 'sdlc-owners-bad-'));
    execFileSync('git', ['init', '-q', bad]);
    mkdirSync(join(bad, '.sdlc-harness'));
    writeFileSync(join(bad, '.sdlc-harness', 'sdlc.json'), '{ not json');
    const r = bash('gh issue create --repo acme/tracker --title t --body b', bad);
    rmSync(bad, { recursive: true, force: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot be read/);
  });
  test("the config's issue prefix is the closing form refused in a PR", () => {
    const web = mkdtempSync(join(tmpdir(), 'sdlc-prefix-'));
    execFileSync('git', ['init', '-q', web]);
    mkdirSync(join(web, '.sdlc-harness'));
    writeFileSync(join(web, '.sdlc-harness', 'sdlc.json'), JSON.stringify({ testCommand: 'true', issuePrefix: 'WEB' }));
    const refusedHere = bash('gh pr create --title "WEB-4: x" --body "fixes WEB-4"', web).status;
    const allowedHere = bash('gh pr create --title "WEB-4: fix utf-8" --body "Refs #4"', web).status;
    rmSync(web, { recursive: true, force: true });
    assert.equal(refusedHere, 2);
    assert.equal(allowedHere, 0);
  });
});

// The stub is a #! script on a :-separated PATH; Windows runs neither, and the
// alias reading this checks is the same on every platform.
describe('gh aliases already set', { skip: process.platform === 'win32' && 'the gh stub is a shell script' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-gh-alias-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // A stub gh on PATH answers `gh alias list` the way gh does.
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\n[ "$1 $2" = "alias list" ] && printf \'ic: issue close\\nsh2: !gh issue close "$1"\\nv: issue view\\n\'\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const withStub = (command) => {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    delete env.SDLC_HARNESS_HOOK_BYPASS;
    return spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: PLAIN }), encoding: 'utf8', env }).status;
  };
  test('an alias whose expansion is refused is refused where it is used', () => {
    assert.equal(withStub('gh ic 12'), 2);
    assert.equal(withStub('gh sh2 12'), 2);
  });
  test('an ordinary alias runs', () => assert.equal(withStub('gh v 12'), 0));
});

describe('aliases already in a repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-alias-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', join(dir, 'r')], { env });
  for (const [k, v] of [['alias.p', 'push --no-verify'], ['alias.sp', '!git push --no-verify origin main'], ['alias.st', 'status']]) execFileSync('git', ['-C', join(dir, 'r'), 'config', k, v], { env });
  const inRepo = (command) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: join(dir, 'r') }), encoding: 'utf8', env });
    return r.status;
  };
  test('an alias that skips hooks is refused where it is used', () => {
    assert.equal(inRepo('git p origin HEAD:main'), 2);
    assert.equal(inRepo('git sp'), 2);
  });
  test('an ordinary alias runs', () => assert.equal(inRepo('git st'), 0));
});

describe('SDLC_HARNESS_HOOK_BYPASS changes nothing', () => {
  test('a refused command stays refused with the variable set', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify origin main' } }), encoding: 'utf8', env: { ...process.env, SDLC_HARNESS_HOOK_BYPASS: '1' } });
    assert.equal(r.status, 2);
  });
});

describe('file tools', () => {
  for (const [tool, path] of [
    ['Edit', '/repo/.git/sdlc-harness/hooks/git-pre-push.mjs'],
    ['Write', '/home/u/.local/share/sdlc-harness/hooks/pre-push'],
    ['Write', '/data/custom-xdg/sdlc-harness/hooks/pre-push'],
    ['Write', '/repo/.git/config'],
    ['MultiEdit', '/repo/.git/config'],
    // The installed plugin is the code every guard runs.
    ['Write', '/home/u/.claude/plugins/marketplaces/sdlc-harness/plugins/sdlc-harness/hooks/lib.mjs'],
    ['Edit', '/home/u/.claude/plugins/cache/sdlc-harness/sdlc-harness/0.1.0/hooks/pre-push.mjs'],
    ['Edit', '/home/u/.claude/plugins/cache/sdlc-harness/sdlc-harness/0.1.0/RULES.md'],
    ['Write', '/home/u/.claude/plugins/cache/client-tools/sdlc-harness/0.2.0/hooks/git-pre-push.mjs'],
  ]) {
    test(`${tool} ${path} is refused`, () => {
      assert.equal(run({ tool_name: tool, tool_input: { file_path: path } }).status, 2);
    });
  }
  test('a command that writes the installed plugin is refused', () => {
    assert.equal(bash("echo 'process.exit(0)' > ~/.claude/plugins/cache/sdlc-harness/sdlc-harness/0.1.0/hooks/pre-push.mjs").status, 2);
    assert.equal(bash('rm -rf ~/.claude/plugins/cache/sdlc-harness').status, 2);
  });
  test('an edit anywhere else runs, the plugin source in a checkout and other installed plugins included', () => {
    assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.js' } }).status, 0);
    assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/repo/plugins/sdlc-harness/hooks/git-pre-push.mjs' } }).status, 0);
    assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/home/u/.claude/plugins/cache/other/other-plugin/1.0.0/hooks/x.mjs' } }).status, 0);
  });
});

describe('GitHub MCP tools', () => {
  for (const name of ['mcp__github__create_pull_request', 'mcp__github__merge_pull_request', 'mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__plugin_x_github__delete_branch', 'mcp__github__update_issue', 'mcp__github__add_issue_comment']) {
    test(`${name} is refused`, () => assert.equal(run({ tool_name: name, tool_input: {} }).status, 2));
  }
  for (const name of ['mcp__github__get_file_contents', 'mcp__github__list_pull_requests', 'mcp__github__search_code', 'mcp__github__get_issue', 'mcp__plugin_engineering_github__authenticate', 'mcp__plugin_engineering_github__complete_authentication']) {
    test(`${name} runs`, () => assert.equal(run({ tool_name: name, tool_input: {} }).status, 0));
  }
  test('a refused MCP write says to use the tracker helper', () => {
    assert.match(run({ tool_name: 'mcp__github__add_issue_comment', tool_input: {} }).stderr, /tracker helper/);
  });
});

describe('reading commands', () => {
  test('quotes and escapes are removed as the shell removes them', () => {
    assert.deepEqual(commandsOf(`gi''t pu\\sh "origin" 'HEAD:main'`)[0].words, ['git', 'push', 'origin', 'HEAD:main']);
  });
  test('separators split commands, and redirect targets are kept', () => {
    const cs = commandsOf('a x && b y | c > out.txt; d');
    assert.deepEqual(cs.map((c) => c.words[0]), ['a', 'b', 'c', 'd']);
    assert.deepEqual(cs[2].redirects, ['out.txt']);
  });
  test('a verdict names its reason', () => {
    assert.match(verdict({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify origin main' } }), /no-verify|skips/);
    assert.equal(verdict({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), null);
    assert.match(verdict({ tool_name: 'Bash', tool_input: { command: 'gh issue close 3' }, cwd: PLAIN }), /only an approver closes an issue/);
  });
});

// A symlink anywhere in the hook's path (macOS's /var, a linked home) must not
// turn it off: node runs the module at its real path, so a main-module check
// that compares paths as typed would skip every check and allow everything.
test('the hook still judges when run through a symlinked path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-link-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(dirname(HOOK), join(dir, 'hooks'));
  const env = { ...process.env };
  delete env.SDLC_HARNESS_HOOK_BYPASS;
  const r = spawnSync(process.execPath, [join(dir, 'hooks', 'pre-push.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify origin main' } }), encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stderr);
});
