// Tests for the GitHub side (tracker.mjs, setup-labels.mjs), against a fake gh
// that answers like GitHub's API and records every call. Nothing here reaches
// the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchIssue,
  fetchInFlight,
  fetchInbox,
  issueNumberOf,
  linkSubIssue,
  markRead,
  queueOf,
  setState,
  statusLabelChanges,
  statusOf,
  threadOwner,
  whoami,
  fetchAssigned,
} from '../tracker.mjs';
import { labelCommands, labelSet } from '../setup-labels.mjs';
import { checkIssue } from '../policy.mjs';
import { normalizeConfig } from '../lib.mjs';

const RAW = {
  approvers: [{ login: 'octo-lead', id: 101 }],
  agent: { login: 'acme-bot', id: 303 },
  tracker: { repo: 'acme/tracker' },
  area: 'web',
  areas: ['web', 'api'],
  defaultArea: 'web',
  policyStart: '2026-01-01T00:00:00Z',
};
const CFG = normalizeConfig(RAW);
const PROJECT = normalizeConfig({ ...RAW, tracker: { repo: 'acme/tracker', states: 'project', project: { owner: 'acme', number: 3 } } });

/** A fake gh: `routes` is a list of [predicate(args), answer(args)]; every call is kept in `calls`. */
function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    for (const [when, answer] of routes) if (when(args)) return answer(args);
    return { ok: false, out: '', err: `no route for gh ${args.join(' ')}` };
  };
  return { gh, calls };
}
const ok = (data) => ({ ok: true, out: typeof data === 'string' ? data : JSON.stringify(data), err: '' });
const isQuery = (needle) => (a) => a[0] === 'api' && a[1] === 'graphql' && a.some((x) => x.startsWith('query=') && x.includes(needle));
const varOf = (args, name) => {
  const i = args.findIndex((x) => x.startsWith(`${name}=`));
  return i < 0 ? undefined : args[i].slice(name.length + 1);
};

const user = (login, id) => ({ __typename: 'User', login, databaseId: id });
const INTENT = '## Problem\nx\n## Outcome\ny\n## Constraints\nnone known';

function issueNode({ comments = [], labels = [], state = 'OPEN', stateReason = null, hasNextPage = false, endCursor = null, projectItems = [] } = {}) {
  return {
    id: 'I_1',
    number: 12,
    title: 'Dates parse in every locale',
    body: INTENT,
    url: 'https://github.com/acme/tracker/issues/12',
    createdAt: '2026-09-28T10:00:00Z',
    state,
    stateReason,
    author: user('pat-writer', 202),
    labels: { nodes: labels.map((name) => ({ name })) },
    assignees: { nodes: [{ login: 'acme-bot' }] },
    subIssues: { totalCount: 0 },
    projectItems: { nodes: projectItems },
    comments: { pageInfo: { hasNextPage, endCursor }, nodes: comments },
  };
}
const c = (author, body, createdAt, extra = {}) => ({ databaseId: Math.floor(Math.random() * 1e6), url: 'u', author, body, createdAt, lastEditedAt: null, editor: null, ...extra });

describe('status', () => {
  test('labels mode: no status label is Backlog, each label its status, closed by reason', () => {
    assert.equal(statusOf({ state: 'open', labels: [] }, CFG), 'backlog');
    assert.equal(statusOf({ state: 'open', labels: ['status:not-started'] }, CFG), 'not-started');
    assert.equal(statusOf({ state: 'open', labels: ['Status:In-Progress'] }, CFG), 'in-progress');
    assert.equal(statusOf({ state: 'open', labels: ['status:in-review'] }, CFG), 'in-review');
    assert.equal(statusOf({ state: 'closed', stateReason: 'COMPLETED', labels: ['status:in-review'] }, CFG), 'done');
    assert.equal(statusOf({ state: 'closed', stateReason: 'NOT_PLANNED', labels: [] }, CFG), 'canceled');
  });

  test('two status labels read as In Progress, the one that counts toward the limit', () => {
    assert.equal(statusOf({ state: 'open', labels: ['status:in-review', 'status:in-progress'] }, CFG), 'in-progress');
  });

  test('project mode: the board field decides, and a board "Done" on an open issue is not Done', () => {
    assert.equal(statusOf({ state: 'open', projectStatus: 'In Progress' }, PROJECT), 'in-progress');
    assert.equal(statusOf({ state: 'open', projectStatus: 'Not Started' }, PROJECT), 'not-started');
    assert.equal(statusOf({ state: 'open', projectStatus: 'Done' }, PROJECT), 'backlog');
    assert.equal(statusOf({ state: 'open', projectStatus: null }, PROJECT), 'backlog');
    assert.equal(statusOf({ state: 'closed', stateReason: 'COMPLETED' }, PROJECT), 'done');
  });

  test('custom status label names come from the config', () => {
    const cfg = normalizeConfig({ ...RAW, tracker: { repo: 'acme/tracker', statusLabels: { inProgress: 'doing' } } });
    assert.equal(statusOf({ state: 'open', labels: ['doing'] }, cfg), 'in-progress');
  });
});

describe('reading an issue', () => {
  test('every comment, every page, with authors, dates, and edits, in the shape policy.mjs reads', () => {
    const page1 = [c(user('acme-bot', 303), '## Spec\nx', '2026-09-28T10:30:00Z')];
    const page2 = [c(user('octo-lead', 101), 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: '2026-09-28T11:01:00Z', editor: user('octo-lead', 101) })];
    const { gh, calls } = fakeGh([
      [isQuery('issue(number: $number)'), (a) => ok({ data: { repository: { issue: varOf(a, 'after') ? issueNode({ comments: page2 }) : issueNode({ comments: page1, hasNextPage: true, endCursor: 'C1' }) } } })],
    ]);
    const { issue } = fetchIssue(CFG, 12, { gh });
    assert.equal(calls.length, 2);
    assert.equal(varOf(calls[1], 'after'), 'C1');
    assert.equal(varOf(calls[0], 'owner'), 'acme');
    assert.equal(varOf(calls[0], 'name'), 'tracker');
    assert.equal(issue.comments.length, 2);
    assert.deepEqual(issue.author, { login: 'pat-writer', id: 202, type: 'User' });
    assert.deepEqual(issue.comments[1].editor, { login: 'octo-lead', id: 101 });
    assert.equal(issue.status, 'backlog');
    assert.equal(issue.state, 'open');
    // The path the skills walk: fetch, then the policy check.
    assert.equal(checkIssue(issue, CFG).approved, true);
  });

  test("the body's last edit and its editor are read, so human-architected can check them", () => {
    const node = { ...issueNode({ labels: ['human-architected'] }), author: user('octo-lead', 101), body: `${INTENT}\n\n## Spec\nx`, lastEditedAt: '2026-09-29T00:00:00Z', editor: user('pat-writer', 202) };
    const { gh } = fakeGh([[isQuery('issue(number: $number)'), () => ok({ data: { repository: { issue: node } } })]]);
    const { issue } = fetchIssue(CFG, 12, { gh });
    assert.deepEqual(issue.editor, { login: 'pat-writer', id: 202 });
    assert.equal(checkIssue(issue, CFG).blocked, true);
  });

  test('a comment edited by someone else, as GitHub reports it, does not approve', () => {
    const comments = [c(user('acme-bot', 303), '## Spec\nx', '2026-09-28T10:30:00Z'), c(user('octo-lead', 101), 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: '2026-09-28T11:02:00Z', editor: user('pat-writer', 202) })];
    const { gh } = fakeGh([[isQuery('issue(number: $number)'), () => ok({ data: { repository: { issue: issueNode({ comments }) } } })]]);
    assert.equal(checkIssue(fetchIssue(CFG, 12, { gh }).issue, CFG).approved, false);
  });

  test('a GraphQL error or a missing issue is an error, never an empty issue', () => {
    const err = fakeGh([[isQuery('issue('), () => ok({ errors: [{ message: 'Could not resolve' }] })]]);
    assert.throws(() => fetchIssue(CFG, 12, { gh: err.gh }), /Could not resolve/);
    const none = fakeGh([[isQuery('issue('), () => ok({ data: { repository: { issue: null } } })]]);
    assert.throws(() => fetchIssue(CFG, 12, { gh: none.gh }), /not in acme\/tracker/);
    const down = fakeGh([]);
    assert.throws(() => fetchIssue(CFG, 12, { gh: down.gh }), /could not read issue #12/);
  });
});

describe('setting status', () => {
  const route = (labels, extra = {}) => [isQuery('issue(number: $number)'), () => ok({ data: { repository: { issue: issueNode({ labels, ...extra }) } } })];

  test('labels mode adds the one status label and removes the others', () => {
    const { gh, calls } = fakeGh([route(['Defect', 'status:not-started']), [(a) => a[0] === 'issue' && a[1] === 'edit', () => ok('')]]);
    assert.deepEqual(setState(CFG, 12, 'in-progress', { gh }), { number: 12, status: 'in-progress', changed: true });
    assert.deepEqual(calls.at(-1), ['issue', 'edit', '12', '--repo', 'acme/tracker', '--add-label', 'status:in-progress', '--remove-label', 'status:not-started']);
  });

  test('backlog removes every status label; a status already set changes nothing', () => {
    assert.deepEqual(statusLabelChanges(['status:in-review', 'area:web'], 'backlog', CFG), { add: [], remove: ['status:in-review'] });
    const { gh, calls } = fakeGh([route(['status:in-review'])]);
    assert.equal(setState(CFG, 12, 'in-review', { gh }).changed, false);
    assert.equal(calls.length, 1);
  });

  test('Done, Canceled, and closing are refused: only an approver closes an issue', () => {
    const { gh, calls } = fakeGh([]);
    for (const s of ['done', 'canceled', 'closed']) assert.throws(() => setState(CFG, 12, s, { gh }), /only an approver/);
    assert.throws(() => setState(CFG, 12, 'shipped', { gh }), /not one of/);
    assert.equal(calls.length, 0);
  });

  test('a closed issue is never moved', () => {
    const { gh } = fakeGh([route([], { state: 'CLOSED', stateReason: 'COMPLETED' })]);
    assert.throws(() => setState(CFG, 12, 'in-progress', { gh }), /closed; only an approver reopens it/);
  });

  test('project mode sets the board field, adding the issue to the board first when it is not on it', () => {
    const { gh, calls } = fakeGh([
      route([]),
      [isQuery('projectV2(number: $number)'), () => ok({ data: { repositoryOwner: { projectV2: { id: 'P_1', field: { id: 'F_1', options: [{ id: 'O_b', name: 'Backlog' }, { id: 'O_ip', name: 'In Progress' }] } } } } })],
      [isQuery('addProjectV2ItemById'), () => ok({ data: { addProjectV2ItemById: { item: { id: 'ITEM_1' } } } })],
      [isQuery('updateProjectV2ItemFieldValue'), () => ok({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_1' } } } })],
    ]);
    setState(PROJECT, 12, 'in-progress', { gh });
    const update = calls.at(-1);
    assert.equal(varOf(update, 'item'), 'ITEM_1');
    assert.equal(varOf(update, 'option'), 'O_ip');
    assert.equal(varOf(update, 'project'), 'P_1');
    assert.ok(calls.some(isQuery('addProjectV2ItemById')));
  });

  test('project mode reuses the item the issue already has on the board', () => {
    const items = [{ id: 'ITEM_9', project: { id: 'P_1', number: 3, owner: { login: 'Acme' } }, fieldValueByName: { name: 'Backlog' } }];
    const { gh, calls } = fakeGh([
      route([], { projectItems: items }),
      [isQuery('projectV2(number: $number)'), () => ok({ data: { repositoryOwner: { projectV2: { id: 'P_1', field: { id: 'F_1', options: [{ id: 'O_ir', name: 'In Review' }] } } } } })],
      [isQuery('updateProjectV2ItemFieldValue'), () => ok({ data: {} })],
    ]);
    setState(PROJECT, 12, 'in-review', { gh });
    assert.equal(varOf(calls.at(-1), 'item'), 'ITEM_9');
    assert.ok(!calls.some(isQuery('addProjectV2ItemById')));
  });

  test('project mode with no such option says so', () => {
    const { gh } = fakeGh([route([]), [isQuery('projectV2(number: $number)'), () => ok({ data: { repositoryOwner: { projectV2: { id: 'P_1', field: { id: 'F_1', options: [] } } } } })]]);
    assert.throws(() => setState(PROJECT, 12, 'in-progress', { gh }), /no option "In Progress"/);
  });
});

describe('in flight and the queue', () => {
  const searchNode = (number, area, extra = {}) => ({ number, title: `Issue ${number}`, createdAt: `2026-09-${String(number % 28 + 1).padStart(2, '0')}T00:00:00Z`, updatedAt: '2026-10-01T00:00:00Z', state: 'OPEN', stateReason: null, labels: { nodes: [{ name: `area:${area}` }, { name: 'status:in-progress' }, ...(extra.labels || [])] }, assignees: { nodes: [{ login: 'acme-bot' }] }, projectItems: { nodes: [] } });
  const search = (nodes) => fakeGh([[isQuery('issues(first: 100'), () => ok({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } })]]);

  test("the repository's own issue list (not search, which lags) names the tracker repo and the agent, and counts only this area (four own plus others: room left)", () => {
    const { gh, calls } = search([1, 2, 3, 4].map((n) => searchNode(n, 'web')).concat([20, 21, 22, 23, 24, 25].map((n) => searchNode(n, 'api'))));
    const v = fetchInFlight(CFG, { gh });
    assert.ok(!calls[0].some((x) => x.includes('search(')));
    assert.equal(varOf(calls[0], 'owner'), 'acme');
    assert.equal(varOf(calls[0], 'name'), 'tracker');
    assert.equal(varOf(calls[0], 'agent'), 'acme-bot');
    assert.equal(v.full, false);
    assert.deepEqual(v.counted, [1, 2, 3, 4]);
    assert.equal(v.others, 6);
  });

  test('a list with more pages than the helper reads is an error, never a short count', () => {
    const { gh } = fakeGh([[isQuery('issues(first: 100'), () => ok({ data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: 'C' }, nodes: [] } } } })]]);
    assert.throws(() => fetchInFlight(CFG, { gh }), /more open issues than the helper reads/);
  });

  test('five of its own: full, and every counted issue named', () => {
    const { gh } = search([1, 2, 3, 4, 5].map((n) => searchNode(n, 'web')));
    const v = fetchInFlight(CFG, { gh });
    assert.equal(v.full, true);
    assert.deepEqual(v.counted, [1, 2, 3, 4, 5]);
  });

  test("the queue is this area's issues, oldest first, each with its autonomy label", () => {
    const { gh } = search([
      searchNode(7, 'web', { labels: [{ name: 'agent-fully-autonomous' }] }),
      searchNode(3, 'web'),
      searchNode(5, 'api'),
      searchNode(4, 'web', { labels: [{ name: 'agent-needs-go' }, { name: 'human-only' }] }),
    ]);
    const q = queueOf(fetchAssigned(CFG, { gh }), CFG);
    assert.deepEqual(q.map((i) => i.number), [3, 4, 7]);
    assert.deepEqual(q.map((i) => i.autonomy), [null, null, 'agent-fully-autonomous']);
  });
});

describe('the inbox', () => {
  const thread = (id, extra) => JSON.stringify({ id, reason: 'comment', updated_at: '2026-10-01T00:00:00Z', repository: 'acme/tracker', type: 'Issue', title: 't', url: `https://api.github.com/repos/acme/tracker/issues/${id}`, ...extra });
  const routes = (labelsByNumber) => [
    [(a) => a[0] === 'api' && a[1] === '--paginate' && a[2] === 'notifications', () => ok([thread('11'), thread('12'), thread('13', { type: 'PullRequest', url: 'https://api.github.com/repos/acme/tracker/pulls/13' }), thread('14', { repository: 'acme/other', url: 'https://api.github.com/repos/acme/other/issues/1' })].join('\n') + '\n')],
    [(a) => a[0] === 'api' && /^repos\/acme\/tracker\/issues\/\d+$/.test(a[1]), (a) => ok(JSON.stringify({ labels: labelsByNumber[a[1].split('/').pop()] || [] }))],
  ];

  test('each notification carries its owner, from the issue\'s area label', () => {
    const { gh } = fakeGh(routes({ 11: ['area:web'], 12: ['area:api'] }));
    const inbox = fetchInbox(CFG, { gh });
    assert.deepEqual(inbox.map((t) => [t.thread, t.number, t.owner, t.mine]), [
      ['11', 11, 'web', true],
      ['12', 12, 'api', false],
      ['13', null, 'web', true],
      ['14', null, null, false],
    ]);
    assert.equal(inbox[2].reason, 'not about an issue');
    assert.equal(inbox[3].reason, 'an issue outside the tracker repo');
  });

  test('an issue thread whose URL is not understood has no owner and stays unread', () => {
    assert.deepEqual(threadOwner({ repository: 'acme/tracker', type: 'Issue', url: 'https://api.github.com/repositories/99/issues/3' }, CFG).mine, false);
  });

  test('a notification whose labels cannot be read is never mine', () => {
    const { gh } = fakeGh([routes({})[0]]);
    const inbox = fetchInbox(CFG, { gh });
    assert.equal(inbox[0].mine, false);
    assert.match(inbox[0].reason, /labels not loaded/);
  });

  test("marking read refuses another area's thread and marks this area's", () => {
    const { gh, calls } = fakeGh([
      [(a) => a[0] === 'api' && a[1] === 'notifications/threads/12', () => ok(JSON.stringify({ repository: 'acme/tracker', type: 'Issue', url: 'https://api.github.com/repos/acme/tracker/issues/12' }))],
      [(a) => a[0] === 'api' && a[1] === 'notifications/threads/11', () => ok(JSON.stringify({ repository: 'acme/tracker', type: 'Issue', url: 'https://api.github.com/repos/acme/tracker/issues/11' }))],
      ...routes({ 11: ['area:web'], 12: ['area:api'] }).slice(1),
      [(a) => a[0] === 'api' && a[1] === '-X' && a[2] === 'PATCH', () => ok('')],
    ]);
    assert.throws(() => markRead(CFG, '12', { gh }), /belongs to area api/);
    assert.ok(!calls.some((a) => a[2] === 'PATCH'));
    assert.deepEqual(markRead(CFG, '11', { gh }), { thread: 11, read: true, number: 11 });
    assert.deepEqual(calls.at(-1), ['api', '-X', 'PATCH', 'notifications/threads/11']);
    assert.throws(() => markRead(CFG, '11; rm -rf /', { gh }), /not a notification thread id/);
  });

  test('a repo with no default area owns no thread that is not about an issue', () => {
    const cfg = normalizeConfig({ ...RAW, defaultArea: undefined });
    assert.equal(threadOwner({ repository: 'acme/tracker', type: 'PullRequest', url: 'x' }, cfg).mine, false);
  });

  test('issue numbers come only from issue URLs in the tracker repo', () => {
    assert.equal(issueNumberOf('https://api.github.com/repos/acme/tracker/issues/42', 'acme/tracker'), 42);
    assert.equal(issueNumberOf('https://api.github.com/repos/acme/other/issues/42', 'acme/tracker'), null);
    assert.equal(issueNumberOf('https://api.github.com/repos/acme/tracker/pulls/42', 'acme/tracker'), null);
  });
});

describe('who gh is', () => {
  const me = (login, id) => fakeGh([[(a) => a[0] === 'api' && a[1] === 'user', () => ok(JSON.stringify({ login, id }))]]).gh;

  test('the agent account is ok', () => assert.equal(whoami(CFG, { gh: me('acme-bot', 303) }).ok, true));
  test('another account is not, and says which', () => {
    const r = whoami(CFG, { gh: me('pat-writer', 202) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /logged in as pat-writer, not the agent account acme-bot/);
  });
  test('an approver is not, even when the config also names it the agent', () => {
    const cfg = normalizeConfig({ ...RAW, agent: 'octo-lead' });
    const r = whoami(cfg, { gh: me('octo-lead', 101) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /logged in as an approver/);
  });
  test('the right login with the wrong id is not the agent', () => assert.equal(whoami(CFG, { gh: me('acme-bot', 999) }).ok, false));
});

describe('sub-issues', () => {
  test('links the child by its database id', () => {
    const { gh, calls } = fakeGh([
      [(a) => a[0] === 'api' && a[1] === 'repos/acme/tracker/issues/13', () => ok('987654\n')],
      [(a) => a[0] === 'api' && a[1] === '-X' && a[2] === 'POST', () => ok('{}')],
    ]);
    linkSubIssue(CFG, 12, 13, { gh });
    assert.deepEqual(calls.at(-1), ['api', '-X', 'POST', 'repos/acme/tracker/issues/12/sub_issues', '-F', 'sub_issue_id=987654']);
    assert.throws(() => linkSubIssue(CFG, 12, 'x', { gh }), /two issue numbers/);
  });
});

describe('label setup', () => {
  test('the autonomy, kind, intake, status, and area labels, each once', () => {
    const names = labelSet(CFG).map((l) => l.name);
    for (const n of ['agent-fully-autonomous', 'agent-needs-go', 'human-only', 'Defect', 'Improvement', 'Feature', 'Discovered', 'human-architected', 'status:not-started', 'status:in-progress', 'status:in-review', 'area:web', 'area:api']) assert.ok(names.includes(n), n);
    assert.equal(new Set(names).size, names.length);
    for (const l of labelSet(CFG)) assert.match(l.color, /^[0-9a-f]{6}$/);
  });

  test('project mode makes no status labels; each command targets the tracker repo and updates in place', () => {
    assert.ok(!labelSet(PROJECT).some((l) => l.name.startsWith('status:')));
    for (const args of labelCommands(CFG)) {
      assert.deepEqual(args.slice(0, 2), ['label', 'create']);
      assert.equal(args[args.indexOf('--repo') + 1], 'acme/tracker');
      assert.ok(args.includes('--force'));
    }
  });
});
