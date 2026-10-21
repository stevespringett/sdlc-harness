// Tests for the ticket intake, approval, ownership, and in-flight policy. The
// fixtures are the shapes real issues take: Intent bodies with bold
// sub-headings, in-body Spec sections, and "EPIC n —" titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasEpicTerm,
  suggestTitle,
  hasHeading,
  intentMissing,
  specHeadingsFound,
  checkIssue,
  approvedByApprover,
  externalAiComments,
  owner,
  inFlight,
  NOTICE_TAG,
} from '../policy.mjs';
import { normalizeConfig } from '../lib.mjs';

const POLICY = fileURLToPath(new URL('../policy.mjs', import.meta.url));
const NEW = '2026-09-28T10:00:00Z';
const OLD = '2025-12-05T10:00:00Z';
const LEAD = { login: 'octo-lead', id: 101 };
const PAT = { login: 'pat-writer', id: 202 };
const BOT = { login: 'acme-bot', id: 303 };
const RAW = {
  approvers: [LEAD],
  agent: BOT,
  people: [PAT.login],
  policyStart: '2026-01-01T00:00:00Z',
  tracker: { repo: 'acme/tracker' },
  area: 'web',
  areas: ['web', 'api', 'docs'],
  defaultArea: 'web',
};
const CFG = normalizeConfig(RAW);
const check = (issue, cfg = CFG) => checkIssue(issue, cfg);

const INTENT = `## Problem

Cards don't work for new users.

## Outcome

* Every card leads with the next step.

## Constraints

**Publicity and legal**

* No customer logos.

**Timing**

Due Oct 2.

## Not in scope

* The paid tier.`;

const WITH_SPEC = `${INTENT}

## Spec (first slice)

**Acceptance criteria**

- [ ] the card binds NEXT_STEP

**Touches** frontend/src/cards/next-step.js`;

test('epic is matched as a whole word in any case, never inside another word', () => {
  assert.equal(hasEpicTerm('EPIC 6 — Checkout Experience'), true);
  assert.equal(hasEpicTerm('Onboarding epic'), true);
  assert.equal(hasEpicTerm('[Epics] cleanup'), true);
  assert.equal(hasEpicTerm('Map epicenter readout'), false);
  assert.equal(hasEpicTerm('Epicycle animation'), false);
  assert.equal(hasEpicTerm('Search Revamp'), false);
});

test('numbered EPIC titles lose the prefix and keep the rest', () => {
  const cases = [
    ['EPIC 1 — UX Foundation: Design Language for the App', 'UX Foundation: Design Language for the App'],
    ['EPIC 2 — Design System: Visual & Interaction System', 'Design System: Visual & Interaction System'],
    ['EPIC 3 — Onboarding & Personalization', 'Onboarding & Personalization'],
    ['EPIC 4 — Personalized Home Experience', 'Personalized Home Experience'],
    ['EPIC 8 — Admin Workspace (MVP)', 'Admin Workspace (MVP)'],
    ['EPIC 9 — Application Framework & Platform Standards', 'Application Framework & Platform Standards'],
  ];
  for (const [before, after] of cases) assert.equal(suggestTitle(before), after);
});

test('epic in other positions is removed cleanly, and a title that is only "epic" needs a rewrite', () => {
  assert.equal(suggestTitle('[Epic] Admin inbox'), 'Admin inbox');
  assert.equal(suggestTitle('Epic: Admin inbox'), 'Admin inbox');
  assert.equal(suggestTitle('Admin inbox epic'), 'Admin inbox');
  assert.equal(suggestTitle('Admin inbox (epic) and grading'), 'Admin inbox and grading');
  assert.equal(suggestTitle('EPIC 4'), null);
  assert.equal(suggestTitle('Epic'), null);
});

test('a heading is a # line, a bold line, or a bare line; prose and bullets are not', () => {
  assert.equal(hasHeading('## Problem\ntext', 'Problem'), true);
  assert.equal(hasHeading('**Acceptance criteria**\n- [ ] x', 'Acceptance criteria'), true);
  assert.equal(hasHeading('Problem:\ntext', 'Problem'), true);
  assert.equal(hasHeading('Problem is that nothing works.', 'Problem'), false);
  assert.equal(hasHeading('* **Design:** keep it simple', 'Design'), false);
  assert.equal(hasHeading('**Specification tables**', 'Spec', { exact: true }), false);
  assert.equal(hasHeading('**Specification tables**', 'Specification', { exact: true }), false);
});

test('Intent sub-headings that start with a spec word are not a spec', () => {
  const body = `${INTENT}

**Design system**

* Use the app's tokens.

**API compatibility**

* v1 stays.

## Design references

* the Figma file

\`\`\`
Schema
## Spec
\`\`\``;
  assert.deepEqual(specHeadingsFound(body), []);
  assert.deepEqual(specHeadingsFound('## Spec (first slice)\n**Touches** db/\n## Acceptance criteria:'), ['Spec', 'Acceptance criteria', 'Touches']);
});

test('plural and qualified Intent headings count', () => {
  assert.deepEqual(intentMissing('## Problems\nx\n## Desired outcomes\ny\n## Constraints\nnone known'), []);
});

test('an Intent body conforms and carries no spec, bold sub-headings included', () => {
  assert.deepEqual(intentMissing(INTENT), []);
  assert.deepEqual(specHeadingsFound(INTENT), []);
});

test('a body missing Outcome and Constraints is reported with what is missing', () => {
  assert.deepEqual(intentMissing('## Problem\nIt breaks.'), ['Outcome', 'Constraints']);
  assert.deepEqual(intentMissing('Just make search better.'), ['Problem', 'Outcome', 'Constraints']);
});

test('an in-body Spec, Acceptance criteria, and Touches are all detected', () => {
  assert.deepEqual(specHeadingsFound(WITH_SPEC), ['Spec', 'Acceptance criteria', 'Touches']);
});

test('a new conforming issue passes with no notice', () => {
  const v = check({ title: 'Cards lead with the next step', body: INTENT, createdAt: NEW, author: PAT, labels: [] });
  assert.equal(v.blocked, false);
  assert.equal(v.notice, null);
  assert.equal(v.title.hasEpic, false);
});

test('a new issue with a spec in its body is blocked and gets one notice naming the headings', () => {
  const v = check({ title: 'Next-step card', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: [], model: 'Claude Opus 5.5 (claude-opus-5-5)' });
  assert.equal(v.blocked, true);
  assert.match(v.notice, new RegExp(NOTICE_TAG.replace(/[()]/g, '\\$&')));
  assert.match(v.notice, /Spec, Acceptance criteria, Touches/);
  assert.equal(v.notice.trim().split('\n').at(-1), 'Claude Opus 5.5 (claude-opus-5-5)');
});

test('with no model line given, the notice ends with the way back', () => {
  const v = check({ title: 'x', body: 'do it', createdAt: NEW, labels: [] });
  assert.match(v.notice.trim().split('\n').at(-1), /assign the issue back to @acme-bot/);
});

test('an issue failing both rules gets a single combined notice', () => {
  const v = check({ title: 'Do the thing', body: '## Spec\n**Touches** db/', createdAt: NEW, labels: [] });
  assert.equal(v.blocked, true);
  assert.match(v.notice, /Not in the Intent shape/);
  assert.match(v.notice, /The body carries a spec/);
});

test('the notice is never posted twice: an agent comment carrying the tag suppresses it', () => {
  const comments = [{ author: BOT, body: `**${NOTICE_TAG}**\n\nThe agent will not pick this issue up yet.`, createdAt: NEW }];
  const v = check({ title: 'Do the thing', body: 'make it work', createdAt: NEW, labels: [], comments });
  assert.equal(v.blocked, true);
  assert.equal(v.noticePosted, true);
  assert.equal(v.notice, null);
});

test('the tag quoted by someone else does not count as the notice', () => {
  const comments = [{ author: PAT, body: `quoting: ${NOTICE_TAG}`, createdAt: NEW }];
  const v = check({ title: 'Do the thing', body: 'make it work', createdAt: NEW, labels: [], comments });
  assert.notEqual(v.notice, null);
});

test('human-architected lifts the spec rule when an approver created the issue', () => {
  const v = check({ title: 'Next-step card', body: WITH_SPEC, createdAt: NEW, author: LEAD, labels: ['human-architected'] });
  assert.equal(v.spec.architectedByApprover, true);
  assert.deepEqual(v.spec.found, []);
  assert.equal(v.blocked, false);
});

test('human-architected lifts the spec rule when an approver says so in a comment on an issue they did not create', () => {
  const comments = [{ author: LEAD, body: 'The design is mine.\nhuman-architected', createdAt: NEW }];
  const v = check({ title: 'Next-step card', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments });
  assert.equal(v.blocked, false);
});

test('human-architected applied by anyone else is ignored', () => {
  const comments = [{ author: PAT, body: 'human-architected', createdAt: NEW }];
  const v = check({ title: 'Next-step card', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments });
  assert.equal(v.spec.architectedByApprover, false);
  assert.equal(v.blocked, true);
});

test("an approver's human-architected comment edited by someone else does not grant trust", () => {
  const comments = [{ author: LEAD, body: 'human-architected', createdAt: NEW, lastEditedAt: '2026-09-28T12:00:00Z', editor: PAT }];
  assert.equal(check({ title: 'x', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments }).blocked, true);
});

test('human-architected stops counting once anyone but an approver edits the body', () => {
  const vouched = [{ author: LEAD, body: 'human-architected', createdAt: NEW }];
  const base = { title: 'x', body: WITH_SPEC, createdAt: NEW, labels: ['human-architected'] };
  assert.equal(check({ ...base, author: LEAD, lastEditedAt: '2026-09-29T00:00:00Z', editor: PAT }).blocked, true, 'approver-written body edited by someone else');
  assert.equal(check({ ...base, author: PAT, comments: vouched, lastEditedAt: '2026-09-29T00:00:00Z', editor: PAT }).blocked, true, 'vouched body edited after');
  assert.equal(check({ ...base, author: PAT, comments: vouched, lastEditedAt: '2026-09-29T00:00:00Z', editor: null }).blocked, true, 'editor unknown');
  assert.equal(check({ ...base, author: LEAD, lastEditedAt: '2026-09-29T00:00:00Z', editor: LEAD }).blocked, false, 'edited by an approver');
});

test('human-architected does not excuse a missing Intent shape', () => {
  const v = check({ title: 'x', body: '## Spec\nbuild it', createdAt: NEW, author: LEAD, labels: ['human-architected'] });
  assert.deepEqual(v.intent.missing, ['Problem', 'Outcome', 'Constraints']);
  assert.equal(v.blocked, true);
});

test('issues created before policyStart are grandfathered for intent and spec, but not for epic titles', () => {
  const v = check({ title: 'EPIC 6 — Checkout Experience', body: WITH_SPEC.replace(/## (Problem|Outcome|Constraints)/g, ''), createdAt: OLD, labels: [] });
  assert.equal(v.grandfathered, true);
  assert.equal(v.blocked, false);
  assert.equal(v.notice, null);
  assert.equal(v.title.rename, 'Checkout Experience');
});

test('with no policyStart in the config, every issue is in force', () => {
  const cfg = normalizeConfig({ ...RAW, policyStart: undefined });
  assert.equal(check({ title: 'x', body: 'do it', createdAt: OLD }, cfg).grandfathered, false);
});

test('a missing or unparseable createdAt enforces the rules', () => {
  assert.equal(check({ title: 'x', body: 'do it', createdAt: 'garbage' }).blocked, true);
  assert.equal(check({ title: 'x', body: 'do it' }).blocked, true);
});

test('an approver counts by login (and id, when the config gives one), and "not human-architected" does not trust the label', () => {
  const sameLoginOtherId = [{ author: { login: 'octo-lead', id: 999 }, body: 'human-architected', createdAt: NEW }];
  assert.equal(check({ title: 'x', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments: sameLoginOtherId }).blocked, true);
  const negated = [{ author: LEAD, body: 'This is not human-architected yet.', createdAt: NEW }];
  assert.equal(check({ title: 'x', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments: negated }).blocked, true);
});

test('a refused issue leaves the queue: assigned to its human creator, or to the first approver when the agent created it', () => {
  assert.equal(check({ title: 'x', body: 'do it', createdAt: NEW, author: PAT }).assignTo, 'pat-writer');
  assert.equal(check({ title: 'x', body: 'do it', createdAt: NEW, author: BOT }).assignTo, 'octo-lead');
  assert.equal(check({ title: 'x', body: INTENT, createdAt: NEW, author: BOT, subIssues: 2 }).assignTo, 'octo-lead');
  assert.equal(check({ title: 'x', body: INTENT, createdAt: NEW, author: PAT }).assignTo, null);
});

test('a refused issue from an unknown creator goes to the first approver', () => {
  assert.equal(check({ title: 'x', body: 'do it', createdAt: NEW, author: { login: 'outside-agent', id: 5 } }).assignTo, 'octo-lead');
});

test('the notice tells the creator to assign the issue back to the agent', () => {
  assert.match(check({ title: 'x', body: 'do it', createdAt: NEW }).notice, /assign the issue back to @acme-bot/);
});

test('long whitespace runs are checked in time proportional to their length', () => {
  const pad = ' '.repeat(50000);
  const start = Date.now();
  specHeadingsFound(`## Spec${pad}x\n**Spec${pad}x\nSpec${pad}x`);
  intentMissing(`## Problem${pad}x`);
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

test('numbered and suffixed spec headings are caught', () => {
  const body = '## 1. Problem\nx\n## 2. Outcome\ny\n## 3. Constraints\nz\n## 4. Acceptance Criteria\n- [ ] a\n## 5. Implementation Plan\n1. b';
  assert.deepEqual(intentMissing(body), []);
  assert.deepEqual(specHeadingsFound(body), ['Acceptance criteria', 'Implementation plan']);
  assert.deepEqual(specHeadingsFound('## Implementation: use Redis\n## Spec — v2'), ['Spec', 'Implementation']);
});

test('fences close only on a matching bare marker, and an unclosed fence hides the rest', () => {
  assert.deepEqual(specHeadingsFound('```\n## Spec'), []);
  assert.deepEqual(specHeadingsFound('```\na\n```js\n## Spec\n```'), []);
  assert.deepEqual(specHeadingsFound('````\n```\n## Spec\n```\n````'), []);
  assert.deepEqual(specHeadingsFound('```\ncode\n```\n## Spec'), ['Spec']);
});

test('a null date enforces, a singular Constraint heading counts', () => {
  assert.equal(check({ title: 'x', body: 'do it', createdAt: null }).grandfathered, false);
  assert.deepEqual(intentMissing('## Problem\nx\n## Outcome\ny\n## Constraint\nnone known'), []);
});

test('only a comment line that is exactly the label grants trust', () => {
  const trust = (body) => check({ title: 'x', body: WITH_SPEC, createdAt: NEW, author: PAT, labels: ['human-architected'], comments: [{ author: LEAD, body, createdAt: NEW }] }).blocked === false;
  assert.equal(trust('human-architected'), true);
  assert.equal(trust('Reviewed the design.\nhuman-architected'), true);
  assert.equal(trust('Should this be human-architected?'), false);
  assert.equal(trust('Do not label this human-architected'), false);
});

test('an inline-code line is not a fence and hides nothing', () => {
  assert.deepEqual(specHeadingsFound(`${INTENT}\n\n\`\`\`js\`\`\` is how we call it\n\n## Implementation plan\n1. x`), ['Implementation plan']);
});

test('hyphenated words are not separators; dotted, bold, and plain numbered headings are caught', () => {
  assert.deepEqual(specHeadingsFound('## Implementation-agnostic constraints\n## Spec-compliant output'), []);
  assert.deepEqual(specHeadingsFound('## 5.1 Implementation plan'), ['Implementation plan']);
  assert.deepEqual(specHeadingsFound('**5. Implementation plan**'), ['Implementation plan']);
  assert.deepEqual(specHeadingsFound('**Implementation: use Redis**'), ['Implementation']);
  assert.deepEqual(specHeadingsFound('Implementation plan: use Redis'), ['Implementation plan']);
});

test('huge unclosed bold lines stay fast, and a non-string date enforces', () => {
  const start = Date.now();
  intentMissing('**' + ' Problem'.repeat(150000));
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  assert.equal(check({ title: 'x', body: 'do it', createdAt: 0 }).grandfathered, false);
});

test('padding cannot push a heading name past the line cap', () => {
  assert.deepEqual(specHeadingsFound(`##${' '.repeat(3000)}Implementation`), ['Implementation']);
  assert.deepEqual(specHeadingsFound(`**${' '.repeat(3000)}Spec**`), ['Spec']);
});

test('an issue with sub-issues is a parent and is never specced or built', () => {
  assert.equal(check({ title: 'Checkout Experience', body: INTENT, createdAt: NEW, subIssues: 3 }).parent, true);
  assert.equal(check({ title: 'Checkout Experience', body: INTENT, createdAt: NEW }).parent, false);
});

// ---- approval and acceptance belong to the approvers alone -----------------
// A status label, an "approved" from another account, an edit by someone
// else, or a relayed approval never counts.

const SPEC_BY_AGENT = { author: BOT, body: '## Spec\n**Acceptance criteria**\n- [ ] x\n\nClaude Opus 5.5 (claude-opus-5-5)', createdAt: '2026-09-28T10:00:00Z' };
const comment = (who, body, at, extra = {}) => ({ author: who, body, createdAt: at, ...extra });
const approved = (issue, cfg = CFG) => approvedByApprover(issue, cfg);

test('a line of only "approved" or "go" from an approver after the latest Spec approves the issue', () => {
  for (const word of ['approved', 'Approved.', 'go', 'Go!', '  approve  ']) {
    const issue = { comments: [SPEC_BY_AGENT, comment(LEAD, word, '2026-09-28T11:00:00Z')] };
    assert.equal(approved(issue), true, word);
  }
});

test('logins compare without case, as GitHub does', () => {
  const issue = { comments: [SPEC_BY_AGENT, comment({ login: 'Octo-Lead', id: 101 }, 'approved', '2026-09-28T11:00:00Z')] };
  assert.equal(approved(issue), true);
});

test('no one but an approver approves: another person, the agent, or a look-alike account never counts', () => {
  for (const who of [PAT, BOT, { login: 'octo-lead', id: 102 }, { login: 'octo-lead-2', id: 101 }]) {
    const issue = { comments: [SPEC_BY_AGENT, comment(who, 'approved', '2026-09-28T11:00:00Z')] };
    assert.equal(approved(issue), false, `${who.login}/${who.id}`);
  }
});

test('an approver given by login alone matches that login', () => {
  const cfg = normalizeConfig({ ...RAW, approvers: ['octo-lead'] });
  assert.equal(approved({ comments: [SPEC_BY_AGENT, comment({ login: 'octo-lead', id: 999 }, 'go', '2026-09-28T11:00:00Z')] }, cfg), true);
});

test('any of several approvers approves', () => {
  const cfg = normalizeConfig({ ...RAW, approvers: [LEAD, 'second-lead'] });
  assert.equal(approved({ comments: [SPEC_BY_AGENT, comment({ login: 'second-lead', id: 7 }, 'approved', '2026-09-28T11:00:00Z')] }, cfg), true);
});

test('an approval before the latest Spec does not approve the revised Spec', () => {
  const issue = { comments: [comment(LEAD, 'approved', '2026-09-28T09:00:00Z'), SPEC_BY_AGENT] };
  assert.equal(approved(issue), false);
});

test('a Spec edited after the approval drops it', () => {
  const edited = { ...SPEC_BY_AGENT, lastEditedAt: '2026-09-28T12:00:00Z', editor: BOT };
  assert.equal(approved({ comments: [edited, comment(LEAD, 'approved', '2026-09-28T11:00:00Z')] }), false);
  assert.equal(approved({ comments: [edited, comment(LEAD, 'approved', '2026-09-28T13:00:00Z')] }), true, 'an approval after the edit counts');
});

test('an approval comment edited by anyone but an approver does not count', () => {
  const byOther = comment(LEAD, 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: '2026-09-28T11:05:00Z', editor: PAT });
  const byNobodyKnown = comment(LEAD, 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: '2026-09-28T11:05:00Z', editor: null });
  const bySelf = comment(LEAD, 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: '2026-09-28T11:05:00Z', editor: LEAD });
  assert.equal(approved({ comments: [SPEC_BY_AGENT, byOther] }), false);
  assert.equal(approved({ comments: [SPEC_BY_AGENT, byNobodyKnown] }), false);
  assert.equal(approved({ comments: [SPEC_BY_AGENT, bySelf] }), true);
});

test('a sentence that only mentions approval is not an approval', () => {
  for (const body of ['not approved yet', 'approved if pat agrees', 'go ahead and ask pat first', 'pat approved this']) {
    const issue = { comments: [SPEC_BY_AGENT, comment(LEAD, body, '2026-09-28T11:00:00Z')] };
    assert.equal(approved(issue), false, body);
  }
});

test('with no Spec comment by the agent there is nothing to approve, whatever an approver wrote', () => {
  assert.equal(approved({ comments: [comment(LEAD, 'go', '2026-09-28T11:00:00Z')] }), false);
  assert.equal(approved({ comments: [comment(BOT, '### Spec\nx', '2026-09-28T10:00:00Z'), comment(LEAD, 'go', '2026-09-28T11:00:00Z')] }), false, 'a heading the helper does not read as a Spec');
  assert.equal(approved({ comments: [] }), false);
  assert.equal(approved({}), false);
});

test('a bot agent is matched by its login and its type, as GraphQL reports it, and never by a user of the same name', () => {
  const cfg = normalizeConfig({ ...RAW, agent: 'acme-app[bot]' });
  const spec = (author) => ({ comments: [comment(author, '## Spec\nx', '2026-09-28T10:00:00Z'), comment(LEAD, 'approved', '2026-09-28T11:00:00Z')] });
  assert.equal(approved(spec({ login: 'acme-app', id: 9, type: 'Bot' }), cfg), true, 'GraphQL drops the [bot] suffix');
  assert.equal(approved(spec({ login: 'acme-app[bot]', id: 9 }), cfg), true, 'REST keeps it');
  assert.equal(approved(spec({ login: 'acme-app', id: 10, type: 'User' }), cfg), false, 'a user named like the app');
  assert.equal(approved({ comments: [SPEC_BY_AGENT, comment({ login: 'octo-lead', id: 101, type: 'Bot' }, 'approved', '2026-09-28T11:00:00Z')] }), false, 'a bot named like an approver');
});

test('approval fails closed when any comment has no valid date or a broken edit date', () => {
  const spec = { author: BOT, body: '## Spec\nx' };
  assert.equal(approved({ comments: [spec, { author: LEAD, body: 'approved' }] }), false);
  assert.equal(approved({ comments: [SPEC_BY_AGENT, { author: LEAD, body: 'approved', createdAt: 'not a date' }] }), false);
  assert.equal(approved({ comments: [SPEC_BY_AGENT, comment(LEAD, 'approved', '2026-09-28T11:00:00Z', { lastEditedAt: 'garbage', editor: LEAD })] }), false);
});

test('comments listed newest first are still read in time order', () => {
  const issue = { comments: [comment(LEAD, 'go', '2026-09-28T11:00:00Z'), SPEC_BY_AGENT] };
  assert.equal(approved(issue), true);
});

test("only the agent's own account marks a Spec: a look-alike login does not move the anchor", () => {
  const fake = { author: { login: 'acme-bot', id: 999 }, body: '## Spec\nfake', createdAt: '2026-09-28T12:00:00Z' };
  const issue = { comments: [SPEC_BY_AGENT, comment(LEAD, 'approved', '2026-09-28T11:00:00Z'), fake] };
  assert.equal(approved(issue), true);
});

test('nothing is approved while the agent account is also an approver, or no approver or agent is set', () => {
  const issue = { comments: [SPEC_BY_AGENT, comment(LEAD, 'approved', '2026-09-28T11:00:00Z')] };
  const both = normalizeConfig({ ...RAW, approvers: [LEAD, 'acme-bot'] });
  assert.equal(approved(issue, both), false);
  assert.match(both.problems.join(' '), /also an approver/);
  assert.equal(approved(issue, normalizeConfig({ ...RAW, approvers: [] })), false);
  assert.equal(approved(issue, normalizeConfig({ ...RAW, agent: undefined })), false);
  assert.match(checkIssue({ title: 'x', body: INTENT, createdAt: NEW, ...issue }, both).problems.join(' '), /also an approver/);
});

test('the verdict carries approved, and the status of the issue plays no part in it', () => {
  const base = { title: 'x', body: INTENT, createdAt: NEW, author: PAT, labels: [], subIssues: 0 };
  assert.equal(check({ ...base, comments: [SPEC_BY_AGENT] }).approved, false);
  assert.equal(check({ ...base, labels: ['status:not-started'], status: 'not-started', comments: [SPEC_BY_AGENT] }).approved, false);
  assert.equal(check({ ...base, comments: [SPEC_BY_AGENT, comment(LEAD, 'approved', '2026-09-28T11:00:00Z')] }).approved, true);
});

test('comments from another account that read as an outside AI, or come from a bot, are flagged as unconfirmed', () => {
  const relayed = [
    "Recorded by Claude on pat's direction.",
    'pat has approved every option.',
    'Approved by @octo-lead in chat.',
    'Build v75: I rendered the chart in-house.',
    'The file upload is blocked from my environment.',
    'Done.\n\nClaude Opus 5.5 (claude-opus-5-5)',
    '—Claude, 2026-09-12',
  ];
  for (const body of relayed) {
    assert.deepEqual(externalAiComments({ comments: [comment(PAT, body, '2026-09-28T11:00:00Z')] }, CFG), [0], body);
  }
  assert.deepEqual(externalAiComments({ comments: [comment({ login: 'renovate[bot]', id: 9, type: 'Bot' }, 'go', '2026-09-28T11:00:00Z')] }, CFG), [0]);
});

test("plain human replies and the agent's own comments are not flagged", () => {
  const issue = {
    comments: [
      comment(PAT, 'go', '2026-09-28T11:00:00Z'),
      comment(PAT, 'Use the short label below 400px.', '2026-09-28T11:01:00Z'),
      comment(PAT, 'In my environment the page lags.', '2026-09-28T11:01:30Z'),
      comment(PAT, 'I uploaded the recordings to the drive.', '2026-09-28T11:01:40Z'),
      comment(LEAD, 'Authored by Claude. Delegated by me', '2026-09-28T11:02:00Z'),
      comment(BOT, 'Plan\n\nClaude Opus 5.5 (claude-opus-5-5)', '2026-09-28T11:03:00Z'),
    ],
  };
  assert.deepEqual(externalAiComments(issue, CFG), []);
  assert.deepEqual(check({ title: 'x', body: INTENT, createdAt: NEW, author: PAT, labels: [], ...issue }).untrustedComments, []);
});

// ---- ownership: the area label, and nothing else ---------------------------

test("an issue under the repo's own area is mine; under another it is not", () => {
  const api = { labels: ['Feature', 'area:api'] };
  assert.equal(owner(api, CFG, 'api').mine, true);
  assert.equal(owner(api, CFG, 'web').mine, false);
  assert.equal(owner(api, CFG).owner, 'api');
});

test('area labels compare without case and keep their own prefix', () => {
  assert.equal(owner({ labels: ['Area:API'] }, CFG, 'api').mine, true);
  const cfg = normalizeConfig({ ...RAW, areaLabelPrefix: 'team/' });
  assert.equal(owner({ labels: ['team/api'] }, cfg, 'api').mine, true);
  assert.equal(owner({ labels: ['area:api'] }, cfg, 'api').mine, false);
});

test('an issue with no area belongs to the default area, or to no one without one', () => {
  assert.equal(owner({ labels: [] }, CFG, 'web').mine, true);
  assert.equal(owner({ labels: [] }, CFG, 'api').mine, false);
  const noDefault = normalizeConfig({ ...RAW, defaultArea: undefined });
  const v = owner({ labels: [] }, noDefault, 'web');
  assert.equal(v.mine, false);
  assert.equal(v.owner, null);
  assert.match(v.reason, /ask the approver/);
});

test('several area labels belong to the default area when it is among them, and to no one otherwise', () => {
  assert.equal(owner({ labels: ['area:api', 'area:web'] }, CFG, 'web').mine, true);
  assert.equal(owner({ labels: ['area:api', 'area:web'] }, CFG, 'api').mine, false);
  const split = owner({ labels: ['area:api', 'area:docs'] }, CFG, 'api');
  assert.equal(split.mine, false);
  assert.equal(split.owner, null);
});

test('the repo an issue lives in and the files its Spec touches never decide ownership', () => {
  const issue = { repo: 'acme/web', labels: ['area:api'], body: '**Touches** acme/web: src/app.js' };
  assert.equal(owner(issue, CFG, 'web').mine, false);
  assert.equal(owner(issue, CFG, 'api').mine, true);
});

test('ownership fails closed: labels not loaded, or a repo with no area, is never mine', () => {
  assert.equal(owner({}, CFG, 'web').mine, false);
  assert.equal(owner({ labels: [null] }, CFG, 'web').mine, false);
  assert.equal(owner(null, CFG, 'web').mine, false);
  assert.equal(owner('GH-1', CFG, 'web').mine, false);
  assert.equal(owner({ labels: ['area:web'] }, CFG, null).mine, false);
  assert.equal(owner({ labels: ['area:web'] }, CFG, '').mine, false);
});

// ---- in flight: counted per area, against inFlightLimit --------------------

const flight = (number, area, extra = {}) => ({ number, state: 'open', status: 'in-progress', assignees: ['acme-bot'], labels: [`area:${area}`], ...extra });

test("four of the area's own in flight plus any number of others' leaves room: the build starts", () => {
  const issues = [1, 2, 3, 4].map((n) => flight(n, 'web')).concat([10, 11, 12, 13, 14, 15].map((n) => flight(n, 'api')));
  const v = inFlight(issues, CFG);
  assert.equal(v.count, 4);
  assert.equal(v.limit, 5);
  assert.equal(v.full, false);
  assert.deepEqual(v.counted, [1, 2, 3, 4]);
  assert.equal(v.others, 6);
});

test("five of the area's own fills it: the build parks, and the verdict names every issue counted", () => {
  const v = inFlight([5, 3, 1, 4, 2].map((n) => flight(n, 'web')), CFG);
  assert.equal(v.full, true);
  assert.deepEqual(v.counted, [1, 2, 3, 4, 5]);
});

test('only open, In Progress issues assigned to the agent count', () => {
  const issues = [
    flight(1, 'web'),
    flight(2, 'web', { status: 'in-review' }),
    flight(3, 'web', { state: 'closed' }),
    flight(4, 'web', { assignees: ['octo-lead'] }),
    flight(5, 'web', { assignees: ['Acme-Bot'] }),
  ];
  assert.deepEqual(inFlight(issues, CFG).counted, [1, 5]);
});

test('an issue whose owner cannot be told counts against the limit, so missing data never lets it pass', () => {
  const v = inFlight([flight(1, 'web', { labels: undefined }), flight(2, 'web', { labels: ['area:api', 'area:docs'] }), flight(3, 'api')], CFG, 'web');
  assert.deepEqual(v.counted, [1, 2]);
  assert.equal(v.others, 1);
});

test('an issue with no area counts for the default area, by the same owner rule', () => {
  assert.deepEqual(inFlight([flight(1, 'web', { labels: [] })], CFG, 'web').counted, [1]);
  assert.deepEqual(inFlight([flight(1, 'web', { labels: [] })], CFG, 'api').counted, []);
});

test('the limit comes from the config, and a repo with no area counts every area', () => {
  const two = normalizeConfig({ ...RAW, inFlightLimit: 2 });
  assert.equal(inFlight([flight(1, 'web'), flight(2, 'web')], two).full, true);
  const noArea = normalizeConfig({ ...RAW, area: undefined });
  const v = inFlight([flight(1, 'web'), flight(2, 'api')], noArea);
  assert.equal(v.count, 2);
  assert.match(v.reason, /every area counts/);
});

// ---- the CLI ---------------------------------------------------------------

function cliRepo(cfg = RAW) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-policy-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('mkdir', ['-p', join(dir, '.sdlc-harness')]);
  writeFileSync(join(dir, '.sdlc-harness', 'sdlc.json'), JSON.stringify(cfg));
  return dir;
}
const cli = (dir, args, input) => spawnSync(process.execPath, [POLICY, ...args], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });

test('the CLI reads an issue on stdin with the repo config and prints the verdict', () => {
  const r = cli(cliRepo(), ['check'], { title: 'EPIC 3 — Onboarding & Personalization', body: INTENT, createdAt: NEW });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.title.rename, 'Onboarding & Personalization');
  assert.equal(v.blocked, false);
});

test("the CLI's owner and inflight use the repo's area, or the one given", () => {
  const dir = cliRepo();
  assert.equal(JSON.parse(cli(dir, ['owner'], { labels: ['area:web'] }).stdout).mine, true);
  assert.equal(JSON.parse(cli(dir, ['owner', 'api'], { labels: ['area:web'] }).stdout).mine, false);
  const v = JSON.parse(cli(dir, ['inflight'], [flight(1, 'web'), flight(2, 'api')]).stdout);
  assert.deepEqual(v.counted, [1]);
  assert.notEqual(cli(dir, ['owner'], 'not json').status, 0);
});

test('the CLI takes --config outside a managed repo, and refuses with neither', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sdlc-policy-cfg-')), 'sdlc.json');
  writeFileSync(file, JSON.stringify(RAW));
  const r = spawnSync(process.execPath, [POLICY, 'owner', '--config', file], { cwd: tmpdir(), input: JSON.stringify({ labels: ['area:web'] }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mine, true);
  const none = spawnSync(process.execPath, [POLICY, 'owner'], { cwd: tmpdir(), input: '{}', encoding: 'utf8' });
  assert.notEqual(none.status, 0);
});
