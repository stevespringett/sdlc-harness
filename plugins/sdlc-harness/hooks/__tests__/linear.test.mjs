// Tests for the Linear tracker (decision 0011): the config, the adapter that
// turns saved Linear MCP output into what policy.mjs reads, the hook's guard on
// Linear MCP writes, Linear's closing words, the session-start text, and label
// setup. The fixtures have the shapes the Linear MCP tools return.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPerson, normalizeConfig } from '../lib.mjs';
import { adapterFor, parseCommand, run } from '../tracker.mjs';
import { assigned, inbox, issue, notificationIssue, parseId, statusOf, whoami } from '../trackers/linear.mjs';
import { checkIssue, owner } from '../policy.mjs';
import { linearVerdict } from '../pre-push.mjs';
import { closingKeyword, issuePrefixOf } from '../git-pre-push.mjs';
import { OUTPUT_LIMIT, renderRepo, trackerText, watchText } from '../session-start.mjs';
import { labelSet, linearLabelCalls } from '../setup-labels.mjs';

const LEAD = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const WRITER = '33333333-3333-4333-8333-333333333333';

const RAW = {
  approvers: [{ login: 'lead', id: LEAD }],
  agent: { login: 'claude', id: AGENT },
  tracker: { kind: 'linear', team: 'ENG' },
  area: 'web',
  areas: ['web', 'api'],
  defaultArea: 'web',
  policyStart: '2026-01-01T00:00:00Z',
};
const CFG = normalizeConfig(RAW);

const INTENT = '## Problem\nx\n## Outcome\ny\n## Constraints\nnone known';

/** get_issue's output, as the Linear MCP tool returns it. */
const rawIssue = (over = {}) => ({
  id: 'ENG-12',
  uuid: 'd7a01b10-b260-44da-8e59-28e27d34cf1e',
  title: 'Dates parse in every locale',
  description: INTENT,
  url: 'https://linear.app/acme/issue/ENG-12/dates-parse-in-every-locale',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  status: 'Backlog',
  statusType: 'backlog',
  labels: ['Defect', 'area:web'],
  createdBy: 'Pat Writer',
  createdById: WRITER,
  assignee: 'Claude Code',
  assigneeId: AGENT,
  parentId: null,
  team: 'Engineering',
  teamId: 'c69518f4-c63b-4f4b-af6a-685ab27005b5',
  ...over,
});

/** One of list_comments' comments. */
const comment = (authorId, name, body, createdAt, updatedAt = createdAt) => ({ id: `c-${createdAt}`, body, createdAt, updatedAt, parentId: null, author: { id: authorId, name }, onBehalfOf: null });
const SPEC = comment(AGENT, 'Claude Code', '## Spec\n- [ ] dates parse', '2026-10-01T10:00:00.000Z', '2026-10-01T09:59:59.980Z');
const YES = comment(LEAD, 'Lead Person', 'approved', '2026-10-01T11:00:00.000Z');

const read = (comments, over = {}, children = 0) => issue(CFG, 'ENG-12', { issue: rawIssue(over), comments, children });

describe('config', () => {
  test('a Linear tracker takes its team key as the prefix and needs no repo', () => {
    assert.deepEqual(CFG.problems, []);
    assert.equal(CFG.tracker.kind, 'linear');
    assert.equal(CFG.tracker.team, 'ENG');
    assert.equal(CFG.tracker.repo, null);
    assert.equal(CFG.issuePrefix, 'ENG');
    assert.equal(issuePrefixOf(RAW), 'ENG', 'the push judge reads the raw config the same way');
    assert.deepEqual(CFG.tracker.allowedOwners, ['eng']);
  });

  test('no team, a prefix that is not the team key, or a GitHub-style person is a problem', () => {
    assert.ok(normalizeConfig({ ...RAW, tracker: { kind: 'linear' } }).problems.some((p) => p.includes('tracker.team')));
    assert.ok(normalizeConfig({ ...RAW, issuePrefix: 'GH' }).problems.some((p) => p.includes('not the Linear team key')));
    assert.ok(normalizeConfig({ ...RAW, agent: { login: 'claude', id: 7 } }).problems.some((p) => p.includes('UUID')));
    assert.ok(normalizeConfig({ ...RAW, approvers: [{ login: 'claude', id: AGENT }] }).problems.some((p) => p.includes('also an approver')));
  });

  test('a Linear member matches by UUID alone, never by name', () => {
    const lead = CFG.approvers[0];
    assert.equal(isPerson({ login: 'someone-else', id: LEAD.toUpperCase() }, lead), true);
    assert.equal(isPerson({ login: 'lead', id: WRITER }, lead), false);
    assert.equal(isPerson('lead', lead), false);
  });

  test('GitHub configs are unchanged', () => {
    const gh = normalizeConfig({ approvers: [{ login: 'octo-lead', id: 101 }], agent: { login: 'acme-bot', id: 303 }, tracker: { repo: 'acme/tracker' } });
    assert.deepEqual(gh.problems, []);
    assert.equal(gh.tracker.kind, 'github');
    assert.equal(gh.issuePrefix, 'GH');
    assert.equal(isPerson({ login: 'octo-lead', id: 101 }, gh.approvers[0]), true);
  });
});

describe('the Linear adapter', () => {
  test('ids are this team\'s only', () => {
    assert.equal(parseId('12', CFG), 'ENG-12');
    assert.equal(parseId('eng-12', CFG), 'ENG-12');
    for (const bad of ['GH-12', 'DES-12', '#12', '0', '']) assert.throws(() => parseId(bad, CFG), /not an issue id in team ENG/, bad);
  });

  test('status: configured names first, then the state type; completed and canceled are closed', () => {
    assert.equal(statusOf('Todo', 'unstarted', CFG), 'not-started');
    assert.equal(statusOf('In Progress', 'started', CFG), 'in-progress');
    assert.equal(statusOf('In Review', 'started', CFG), 'in-review');
    assert.equal(statusOf('Building', 'started', CFG), 'in-progress', 'an unnamed started state counts toward the limit');
    assert.equal(statusOf('Done', 'completed', CFG), 'done');
    assert.equal(statusOf('Duplicate', 'canceled', CFG), 'canceled');
    assert.equal(statusOf('Triage', 'triage', CFG), 'backlog');
  });

  test('an issue reads in the shape policy.mjs reads, with configured people by login', () => {
    const i = read([YES, SPEC]);
    assert.equal(i.identifier, 'ENG-12');
    assert.equal(i.number, 12);
    assert.equal(i.state, 'open');
    assert.equal(i.status, 'backlog');
    assert.deepEqual(i.assignees, ['claude']);
    assert.equal(i.author.id, WRITER);
    assert.deepEqual(i.comments.map((c) => c.author.login), ['claude', 'lead'], 'comments sorted by time');
    assert.equal(i.comments[0].lastEditedAt, null, 'an update a few ms off its creation is not an edit');
  });

  test('approval works end to end through the policy: a Spec by the agent, then the approver\'s line', () => {
    assert.equal(checkIssue({ ...read([SPEC, YES]), model: 'm' }, CFG).approved, true);
    assert.equal(checkIssue({ ...read([SPEC]), model: 'm' }, CFG).approved, false);
    const fromWriter = comment(WRITER, 'Pat Writer', 'approved', '2026-10-01T11:00:00.000Z');
    assert.equal(checkIssue({ ...read([SPEC, fromWriter]), model: 'm' }, CFG).approved, false, 'only an approver approves');
    const sameName = { ...YES, author: { id: WRITER, name: 'Lead Person' } };
    assert.equal(checkIssue({ ...read([SPEC, sameName]), model: 'm' }, CFG).approved, false, 'a name is not an identity');
    const specEditedAfter = { ...SPEC, updatedAt: '2026-10-01T12:00:00.000Z' };
    assert.equal(checkIssue({ ...read([specEditedAfter, YES]), model: 'm' }, CFG).approved, false, 'a Spec edited after the approval drops it');
  });

  test('approval fails closed on a Linear config that names people without UUIDs (QA finding)', () => {
    const loose = normalizeConfig({ ...RAW, approvers: ['lead'] });
    assert.ok(loose.problems.length > 0);
    const yesFromAnyLead = comment(WRITER, 'Lead', 'approved', '2026-10-01T11:00:00.000Z');
    const i = issue(loose, 'ENG-12', { issue: rawIssue(), comments: [SPEC, yesFromAnyLead], children: 0 });
    assert.equal(checkIssue({ ...i, model: 'm' }, loose).approved, false);
  });

  test('a refused issue hands back to a Linear member by UUID', () => {
    const r = checkIssue({ ...read([], { description: 'no intent here' }), model: 'm' }, CFG);
    assert.equal(r.assignTo, LEAD);
  });

  test('a state with no known type is refused, and the configured Done name reads as done (QA finding)', () => {
    assert.throws(() => statusOf('Done', undefined, CFG), /no known statusType/);
    assert.throws(() => statusOf('Weird', 'mystery', CFG), /no known statusType/);
    assert.equal(statusOf('Done', 'started', CFG), 'done');
  });

  test('every issue in the agent\'s list counts as the agent\'s, so a missing assigneeId never passes the limit (QA finding)', () => {
    const list = [rawIssue({ id: 'ENG-1', status: 'In Progress', statusType: 'started', assigneeId: undefined, assignee: undefined })];
    assert.equal(run(CFG, parseCommand(['inflight']), adapterFor(CFG), { input: list }).count, 1);
  });

  test('a missing comments list or children count is refused, not guessed', () => {
    assert.throws(() => issue(CFG, 'ENG-12', { issue: rawIssue(), children: 0 }), /no comments list/);
    assert.throws(() => issue(CFG, 'ENG-12', { issue: rawIssue(), comments: [] }), /no children count/);
    assert.throws(() => issue(CFG, 'ENG-13', { issue: rawIssue(), comments: [], children: 0 }), /not ENG-13/);
  });

  test('a parent issue reads as one', () => {
    assert.equal(read([], {}, 3).subIssues, 3);
  });

  test('the agent\'s issues feed the in-flight count and the queue', () => {
    const list = [
      rawIssue({ id: 'ENG-1', status: 'In Progress', statusType: 'started' }),
      rawIssue({ id: 'ENG-2', status: 'In Progress', statusType: 'started', labels: ['area:api'] }),
      rawIssue({ id: 'ENG-3', status: 'Done', statusType: 'completed' }),
      rawIssue({ id: 'DES-4', status: 'In Progress', statusType: 'started' }),
      rawIssue({ id: 'ENG-5', status: 'Todo', statusType: 'unstarted', labels: ['agent-fully-autonomous', 'area:web'] }),
    ];
    const a = adapterFor(CFG);
    const flight = run(CFG, parseCommand(['inflight']), a, { input: list });
    assert.deepEqual(flight.counted, [1]);
    assert.equal(flight.others, 1);
    const queue = run(CFG, parseCommand(['queue']), a, { input: list });
    assert.deepEqual(queue.map((q) => q.identifier), ['ENG-1', 'ENG-5']);
    assert.equal(queue[1].autonomy, 'agent-fully-autonomous');
    assert.equal(assigned(CFG, list).length, 4, 'another team\'s issue is not this tracker\'s');
  });

  test('the inbox keeps unread notifications and names each one\'s issue', () => {
    const n = (id, url, readAt = null) => ({ id, type: 'issueNewComment', title: 't', url, createdAt: '2026-10-26T19:53:42.823Z', updatedAt: '2026-10-26T19:54:28.636Z', readAt, archivedAt: null });
    const box = inbox(CFG, [n('a', 'https://linear.app/acme/issue/ENG-559/free-trial'), n('b', 'https://linear.app/acme/issue/ENG-560/x', '2026-10-26T19:54:28Z'), n('c', 'https://linear.app/acme/project/p-1')]);
    assert.deepEqual(box.map((x) => [x.thread, x.issue, x.mine]), [['a', 'ENG-559', false], ['c', null, true]]);
    assert.equal(notificationIssue('https://linear.app/acme/issue/DES-1/x', CFG), null);
  });

  test('whoami reads get_user "me" and refuses an approver or another member', () => {
    assert.equal(whoami(CFG, { id: AGENT, displayName: 'claude' }).ok, true);
    assert.match(whoami(CFG, { id: LEAD, displayName: 'lead' }).reason, /logged in as an approver/);
    assert.equal(whoami(CFG, { id: WRITER, displayName: 'pat' }).ok, false);
    assert.throws(() => whoami(CFG, {}), /get_user/);
  });

  test('a write is not this helper\'s: it names the Linear MCP call to make', () => {
    const a = adapterFor(CFG);
    assert.throws(() => run(CFG, parseCommand(['state', 'ENG-12', 'in-review']), a), /save_issue with id and state/);
    assert.throws(() => run(CFG, parseCommand(['label', '12', '--add', 'Defect']), a), /addLabels or removeLabels/);
    assert.throws(() => run(CFG, parseCommand(['read', 'abc']), a), /mark_notification/);
    assert.throws(() => run(CFG, parseCommand(['comment', 'ENG-12', 'missing.md']), a), /save_comment/, 'the MCP call, not a file error');
  });

  test('ownership reads Linear labels like GitHub labels', () => {
    assert.equal(owner(read([]), CFG).mine, true);
    assert.equal(owner(read([], { labels: ['area:api'] }), CFG).owner, 'api');
  });
});

describe('the hook on Linear MCP writes', () => {
  const v = (action, input) => linearVerdict(`mcp__claude_ai_Linear__${action}`, input, CFG);

  test('reads, comments, and allowed issue changes pass', () => {
    assert.equal(v('get_issue', { id: 'ENG-12' }), null);
    assert.equal(v('list_comments', { issueId: 'ENG-12' }), null);
    assert.equal(v('save_comment', { issueId: 'ENG-12', body: 'x' }), null);
    assert.equal(v('save_issue', { id: 'ENG-12', state: 'In Review' }), null);
    assert.equal(v('save_issue', { id: 'ENG-12', state: 'started' }), null);
    assert.equal(v('save_issue', { id: 'ENG-12', addLabels: ['agent-needs-go'] }), null);
    assert.equal(v('save_issue', { team: 'ENG', title: 'T', description: INTENT }), null);
    assert.equal(v('mark_notification', { id: 'n', read: true }), null);
  });

  test('Done, Canceled, an unnamed state, and a duplicate are refused: only an approver closes', () => {
    assert.match(v('save_issue', { id: 'ENG-12', state: 'Done' }), /only an approver/);
    assert.match(v('save_issue', { id: 'ENG-12', state: 'completed' }), /only an approver/);
    assert.match(v('save_issue', { id: 'ENG-12', state: 'Canceled' }), /only an approver/);
    assert.match(v('save_issue', { id: 'ENG-12', state: '6a2f-uuid' }), /cannot name/);
    assert.match(v('save_issue', { id: 'ENG-12', duplicateOf: 'ENG-3' }), /duplicate/);
    assert.match(v('save_issue', { id: 'ENG-12', delegate: 'Linear' }), /another agent/);
    assert.match(v('save_issue', { team: 'ENG', title: 'T', template: 'Bug' }), /template/);
  });

  test('an issue filed or moved outside the team is refused', () => {
    assert.match(v('save_issue', { team: 'DES', title: 'T' }), /only in team ENG/);
    assert.match(v('save_issue', { title: 'T' }), /only in team ENG/);
    assert.match(v('save_issue', { id: 'ENG-12', team: 'DES' }), /another team/);
  });

  test('every other Linear write is refused', () => {
    for (const a of ['delete_comment', 'delete_attachment', 'save_project', 'save_initiative', 'save_document', 'merge_diff', 'save_status_update', 'retire_issue_label']) assert.match(v(a, {}), /not one of the Linear writes/, a);
  });
});

describe('Linear\'s closing words', () => {
  test('every closing form before the team id is refused; linking words pass', () => {
    for (const l of ['Fixes ENG-12', 'fixing ENG-12', 'Closes: ENG-12', 'closing ENG-12', 'Resolves ENG-12', 'resolving ENG-12', 'Completes ENG-12', 'completed ENG-12', 'Implements ENG-12', 'implementing ENG-12']) assert.ok(closingKeyword(l, 'ENG', 'linear'), l);
    for (const l of ['Refs ENG-12', 'Part of ENG-12', 'ENG-12: dates parse', 'Related to ENG-12', 'Implement the parser']) assert.equal(closingKeyword(l, 'ENG', 'linear'), null, l);
  });

  test('GitHub\'s rules for #12 are unchanged', () => {
    assert.ok(closingKeyword('Fixes #12'));
    assert.equal(closingKeyword('Implements #12'), null);
    assert.equal(closingKeyword('Fixing #12'), null);
    assert.ok(closingKeyword('Fixes GH-12', 'GH'));
    assert.equal(closingKeyword('Implement GH-12 parser', 'GH'), null, 'GitHub ignores Linear\'s words');
    assert.equal(closingKeyword('Completing GH-3', 'GH'), null);
  });
});

describe('session start and label setup', () => {
  test('the tracker text names every operation as a Linear MCP call', () => {
    const text = trackerText(CFG).join('\n');
    for (const op of ['whoami:', 'issue <id>', 'state <id>', 'comment <id>', 'label <id>', 'assign <id>', 'title <id>', 'create', 'sub <parent>', 'search <words>', 'labels:', 'inflight, queue', 'inbox:', 'read <thread>']) assert.ok(text.includes(op), op);
    assert.match(text, /Linear team ENG, through the Linear MCP connector/);
    assert.match(text, /Never Done or Canceled/);
    assert.match(watchText(CFG).join('\n'), /runs the Linear watch for area "web" in team ENG/);
  });

  test('a heavy Linear config\'s repo text stays under the hook-output cap (decision 0008)', () => {
    const heavy = normalizeConfig({
      ...RAW,
      approvers: [1, 2, 3].map((n) => ({ login: `approver-number-${n}`, id: `${n}1111111-1111-4111-8111-111111111111` })),
      protectedPaths: Array.from({ length: 20 }, (_, i) => `services/area-${i}/migrations/`),
      testCommand: Array.from({ length: 12 }, (_, i) => `node --test packages/module-${i}/__tests__/*.test.mjs || exit 1`).join('; '),
      adhdStyle: true,
    });
    const out = renderRepo(`/Users/someone/${'deep-path-'.repeat(8)}/repo`, heavy, { install: () => {} });
    assert.ok(out.length <= OUTPUT_LIMIT, `${out.length} characters`);
    assert.match(out, /Linear team ENG/);
  });

  test('a Linear team gets no status labels, and each label is a create_issue_label call', () => {
    const names = labelSet(CFG).map((l) => l.name);
    assert.ok(!names.some((n) => n.startsWith('status:')));
    assert.ok(names.includes('area:api'));
    const calls = linearLabelCalls(CFG);
    assert.ok(calls.every((c) => c.tool === 'create_issue_label' && c.team === 'ENG' && /^#[0-9a-f]{6}$/.test(c.color)));
  });
});
