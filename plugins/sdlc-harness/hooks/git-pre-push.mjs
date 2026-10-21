#!/usr/bin/env node
// The push judge (decision 0005). Git runs it as the pre-push hook of every
// repo the SDLC manages: git passes the remote's name and URL as arguments
// and, on stdin, one line per ref it is about to send:
//
//   <local ref> <local sha> <remote ref> <remote sha>
//
// Git has already asked the remote for its refs, so the remote sha is what the
// remote holds, not a local tracking ref. The judge checks exactly the
// commits each line sends; there is no command text to read and no time limit
// to race. A nonzero exit, or a judge that is killed, stops the push.
//
// In a repo whose remote tree carries .sdlc-harness/sdlc.json, a line is
// refused when it:
//   1. deletes a ref, rewrites history (the remote sha is not an ancestor of
//      the local one), moves an existing tag, sends a ref that is neither a
//      branch nor a tag, or opens a new branch on a trunk repo; a mirror push
//      is refused whole, since git deletes for it without telling the hook;
//   2. sends a tree with no green record (verify.mjs writes one after the
//      testCommand in that tree passes);
//   3. changes a protected path, or .sdlc-harness/, and no ticket in the
//      commits sent has a recorded go (approve.mjs writes one after the
//      approver's comment);
//   4. adds something that looks like a secret in any commit sent, or in a
//      commit or tag message;
//   5. carries a GitHub closing keyword ("Fixes #12") in a commit message:
//      GitHub would close the issue when the commit lands, and only the
//      approver closes an issue (decision 0003).
// Any read that fails refuses the push. SDLC_HARNESS_HOOK_BYPASS is ignored
// here; a person at the keyboard can still run `git push --no-verify`.
//
// When every line passes, the judge runs the hook it stands in front of (the
// repo's own .git/hooks/pre-push, or the hooks path that was set before the
// install) with the same arguments and stdin.
//
// This file is self-contained (node: imports only): install copies it into
// <git-common-dir>/sdlc-harness/hooks/ and the global hooks directory.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The harness's name: the marker directory under .git, and the global hooks directory. */
export const NAME = 'sdlc-harness';
/** The per-repo config file, relative to the repo root. */
export const CONFIG_DIR = '.sdlc-harness';
export const CONFIG_FILE = `${CONFIG_DIR}/sdlc.json`;
export const DEFAULT_PREFIX = 'GH';

const CEILING = 256 * 1024 * 1024;
const ZERO = /^0+$/;

/** The green record's name: the tree and the testCommand that tree carries. */
export function greenKey(tree, testCommand) {
  return `${tree}.${createHash('sha256').update(String(testCommand || '')).digest('hex').slice(0, 16)}`;
}

/** The issue prefix commits name (GH-12), or null when the config's value is unusable. */
export function issuePrefixOf(cfg) {
  const p = cfg && cfg.issuePrefix !== undefined ? cfg.issuePrefix : DEFAULT_PREFIX;
  return typeof p === 'string' && /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(p) ? p : null;
}

export const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/, 'private key block'],
  [/\bsk_live_[0-9A-Za-z]{16,256}/, 'Stripe live secret key'],
  [/\bghp_[0-9A-Za-z]{30,256}/, 'GitHub personal access token'],
  [/\bgho_[0-9A-Za-z]{30,256}/, 'GitHub OAuth token'],
  [/\bgithub_pat_[0-9A-Za-z_]{40,256}/, 'GitHub fine-grained token'],
  [/\bxox[abpr]-[0-9A-Za-z-]{20,256}/, 'Slack token'],
  [/\bsk-ant-[0-9A-Za-z_-]{20,256}/, 'Anthropic API key'],
  [/\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,256}/, 'Resend API key'],
  [/\bpostgres(?:ql)?:\/\/[^:\s/@]{1,256}:[^@\s/]{1,256}@/, 'database URL with embedded password'],
];

/** The labels of every secret pattern a line matches. Bounded: no pattern backtracks past 256 characters. */
export function secretsIn(line) {
  const hits = [];
  for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) hits.push(label);
  return hits;
}

// GitHub closes an issue when a commit on the default branch (or a merged
// pull request) says one of these words before a reference to it: "#12",
// "owner/repo#12", or the issue's URL. A prefix form ("Fixes GH-12") is
// refused too, so a message never relies on GitHub ignoring it.
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]*:?[ \t]+(?:(?:[\w.-]{1,100}\/[\w.-]{1,100})?#\d+|https?:\/\/[^\s]{1,200}\/issues\/\d+|[A-Za-z][A-Za-z0-9]{0,15}-\d+\b)/i;

/** The closing phrase a line of text carries, or null. */
export function closingKeyword(line) {
  const m = CLOSING.exec(String(line || ''));
  return m ? m[0] : null;
}

/** Does a path fall under a protected entry? Prefix match, or a glob with * and **. */
export function pathMatches(file, entry) {
  if (!entry) return false;
  if (entry.includes('*')) {
    const re = new RegExp(
      '^' +
        entry
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '(?:.*/)?')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') +
        '$',
    );
    return re.test(file);
  }
  return file === entry || file.startsWith(entry);
}

/**
 * Added lines of a `git diff-tree --stdin -p -U0` stream, with the commit and
 * file each belongs to. Hunk-aware: inside a hunk the header's line counts say
 * what each line is, so an added line whose text starts with "++" (shown as
 * "+++") is read as content, never as a file header. A merge comes as a
 * combined diff (--cc), one prefix column per parent: a line is new only when
 * every column is "+", so what a merge brings from the other side, which that
 * side's own commits already show, is not read twice.
 */
export function* addedLines(diff, commitIds) {
  let commit = '';
  let file = '';
  let cols = 0;
  let parentLeft = [];
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (newLeft > 0 || parentLeft.some((n) => n > 0)) {
      // "\ No newline at end of file" counts as nothing.
      if (line[0] === '\\') continue;
      const prefix = line.slice(0, cols);
      for (let i = 0; i < cols; i++) if (prefix[i] !== '+') parentLeft[i]--;
      if (!prefix.includes('-')) {
        newLeft--;
        if (/^\++$/.test(prefix)) yield { commit, file, text: line.slice(cols) };
      }
      continue;
    }
    if (commitIds.has(line)) {
      commit = line;
      file = '';
      continue;
    }
    const hunk = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+\d+(?:,(\d+))? \1/.exec(line);
    if (hunk) {
      cols = hunk[1].length - 1;
      parentLeft = hunk[2].trim().split(' ').map((r) => (r.includes(',') ? Number(r.split(',')[1]) : 1));
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      continue;
    }
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('diff --git ')) file = line.slice(11);
    else if (line.startsWith('diff --cc ')) file = line.slice(10);
  }
}

class Refusal extends Error {}

function maxBytes() {
  const asked = Number(process.env.SDLC_HARNESS_JUDGE_MAX_BYTES);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, CEILING) : CEILING;
}

// What the repo's or the caller's config could change about a read is set on
// every call: config from the environment (git -c, GIT_CONFIG_*) is dropped,
// replace refs are off, and the diff options below pin the output.
export function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_CONFIG/.test(k) || k === 'GIT_EXTERNAL_DIFF' || k === 'GIT_DIFF_OPTS' || k === 'GIT_REPLACE_REF_BASE') continue;
    env[k] = v;
  }
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}
const PINNED = ['--no-replace-objects', '-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', '-c', 'core.attributesFile=/dev/null'];

/** Run git; return stdout. A failure, or output past the ceiling, refuses the push. */
function git(cwd, args, { input, allow = [0], timeout } = {}) {
  const r = spawnSync('git', [...PINNED, ...args], { cwd, env: gitEnv(), input, encoding: 'utf8', maxBuffer: maxBytes(), stdio: ['pipe', 'pipe', 'pipe'], timeout });
  if (r.error) {
    const why = r.error.code === 'ENOBUFS' ? `its answer is past the ${maxBytes()} byte ceiling` : r.error.code === 'ETIMEDOUT' ? `no answer within ${timeout / 1000}s` : r.error.message;
    throw new Refusal(`The judge could not read git ${args[0]}: ${why}.`);
  }
  if (!allow.includes(r.status)) throw new Refusal(`The judge could not read git ${args.slice(0, 2).join(' ')} (exit ${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
  return { out: r.stdout, status: r.status };
}

function loadConfigAt(cwd, commit) {
  const listed = git(cwd, ['ls-tree', '--name-only', commit, '--', CONFIG_FILE]).out.trim();
  if (!listed) return null;
  const raw = git(cwd, ['cat-file', 'blob', `${commit}:${CONFIG_FILE}`]).out;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Refusal(`${CONFIG_FILE} in ${commit.slice(0, 12)} is not JSON.`);
  }
  const prefix = issuePrefixOf(cfg);
  if (!prefix) throw new Refusal(`${CONFIG_FILE} in ${commit.slice(0, 12)} has an issuePrefix that is not letters and digits.`);
  return {
    integration: cfg.integration || 'trunk',
    defaultBranch: cfg.defaultBranch || 'main',
    testCommand: cfg.testCommand || '',
    protectedPaths: [...(cfg.protectedPaths || []), `${CONFIG_DIR}/`],
    issuePrefix: prefix,
    requireGreen: cfg.requireGreen !== false,
  };
}

function objectType(cwd, sha) {
  const r = git(cwd, ['cat-file', '-t', sha], { allow: [0, 1, 128] });
  return r.status === 0 ? r.out.trim() : null;
}

/** Raw objects by sha, through one cat-file --batch. */
function readObjects(cwd, shas) {
  if (!shas.length) return new Map();
  const r = spawnSync('git', [...PINNED, 'cat-file', '--batch'], { cwd, env: gitEnv(), input: shas.join('\n') + '\n', maxBuffer: maxBytes() });
  if (r.error || r.status !== 0) throw new Refusal(`The judge could not read the commits sent: ${r.error ? (r.error.code === 'ENOBUFS' ? 'past the byte ceiling' : r.error.message) : `exit ${r.status}`}.`);
  const buf = r.stdout;
  const out = new Map();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    if (header[1] === 'missing') throw new Refusal(`The judge could not read object ${header[0]}.`);
    const size = Number(header[2]);
    out.set(header[0], { type: header[1], body: buf.subarray(nl + 1, nl + 1 + size).toString('utf8') });
    at = nl + 1 + size + 1;
  }
  return out;
}

const messageOf = (body) => {
  const i = body.indexOf('\n\n');
  return i < 0 ? '' : body.slice(i + 2);
};

/**
 * What the remote advertises, read once per push: the shas it holds that exist
 * locally, and the commit its HEAD names when that is held locally. A remote
 * that does not answer within a minute refuses the push.
 */
function advertised(cwd, remoteUrl, state) {
  if (state.advertised) return state.advertised;
  const rows = git(cwd, ['ls-remote', '--', remoteUrl], { timeout: 60_000 }).out.split('\n').map((l) => l.split('\t')).filter(([sha]) => /^[0-9a-f]{40,64}$/.test(sha || ''));
  const unique = [...new Set(rows.map(([sha]) => sha))];
  const known = new Set(unique.length ? git(cwd, ['cat-file', '--batch-check'], { input: unique.join('\n') + '\n' }).out.split('\n').filter((l) => l && !l.endsWith(' missing')).map((l) => l.split(' ')[0]) : []);
  const headSha = (rows.find(([, ref]) => ref === 'HEAD') || [])[0];
  const head = headSha && known.has(headSha) ? git(cwd, ['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`], { allow: [0, 1, 128] }).out.trim() || null : null;
  state.advertised = { shas: [...known], head };
  return state.advertised;
}

/** The first local branch or tracking ref (any remote) whose tree carries the config, read in one batch. */
function managedRef(cwd, state) {
  if (state.managedRef !== undefined) return state.managedRef;
  const tips = [...new Set(git(cwd, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/', 'refs/heads/']).out.split('\n').filter(Boolean))];
  let found = null;
  if (tips.length) {
    const rows = git(cwd, ['cat-file', '--batch-check'], { input: tips.map((t) => `${t}:${CONFIG_FILE}`).join('\n') + '\n' }).out.split('\n');
    const i = rows.findIndex((r) => / blob \d+$/.test(r));
    if (i >= 0) found = git(cwd, ['rev-parse', '--verify', '--quiet', `${tips[i]}^{commit}`], { allow: [0, 1, 128] }).out.trim() || null;
  }
  state.managedRef = found;
  return found;
}

/**
 * The config of the remote's HEAD, then of any tracking ref or local branch,
 * then of the local HEAD. Only a repo that is or was managed (records under
 * its git directory, or a ref that carries the config) gets this far, so a
 * plain push in any other repo asks the remote nothing more.
 */
function fallbackConfig(cwd, remoteUrl, state) {
  if (state.fallback !== undefined) return state.fallback;
  if (!existsSync(join(state.common, NAME)) && !managedRef(cwd, state)) return (state.fallback = state.headCfg);
  const head = advertised(cwd, remoteUrl, state).head;
  let cfg = head ? loadConfigAt(cwd, head) : null;
  if (!cfg && managedRef(cwd, state)) cfg = loadConfigAt(cwd, managedRef(cwd, state));
  state.fallback = cfg || state.headCfg;
  return state.fallback;
}

/** Was this repo under the SDLC: records of it here, a ref that carries the config, or one in the history sent? */
function wasManaged(cwd, localTip, state) {
  if (existsSync(join(state.common, NAME)) || managedRef(cwd, state)) return true;
  return Boolean(localTip && git(cwd, ['log', '-1', '--format=%H', localTip, '--', CONFIG_FILE]).out.trim());
}

/** Judge one stdin line. Returns the refusal lines, or [] when it passes. */
function judgeLine(cwd, remoteUrl, line, state) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
  const deleting = ZERO.test(localSha);
  const creating = ZERO.test(remoteSha);
  const remoteKnown = !creating && objectType(cwd, remoteSha) !== null;
  const localTip = deleting ? null : git(cwd, ['rev-parse', '--verify', '--quiet', `${localSha}^{commit}`], { allow: [0, 1, 128] }).out.trim() || null;

  const remoteCommit = remoteKnown ? git(cwd, ['rev-parse', '--verify', '--quiet', `${remoteSha}^{commit}`], { allow: [0, 1, 128] }).out.trim() || null : null;

  // The config already on the remote decides what is protected, so a push
  // cannot loosen its own rules. With none there (a first adoption) the commit
  // sent decides. With none in that either (a tip that deletes it), or a
  // remote tip not held here, the remote's HEAD, this repo's tracking refs for
  // that remote, then the local HEAD decide, so leaving the SDLC is judged.
  const cfg = (remoteCommit && loadConfigAt(cwd, remoteCommit)) || (localTip && loadConfigAt(cwd, localTip)) || fallbackConfig(cwd, remoteUrl, state);
  if (!cfg) {
    // A remote tip held here with no config is a repo the SDLC does not
    // manage. One not held here cannot be read: refused where it was managed.
    if (!creating && !remoteCommit && wasManaged(cwd, localTip, state)) return [`${remoteRef}: the judge cannot read ${CONFIG_FILE} from the remote, the commit sent, or any ref here, but this repo is managed. Fetch, then push again (decision 0005).`];
    return [];
  }
  if (deleting) return [`${remoteRef}: a push never deletes a ref (decision 0005). A person can do it at a keyboard.`];
  state.managed = true;
  if (!localTip) return [`${remoteRef}: ${localSha.slice(0, 12)} is not a commit, and only commits and tags of commits are pushed.`];
  if (!creating) {
    if (remoteRef.startsWith('refs/tags/')) return [`${remoteRef}: the tag is already on the remote, and moving a tag rewrites what it names.`];
    const anc = remoteKnown ? git(cwd, ['merge-base', '--is-ancestor', remoteSha, localTip], { allow: [0, 1] }).status : 1;
    if (anc !== 0) return [`${remoteRef}: not a fast-forward. The remote's ${remoteSha.slice(0, 12)} is not in the history sent, so this push would rewrite history (a force push).`];
  }
  if (!/^refs\/(heads|tags)\//.test(remoteRef)) return [`${remoteRef}: a push sends only branches and tags, and this ref is neither a branch nor a tag.`];
  if (creating && cfg.integration === 'trunk' && remoteRef.startsWith('refs/heads/') && remoteRef !== `refs/heads/${cfg.defaultBranch}`) {
    return [`${remoteRef}: a new branch on a trunk repo. Push to ${cfg.defaultBranch} from the worktree's branch instead (git push origin HEAD:${cfg.defaultBranch}).`];
  }

  // The commits sent: what the remote does not hold. For a new ref, that is
  // everything not reachable from the shas the remote advertises.
  const exclude = creating ? advertised(cwd, remoteUrl, state).shas : [remoteSha];
  const commits = git(cwd, ['rev-list', '--stdin'], { input: [localTip, ...exclude.map((s) => `^${s}`)].join('\n') + '\n' }).out.split('\n').filter(Boolean);
  const refusals = [];

  // A tag object's own message is scanned whether or not it sends commits.
  if (objectType(cwd, localSha) === 'tag') {
    const tag = readObjects(cwd, [localSha]).get(localSha);
    for (const l of messageOf(tag.body).split('\n')) for (const label of secretsIn(l)) refusals.push(`${remoteRef}: the tag message holds something that looks like a secret (${label}).`);
  }
  if (!commits.length) return refusals;

  // Green for the tree sent, under the testCommand that tree carries.
  if (cfg.requireGreen) {
    const tree = git(cwd, ['rev-parse', `${localTip}^{tree}`]).out.trim();
    const localCfg = loadConfigAt(cwd, localTip);
    const key = greenKey(tree, localCfg ? localCfg.testCommand : '');
    if (!existsSync(join(state.common, NAME, 'green', key))) {
      refusals.push(
        `${remoteRef}: No green record for the tree sent (${tree.slice(0, 12)}, from ${localTip.slice(0, 12)}).`,
        '  Run the repo test command through the verifier on that commit, then push again:',
        '  node <plugin root>/hooks/verify.mjs',
      );
    }
  }

  // Every path any commit sent touches, renames as a delete and an add, so
  // both sides of a move are checked. A merge lists what differs from every
  // parent: what it brings from one side, that side's commits list.
  const ids = new Set(commits);
  const names = git(cwd, ['diff-tree', '--stdin', '-r', '-z', '--name-only', '--no-renames', '--root', '--diff-merges=dense-combined', '--ignore-submodules=none'], { input: commits.join('\n') + '\n' }).out.split('\0').filter((p) => p && !ids.has(p));
  const touched = [...new Set(names.filter((f) => cfg.protectedPaths.some((p) => pathMatches(f, p))))];
  const objects = readObjects(cwd, commits);
  const messages = commits.map((c) => messageOf(objects.get(c).body));
  if (touched.length) {
    const tickets = [...new Set(messages.join('\n').match(new RegExp(`\\b${cfg.issuePrefix}-\\d+\\b`, 'g')) || [])];
    const approved = tickets.filter((id) => existsSync(join(state.common, NAME, 'go', id)));
    if (!approved.length) {
      refusals.push(
        `${remoteRef}: the commits sent change protected paths:`,
        ...touched.map((f) => `  ${f}`),
        tickets.length ? `  Tickets in the commits: ${tickets.join(', ')}. None has a recorded go.` : `  No ${cfg.issuePrefix}-n in the commits sent, so no go can apply.`,
        `  Post the plan, wait for the approver's "go", then record it: node <plugin root>/hooks/approve.mjs ${cfg.issuePrefix}-n`,
      );
    }
  }

  // Closing keywords: GitHub would close the issue the moment the commit lands.
  const closing = [];
  commits.forEach((c, i) => {
    for (const l of messages[i].split('\n')) {
      const k = closingKeyword(l);
      if (k) closing.push(`  ${c.slice(0, 12)}: "${k}"`);
    }
  });
  if (closing.length) {
    refusals.push(
      `${remoteRef}: a commit message carries a closing keyword, so GitHub would close the issue when it lands:`,
      ...closing,
      `  Only the approver closes an issue (decision 0003). Name the issue as ${cfg.issuePrefix}-n with no Closes, Fixes, or Resolves before it, reword the commit, then push again.`,
    );
  }

  // Secrets: every line each commit adds, so a key added and later removed
  // within the push is still found, and every commit message. Renames are
  // found, so a moved file shows only the lines its move changes.
  const hits = new Set();
  commits.forEach((c, i) => {
    for (const l of messages[i].split('\n')) for (const label of secretsIn(l)) hits.add(`  ${c.slice(0, 12)} commit message: ${label}`);
  });
  const diff = git(cwd, ['diff-tree', '--stdin', '-p', '-U0', '--inter-hunk-context=0', '-M', '--root', '--diff-merges=dense-combined', '--ignore-submodules=none', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'], { input: commits.join('\n') + '\n' }).out;
  for (const { commit, file, text } of addedLines(diff, ids)) for (const label of secretsIn(text)) hits.add(`  ${commit.slice(0, 12)} ${file}: ${label}`);
  if (hits.size) {
    refusals.push(`${remoteRef}: the commits sent add something that looks like a secret:`, ...hits, '  Remove it from history, rotate the credential, then push again.');
  }
  return refusals;
}

/**
 * Is this a mirror push? Git deletes remote refs for --mirror without listing
 * them on the hook's stdin, so the judge asks the git that ran it, and the
 * remote's config as that git sees it (git -c included).
 */
function mirroring(cwd, remoteName) {
  const cfg = spawnSync('git', ['config', '--bool', '--get', `remote.${remoteName}.mirror`], { cwd, encoding: 'utf8' });
  if (cfg.status === 0 && cfg.stdout.trim() === 'true') return true;
  let args = null;
  try {
    args = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
  } catch {
    const ps = spawnSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' });
    if (ps.status === 0) args = ps.stdout.trim().split(/\s+/);
  }
  if (!args) throw new Refusal('The judge could not read the command that runs this push, so it cannot tell a mirror push.');
  // The git that runs this hook was started as `git [options] <command> ...`;
  // a command that is an alias is read as its expansion.
  let i = 1;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--exec-path'].includes(args[i])) i++;
  }
  let words = args.slice(i);
  if (words[0] && words[0] !== 'push') {
    const alias = spawnSync('git', ['config', '--get', `alias.${words[0]}`], { cwd, encoding: 'utf8' });
    if (alias.status === 0 && !alias.stdout.trim().startsWith('!')) words = [...alias.stdout.trim().split(/\s+/), ...words.slice(1)];
  }
  return words.includes('--mirror');
}

/** Where the hook this judge stands in front of lives. */
function chainedHook(cwd, common) {
  const here = dirname(fileURLToPath(import.meta.url));
  const prevFile = join(here, 'previous-hooks-path');
  let dir = existsSync(prevFile) ? readFileSync(prevFile, 'utf8').trim() : '';
  if (!dir) dir = join(common, 'hooks');
  else if (!isAbsolute(dir)) dir = resolve(cwd, dir);
  const hook = join(dir, 'pre-push');
  if (resolve(hook) === resolve(here, 'pre-push')) return null;
  try {
    return statSync(hook).isFile() ? hook : null;
  } catch {
    return null;
  }
}

function main() {
  const [remoteName, remoteUrl = remoteName] = process.argv.slice(2);
  const input = readFileSync(0, 'utf8');
  const cwd = process.cwd();
  const refuse = (lines) => {
    process.stderr.write(`[${NAME}] push refused\n${lines.join('\n')}\n`);
    process.exit(1);
  };
  try {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out.trim();
    const hasHead = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allow: [0, 1, 128] }).out.trim();
    const headCfg = hasHead ? loadConfigAt(cwd, hasHead) : null;
    const state = { common, advertised: null, managed: false, headCfg, remoteName };
    const refusals = [];
    for (const line of input.split('\n').filter(Boolean)) refusals.push(...judgeLine(cwd, remoteUrl, line, state));
    if (state.managed || headCfg) {
      if (mirroring(cwd, remoteName)) refusals.unshift('A mirror push is refused: git deletes remote refs for it without telling this hook (decision 0005).');
    }
    if (refusals.length) refuse(refusals);
    // A chain that comes back to this judge (another tool's hooks directory
    // that records this one as its previous path) ends here, judged.
    if (process.env.SDLC_HARNESS_PUSH_CHAINED === '1') process.exit(0);
    const hook = chainedHook(cwd, common);
    if (hook) {
      const r = spawnSync(hook, process.argv.slice(2), { cwd, input, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, SDLC_HARNESS_PUSH_CHAINED: '1' } });
      if (r.error) refuse([`The repo's own pre-push hook could not run: ${r.error.message}`]);
      process.exit(r.status ?? 1);
    }
    process.exit(0);
  } catch (e) {
    refuse([e instanceof Refusal ? e.message : `The judge failed: ${e.message}`]);
  }
}

// Node runs a module at its real path, so compare real paths: a symlink in the
// path as typed (macOS's /var, a linked home) must not skip main().
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
