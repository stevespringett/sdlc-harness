// Shared helpers for the sdlc-harness hooks and scripts. Node 20+.
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, NAME, issuePrefixOf } from './git-pre-push.mjs';

export { CONFIG_DIR, CONFIG_FILE, NAME, closingKeyword, greenKey } from './git-pre-push.mjs';

/** Run a shell command, return trimmed stdout, or null on failure. */
export function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Repo root for a cwd, or null when not inside a git repo. */
export function repoRoot(cwd) {
  return sh('git rev-parse --show-toplevel', cwd);
}

/** The shared .git directory (worktrees share it, so markers are visible everywhere). */
export function gitCommonDir(root) {
  const d = sh('git rev-parse --path-format=absolute --git-common-dir', root);
  return d || join(root, '.git');
}

/** "owner/name" from a GitHub remote URL (https, ssh, or scp form), or null. */
export function githubRepoOf(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A person as the config names them: a GitHub login, or { login, id }. Logins
 * compare without case, as GitHub's do. An id, when given, must match too: a
 * login can be renamed and later taken by someone else; the numeric id cannot.
 */
export function person(p) {
  // A Linear member: its UUID is the identity, and the login (its display name) is for text.
  if (p && typeof p === 'object' && typeof p.id === 'string' && UUID.test(p.id)) {
    const login = typeof p.login === 'string' && p.login.trim() ? p.login.trim().toLowerCase() : null;
    return login ? { login, id: p.id.toLowerCase() } : null;
  }
  if (typeof p === 'string' && /^[A-Za-z0-9-]+(?:\[bot\])?$/.test(p)) return { login: p.toLowerCase(), id: null };
  if (p && typeof p === 'object' && typeof p.login === 'string' && /^[A-Za-z0-9-]+(?:\[bot\])?$/.test(p.login)) {
    const id = Number.isInteger(p.id) && p.id > 0 ? p.id : null;
    return { login: p.login.toLowerCase(), id };
  }
  return null;
}

function people(list) {
  return (Array.isArray(list) ? list : list ? [list] : []).map(person).filter(Boolean);
}

/**
 * Does a comment or issue author ({ login, id, type }) match a configured
 * person? A GitHub App's bot is "name[bot]" in the config and in REST, but
 * GraphQL gives its login without the suffix and its type as Bot, so the
 * suffix and the type are read together: a bot never matches a user of the
 * same name, and a user never matches a bot.
 */
export function isPerson(author, who) {
  if (!author || !who) return false;
  // A Linear member matches by UUID alone: names change and repeat, the id does not.
  if (typeof who.id === 'string') return typeof author === 'object' && String(author.id || '').toLowerCase() === who.id;
  const raw = typeof author === 'string' ? author : author.login;
  if (typeof raw !== 'string') return false;
  const type = typeof author === 'object' ? author.type : null;
  const authorBot = /\[bot\]$/i.test(raw) || type === 'Bot';
  const whoBot = /\[bot\]$/.test(who.login);
  if (authorBot !== whoBot) return false;
  if (raw.toLowerCase().replace(/\[bot\]$/, '') !== who.login.replace(/\[bot\]$/, '')) return false;
  if (who.id === null) return true;
  return typeof author === 'object' && Number(author.id) === who.id;
}

/** The tracker kinds with an adapter (decisions 0010 and 0011). */
export const TRACKER_KINDS = ['github', 'linear'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Linear workflow state names for each status, by default the names a new Linear team starts with. */
export const DEFAULT_LINEAR_STATES = {
  backlog: 'Backlog',
  notStarted: 'Todo',
  inProgress: 'In Progress',
  inReview: 'In Review',
  done: 'Done',
};

export const DEFAULT_STATUS_LABELS = {
  notStarted: 'status:not-started',
  inProgress: 'status:in-progress',
  inReview: 'status:in-review',
};
export const DEFAULT_PROJECT_OPTIONS = {
  backlog: 'Backlog',
  notStarted: 'Not Started',
  inProgress: 'In Progress',
  inReview: 'In Review',
  done: 'Done',
};

/**
 * The config with every default filled in. `origin` is the GitHub repo the
 * checkout's origin names, the tracker's default. Problems that make a part of
 * the SDLC unsafe to run are listed in `problems`, never thrown: the push
 * judge and the hooks still run, and the part that needs the value fails
 * closed.
 */
export function normalizeConfig(cfg, { origin = null } = {}) {
  const problems = [];
  const prefix = issuePrefixOf(cfg);
  if (!prefix) problems.push('issuePrefix must be letters and digits, such as "GH"');
  const t = cfg.tracker || {};
  const kind = t.kind === undefined ? 'github' : String(t.kind);
  if (!TRACKER_KINDS.includes(kind)) problems.push(`tracker.kind "${kind}" is not one of ${TRACKER_KINDS.join(', ')}`);
  const team = kind === 'linear' && typeof t.team === 'string' && /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(t.team) ? t.team : null;
  if (kind === 'linear' && !team) problems.push('tracker.kind is "linear" but tracker.team is not a team key such as "ENG"');
  if (kind === 'linear' && team && prefix && prefix.toUpperCase() !== team.toUpperCase()) problems.push(`issuePrefix "${prefix}" is not the Linear team key "${team}", and a Linear issue id always carries its team key`);
  const repo = kind !== 'github' ? null : typeof t.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(t.repo) ? t.repo : origin;
  if (kind === 'github' && !repo) problems.push('tracker.repo is not set and origin is not a GitHub repo');
  const approvers = people(cfg.approvers);
  const agent = person(cfg.agent);
  const who = kind === 'linear' ? 'Linear member (login and UUID id)' : 'GitHub login';
  if (!approvers.length) problems.push(`approvers names no ${who}, so nothing is ever approved`);
  if (!agent) problems.push(`agent names no ${who}, so no Spec is ever recognized`);
  if (kind === 'linear' && [agent, ...approvers].some((p) => p && typeof p.id !== 'string')) problems.push('with tracker.kind "linear", the agent and every approver need the Linear member\'s UUID as id, from get_user');
  if (agent && approvers.some((a) => a.login === agent.login || (a.id !== null && a.id === agent.id))) problems.push(`the agent account ${agent.login} is also an approver, so its own comments could approve; nothing is approved until they differ`);
  const states = t.states === 'project' ? 'project' : 'labels';
  const project = t.project && typeof t.project === 'object' ? t.project : null;
  if (states === 'project' && !(project && project.owner && Number.isInteger(project.number))) problems.push('tracker.states is "project" but tracker.project has no owner and number');
  const limit = Number.isInteger(cfg.inFlightLimit) && cfg.inFlightLimit > 0 ? cfg.inFlightLimit : 5;
  const areaName = (a) => (typeof a === 'string' && /^[a-z0-9][a-z0-9._-]{0,49}$/.test(a) ? a : null);
  const area = cfg.area === undefined ? null : areaName(cfg.area);
  if (cfg.area !== undefined && !area) problems.push(`area "${cfg.area}" is not a lowercase name such as "web"`);
  const areas = [...new Set([...(Array.isArray(cfg.areas) ? cfg.areas.map(areaName).filter(Boolean) : []), ...(area ? [area] : [])])];
  const defaultArea = areaName(cfg.defaultArea);
  if (defaultArea && !areas.includes(defaultArea)) areas.push(defaultArea);
  return {
    integration: cfg.integration || 'trunk',
    defaultBranch: cfg.defaultBranch || 'main',
    testCommand: cfg.testCommand || '',
    protectedPaths: cfg.protectedPaths || [],
    e2eTriggerPaths: cfg.e2eTriggerPaths || [],
    e2eCommand: cfg.e2eCommand || '',
    browserVerify: !!cfg.browserVerify,
    requireGreen: cfg.requireGreen !== false,
    issuePrefix: prefix,
    approvers,
    agent,
    people: people(cfg.people),
    tracker: {
      kind,
      repo,
      team,
      linearStates: { ...DEFAULT_LINEAR_STATES, ...(t.linearStates || {}) },
      allowedOwners: (Array.isArray(t.allowedOwners) && t.allowedOwners.length ? t.allowedOwners : repo ? [repo.split('/')[0]] : team ? [team] : []).map((o) => String(o).toLowerCase()),
      states,
      statusLabels: { ...DEFAULT_STATUS_LABELS, ...(t.statusLabels || {}) },
      project: project ? { field: 'Status', ...project, options: { ...DEFAULT_PROJECT_OPTIONS, ...(project.options || {}) } } : null,
    },
    areaLabelPrefix: typeof cfg.areaLabelPrefix === 'string' && cfg.areaLabelPrefix ? cfg.areaLabelPrefix : 'area:',
    areas,
    area,
    defaultArea,
    inFlightLimit: limit,
    checkouts: cfg.checkouts && typeof cfg.checkouts === 'object' ? cfg.checkouts : {},
    watch: cfg.watch !== false,
    watchInterval: typeof cfg.watchInterval === 'string' && /^\d+[mh]$/.test(cfg.watchInterval) ? cfg.watchInterval : '15m',
    policyStart: typeof cfg.policyStart === 'string' && !Number.isNaN(Date.parse(cfg.policyStart)) ? cfg.policyStart : '1970-01-01T00:00:00Z',
    modelLine: cfg.modelLine !== false,
    subagentModel: typeof cfg.subagentModel === 'string' && cfg.subagentModel ? cfg.subagentModel : 'opus',
    adhdStyle: cfg.adhdStyle === true,
    problems,
  };
}

/** Load the repo's config, or null when the repo is not managed by the SDLC. */
export function loadConfig(root) {
  const p = join(root, CONFIG_FILE);
  if (!existsSync(p)) return null;
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  return normalizeConfig(cfg, { origin: githubRepoOf(sh('git remote get-url origin', root)) });
}

/** Marker directories under the shared .git: <name>/green/<tree>, <name>/go/<GH-n>. */
export function markerPath(root, kind, key) {
  return join(gitCommonDir(root), NAME, kind, key);
}

export function writeMarker(root, kind, key, body = '') {
  const p = markerPath(root, kind, key);
  mkdirSync(join(gitCommonDir(root), NAME, kind), { recursive: true });
  writeFileSync(p, `${new Date().toISOString()} ${body}\n`);
  return p;
}

export { pathMatches } from './git-pre-push.mjs';

/** All ticket ids (GH-12) mentioned in a block of text, de-duplicated. */
export function ticketIds(text, prefix = 'GH') {
  const re = new RegExp(`\\b${prefix}-\\d+\\b`, 'g');
  return [...new Set((text || '').match(re) || [])];
}

// ---------------------------------------------------------------------------
// The push judge's install (decision 0005). Git runs the judge as the
// pre-push hook: each managed repo's core.hooksPath points at
// <git-common-dir>/sdlc-harness/hooks, which every worktree shares, and the
// global core.hooksPath points at <XDG_DATA_HOME or ~/.local/share>/sdlc-harness/hooks,
// so a clone made later is judged too. Each directory holds a copy of the
// judge, a pre-push shim that runs it with the node that installed it, and a
// shim for every other client hook that runs the hook the directory stands in
// front of: the hooks path set before the install, else the repo's own
// .git/hooks. session-start.mjs and verify.mjs install; verify.mjs records no
// green until proveHooks passes.

export const JUDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'git-pre-push.mjs');

// Client-side hooks git looks for in core.hooksPath. reference-transaction and
// fsmonitor-watchman are left out: git runs the first on every ref change and
// sets the second by its own path.
export const CHAINED_HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'post-rewrite', 'pre-auto-gc',
  'post-index-change', 'sendemail-validate', 'push-to-checkout',
];

function gitRun(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), status: r.status, err: (r.stderr || '').trim() };
}

/** Set a config value; git locks the file, so a concurrent install retries, and one that already set it counts. */
function setConfig(scope, value, root, env) {
  for (let i = 0; i < 40; i++) {
    if (gitRun(['config', scope, 'core.hooksPath', value], root, env).ok) return;
    if (gitRun(['config', scope, '--get', 'core.hooksPath'], root, env).out === value) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`cannot set ${scope} core.hooksPath to ${value}`);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function globalHooksDir(env = process.env) {
  const data = env.XDG_DATA_HOME || join(env.HOME || '', '.local', 'share');
  return join(data, NAME, 'hooks');
}

export function localHooksDir(root, env = process.env) {
  const r = gitRun(['rev-parse', '--path-format=absolute', '--git-common-dir'], root, env);
  if (!r.ok) throw new Error(`cannot find the git directory of ${root}`);
  return join(r.out, NAME, 'hooks');
}

function expandHome(p, env) {
  return p === '~' || p.startsWith('~/') ? (env.HOME || '') + p.slice(1) : p;
}

function same(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Write a file through a temp file and a rename, so a reader never sees half of it. */
function writeAtomic(path, body, mode) {
  if (existsSync(path) && readFileSync(path, 'utf8') === body) {
    if (mode) chmodSync(path, mode);
    return;
  }
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, body);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function prePushShim(dir, node = process.execPath, { local = false } = {}) {
  // A repo's own shim stands in front of a repo the SDLC manages, so with no
  // node it always refuses; the global one asks HEAD whether the repo is one.
  const managed = local ? 'true' : `git cat-file -e HEAD:${CONFIG_FILE} 2>/dev/null`;
  return [
    '#!/bin/sh',
    `# ${NAME} push judge. Written at install with the node that installed it;`,
    '# when that node is gone it uses the one on PATH, and with none, a managed repo refuses',
    '# while any other repo passes through to the hook this directory stands in front of.',
    `node=${quote(node)}`,
    'want="$node"',
    '[ -x "$node" ] || node=$(command -v node 2>/dev/null)',
    'if [ -z "$node" ] || [ ! -x "$node" ]; then',
    `  if ${managed}; then`,
    `    echo "[${NAME}] push refused: node is not at $want or on PATH, so the push judge cannot run. Start a Claude Code session in this repo to reinstall it." >&2`,
    '    exit 1',
    '  fi',
    ...CHAIN_GUARD('pre-push').map((l) => `  ${l}`),
    `  prev=$(cat ${quote(join(dir, 'previous-hooks-path'))} 2>/dev/null)`,
    '  if [ -n "$prev" ]; then h="$prev/pre-push"; else h="$(git rev-parse --git-common-dir)/hooks/pre-push"; fi',
    '  [ -f "$h" ] && [ -x "$h" ] || exit 0',
    '  exec "$h" "$@"',
    'fi',
    `exec "$node" ${quote(join(dir, 'git-pre-push.mjs'))} "$@"`,
    '',
  ].join('\n');
}

// Another tool that installs the same way can record this directory as its
// previous hooks path while this one records it, so a chain could run in a
// circle. A shim records the hook's name with git's pid (its parent, which an
// exec'd link keeps) and its own pid (the parent of a link that spawns the
// next one instead), and ends the chain when either comes back. A git a hook
// starts has a new pid, so its own hooks still run. On Windows the sh a native
// git starts sees $PPID as 1 for every git, so there it keeps only its own pid. A chain that spawns
// through a middleman stops at eight links. The Claude Code hook refuses a
// command that sets the variable itself.
const CHAIN_GUARD = (name) => [
  'g=$PPID; [ "$g" = 1 ] && g=$$',
  `case " $SDLC_HARNESS_CHAINED " in *" ${name}:$g "*|*" ${name}:$$ "*) exit 0 ;; esac`,
  `[ "$(printf '%s\\n' $SDLC_HARNESS_CHAINED | grep -c '^${name}:')" -ge 16 ] && exit 0`,
  `SDLC_HARNESS_CHAINED="$SDLC_HARNESS_CHAINED ${name}:$g ${name}:$$"; export SDLC_HARNESS_CHAINED`,
];

function chainShim(dir, name) {
  return [
    '#!/bin/sh',
    `# ${NAME}: runs the ${name} hook this directory stands in front of.`,
    ...CHAIN_GUARD(name),
    `prev=$(cat ${quote(join(dir, 'previous-hooks-path'))} 2>/dev/null)`,
    `if [ -n "$prev" ]; then h="$prev/${name}"; else h="$(git rev-parse --git-common-dir)/hooks/${name}"; fi`,
    '[ -f "$h" ] && [ -x "$h" ] || exit 0',
    'exec "$h" "$@"',
    '',
  ].join('\n');
}

function writeHooksDir(dir, previous, node, local = false) {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'git-pre-push.mjs'), readFileSync(JUDGE_SOURCE, 'utf8'));
  writeAtomic(join(dir, 'pre-push'), prePushShim(dir, node, { local }), 0o755);
  for (const name of CHAINED_HOOKS) writeAtomic(join(dir, name), chainShim(dir, name), 0o755);
  if (previous !== undefined) writeAtomic(join(dir, 'previous-hooks-path'), previous ? `${previous}\n` : '');
  else if (!existsSync(join(dir, 'previous-hooks-path'))) writeAtomic(join(dir, 'previous-hooks-path'), '');
}

function readPrevious(dir) {
  try {
    return readFileSync(join(dir, 'previous-hooks-path'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Install or refresh the judge for a repo: the global hooks directory and
 * core.hooksPath, then the repo's own. Idempotent; a judge whose content
 * differs from the plugin's is replaced. Throws with the reason on failure.
 */
export function installHooks(root, { env = process.env, node = process.execPath } = {}) {
  const globalDir = globalHooksDir(env);
  const localDir = localHooksDir(root, env);
  const ours = (p) => Boolean(p) && (same(p, globalDir) || same(p, localDir));

  const curGlobal = expandHome(gitRun(['config', '--global', '--get', 'core.hooksPath'], root, env).out, env);
  if (curGlobal && same(curGlobal, globalDir)) writeHooksDir(globalDir, undefined, node);
  else {
    writeHooksDir(globalDir, curGlobal && !ours(curGlobal) ? curGlobal : '', node);
    setConfig('--global', globalDir, root, env);
  }

  const curLocal = expandHome(gitRun(['config', '--local', '--get', 'core.hooksPath'], root, env).out, env);
  const curLocalAbs = curLocal && (isAbsolute(curLocal) ? curLocal : resolve(root, curLocal));
  if (curLocal && same(curLocalAbs, localDir)) writeHooksDir(localDir, undefined, node, true);
  else {
    writeHooksDir(localDir, curLocal && !ours(curLocalAbs) ? curLocal : readPrevious(globalDir), node, true);
    // What the repo itself had, for an uninstall to put back.
    writeAtomic(join(localDir, 'previous-local-hooks-path'), curLocal && !ours(curLocalAbs) ? `${curLocal}\n` : '');
    setConfig('--local', localDir, root, env);
  }
  return { globalDir, localDir };
}

/**
 * Proof that git will run the plugin's judge on a push from this repo: the
 * hooks path git uses is one of the harness's directories, its judge is the
 * plugin's byte for byte, and its pre-push shim runs that judge with a node
 * that exists. Returns { ok, reason }. On Windows a file has no execute bit:
 * Node never reports one, and Git for Windows runs a hook by its #! line.
 */
export function proveHooks(root, { env = process.env, platform = process.platform } = {}) {
  const eff = gitRun(['config', '--get', 'core.hooksPath'], root, env);
  if (!eff.ok || !eff.out) return { ok: false, reason: 'core.hooksPath is not set, so git runs no push judge here' };
  const raw = expandHome(eff.out, env);
  const dir = isAbsolute(raw) ? raw : resolve(root, raw);
  let localDir;
  try {
    localDir = localHooksDir(root, env);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (!same(dir, localDir) && !same(dir, globalHooksDir(env))) return { ok: false, reason: `core.hooksPath is ${eff.out}, not the ${NAME} hooks directory` };
  const judge = join(dir, 'git-pre-push.mjs');
  if (!existsSync(judge)) return { ok: false, reason: `${judge} is missing` };
  if (sha256(readFileSync(judge)) !== sha256(readFileSync(JUDGE_SOURCE))) return { ok: false, reason: `${judge} differs from the plugin's judge` };
  const shim = join(dir, 'pre-push');
  if (!existsSync(shim)) return { ok: false, reason: `${shim} is missing` };
  if (platform !== 'win32' && !(statSync(shim).mode & 0o111)) return { ok: false, reason: `${shim} is not executable` };
  const body = readFileSync(shim, 'utf8');
  if (body !== prePushShim(dir, nodeIn(body), { local: same(dir, localDir) })) return { ok: false, reason: `${shim} does not run ${judge}` };
  if (!existsSync(nodeIn(body))) return { ok: false, reason: `the node ${shim} runs is gone` };
  return { ok: true, dir };
}

function nodeIn(shim) {
  const m = /^node='((?:[^']|'\\'')*)'$/m.exec(shim);
  return m ? m[1].replace(/'\\''/g, "'") : '';
}

/**
 * Undo installHooks for a repo, and globally: each hooks path that still
 * points at a harness directory goes back to what it was before the install,
 * or is unset when nothing was. A path someone changed since is left alone.
 * A person runs it (uninstall-hooks.mjs); the Claude Code hook refuses it.
 */
export function uninstallHooks(root, { env = process.env } = {}) {
  const done = [];
  const restore = (scope, cwd, dir, file) => {
    const cur = expandHome(gitRun(['config', scope, '--get', 'core.hooksPath'], cwd, env).out, env);
    if (!cur || !same(isAbsolute(cur) ? cur : resolve(cwd, cur), dir)) return;
    let prev = '';
    try {
      prev = readFileSync(join(dir, file), 'utf8').trim();
    } catch {}
    const r = prev ? gitRun(['config', scope, 'core.hooksPath', prev], cwd, env) : gitRun(['config', scope, '--unset', 'core.hooksPath'], cwd, env);
    if (!r.ok) throw new Error(`cannot restore ${scope} core.hooksPath: ${r.err}`);
    done.push(`${scope} core.hooksPath ${prev ? `back to ${prev}` : 'unset'}`);
  };
  if (root) restore('--local', root, localHooksDir(root, env), 'previous-local-hooks-path');
  restore('--global', root || env.HOME || '/', globalHooksDir(env), 'previous-hooks-path');
  return done;
}
