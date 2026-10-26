#!/usr/bin/env node
// PreToolUse hook for Bash, the file tools, and GitHub MCP tools (decisions
// 0003 and 0005). Git's own pre-push hook, git-pre-push.mjs, judges every push
// against the exact commits it sends. This hook judges no push. It refuses
// only what would keep git from running that judge, would change GitHub
// without git, or would take acceptance from the approver:
//   - a git option that skips hooks (--no-verify and its prefixes);
//   - config that moves or adds hooks or config for one command (-c or
//     --config-env with core.hooksPath, include.*, includeIf.*), or for the
//     shell (GIT_CONFIG_* variables), or a git config write of those keys;
//   - git commit -n, and an alias (set, passed with -c, or already in the
//     repo) whose expansion runs any of these;
//   - git commands that send commits with no pre-push hook (send-pack,
//     http-push) and push --recurse-submodules;
//   - a write to the judge's directories or to a repo's .git/config, by a
//     command or by the Edit and Write tools;
//   - gh api calls other than a GET, gh pr merge, gh repo and gh release
//     commands that write, GitHub MCP tools that write, and the judge's
//     uninstall, which a person runs;
//   - gh issue close, delete, and transfer: only an approver closes an issue;
//   - gh pr create or edit whose title or body carries a closing keyword
//     ("Fixes #12"), which would close the issue when the pull request merges;
//   - gh issue or pr create with --repo outside the config's allowed owners;
//   - with a Linear tracker (decision 0011), a Linear MCP write other than a
//     comment, an issue, a notification, a label, or an attachment, and a
//     save_issue that sets Done or Canceled, marks a duplicate, or files or
//     moves an issue outside the configured team.
// It reads the words each command runs, after the shell's quote removal, so a
// grep or a path that only mentions these runs untouched. A command it cannot
// read runs: git's hook still judges any push in it, and refuses a closing
// keyword in any commit message. SDLC_HARNESS_HOOK_BYPASS changes nothing.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { NAME, closingKeyword, loadConfig, repoRoot } from './lib.mjs';

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '`']);

/**
 * The simple commands in a line of shell, as words after quote removal, plus
 * the targets of their > and >> redirects. Command substitution, groups, and
 * pipelines split into their own commands. Not a full shell: it never runs
 * anything, and what it misreads, git's hook still judges.
 */
export function commandsOf(text) {
  const commands = [];
  let words = [];
  let redirects = [];
  let word = null;
  let redirectNext = false;
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) {
      redirects.push(word);
      redirectNext = false;
    } else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      word = (word ?? '') + text.slice(i + 1, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j;
    } else if (c === '"') {
      let s = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && '"\\$`\n'.includes(text[j + 1])) s += text[++j];
        else if (text[j] === '$' && text[j + 1] === '(') {
          // A substitution inside quotes runs too: read it as its own commands.
          let depth = 1;
          let k = j + 2;
          for (; k < text.length && depth; k++) depth += text[k] === '(' ? 1 : text[k] === ')' ? -1 : 0;
          commands.push(...commandsOf(text.slice(j + 2, k - 1)));
          s += text.slice(j, k);
          j = k - 1;
        } else s += text[j];
      }
      word = (word ?? '') + s;
      i = j;
    } else if (c === '\\') {
      if (text[i + 1] === '\n') i++;
      else word = (word ?? '') + (text[++i] ?? '');
    } else if (c === '$' && text[i + 1] === '(') {
      endCommand();
      i++;
    } else if (SEPARATORS.has(c)) endCommand();
    else if (c === '>' || c === '<') {
      // 2>&1 and >&2 name no file.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      if (text[i + 1] === '>') i++;
      if (text[i + 1] === '&') {
        i++;
        while (/\d|-/.test(text[i + 1] ?? '')) i++;
        continue;
      }
      if (c === '>') redirectNext = true;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '#' && word === null) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl - 1;
    } else word = (word ?? '') + c;
  }
  endCommand();
  return commands;
}

// Words that run the command after them: wrappers, and the shell keywords a
// command can follow inside a loop, a test, or a group.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'nice', 'time', 'sudo', 'doas', 'xargs', 'builtin', 'timeout', 'gtimeout', 'stdbuf', 'ionice', 'caffeinate', 'chronic', 'unbuffer', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const WRAPPER_VALUE_FLAGS = new Set(['-s', '--signal', '-k', '--kill-after', '-n', '--adjustment', '-u', '-g', '-C', '--chdir', '-a', '--arg-file', '-o', '-e', '-i', '-I']);
// Variables a session never reads into, exports, or declares.
const CHAIN_NAME = /^SDLC_HARNESS_(?:PUSH_)?CHAINED$/;
// The chain guards' own variables (lib.mjs, git-pre-push.mjs): a session never sets them.
const CHAIN_VAR = /^SDLC_HARNESS_(?:PUSH_)?CHAINED=/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Commands that write every path they name, and those that write only their
// destination (the last path, or the one after -t).
const WRITERS = new Set(['rm', 'mv', 'chmod', 'chown', 'tee', 'truncate', 'dd', 'touch', 'unlink', 'rmdir', 'shred']);
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync']);
const GUARDED_KEY = /^(core\.hookspath|include\..*|includeif\..*|remote\..*\.mirror)$/i;
const ALIAS_KEY = /^alias\./i;
const GIT_CONFIG_VAR = /^GIT_CONFIG(_[A-Z0-9_]+)?=/;
// Git options that take the next word as their value, so the value is never
// read as a flag: `git commit -m "--no-verify ..."` passes no flag.
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message', '--author', '--date', '--template', '-t', '--trailer', '--fixup', '--squash', '--cleanup', '--grep', '--format', '--pretty', '--push-option', '--repo', '--receive-pack', '--exec']);
const BUILTINS = new Set(['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hook', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'notes', 'pull', 'push', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-ref', 'var', 'version', 'worktree', 'send-pack', 'http-push', 'help']);

// Where the command runs, for reading the aliases a repo already has.
let CWD = process.cwd();

// The plugin this hook runs from. An installed copy (under ~/.claude/plugins)
// is the code every guard runs, so a session never writes it; a checkout a
// person develops the plugin in is not under that folder and stays editable.
const PLUGIN_ROOT = (() => {
  try {
    return realpathSync(fileURLToPath(new URL('..', import.meta.url))).replace(/\/+$/, '');
  } catch {
    return '';
  }
})();
const INSTALLED = /(^|\/)\.claude\/plugins\/(?:cache|marketplaces)\/(?:[^/]+\/)*?[^/]*sdlc-harness[^/]*(\/|$)/;

/** A path the judge lives in, the installed plugin, or a repo's config. */
export function guardedPath(p) {
  const s = String(p || '').replace(/\/+$/, '');
  if (INSTALLED.test(s)) return true;
  if (PLUGIN_ROOT.includes('/.claude/plugins/')) {
    const abs = resolve(CWD, s.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
    if (abs === PLUGIN_ROOT || abs.startsWith(`${PLUGIN_ROOT}/`)) return true;
  }
  // The plugin's source in a checkout (plugins/sdlc-harness/hooks) shares the name and is not the judge's copy.
  return /(^|\/)(?<!plugins\/)sdlc-harness\/hooks(\/|$)/.test(s) || /(^|\/)\.git\/config$/.test(s) || /(^|\/)\.local\/share\/sdlc-harness$/.test(s) || /(^|\/)\.git\/sdlc-harness$/.test(s);
}

/** Judge an alias's value: a shell command after "!", else git's words. */
function aliasVerdict(name, value) {
  const v = String(value || '').trim();
  const inner = v.startsWith('!') ? bashVerdict(v.slice(1)) : gitVerdict((commandsOf(v)[0] || { words: [] }).words);
  return inner ? `the alias ${name} runs something refused (${inner})` : null;
}

function gitVerdict(args, cwd = CWD) {
  let i = 0;
  // Options before the subcommand.
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    let pair = null;
    if (a === '-c' || a === '--config-env') pair = args[++i] || '';
    else if (a.startsWith('-c')) pair = a.slice(2);
    else if (a.startsWith('--config-env=')) pair = a.slice('--config-env='.length);
    else if (a === '-C') cwd = resolve(cwd, args[++i] || '.');
    else if (['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--list-cmds', '--attr-source'].includes(a)) i++;
    if (pair === null) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (GUARDED_KEY.test(key)) return `git ${a} ${key} changes where git finds its hooks or config for this command`;
    if (ALIAS_KEY.test(key)) {
      const v = aliasVerdict(key, eq < 0 ? '' : pair.slice(eq + 1));
      if (v) return v;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  // Flags only: a value an option takes, and words after --, are not flags.
  const flags = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (a === '--') break;
    // -o is push's --push-option, with a value; commit's -o (--only) takes none.
    if (VALUE_OPTS.has(a) || /^-[a-zA-Z]*[mFC]$/.test(a) || (sub === 'push' && a === '-o')) {
      flags.push(a);
      j++;
      continue;
    }
    if (a.startsWith('-')) flags.push(a);
  }
  for (const a of flags) if (/^--no-v/.test(a)) return `${a} skips git's hooks, including the push judge`;
  if (sub === 'commit' && flags.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return "git commit -n is commit --no-verify, which skips git's hooks";
  if (sub === 'send-pack' || sub === 'http-push') return `git ${sub} sends commits without the pre-push hook`;
  if (sub === 'push' && flags.some((a) => a.startsWith('--recurse-submodules'))) return 'git push --recurse-submodules pushes other repos from inside this one';
  if (sub === 'config') {
    if (rest.some((a) => a === '-e' || a === '--edit' || a === 'edit')) return 'git config --edit can change any config, the hooks path included';
    const writes = rest.some((a) => /^--(unset|unset-all|add|replace-all|remove-section|rename-section)$/.test(a) || ['set', 'unset'].includes(a));
    const reads = rest.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|get|list)$/.test(a));
    const plain = rest.filter((a) => !a.startsWith('-') && !['set', 'unset'].includes(a));
    if (rest.some((a) => GUARDED_KEY.test(a)) && (writes || (!reads && plain.length >= 2))) return 'git config would change the hooks path or config includes';
    const k = plain.findIndex((a) => ALIAS_KEY.test(a));
    if (k >= 0 && !reads && plain[k + 1] !== undefined) {
      const v = aliasVerdict(plain[k], plain[k + 1]);
      if (v) return v;
    }
  }
  // An alias a repo already has is read as what it runs.
  if (sub && !BUILTINS.has(sub) && /^[\w.-]+$/.test(sub)) {
    const r = spawnSync('git', ['config', '--get', `alias.${sub}`], { cwd, encoding: 'utf8', timeout: 2000 });
    if (r.status === 0 && r.stdout.trim()) {
      const v = r.stdout.trim();
      const inner = v.startsWith('!') ? bashVerdict(`${v.slice(1)} ${rest.join(' ')}`) : gitVerdict([...(commandsOf(v)[0] || { words: [] }).words, ...rest], cwd);
      if (inner) return `the alias ${sub} runs something refused (${inner})`;
    }
  }
  return null;
}

/** The values a gh command passes for a flag: --name v, --name=v, -x v, and -xv. */
function flagValues(args, long, short) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${long}` || (short && a === `-${short}`)) out.push(args[++i] ?? '');
    else if (a.startsWith(`--${long}=`)) out.push(a.slice(long.length + 3));
    else if (short && a.startsWith(`-${short}`) && a.length > 2 && a[1] !== '-') out.push(a.slice(2).replace(/^=/, ''));
  }
  return out;
}

/**
 * The repo config where the command runs: { cfg } when there is one, null
 * when the folder is not a managed repo, or { error } when its config cannot
 * be read, so a check that needs it refuses instead of passing.
 */
function hookConfig() {
  try {
    const root = repoRoot(CWD);
    const cfg = root && loadConfig(root);
    return cfg ? { cfg } : null;
  } catch (e) {
    return { error: e.message };
  }
}

/** Why a target repo is outside the allowed owners, or null. */
function ownerVerdict(what, repo) {
  const hc = hookConfig();
  if (!hc) return null;
  if (hc.error) return `${what} ${repo}: the repo's config cannot be read (${hc.error}), so the allowed owners are unknown`;
  const owners = hc.cfg.tracker.allowedOwners;
  const o = String(repo).split('/')[0].toLowerCase();
  return owners.includes(o) ? null : `${what} ${repo} files outside the allowed owners (${owners.join(', ')})`;
}

const prefixHere = () => {
  const hc = hookConfig();
  return (hc && hc.cfg && hc.cfg.issuePrefix) || 'GH';
};

const kindHere = () => {
  const hc = hookConfig();
  return (hc && hc.cfg && hc.cfg.tracker && hc.cfg.tracker.kind) || 'github';
};

// Text the shell builds ("$(cat body.md)", "$BODY", backticks) is not what
// the hook reads, so a title or body that carries it is refused.
const SHELL_BUILT = /[$`]/;

function issueVerdict(sub, sub2, rest, ghRepo) {
  if (sub === 'issue' && ['close', 'delete', 'transfer'].includes(sub2)) return `gh issue ${sub2} is for an approver: only an approver closes an issue (decision 0003)`;
  if (sub === 'issue' && sub2 === 'develop') return 'gh issue develop links a branch to the issue, and GitHub closes a linked issue when its pull request merges; only an approver closes an issue';
  if ((sub === 'issue' || sub === 'pr') && sub2 === 'create') {
    for (const r of [...flagValues(rest, 'repo', 'R'), ...(ghRepo ? [ghRepo] : [])]) {
      const v = ownerVerdict(`gh ${sub} create --repo`, r);
      if (v) return v;
    }
  }
  if (sub === 'pr' && (sub2 === 'create' || sub2 === 'edit')) {
    const texts = [...flagValues(rest, 'title', 't'), ...flagValues(rest, 'body', 'b')];
    if (texts.some((t) => SHELL_BUILT.test(t))) return `gh pr ${sub2}: a title or body the shell builds cannot be checked for a closing keyword; write it to a file and pass --body-file`;
    for (const f of flagValues(rest, 'body-file', 'F')) {
      const p = resolve(CWD, f);
      if (f === '-' || !existsSync(p)) return `gh pr ${sub2} --body-file ${f}: the hook cannot read the body to check it for a closing keyword; write it to a file`;
      texts.push(readFileSync(p, 'utf8'));
    }
    const prefix = prefixHere();
    const kind = kindHere();
    for (const t of texts) {
      for (const line of String(t).split('\n')) {
        const k = closingKeyword(line, prefix, kind);
        if (k) return `gh pr ${sub2} with "${k}" would close the issue when the pull request merges, and only an approver closes an issue`;
      }
    }
  }
  return null;
}

// gh's own commands; any other first word may be an alias.
const GH_COMMANDS = new Set(['agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'co', 'codespace', 'completion', 'config', 'copilot', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow']);

/** Judge a gh alias's expansion: a shell command after "!", else gh's words. */
function ghAliasVerdict(name, expansion, extra) {
  const v = String(expansion || '').trim();
  const inner = v.startsWith('!') ? bashVerdict(`${v.slice(1)} ${extra.join(' ')}`) : ghVerdict([...(commandsOf(v)[0] || { words: [] }).words, ...extra]);
  return inner ? `the gh alias ${name} runs something refused (${inner})` : null;
}

function ghVerdict(argv, { ghRepo = null } = {}) {
  // gh also takes --repo before the command ("gh -R o/r issue close 1"):
  // those flags move after it, where the rest of the reading looks.
  const lead = [];
  let s = 0;
  for (; s < argv.length && argv[s].startsWith('-'); s++) {
    lead.push(argv[s]);
    if (argv[s] === '-R' || argv[s] === '--repo') lead.push(argv[++s] ?? '');
  }
  const args = [argv[s], ...lead, ...argv.slice(s + 1)].filter((a) => a !== undefined);
  const sub = args[0];
  // The subcommand is the first word after it that is neither a flag nor a
  // --repo value: gh takes --repo on the parent too ("gh issue -R o/r close 1").
  let at = 1;
  for (; at < args.length; at++) {
    const a = args[at];
    if (a === '-R' || a === '--repo') at++;
    else if (!a.startsWith('-')) break;
  }
  const sub2 = args[at];
  const rest = [...args.slice(1, at), ...args.slice(at + 1)];
  if (sub === 'alias' && sub2 === 'import') return 'gh alias import sets aliases the hook cannot read; set each with gh alias set';
  if (sub === 'alias' && sub2 === 'set') {
    const words = rest.filter((a) => !a.startsWith('-'));
    const shell = rest.some((a) => a === '--shell' || a === '-s');
    if (words.length >= 2) {
      const v = ghAliasVerdict(words[0], shell ? `!${words[1]}` : words[1], []);
      if (v) return v;
    }
  }
  if (sub && !GH_COMMANDS.has(sub) && /^[\w.-]+$/.test(sub)) {
    const r = spawnSync('gh', ['alias', 'list'], { cwd: CWD, encoding: 'utf8', timeout: 3000 });
    // A gh that hangs could hide an alias: refuse rather than guess.
    if (r.error && r.error.code === 'ETIMEDOUT') return `gh ${sub}: the hook could not read gh's aliases in time, so it cannot tell what this runs`;
    if (r.status === 0) {
      const line = r.stdout.split('\n').find((l) => l.startsWith(`${sub}:`));
      if (line) {
        const v = ghAliasVerdict(sub, line.slice(sub.length + 1).trim().replace(/^'(.*)'$/, '$1'), args.slice(1));
        if (v) return v;
      }
    }
  }
  const issue = issueVerdict(sub, sub2, rest, ghRepo);
  if (issue) return issue;
  if (sub === 'pr' && sub2 === 'merge') return 'gh pr merge changes GitHub without git';
  if (sub === 'repo' && ['sync', 'create', 'delete', 'rename', 'edit', 'archive', 'unarchive', 'fork'].includes(sub2)) return `gh repo ${sub2} changes GitHub without git`;
  if (sub === 'repo' && sub2 === 'deploy-key' && ['add', 'delete'].includes(args[2])) return `gh repo deploy-key ${args[2]} changes who can push without git`;
  if (sub === 'release' && ['create', 'upload', 'delete', 'delete-asset', 'edit'].includes(sub2)) return `gh release ${sub2} writes tags or releases without git`;
  if (sub !== 'api') return null;
  const api = args.slice(1);
  if (api.includes('graphql')) return 'gh api graphql can change GitHub without git';
  let method = null;
  let fields = false;
  for (let i = 0; i < api.length; i++) {
    const a = api[i];
    const m = a === '-X' || a === '--method' ? api[i + 1] : a.startsWith('--method=') ? a.slice(9) : /^-X./.test(a) ? a.slice(2) : null;
    if (m !== null) method = String(m).toUpperCase();
    if (/^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^(-f|-F).|^--(field|raw-field|input)=/.test(a)) fields = true;
  }
  if (method !== null && method !== 'GET') return `gh api ${method} writes to GitHub without git`;
  // Fields make gh send a POST unless the call says GET.
  if (fields && method !== 'GET') return 'gh api with fields writes to GitHub without git';
  return null;
}

function commandVerdict({ words, redirects }) {
  for (const r of redirects) if (guardedPath(r)) return `writing ${r} changes the push judge or a repo's config`;
  let i = 0;
  let ghRepo = null;
  let afterWrapper = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (GIT_CONFIG_VAR.test(w)) return `${w.split('=')[0]} changes git's config for the command`;
    if (CHAIN_VAR.test(w)) return `${w.split('=')[0]} turns off the guard that chains to the repo's own hooks`;
    if (/^GH_REPO=/.test(w)) ghRepo = w.slice(8);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (WRAPPERS.has(basename(w))) {
      afterWrapper = true;
      continue;
    }
    if (/^-/.test(w)) {
      // env -S splits its value into the command it runs.
      if (afterWrapper && (w === '-S' || w === '--split-string') && words[i + 1] !== undefined) {
        const v = bashVerdict(words.slice(i + 1).join(' '));
        if (v) return v;
      }
      // A wrapper flag that takes the next word ("timeout -s KILL 30 git").
      // A flag that takes no value ("sudo -s git ...") never hides git or gh.
      if (afterWrapper && WRAPPER_VALUE_FLAGS.has(w) && !['git', 'gh'].includes(basename(words[i + 1] || ''))) i++;
      continue;
    }
    // A wrapper's own number: timeout's duration, nice's adjustment.
    if (afterWrapper && /^\d+(?:\.\d+)?[smhd]?$/.test(w)) continue;
    break;
  }
  if (['read', 'export', 'declare', 'typeset', 'local', 'readonly'].includes(words[0]) && words.some((w) => CHAIN_NAME.test(w))) return 'the chain guard\'s variable turns off the guard that chains to the repo\'s own hooks';
  if (words.slice(0, i + 1).includes('export') || words[0] === 'export' || words[0] === 'declare' || words[0] === 'typeset') {
    for (const w of words) if (GIT_CONFIG_VAR.test(w) || /^GIT_CONFIG(_[A-Z0-9_]+)?$/.test(w)) return `${w.split('=')[0]} changes git's config for the commands after it`;
    for (const w of words) if (CHAIN_VAR.test(w)) return `${w.split('=')[0]} turns off the guard that chains to the repo's own hooks`;
    for (const w of words) {
      if (/^GH_REPO=/.test(w)) {
        const v = ownerVerdict('GH_REPO', w.slice(8));
        if (v) return v;
      }
    }
  }
  if (words.some((w) => /(^|\/)uninstall-hooks\.mjs$/.test(w))) return 'uninstalling the push judge is for a person at a keyboard';
  const name = basename(words[i] || '');
  const args = words.slice(i + 1);
  if (name === 'git') return gitVerdict(args);
  if (name === 'gh') return ghVerdict(args, { ghRepo });
  if (SHELLS.has(name)) {
    // -c, alone or in a cluster such as -lc or -xc, runs the next word.
    // With -c anywhere among the options (alone or in a cluster such as -lc),
    // the first word that is not an option is the command string. Options:
    // -x, +x, clusters, -o name, +o name, and -- before the string.
    let c = false;
    let run = null;
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '--') {
        run = args[j + 1];
        break;
      }
      if (/^[-+][a-zA-Z]*o$/.test(a)) {
        if (a[0] === '-' && a.includes('c')) c = true;
        j++;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(a) || /^--[a-z-]+$/.test(a)) {
        if (/^-[a-zA-Z]*c/.test(a)) c = true;
        continue;
      }
      run = a;
      break;
    }
    if (c && run) return bashVerdict(run);
    return null;
  }
  if (name === 'eval') return bashVerdict(args.join(' '));
  const inPlace = (name === 'sed' || name === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  const paths = args.filter((a) => !a.startsWith('-'));
  let targets = [];
  if (WRITERS.has(name) || inPlace) targets = args.map((a) => (name === 'dd' && a.startsWith('of=') ? a.slice(3) : a)).filter((a) => !a.startsWith('-'));
  else if (COPIERS.has(name)) {
    const t = args.indexOf('-t');
    targets = t >= 0 ? [args[t + 1]] : paths.slice(-1);
  }
  for (const target of targets) if (guardedPath(target)) return `${name} ${target} changes the push judge or a repo's config`;
  return null;
}

function bashVerdict(command) {
  for (const c of commandsOf(command)) {
    const v = commandVerdict(c);
    if (v) return v;
  }
  return null;
}

// GitHub MCP tools that only read.
const MCP_READ = /^(get|list|search|read|fetch|download|authenticate|complete_authentication)/;

// Linear MCP tools a session on a Linear tracker may write with (decision 0011):
// comments, issues, notifications, labels for setup, and attachments for evidence.
// Every other Linear write (deletes, projects, initiatives, documents, merges) is refused.
const LINEAR_READ = /^(get|list|search|extract|fetch|download|query|guide|authenticate|complete_authentication)/;
const LINEAR_WRITES = new Set(['save_comment', 'save_issue', 'mark_notification', 'create_issue_label', 'save_issue_label', 'prepare_attachment_upload', 'prepare_file_upload', 'create_attachment', 'create_attachment_from_upload']);
// State types a save_issue may name: never completed or canceled.
const LINEAR_OPEN_TYPES = ['backlog', 'unstarted', 'started'];

/** Why a Linear MCP call is refused in a repo whose tracker is Linear, or null. */
export function linearVerdict(tool, ti, cfg) {
  const action = tool.split('__').pop();
  if (LINEAR_READ.test(action)) return null;
  if (!LINEAR_WRITES.has(action)) return `${tool} is not one of the Linear writes the SDLC makes (comments, issues, notifications, labels, attachments); a person makes that change`;
  if (action !== 'save_issue') return null;
  const t = cfg.tracker;
  if (ti.state !== undefined && ti.state !== null) {
    const names = ['backlog', 'notStarted', 'inProgress', 'inReview'].map((k) => String(t.linearStates[k]).toLowerCase());
    const s = String(ti.state).trim().toLowerCase();
    if (!names.includes(s) && !LINEAR_OPEN_TYPES.includes(s)) return `save_issue with state "${ti.state}": only an approver moves an issue to ${t.linearStates.done} or cancels it (decision 0003), and a state this hook cannot name is refused; use one of ${['backlog', 'notStarted', 'inProgress', 'inReview'].map((k) => `"${t.linearStates[k]}"`).join(', ')}`;
  }
  if (ti.duplicateOf !== undefined && ti.duplicateOf !== null) return 'save_issue with duplicateOf closes the issue as a duplicate, and only an approver closes an issue';
  if (ti.delegate !== undefined && ti.delegate !== null) return 'save_issue with delegate hands the issue to another agent, which can close it; a person delegates';
  if (ti.template !== undefined) return 'save_issue with template can set a state or sub-issues this hook cannot see; file the issue without one';
  if (ti.id === undefined && String(ti.team || '').toLowerCase() !== String(t.team || '').toLowerCase()) return `save_issue creates an issue only in team ${t.team}, the tracker the config names (team "${ti.team || ''}" given)`;
  if (ti.id !== undefined && ti.team !== undefined) return 'save_issue that moves an issue to another team takes it out of the tracker; a person moves it';
  return null;
}

/** The reason to refuse a tool call, or null to let it run. */
export function verdict(input) {
  const tool = String(input.tool_name || 'Bash');
  const ti = input.tool_input || {};
  if (tool === 'Bash') {
    CWD = input.cwd || process.cwd();
    return bashVerdict(String(ti.command ?? ''));
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = ti.file_path || ti.notebook_path || '';
    return guardedPath(p) ? `${tool} ${p} changes the push judge or a repo's config` : null;
  }
  if (/^mcp__.*linear/i.test(tool)) {
    CWD = input.cwd || process.cwd();
    const hc = hookConfig();
    let v = null;
    if (hc && hc.error) v = LINEAR_READ.test(tool.split('__').pop()) ? null : `${tool}: the repo's config cannot be read (${hc.error}), so a Linear write cannot be judged`;
    else if (hc && hc.cfg.tracker.kind === 'linear') v = linearVerdict(tool, ti, hc.cfg);
    // A tool whose name also says github still meets the GitHub rule below.
    if (v || !/github/i.test(tool)) return v;
  }
  if (/^mcp__.*github/i.test(tool)) {
    const action = tool.split('__').pop();
    return MCP_READ.test(action) ? null : `${tool} writes to GitHub without git; issue comments, labels, and assignees go through the tracker helper, as the skills say`;
  }
  return null;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const reason = verdict(input);
  if (!reason) process.exit(0);
  process.stderr.write(
    [
      `[${NAME}] refused`,
      reason + '.',
      "Git's pre-push hook judges every push (decision 0005): push with plain git, and let it check the commits sent.",
      'A person at a keyboard can make any of these changes; a session does not.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

// Node runs a module at its real path, so compare real paths: a symlink in the
// path as typed (macOS's /var, a linked home) must not skip main().
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
