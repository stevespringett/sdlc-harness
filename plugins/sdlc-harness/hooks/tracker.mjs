#!/usr/bin/env node
// The GitHub Issues side of the SDLC (decision 0007). Every read the skills
// and the watch make of the tracker, and the few writes that need the API,
// go through here, so every session reads an issue the same way and the
// policy helper always gets the same shape. Plain `gh issue comment`,
// `gh issue edit --add-label`, and `gh issue create` stay with the skills.
//
// Status, by the config's tracker.states:
//   labels  (default) Backlog = open with no status label; Not Started,
//           In Progress, In Review = one status label each (tracker.statusLabels);
//           Done = closed as completed; Canceled = closed as not planned.
//   project a single-select field (default "Status") on a Projects (v2)
//           board, with option names in tracker.project.options; Done is
//           still closed by the approver.
// Nothing here closes an issue or sets Done: only an approver accepts.
//
// CLI (config from the repo the command runs in):
//   node tracker.mjs whoami                  is gh logged in as the configured agent?
//   node tracker.mjs issue <n>               the issue as policy.mjs reads it (JSON)
//   node tracker.mjs state <n> <status>      backlog | not-started | in-progress | in-review
//   node tracker.mjs inflight                the area's in-flight count (policy.inFlight)
//   node tracker.mjs queue                   the area's open issues assigned to the agent, oldest first
//   node tracker.mjs inbox                   the agent's unread notifications, each with its owner
//   node tracker.mjs read <thread-id>        mark one notification read, only when this area owns it
//   node tracker.mjs sub <parent> <child>    make one issue a sub-issue of another

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPerson, loadConfig, repoRoot } from './lib.mjs';
import { inFlight, owner } from './policy.mjs';

export const STATUSES = ['backlog', 'not-started', 'in-progress', 'in-review'];
const KEY = { 'not-started': 'notStarted', 'in-progress': 'inProgress', 'in-review': 'inReview', backlog: 'backlog', done: 'done' };

/** Run gh; { ok, out, err }. A gh that hangs is killed after 30 seconds. */
export function runGh(args, { input } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ETIMEDOUT' ? 'gh gave no answer within 30s' : r.error.message };
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}

class TrackerError extends Error {}

function call(gh, args, what) {
  const r = gh(args);
  if (!r.ok) throw new TrackerError(`could not ${what}: ${(r.err || 'gh failed').split('\n')[0]}`);
  return r.out;
}

function graphql(gh, query, vars, what) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  let body;
  try {
    body = JSON.parse(call(gh, args, what));
  } catch (e) {
    if (e instanceof TrackerError) throw e;
    throw new TrackerError(`could not ${what}: the answer is not JSON`);
  }
  if (body.errors && body.errors.length) throw new TrackerError(`could not ${what}: ${body.errors[0].message}`);
  return body.data;
}

const splitRepo = (repo) => {
  const [o, n] = String(repo || '').split('/');
  if (!o || !n) throw new TrackerError(`"${repo}" is not owner/name`);
  return { owner: o, name: n };
};

const AUTHOR = '__typename login ... on User { databaseId } ... on Bot { databaseId }';
const ITEMS = 'projectItems(first: 20) { nodes { id project { id number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }';

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $field: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title body url createdAt lastEditedAt state stateReason
      author { ${AUTHOR} }
      editor { ${AUTHOR} }
      labels(first: 100) { nodes { name } }
      assignees(first: 20) { nodes { login } }
      subIssues(first: 1) { totalCount }
      ${ITEMS}
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body createdAt lastEditedAt url author { ${AUTHOR} } editor { ${AUTHOR} } }
      }
    }
  }
}`;

const person = (a) => (a ? { login: a.login, id: a.databaseId ?? null, type: a.__typename || null } : null);

/** The status of an issue as the config maps it: backlog, not-started, in-progress, in-review, done, canceled. */
export function statusOf(issue, cfg) {
  if (String(issue.state).toLowerCase() === 'closed') return String(issue.stateReason || '').toUpperCase() === 'COMPLETED' ? 'done' : 'canceled';
  if (cfg.tracker.states === 'project') {
    const opts = cfg.tracker.project.options;
    const name = issue.projectStatus;
    // A status this board names as Done is not Done until the approver closes the issue.
    const found = ['inProgress', 'inReview', 'notStarted', 'backlog'].find((k) => opts[k] === name);
    return found ? { inProgress: 'in-progress', inReview: 'in-review', notStarted: 'not-started', backlog: 'backlog' }[found] : 'backlog';
  }
  const labels = (issue.labels || []).map((l) => String(l).toLowerCase());
  const has = (k) => labels.includes(String(cfg.tracker.statusLabels[k]).toLowerCase());
  // Two status labels at once read as the one that counts toward the in-flight limit.
  if (has('inProgress')) return 'in-progress';
  if (has('inReview')) return 'in-review';
  if (has('notStarted')) return 'not-started';
  return 'backlog';
}

function projectStatusOf(items, cfg) {
  const p = cfg.tracker.project;
  if (!p) return null;
  const node = (items || []).find((n) => n && n.project && n.project.number === p.number && String(n.project.owner && n.project.owner.login).toLowerCase() === String(p.owner).toLowerCase());
  return node ? { itemId: node.id, projectId: node.project.id, status: node.fieldValueByName ? node.fieldValueByName.name : null } : null;
}

/** A GraphQL issue node, as policy.mjs reads it. */
export function parseIssue(node, comments, cfg, repo) {
  const labels = (node.labels ? node.labels.nodes : []).map((l) => l.name);
  const item = projectStatusOf(node.projectItems ? node.projectItems.nodes : [], cfg);
  const issue = {
    repo,
    id: node.id,
    number: node.number,
    url: node.url,
    title: node.title,
    body: node.body || '',
    createdAt: node.createdAt,
    lastEditedAt: node.lastEditedAt || null,
    editor: person(node.editor),
    author: person(node.author),
    state: String(node.state || '').toLowerCase(),
    stateReason: node.stateReason || null,
    labels,
    assignees: (node.assignees ? node.assignees.nodes : []).map((a) => a.login),
    subIssues: node.subIssues ? node.subIssues.totalCount : 0,
    projectStatus: item ? item.status : null,
    comments: comments.map((c) => ({
      id: c.databaseId,
      url: c.url,
      author: person(c.author),
      body: c.body || '',
      createdAt: c.createdAt,
      lastEditedAt: c.lastEditedAt || null,
      editor: person(c.editor),
    })),
  };
  issue.status = statusOf(issue, cfg);
  return { issue, item };
}

/** Every comment, every page. */
export function fetchIssue(cfg, number, { gh = runGh, repo = cfg.tracker.repo } = {}) {
  const { owner: o, name } = splitRepo(repo);
  const field = cfg.tracker.project ? cfg.tracker.project.field : 'Status';
  let after = null;
  let node = null;
  const comments = [];
  for (let page = 0; page < 50; page++) {
    const data = graphql(gh, ISSUE_QUERY, { owner: o, name, number: Number(number), field, after }, `read issue #${number} in ${repo}`);
    const n = data && data.repository && data.repository.issue;
    if (!n) throw new TrackerError(`issue #${number} is not in ${repo}`);
    node = node || n;
    comments.push(...n.comments.nodes);
    if (!n.comments.pageInfo.hasNextPage) return parseIssue(node, comments, cfg, repo);
    after = n.comments.pageInfo.endCursor;
  }
  throw new TrackerError(`issue #${number} has more comments than the helper reads`);
}

// The repository's own issue list, not search: search lags behind recent
// changes, and a count that lags lets the in-flight limit pass.
const ASSIGNED_QUERY = `query($owner: String!, $name: String!, $agent: String!, $field: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: [OPEN], filterBy: { assignee: $agent }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title createdAt updatedAt state stateReason labels(first: 100) { nodes { name } } assignees(first: 20) { nodes { login } } ${ITEMS} }
    }
  }
}`;

/** Open issues assigned to the agent, each with its status, labels, and assignees. */
export function fetchAssigned(cfg, { gh = runGh } = {}) {
  if (!cfg.agent) throw new TrackerError('the config names no agent account');
  const { owner: o, name } = splitRepo(cfg.tracker.repo);
  const field = cfg.tracker.project ? cfg.tracker.project.field : 'Status';
  const agent = cfg.agent.login.replace(/\[bot\]$/, '');
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = graphql(gh, ASSIGNED_QUERY, { owner: o, name, agent, field, after }, 'list the agent\'s open issues');
    const conn = data && data.repository && data.repository.issues;
    if (!conn) throw new TrackerError(`could not list the agent's open issues: ${cfg.tracker.repo} not found`);
    for (const n of conn.nodes) {
      if (!n || n.number === undefined) continue;
      const labels = n.labels.nodes.map((l) => l.name);
      const item = projectStatusOf(n.projectItems ? n.projectItems.nodes : [], cfg);
      const i = { number: n.number, title: n.title, createdAt: n.createdAt, updatedAt: n.updatedAt, state: String(n.state).toLowerCase(), stateReason: n.stateReason, labels, assignees: n.assignees.nodes.map((a) => a.login), projectStatus: item ? item.status : null };
      i.status = statusOf(i, cfg);
      out.push(i);
    }
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  // A partial list would undercount; the caller refuses instead.
  throw new TrackerError('the agent has more open issues than the helper reads');
}

/** The area's in-flight count, with every issue it counted. */
export function fetchInFlight(cfg, opts = {}) {
  return inFlight(fetchAssigned(cfg, opts), cfg);
}

export const AUTONOMY = ['agent-fully-autonomous', 'agent-needs-go', 'human-only'];

/**
 * The watch's queue: open issues assigned to the agent that this area owns,
 * oldest first, each with its status and autonomy label (null when it has
 * none, or more than one). Approval is not in it: run the policy check on
 * the full issue before building anything here.
 */
export function queueOf(issues, cfg) {
  return issues
    .filter((i) => owner(i, cfg).mine)
    .map((i) => {
      const labels = i.labels.map((l) => l.toLowerCase());
      const autonomy = AUTONOMY.filter((a) => labels.includes(a));
      return { number: i.number, title: i.title, status: i.status, autonomy: autonomy.length === 1 ? autonomy[0] : null, createdAt: i.createdAt, updatedAt: i.updatedAt, epicTitle: /\bepics?\b/i.test(i.title || '') };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
}

/** The label changes that move an issue to `target` in labels mode. */
export function statusLabelChanges(labels, target, cfg) {
  const all = Object.values(cfg.tracker.statusLabels);
  const have = new Set((labels || []).map((l) => String(l).toLowerCase()));
  const want = target === 'backlog' ? null : cfg.tracker.statusLabels[KEY[target]];
  return {
    add: want && !have.has(want.toLowerCase()) ? [want] : [],
    remove: (labels || []).filter((l) => all.some((s) => s.toLowerCase() === String(l).toLowerCase()) && (!want || String(l).toLowerCase() !== want.toLowerCase())),
  };
}

const PROJECT_QUERY = `query($owner: String!, $number: Int!, $field: String!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } } } } }
}`;

/** Move an issue to a status. Done is refused: only an approver closes an issue. */
export function setState(cfg, number, target, { gh = runGh } = {}) {
  if (target === 'done' || target === 'canceled' || target === 'closed') throw new TrackerError('only an approver moves an issue to Done or closes it (decision 0003)');
  if (!STATUSES.includes(target)) throw new TrackerError(`"${target}" is not one of ${STATUSES.join(', ')}`);
  const { issue, item } = fetchIssue(cfg, number, { gh });
  if (issue.state === 'closed') throw new TrackerError(`#${number} is closed; only an approver reopens it`);
  if (cfg.tracker.states === 'labels') {
    const { add, remove } = statusLabelChanges(issue.labels, target, cfg);
    if (!add.length && !remove.length) return { number, status: target, changed: false };
    const args = ['issue', 'edit', String(number), '--repo', cfg.tracker.repo];
    if (add.length) args.push('--add-label', add.join(','));
    if (remove.length) args.push('--remove-label', remove.join(','));
    call(gh, args, `set the status labels on #${number}`);
    return { number, status: target, changed: true };
  }
  const p = cfg.tracker.project;
  const data = graphql(gh, PROJECT_QUERY, { owner: p.owner, number: p.number, field: p.field }, `read project ${p.owner}/${p.number}`);
  const proj = data && data.repositoryOwner && data.repositoryOwner.projectV2;
  if (!proj || !proj.field) throw new TrackerError(`project ${p.owner}/${p.number} has no single-select field "${p.field}"`);
  const optionName = p.options[KEY[target]];
  const option = proj.field.options.find((o) => o.name === optionName);
  if (!option) throw new TrackerError(`the field "${p.field}" has no option "${optionName}"`);
  let itemId = item && item.itemId;
  if (!itemId) {
    const added = graphql(gh, 'mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }', { project: proj.id, content: issue.id }, `add #${number} to the project`);
    itemId = added.addProjectV2ItemById.item.id;
  }
  graphql(
    gh,
    'mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }',
    { project: proj.id, item: itemId, field: proj.field.id, option: option.id },
    `set the ${p.field} of #${number}`,
  );
  return { number, status: target, changed: true };
}

/** The issue number an API subject URL names, or null. */
export function issueNumberOf(url, repo) {
  const m = /\/repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(String(url || ''));
  return m && (!repo || m[1].toLowerCase() === repo.toLowerCase()) ? Number(m[2]) : null;
}

/**
 * Who owns a notification thread: the area of the issue it is about. A
 * thread about something that is not an issue (a pull request, a release, a
 * commit) belongs to the default area.
 */
export function threadOwner(thread, cfg, { gh = runGh } = {}) {
  const inTracker = String(thread.repository || '').toLowerCase() === String(cfg.tracker.repo).toLowerCase();
  const number = thread.type === 'Issue' && inTracker ? issueNumberOf(thread.url, cfg.tracker.repo) : null;
  // A thread about an issue whose area cannot be read here (another repo, a
  // renamed or transferred one, an odd URL) has no owner: it stays unread.
  if (thread.type === 'Issue' && number === null) return { number: null, mine: false, owner: null, reason: inTracker ? 'issue URL not understood' : 'an issue outside the tracker repo' };
  if (number === null) {
    const dflt = cfg.defaultArea;
    return { number: null, mine: Boolean(cfg.area) && dflt === cfg.area, owner: dflt || null, reason: inTracker ? 'not about an issue' : 'outside the tracker repo' };
  }
  const out = gh(['api', `repos/${cfg.tracker.repo}/issues/${number}`, '--jq', '{labels: [.labels[].name]} | @json']);
  if (!out.ok) return { number, mine: false, owner: null, reason: `labels not loaded: ${(out.err || '').split('\n')[0]}` };
  let labels;
  try {
    labels = JSON.parse(out.out.trim()).labels;
  } catch {
    return { number, mine: false, owner: null, reason: 'labels not loaded' };
  }
  return { number, ...owner({ labels }, cfg) };
}

/** The agent's unread notifications, every page, each with its owner. */
export function fetchInbox(cfg, { gh = runGh } = {}) {
  const out = call(gh, ['api', '--paginate', 'notifications', '--jq', '.[] | {id, reason, updated_at, repository: .repository.full_name, type: .subject.type, title: .subject.title, url: .subject.url} | @json'], 'read the notifications');
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const t = JSON.parse(l);
      return { thread: t.id, reason: t.reason, updatedAt: t.updated_at, repository: t.repository, type: t.type, title: t.title, ...threadOwner(t, cfg, { gh }) };
    });
}

/** Mark one notification read, after checking this area owns it. */
export function markRead(cfg, thread, { gh = runGh } = {}) {
  if (!/^\d+$/.test(String(thread))) throw new TrackerError(`"${thread}" is not a notification thread id`);
  const raw = call(gh, ['api', `notifications/threads/${thread}`, '--jq', '{repository: .repository.full_name, type: .subject.type, url: .subject.url} | @json'], `read thread ${thread}`);
  const t = JSON.parse(raw.trim());
  const who = threadOwner(t, cfg, { gh });
  if (!who.mine) throw new TrackerError(`thread ${thread} belongs to ${who.owner ? `area ${who.owner}` : 'no area'} (${who.reason}); leave it unread for its owner`);
  call(gh, ['api', '-X', 'PATCH', `notifications/threads/${thread}`], `mark thread ${thread} read`);
  return { thread: Number(thread), read: true, number: who.number };
}

/** Make `child` a sub-issue of `parent`, both in the tracker repo. */
export function linkSubIssue(cfg, parent, child, { gh = runGh } = {}) {
  if (!/^\d+$/.test(String(parent)) || !/^\d+$/.test(String(child))) throw new TrackerError('sub takes two issue numbers');
  const raw = call(gh, ['api', `repos/${cfg.tracker.repo}/issues/${child}`, '--jq', '.id'], `read issue #${child}`);
  const id = Number(raw.trim());
  if (!Number.isInteger(id) || id <= 0) throw new TrackerError(`issue #${child} has no id`);
  call(gh, ['api', '-X', 'POST', `repos/${cfg.tracker.repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${id}`], `make #${child} a sub-issue of #${parent}`);
  return { parent: Number(parent), child: Number(child) };
}

/** Is gh logged in as the configured agent? */
export function whoami(cfg, { gh = runGh } = {}) {
  const raw = call(gh, ['api', 'user', '--jq', '{login, id} | @json'], 'ask GitHub who gh is logged in as');
  const me = JSON.parse(raw.trim());
  const ok = Boolean(cfg.agent) && isPerson({ login: me.login, id: me.id }, cfg.agent);
  const approver = cfg.approvers.some((a) => isPerson({ login: me.login, id: me.id }, a));
  return {
    login: me.login,
    ok: ok && !approver,
    reason: approver ? 'gh is logged in as an approver: the agent must write through its own account, or its comments would read as approvals' : ok ? 'gh is the agent account' : `gh is logged in as ${me.login}, not the agent account ${cfg.agent ? cfg.agent.login : '(none configured)'}`,
  };
}

function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const root = repoRoot(process.cwd());
  const cfg = root && loadConfig(root);
  if (!cfg) {
    console.error('[tracker] no .sdlc-harness/sdlc.json in this repo');
    return 1;
  }
  const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  try {
    if (cfg.problems.length && cmd !== 'whoami') console.error(`[tracker] config problems: ${cfg.problems.join('; ')}`);
    if (cmd === 'whoami') {
      const r = whoami(cfg);
      print(r);
      return r.ok ? 0 : 1;
    }
    if (cmd === 'issue' && /^\d+$/.test(a1 || '')) return print(fetchIssue(cfg, Number(a1)).issue), 0;
    if (cmd === 'state' && /^\d+$/.test(a1 || '') && a2) return print(setState(cfg, Number(a1), a2)), 0;
    if (cmd === 'inflight') return print(fetchInFlight(cfg)), 0;
    if (cmd === 'queue') return print(queueOf(fetchAssigned(cfg), cfg)), 0;
    if (cmd === 'inbox') return print(fetchInbox(cfg)), 0;
    if (cmd === 'read' && a1) return print(markRead(cfg, a1)), 0;
    if (cmd === 'sub' && a1 && a2) return print(linkSubIssue(cfg, a1, a2)), 0;
  } catch (e) {
    console.error(`[tracker] ${e.message}`);
    return 1;
  }
  console.error('usage: tracker.mjs whoami | issue <n> | state <n> <backlog|not-started|in-progress|in-review> | inflight | queue | inbox | read <thread-id> | sub <parent> <child>');
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
