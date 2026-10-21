#!/usr/bin/env node
// Ticket intake, approval, ownership, and the in-flight count (decisions
// 0002, 0003, 0007). Pure checks the watch and the skills run on a GitHub
// issue before touching it, so every session on every machine decides the
// same way. RULES.md says when to call it; this file decides.
//
// Intake:
//   1. No title contains the word "epic". suggestTitle() strips it.
//   2. An issue the agent would pick up must be in the Intent shape.
//   3. An issue whose body carries a spec is refused unless an approver
//      applied `human-architected`.
//   Checks 2 and 3 apply only to issues created on or after the config's
//   policyStart. An issue that fails 2 or 3 gets ONE policy notice, ever;
//   NOTICE_TAG in a comment by the agent account means it has been posted.
//
// Approval. `approved` is true only when an approver's own account wrote a
// line that is just "approved" or "go" after the latest `## Spec` comment by
// the agent account, and after its last edit. GitHub lets anyone with write
// access edit any comment, so an edited approval counts only when an approver
// made the edit, and a Spec edited after an approval drops it. The issue's
// state and labels never count. `untrustedComments` lists comments from
// other accounts that read as an outside AI's work (relayed approvals, build
// logs, a model line) or come from a bot; they are input at most.
//
// Ownership. Each issue's area is its one `area:<name>` label, and nothing
// else (not the repo it lives in, not the files its Spec touches). The repo
// whose config names that area owns the issue. The config's defaultArea owns
// an issue with no area label, and one with several when it is among them.
// It fails closed: labels not loaded, or a repo with no area, owns nothing.
//
// In flight: an open issue assigned to the agent whose status is In
// Progress. A repo counts only the issues its own area owns, against the
// config's inFlightLimit (default 5).
//
// CLI (config from the repo the command runs in, or --config <file>):
//   node policy.mjs check < issue.json            the intake and approval verdict
//   node policy.mjs owner [area] < issue.json     { mine, owner, reason }
//   node policy.mjs inflight [area] < issues.json { area, limit, count, counted, full }
// Issue JSON is what `tracker.mjs issue <n>` prints: { title, body,
//   createdAt, author: { login, id, type }, labels: [names], state, status,
//   assignees: [logins], subIssues, comments: [{ author, body, createdAt,
//   lastEditedAt, editor }] }, plus `model`, the model line the caller writes.

import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPerson, loadConfig, normalizeConfig, repoRoot } from './lib.mjs';

export const HUMAN_ARCHITECTED = 'human-architected';
export const NOTICE_TAG = 'Policy notice (ticket intake)';

export const INTENT_REQUIRED = ['Problem', 'Outcome', 'Constraints'];
// Stems matched with an optional plural, so "Constraint" and "Outcomes" both count.
const INTENT_STEM = { Problem: 'Problem', Outcome: 'Outcome', Constraints: 'Constraint' };
// Headings that mean the body carries design, not intent. Matched only when the
// whole heading is the name (plus an optional "(...)" and colon), so Intent
// sub-headings such as "Design system" or "API compatibility" never trip it.
export const SPEC_HEADINGS = [
  'Spec',
  'Specification',
  'Acceptance criteria',
  'Technical design',
  'Implementation',
  'Implementation plan',
  'Implementation notes',
  'Architecture',
  'Data model',
  'Touches',
  'File changes',
];

const EPIC_WORD = /\bepics?\b/i;

/** Does the title contain the word "epic" (whole word, any case)? */
export function hasEpicTerm(title) {
  return EPIC_WORD.test(String(title || ''));
}

/**
 * The title with "epic" removed, or null when nothing meaningful is left and
 * the title must be rewritten by hand. "EPIC 6 — Checkout Experience" becomes
 * "Checkout Experience"; "[Epic] Onboarding" becomes "Onboarding".
 */
export function suggestTitle(title) {
  let t = String(title || '');
  // A leading label with an optional number and separator: "EPIC 6 —", "[Epic]:", "Epic -".
  t = t.replace(/^\s*[[(]?\s*epics?\s*\d*\s*[\])]?\s*[:—–\-|.]*\s*/i, '');
  // Any other occurrence, with the separator that hangs off it.
  t = t.replace(/\s*[:—–\-|]?\s*\bepics?\b\s*\d*\s*[:—–\-|]?\s*/gi, ' ');
  t = t.replace(/\s*[([]\s*[)\]]/g, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s:—–\-|.]+|[\s:—–\-|]+$/g, '').trim();
  return /[A-Za-z]{3,}/.test(t) ? t : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body without fenced code blocks, so code never reads as a heading. */
function prose(body) {
  const out = [];
  let fence = null; // the opening marker while inside a fence, e.g. "````"
  for (const raw of String(body || '').split('\n')) {
    // Headings are short; capping each line keeps every match proportional to
    // the line length no matter how the body is written. Runs of inner
    // whitespace collapse first, so padding cannot push a heading name past
    // the cap; leading indentation is kept for the fence rule.
    const line = raw.replace(/(\S)[ \t]{2,}/g, '$1 ').slice(0, 2000);
    let m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    // CommonMark: a backtick fence's info string cannot contain a backtick, so
    // "```js``` is how we call it" is inline code, not a fence.
    if (m && !fence && m[1][0] === '`' && m[2].includes('`')) m = null;
    if (fence) {
      // Closes only on the same character, at least as long, with nothing after it.
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '') fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  // An unclosed fence hides the rest of the body, as a Markdown renderer would.
  return out.join('\n');
}

/**
 * Is `name` present as a heading? A heading is a `#` line, a line that opens
 * with `**` or `__` bold, or a line that is only the name (optionally with a
 * colon). Prose that starts with the word ("Problem is that...") and bullets
 * ("* **Design:** ...") are not headings.
 *
 * exact = false (Intent): the heading contains the word, plural allowed, so
 *   "## Outcomes" and "## Desired outcome" count.
 * exact = true (spec): the whole heading is the name, plus an optional
 *   "(...)" and colon, so "## Spec (first slice)" counts and "**Design system**"
 *   does not. For bold, text may follow the closing marker ("**Touches** db/").
 */
export function hasHeading(body, name, { exact = false } = {}) {
  const n = escapeRe(name);
  const text = prose(body);
  // A tail with no backtracking: each optional part owns its trailing whitespace, so no
  // two whitespace quantifiers sit side by side (cubic backtracking on a long
  // run of spaces otherwise).
  const tail = '[ \\t]*(?:\\([^)\\n]*\\)[ \\t]*)?(?::[ \\t]*)?';
  // A `#` heading may be numbered ("## 3. Implementation plan") and may carry
  // text after a colon or dash ("## Implementation: use Redis", "## Spec — v2").
  const num = '(?:\\d+(?:\\.\\d+)*[.)]?[ \\t]+)?';
  // A hyphen separates only when a space follows, so "Spec-compliant" is a word.
  const after = '(?:(?:[:—–]|-(?=[ \\t]))[^\\n]*)?';
  const md = exact
    ? new RegExp(`^[ \\t]{0,3}#{1,6}[ \\t]*${num}${n}${tail}${after}$`, 'im')
    : new RegExp(`^[ \\t]{0,3}#{1,6}[^\\n]*\\b${n}s?\\b[^\\n]*$`, 'im');
  const bold = exact
    ? new RegExp(`^[ \\t]{0,3}(\\*\\*|__)[ \\t]*${num}${n}${tail}(?:(?:[:—–]|-(?=[ \\t]))[^*_\\n]*)?(\\*\\*|__)`, 'im')
    : new RegExp(`^[ \\t]{0,3}(\\*\\*|__)[^\\n]*?\\b${n}s?\\b[^\\n]*?(\\*\\*|__)`, 'im');
  const bare = exact
    ? new RegExp(`^[ \\t]{0,3}${num}${n}[ \\t]*(?::[^\\n]*)?$`, 'im')
    : new RegExp(`^[ \\t]{0,3}${n}s?(?::)?[ \\t]*$`, 'im');
  return md.test(text) || bold.test(text) || bare.test(text);
}

/** Intent conformance: the required headings that are missing. */
export function intentMissing(body) {
  return INTENT_REQUIRED.filter((h) => !hasHeading(body, INTENT_STEM[h]));
}

/** The spec headings the body carries. */
export function specHeadingsFound(body) {
  return SPEC_HEADINGS.filter((h) => hasHeading(body, h, { exact: true }));
}

// People are matched by GitHub login (and id, when the config gives one),
// never by a display name, which anyone can set.
const authorOf = (x) => (x && typeof x === 'object' && 'author' in x ? x.author : x);
export const isApprover = (author, cfg) => cfg.approvers.some((a) => isPerson(author, a));
export const isAgent = (author, cfg) => Boolean(cfg.agent) && isPerson(author, cfg.agent);
const loginOf = (author) => String((author && typeof author === 'object' ? author.login : author) || '').toLowerCase();

/** Can approval be decided at all? Not when nobody approves, or the agent is an approver. */
function approvalUsable(cfg) {
  return cfg.approvers.length > 0 && Boolean(cfg.agent) && !cfg.approvers.some((a) => a.login === cfg.agent.login);
}

/** human-architected counts only when an approver applied it. */
export function architectedByApprover(issue, cfg) {
  if (!approvalUsable(cfg)) return false;
  const labels = (issue.labels || []).map((l) => String(l).toLowerCase());
  if (!labels.includes(HUMAN_ARCHITECTED)) return false;
  if (isApprover(issue.author, cfg)) return true;
  return (issue.comments || []).some((c) => {
    const b = String(c.body || '');
    // A line that is only the label (optionally with punctuation), so a question
    // or a negation that merely mentions it never grants trust. An edited
    // comment counts only when an approver made the edit.
    return isApprover(authorOf(c), cfg) && editedByApprover(c, cfg) && /^[ \t]*`?human-architected`?[ \t.!]*$/im.test(b);
  });
}

// A comment's line that is only an approval word, optionally punctuated.
const APPROVAL_LINE = /^[ \t]*(?:approved?|go)[ \t.!]*$/im;
// A Spec comment by the agent starts with a "## Spec" heading line.
const SPEC_COMMENT = /^[ \t]*##[ \t]+Spec\b/im;

/** Never edited, or last edited by an approver's own account. */
function editedByApprover(c, cfg) {
  if (c.lastEditedAt === undefined || c.lastEditedAt === null) return true;
  return Boolean(c.editor) && isApprover(c.editor, cfg);
}

// Comments in time order by createdAt, or null when any comment lacks a valid
// date, or carries an edit date that is not one: the caller must pass dates,
// and approval fails closed without them.
function inOrder(comments) {
  const list = (comments || []).map((c, i) => ({
    c,
    i,
    t: Date.parse(c && c.createdAt),
    e: c && c.lastEditedAt !== undefined && c.lastEditedAt !== null ? Date.parse(c.lastEditedAt) : null,
  }));
  if (list.some((x) => Number.isNaN(x.t) || Number.isNaN(x.e))) return null;
  return list.sort((a, b) => a.t - b.t || a.i - b.i);
}

/**
 * Has an approver approved this issue for work? Only a comment from an
 * approver's own account with a line that is just "approved" or "go"
 * (anywhere in the comment), written after the latest Spec comment by the
 * agent (or anywhere, when there is no Spec comment) and after that Spec's
 * last edit, counts. Every comment needs its createdAt; one without a valid
 * date makes the answer false.
 */
export function approvedByApprover(issue, cfg) {
  if (!approvalUsable(cfg)) return false;
  const list = inOrder(issue && issue.comments);
  if (!list) return false;
  let from = 0;
  let specEdited = null;
  list.forEach((x, pos) => {
    if (isAgent(authorOf(x.c), cfg) && SPEC_COMMENT.test(String(x.c.body || ''))) {
      from = pos + 1;
      specEdited = x.e;
    }
  });
  return list
    .slice(from)
    .some((x) => isApprover(authorOf(x.c), cfg) && editedByApprover(x.c, cfg) && (specEdited === null || x.t > specEdited) && APPROVAL_LINE.test(String(x.c.body || '')));
}

// Phrases an outside AI leaves when it writes through a person's account.
const OUTSIDE_AI = [
  /\b(?:recorded|updated|drafted|authored|written|audit(?:ed)?)\s+by\s+(?:claude|an?\s+(?:ai|agent|assistant))\b/i,
  /^[ \t]*(?:[-—–]+[ \t]*)?claude\b[,:]?[ \t]*\d{4}-\d{2}-\d{2}/im,
  /\bclaude\s+(?:opus|sonnet|haiku|fable|mythos)\b[^\n]*\(claude-/i,
  /\b(?:has|have)\s+(?:approved|confirmed|signed\s+off\s+on|decided)\b/i,
  /\b(?:approved|confirmed|signed\s+off)\s+by\s+@?[\w-]+/i,
  /\b(?:blocked|unavailable|not\s+available|unreachable)\s+(?:from|in)\s+my\s+environment\b/i,
  /\bI\s+(?:rendered|regenerated|reconstructed)\b/i,
  /\b(?:build|explorer)\s+v\d+\b/i,
];

/**
 * Indexes of comments, from any account other than an approver's and the
 * agent's, that read as an outside AI's work or come from a bot account. They
 * are input at most: never an approval, a confirmation, or an acceptance.
 */
export function externalAiComments(issue, cfg) {
  const out = [];
  (issue && issue.comments ? issue.comments : []).forEach((c, i) => {
    const a = authorOf(c);
    if (isApprover(a, cfg) || isAgent(a, cfg)) return;
    const bot = (a && typeof a === 'object' && a.type === 'Bot') || /\[bot\]$/i.test(loginOf(a));
    const b = String(c.body || '');
    if (bot || OUTSIDE_AI.some((re) => re.test(b))) out.push(i);
  });
  return out;
}

export function noticeAlreadyPosted(issue, cfg) {
  return (issue.comments || []).some((c) => isAgent(authorOf(c), cfg) && String(c.body || '').includes(NOTICE_TAG));
}

function noticeBody({ missing, specFound, model, agent }) {
  const lines = [`**${NOTICE_TAG}**`, '', 'The agent will not pick this issue up yet.', ''];
  if (missing.length) {
    lines.push(
      `- **Not in the Intent shape.** Missing: ${missing.join(', ')}. The body needs the headings Problem, Outcome, and Constraints; Not in scope and Open questions are optional.`,
    );
  }
  if (specFound.length) {
    lines.push(
      `- **The body carries a spec** (${specFound.join(', ')}). Design is decided by the agent session that reads the code, and posted as a Spec comment. An issue whose design an approver wrote carries \`${HUMAN_ARCHITECTED}\`, applied by an approver.`,
    );
  }
  lines.push('', `To go ahead: edit the description, then assign the issue back to @${agent}. This is the only notice on this issue.`);
  if (model) lines.push('', model);
  return lines.join('\n');
}

/**
 * The verdict for one issue.
 *   title.rename   the suggested title when "epic" must go (null = rewrite by hand)
 *   parent         true when the issue has sub-issues: never spec or build it
 *   blocked        true when the agent must not spec or build it (intent or spec rule)
 *   notice         the comment body to post, or null (none needed, or already posted)
 *   assignTo       the login to assign when parent or blocked, so it leaves the agent's queue
 *   approved       true only when an approver's own account approved it after the latest Spec
 *   untrustedComments  indexes of comments that read as an outside AI (never a decision)
 *   problems       config problems that make approval impossible (fix the config)
 */
export function checkIssue(issue, cfg) {
  const title = String(issue.title || '');
  const body = String(issue.body ?? issue.description ?? '');
  const epic = hasEpicTerm(title);
  // A missing or unparseable date enforces the rules; only a real date before
  // policyStart grandfathers the issue.
  const created = new Date(issue.createdAt);
  const inForce =
    typeof issue.createdAt !== 'string' || Number.isNaN(created.getTime()) || created >= new Date(cfg.policyStart);

  const missing = inForce ? intentMissing(body) : [];
  const trusted = architectedByApprover(issue, cfg);
  const specFound = inForce && !trusted ? specHeadingsFound(body) : [];
  const blocked = missing.length > 0 || specFound.length > 0;
  const posted = noticeAlreadyPosted(issue, cfg);
  const parent = (issue.subIssues ?? issue.childCount ?? 0) > 0;
  // Whose move it is when the agent cannot proceed: the creator when they are
  // an approver or one of the config's people, otherwise the first approver,
  // so a refused issue never stays in the agent's queue.
  const humans = [...cfg.approvers, ...cfg.people];
  const creatorIsHuman = humans.some((h) => isPerson(issue.author, h)) && !isAgent(issue.author, cfg);
  const firstApprover = cfg.approvers[0] ? cfg.approvers[0].login : null;
  const handBack = creatorIsHuman ? loginOf(issue.author) : firstApprover;
  const assignTo = blocked || parent ? handBack : null;

  return {
    title: { hasEpic: epic, rename: epic ? suggestTitle(title) : undefined },
    parent,
    assignTo,
    grandfathered: !inForce,
    intent: { missing },
    spec: { found: specFound, architectedByApprover: trusted },
    blocked,
    approved: approvedByApprover(issue, cfg),
    untrustedComments: externalAiComments(issue, cfg),
    noticePosted: posted,
    notice: blocked && !posted ? noticeBody({ missing, specFound, model: issue.model, agent: cfg.agent ? cfg.agent.login : 'the agent' }) : null,
    problems: cfg.problems || [],
  };
}

/** The areas an issue's labels name, lowercased, or null when its labels were not loaded. */
export function areasOf(issue, cfg) {
  if (!issue || typeof issue !== 'object' || !Array.isArray(issue.labels)) return null;
  const prefix = cfg.areaLabelPrefix.toLowerCase();
  const names = issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name));
  if (names.some((n) => typeof n !== 'string')) return null;
  return [...new Set(names.map((n) => n.toLowerCase()).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length).trim()).filter(Boolean))];
}

/**
 * Which area owns an issue, and whether that is `area` (the repo's own, by
 * default). Input: an issue with its labels.
 */
export function owner(issue, cfg, area = cfg.area) {
  const answer = (owning, reason) => ({ mine: Boolean(area) && owning === area, owner: owning, reason });
  const names = areasOf(issue, cfg);
  if (names === null) return { mine: false, owner: null, reason: 'labels not loaded' };
  const dflt = cfg.defaultArea;
  if (names.length === 0) return dflt ? answer(dflt, 'no area label') : { mine: false, owner: null, reason: 'no area label and no defaultArea: ask the approver' };
  if (names.length > 1) {
    return dflt && names.includes(dflt)
      ? answer(dflt, 'several area labels, one of them the default area')
      : { mine: false, owner: null, reason: `several area labels (${names.join(', ')}): ask the approver` };
  }
  return answer(names[0], area ? 'area label' : 'repo names no area');
}

/**
 * The in-flight count for an area: open issues assigned to the agent whose
 * status is In Progress and whose owner is that area. Issues another area
 * owns never count. A repo that names no area counts every area's issues.
 * Input: issues as tracker.mjs prints them ({ number, state, status, assignees, labels }).
 */
export function inFlight(issues, cfg, area = cfg.area) {
  const agent = cfg.agent ? cfg.agent.login : null;
  const counted = [];
  let others = 0;
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i || i.state !== 'open' || i.status !== 'in-progress') continue;
    if (!agent || !(i.assignees || []).some((a) => loginOf(a) === agent)) continue;
    if (!area || owner(i, cfg, area).mine) counted.push(i.number);
    else others++;
  }
  counted.sort((a, b) => a - b);
  return {
    area: area || null,
    limit: cfg.inFlightLimit,
    count: counted.length,
    counted,
    others,
    full: counted.length >= cfg.inFlightLimit,
    reason: area ? `counts only issues area ${area} owns` : 'the repo names no area, so every area counts',
  };
}

function configFor(args) {
  const i = args.indexOf('--config');
  if (i >= 0) return normalizeConfig(JSON.parse(readFileSync(args[i + 1], 'utf8')));
  const root = repoRoot(process.cwd());
  const cfg = root && loadConfig(root);
  if (!cfg) throw new Error('no .sdlc-harness/sdlc.json in this repo; pass --config <file>');
  return cfg;
}

// CLI
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--config');
  if (!['check', 'owner', 'inflight'].includes(cmd)) {
    console.error('usage: policy.mjs check | owner [area] | inflight [area]  [--config <file>] < input.json');
    process.exit(1);
  }
  let cfg;
  let input;
  try {
    cfg = configFor(args);
  } catch (e) {
    console.error(`[policy] ${e.message}`);
    process.exit(1);
  }
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    console.error(`[policy] input is not JSON: ${e.message}`);
    process.exit(1);
  }
  const area = positional[0] !== undefined ? positional[0] : cfg.area;
  const verdict = cmd === 'owner' ? owner(input, cfg, area) : cmd === 'inflight' ? inFlight(input, cfg, area) : checkIssue(input, cfg);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}
