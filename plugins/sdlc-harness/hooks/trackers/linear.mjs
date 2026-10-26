// The Linear adapter behind tracker.mjs (decision 0011). The session reaches
// Linear through the Linear MCP connector, logged in as the agent's own Linear
// member, never through an API key: the model makes each call (get_issue,
// list_comments, save_comment, save_issue, ...) and saves what it read to a
// file. This file turns that raw output into the shapes policy.mjs reads, so
// approval, intake, ownership, and the in-flight count are decided by the same
// code as on GitHub. It never writes: a write command here names the Linear
// tool call to make instead, and the Claude Code hook guards those calls.
//
// The raw input each command reads on stdin:
//   whoami    get_user with query "me"
//   issue     { "issue": get_issue, "comments": [every comment, every page of
//             list_comments], "children": the number of issues list_issues
//             finds with parentId set to it }
//   inflight, queue   [every issue, every page, of list_issues with assignee "me" and the team]
//   inbox     [every notification, every page, of get_notifications with unreadOnly]
//
// Status is the team's workflow state, matched by name (tracker.linearStates),
// then by type: completed is Done and canceled is Canceled, and only an
// approver sets either.

import { isPerson } from '../lib.mjs';
import { TrackerError } from './error.mjs';
import { inFlight, owner } from '../policy.mjs';


/** The issue id as Linear writes it: ENG-12 for 12, eng-12, or ENG-12, in this team only. */
export function parseId(id, cfg) {
  const team = cfg.tracker.team;
  const m = new RegExp(`^(?:${team}-)?(\\d+)$`, 'i').exec(String(id ?? '').trim());
  if (!m || Number(m[1]) < 1) throw new TrackerError(`"${id}" is not an issue id in team ${team}, such as ${team}-12`);
  return `${team}-${Number(m[1])}`;
}

const numberOf = (identifier) => {
  const m = /-(\d+)$/.exec(String(identifier || ''));
  return m ? Number(m[1]) : null;
};

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

/** backlog, not-started, in-progress, in-review, done, or canceled, from a state's name and type. */
export function statusOf(name, type, cfg) {
  const t = String(type || '').toLowerCase();
  // Without a known state type an issue could read as open when it is closed: refuse it instead.
  if (!STATE_TYPES.includes(t)) throw new TrackerError(`the state "${name}" has no known statusType ("${type ?? ''}"): read issues with statusType`);
  if (t === 'completed') return 'done';
  if (t === 'canceled') return 'canceled';
  const names = cfg.tracker.linearStates;
  const n = String(name || '').toLowerCase();
  if (n === String(names.done).toLowerCase()) return 'done';
  const found = ['inReview', 'inProgress', 'notStarted', 'backlog'].find((k) => String(names[k]).toLowerCase() === n);
  if (found) return { inReview: 'in-review', inProgress: 'in-progress', notStarted: 'not-started', backlog: 'backlog' }[found];
  // A state the config does not name reads by its type, and a started one counts toward the limit.
  return { started: 'in-progress', unstarted: 'not-started' }[t] || 'backlog';
}

const closedOf = (status) => (status === 'done' ? 'COMPLETED' : status === 'canceled' ? 'NOT_PLANNED' : null);

/** A member as policy.mjs reads it: the configured login when the UUID is a configured person's. */
function memberOf(id, name, cfg) {
  if (!id) return null;
  const known = [cfg.agent, ...cfg.approvers, ...cfg.people].find((p) => p && isPerson({ id }, p));
  return { login: known ? known.login : String(name || id).toLowerCase(), id: String(id).toLowerCase(), type: 'User' };
}

// Linear lets only a comment's author edit it, so an edited comment's editor is
// its author. A comment counts as edited when its update lands well after it
// was written; a few seconds absorbs the gap between the two stamps.
const EDIT_SLACK_MS = 5000;
const editedAt = (c) => {
  const made = Date.parse(c.createdAt);
  const changed = Date.parse(c.updatedAt);
  return Number.isFinite(made) && Number.isFinite(changed) && changed - made > EDIT_SLACK_MS ? c.updatedAt : null;
};

/** The agent's own member, from get_user "me": is the Linear connector logged in as the configured agent? */
export function whoami(cfg, raw) {
  const me = raw && typeof raw === 'object' ? raw : {};
  if (!me.id) throw new TrackerError('whoami reads the output of get_user with query "me" on stdin');
  const self = { id: me.id };
  const ok = Boolean(cfg.agent) && isPerson(self, cfg.agent);
  const approver = cfg.approvers.some((a) => isPerson(self, a));
  const label = me.displayName || me.name || me.id;
  return {
    login: label,
    ok: ok && !approver,
    reason: approver
      ? 'the Linear connector is logged in as an approver: the agent must write through its own Linear member, or its comments would read as approvals'
      : ok
        ? 'the Linear connector is the agent member'
        : `the Linear connector is logged in as ${label}, not the agent member ${cfg.agent ? cfg.agent.login : '(none configured)'}`,
  };
}

/** The issue as policy.mjs reads it, from { issue, comments, children }. */
export function issue(cfg, id, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const i = r.issue;
  if (!i || !i.id) throw new TrackerError('issue reads { "issue": <get_issue>, "comments": [...], "children": <n> } on stdin');
  const identifier = String(i.id);
  if (identifier.toUpperCase() !== String(id).toUpperCase()) throw new TrackerError(`the input is ${identifier}, not ${id}`);
  if (!Array.isArray(r.comments)) throw new TrackerError(`the input has no comments list for ${identifier}: read every page of list_comments`);
  if (!Number.isInteger(r.children) || r.children < 0) throw new TrackerError(`the input has no children count for ${identifier}: list_issues with parentId ${identifier}`);
  const status = statusOf(i.status, i.statusType, cfg);
  const out = {
    tracker: 'linear',
    identifier,
    id: i.uuid || identifier,
    number: numberOf(identifier),
    url: i.url || null,
    title: i.title || '',
    body: i.description || '',
    createdAt: i.createdAt,
    // Linear's API does not say who edited a description, so it reads as unedited.
    lastEditedAt: null,
    editor: null,
    author: memberOf(i.createdById, i.createdBy, cfg),
    state: status === 'done' || status === 'canceled' ? 'closed' : 'open',
    stateReason: closedOf(status),
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean),
    assignees: i.assigneeId ? [memberOf(i.assigneeId, i.assignee, cfg).login] : [],
    subIssues: r.children,
    projectStatus: null,
    comments: r.comments
      // Replies in a thread count like top-level comments: an approval can be either.
      .filter(Boolean)
      .map((c) => {
        const author = c.author ? memberOf(c.author.id, c.author.name, cfg) : c.botActor ? { login: String(c.botActor.name || 'bot').toLowerCase(), id: null, type: 'Bot' } : null;
        const edited = editedAt(c);
        return { id: c.id, url: c.url || null, author, body: c.body || '', createdAt: c.createdAt, lastEditedAt: edited, editor: edited ? author : null };
      })
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    status,
  };
  return out;
}

/**
 * The agent's issues, from every page of list_issues with assignee "me": the
 * shape inFlight and the queue read. The list is the agent's by how it was
 * read, so every issue in it counts as assigned to the agent: a missing or
 * unmatched assigneeId never lets the in-flight limit pass.
 */
export function assigned(cfg, raw) {
  if (!Array.isArray(raw)) throw new TrackerError('reads [every issue from every page of list_issues with assignee "me" and the team] on stdin');
  return raw
    .filter((i) => i && i.id && String(i.id).toUpperCase().startsWith(`${cfg.tracker.team.toUpperCase()}-`))
    .map((i) => {
      const status = statusOf(i.status, i.statusType, cfg);
      return {
        identifier: String(i.id),
        number: numberOf(i.id),
        title: i.title || '',
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        state: status === 'done' || status === 'canceled' ? 'closed' : 'open',
        stateReason: closedOf(status),
        labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean),
        assignees: cfg.agent ? [cfg.agent.login] : [],
        status,
      };
    });
}

/** The issue a notification is about, from its URL (…/issue/ENG-12/…), or null. */
export function notificationIssue(url, cfg) {
  const m = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/.exec(String(url || ''));
  return m && m[1].toUpperCase().startsWith(`${cfg.tracker.team.toUpperCase()}-`) ? m[1].toUpperCase() : null;
}

/**
 * The unread notifications, each with the issue it is about. Linear's
 * notification carries no labels, so an issue's owner is not known here:
 * `owner: null` and `mine: false` until the session reads that issue and runs
 * `policy.mjs owner` on it. A notification about no issue in the team belongs
 * to the default area.
 */
export function inbox(cfg, raw) {
  if (!Array.isArray(raw)) throw new TrackerError('inbox reads [every notification from every page of get_notifications with unreadOnly] on stdin');
  return raw
    .filter((n) => n && n.id && !n.readAt && !n.archivedAt)
    .map((n) => {
      const id = notificationIssue(n.url, cfg);
      const base = { thread: n.id, type: n.type, title: n.title, updatedAt: n.updatedAt, issue: id };
      if (id) return { ...base, mine: false, owner: null, reason: `read ${id}, then run policy owner on it` };
      const dflt = cfg.defaultArea;
      return { ...base, mine: Boolean(cfg.area) && dflt === cfg.area, owner: dflt || null, reason: 'not about an issue in the team' };
    });
}

/** The Linear tool call for each command the model makes itself: the writes, which the Claude Code hook guards, and two reads. */
export const MCP_CALLS = {
  state: 'save_issue with id and state set to the name tracker.linearStates gives that status (never Done or Canceled)',
  comment: 'save_comment with issueId and body; to edit, save_comment with the id of your own latest comment (never an approved Spec)',
  label: 'save_issue with id and addLabels or removeLabels',
  assign: 'save_issue with id and assignee (a Linear issue has one assignee)',
  title: 'save_issue with id and title',
  create: 'save_issue with team, title, description, and labels (no state: a new issue starts in Backlog)',
  sub: 'save_issue with the child\'s id and parentId set to the parent',
  search: 'list_issues with query and team',
  labels: 'list_issue_labels with team and name set to the area label prefix',
  read: 'mark_notification with id and read true, only for a notification this area owns',
};

const viaMcp = (cmd) => () => {
  throw new TrackerError(`with Linear, ${cmd} is a Linear MCP call the session makes itself, not this helper: ${MCP_CALLS[cmd]}`);
};

/** The adapter tracker.mjs calls. Reads take the raw MCP output; writes name the tool call. */
export const adapter = {
  kind: 'linear',
  stdin: true,
  writes: false,
  parseId,
  whoami: (cfg, o) => whoami(cfg, o.input),
  issue: (cfg, id, o) => issue(cfg, id, o.input),
  inflight: (cfg, o) => inFlight(assigned(cfg, o.input), cfg),
  queue: (cfg, o) => queueOf(assigned(cfg, o.input), cfg),
  inbox: (cfg, o) => inbox(cfg, o.input),
  ...Object.fromEntries(Object.keys(MCP_CALLS).map((k) => [k, viaMcp(k)])),
};

export const AUTONOMY = ['agent-fully-autonomous', 'agent-needs-go', 'human-only'];

/** The queue, as on GitHub: the area's open issues assigned to the agent, oldest first. */
export function queueOf(issues, cfg) {
  return issues
    .filter((i) => i.state === 'open' && owner(i, cfg).mine)
    .map((i) => {
      const labels = i.labels.map((l) => l.toLowerCase());
      const autonomy = AUTONOMY.filter((a) => labels.includes(a));
      return { number: i.number, identifier: i.identifier, title: i.title, status: i.status, autonomy: autonomy.length === 1 ? autonomy[0] : null, createdAt: i.createdAt, updatedAt: i.updatedAt, epicTitle: /\bepics?\b/i.test(i.title || '') };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
}
