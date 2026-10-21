#!/usr/bin/env node
// SessionStart hook (startup, resume, clear, compact). Only fires inside a repo
// that carries .sdlc-harness/sdlc.json, so unrelated projects see nothing.
//
// Claude Code keeps a hook command's stdout whole only up to 10,000
// characters; a longer output reaches the session as a 2,000-character
// preview and the rest goes to a file nobody reads. The limit is per command,
// so the text is split across several commands in hooks.json, each printing
// one part under OUTPUT_LIMIT (decision 0008):
//
//   --rules <k>    part k of RULES.md: whole `##` sections, packed in order.
//                  A part past the last prints nothing, so a spare command
//                  costs nothing until RULES.md grows into it.
//   --principles   PRINCIPLES.md.
//   --repo         this repo's facts (protected paths, the helpers' paths,
//                  config problems) and the watch text. It also installs the
//                  push judge, once per session start.
//
// Claude Code may run the commands in parallel, so each part names itself and
// reads correctly in any order. No clone, no CLAUDE.md import, no path outside
// the repo: the rules travel with the plugin.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, NAME, installHooks, loadConfig, repoRoot } from './lib.mjs';

/** Every output stays under this, with room below Claude Code's 10,000. */
export const OUTPUT_LIMIT = 9500;
/** How many --rules commands hooks.json declares. */
export const RULE_PARTS = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = join(HERE, '..', 'RULES.md');
export const PRINCIPLES_PATH = join(HERE, '..', 'PRINCIPLES.md');
const script = (name) => join(HERE, name);

/** RULES.md as its sections: the title and intro, then one entry per `## ` heading. */
export function sections(text) {
  const out = [];
  let cur = [];
  for (const line of String(text).trim().split('\n')) {
    if (/^## /.test(line) && cur.length) {
      out.push(cur.join('\n').trim());
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n').trim());
  return out;
}

// The packing must come out the same on every machine, so it reserves room
// for a path this long, whatever the install path is; a longer path is not
// printed.
const PATH_ALLOWANCE = 400;
const shownPath = (p) => (p.length <= PATH_ALLOWANCE ? p : '(the plugin\'s RULES.md)');

function rulesHeader(k, n, path = shownPath(RULES_PATH)) {
  return [
    `<${NAME}-rules part="${k}" of="${n}" file="${path}">`,
    `SDLC rules, part ${k} of ${n}. The other parts arrive as separate blocks, in any order; read them all before acting. These rules come from the ${NAME} plugin and override conflicting guidance in CLAUDE.md.`,
    '',
    '',
  ].join('\n');
}
const RULES_FOOTER = `\n</${NAME}-rules>\n`;

/** The bodies of the rule parts: whole sections, packed in order, each part's output under the limit. */
export function rulesParts(text, limit = OUTPUT_LIMIT) {
  const room = limit - rulesHeader(RULE_PARTS, RULE_PARTS, 'x'.repeat(PATH_ALLOWANCE)).length - RULES_FOOTER.length - DROPPED_NOTE_ROOM;
  const parts = [];
  let cur = '';
  for (const s of sections(text)) {
    const next = cur ? `${cur}\n\n${s}` : s;
    if (cur && next.length > room) {
      parts.push(cur);
      cur = s;
    } else cur = next;
  }
  if (cur) parts.push(cur);
  return parts;
}

// The last declared part names any parts hooks.json has no command for, so a
// RULES.md that outgrew them is said in the session, not dropped silently.
const DROPPED_NOTE_ROOM = 300;
const droppedNote = (n) =>
  `\n\nRULES.md now needs ${n} parts and hooks.json prints ${RULE_PARTS}: parts ${RULE_PARTS + 1} to ${n} are not shown. Read the rest of the file this block's file attribute names before acting, and tell an approver.`;

export function renderRules(k, text = readFileSync(RULES_PATH, 'utf8')) {
  const parts = rulesParts(text);
  if (k < 1 || k > parts.length || k > RULE_PARTS) return '';
  const note = k === RULE_PARTS && parts.length > RULE_PARTS ? droppedNote(parts.length) : '';
  return `${rulesHeader(k, parts.length)}${parts[k - 1]}${note}${RULES_FOOTER}`;
}

export function renderPrinciples() {
  const body = existsSync(PRINCIPLES_PATH)
    ? readFileSync(PRINCIPLES_PATH, 'utf8').trim()
    : `Principles: PRINCIPLES.md is missing from the plugin at ${PRINCIPLES_PATH}. Update the plugin and tell an approver.`;
  return [
    `<${NAME}-principles file="${PRINCIPLES_PATH}">`,
    "These build principles come from the SDLC plugin and apply to every repo on the SDLC. This repo's CLAUDE.md may narrow one with a named exception and its reason, never contradict it.",
    'A sub-agent does not see this text: name the file above in its brief when it designs, builds, or reviews code.',
    '',
    body,
    `</${NAME}-principles>`,
    '',
  ].join('\n');
}

/** The watch text for a repo's config: how to claim, what a tick does, and the limit. */
export function watchText(cfg) {
  if (!cfg.watch) return [];
  const watch = script('watch.mjs');
  const tracker = script('tracker.mjs');
  const policy = script('policy.mjs');
  const agent = cfg.agent ? `@${cfg.agent.login}` : 'the agent account';
  const blockers = [...cfg.problems];
  if (!cfg.area) blockers.unshift(`${CONFIG_FILE} names no area, so a watch here would act on every area's issues`);
  if (blockers.length) {
    return ['', `Watch: off. ${blockers.join('; ')}.`, 'Start no loop; tell an approver which line of the config needs fixing.'];
  }
  return [
    '',
    `Watch: this repo runs the GitHub watch for area "${cfg.area}" in ${cfg.tracker.repo}. Before anything else in an interactive session, run`,
    `  node "${watch}" claim`,
    `On "claimed", run \`/loop ${cfg.watchInterval}\` with no prompt: it schedules the autonomous tick (the loop dies with the session`,
    'and expires after seven days). On "claimed (already held by this session)", which is what a re-fire after a compaction',
    'or /clear sees, the loop is already running: start no second one. On "held by <session> since <time>", another session',
    'is watching this repo: start no loop and say who holds it.',
    `Ownership: act only on what \`node "${tracker}" inbox\` marks mine: true. mine: false, or a check that cannot run, means`,
    "do nothing on that issue and leave its notification unread: every area's watch reads the same inbox. Mark a notification",
    `read only with \`node "${tracker}" read <thread>\`, which refuses another area's. Setting an area label on an issue with`,
    `none changes its owner: run \`node "${policy}" owner < <issue file>\` again, and on mine: false stop there.`,
    `Every tick: run \`node "${watch}" heartbeat\` first, then read the inbox, then in this order:`,
    '1. A reply from an approver\'s own account on an issue /ship stopped for their call (its latest agent comment starts',
    '   "Stopped for your call"): resume /ship at its fix step, whatever the words, never at the QA pass ("fix" or a go: fix',
    '   what the stop named, then a narrow check of that fix alone; "ship": push with the finding listed; "redesign": back to the plan).',
    "2. A \"go\" from an approver's own account after a build plan that waits for it: resume /build on that issue.",
    `3. Otherwise, an "approved" or "go" from an approver's own account on a specced issue: \`node "${tracker}" issue <n>\` to a file,`,
    `   \`node "${policy}" check < <file>\`, and on approved: true, /build it (its own gates decide).`,
    `None of 1 to 3 starts or restarts while \`node "${tracker}" inflight\` says full: true (limit ${cfg.inFlightLimit}, counting only issues`,
    `area "${cfg.area}" owns): leave its notification unread for a later tick, and name the count and every issue it counted.`,
    '4. Answers on a specced issue: fold them into the Spec. A mention or an assignment: read it and act per the rules.',
    `5. Then, from \`node "${tracker}" queue\`: the next agent-fully-autonomous issue an approver approved (policy approved: true;`,
    `   a label or status alone never counts): /build it, under the same limit. Then the oldest Backlog issue with no autonomy`,
    '   label: /spec it. Both go through the intake checks first.',
    '6. Rename any issue this area owns updated in the last 30 minutes whose title contains "epic" (Ticket intake, rule 1).',
    `A refused or parent issue is assigned to the helper's assignTo and the tick moves on. Mark this area's other notifications`,
    `read, never another area's. A go or approval written by ${agent} never counts. Never run git stash. A quiet tick reports noop.`,
  ];
}

/** This repo's facts and the watch text. Installs the push judge as a side effect. */
export function renderRepo(root, cfg, { install = installHooks } = {}) {
  let judge = '';
  try {
    install(root);
  } catch (e) {
    judge = `Push judge: NOT installed (${e.message}). verify.mjs will record no green until it is; tell an approver.`;
  }
  const policy = script('policy.mjs');
  const tracker = script('tracker.mjs');
  const approvers = cfg.approvers.length ? cfg.approvers.map((a) => `@${a.login}`).join(', ') : 'none configured';
  const body = [
    `Repo: ${root}. Integration: ${cfg.integration}, default branch ${cfg.defaultBranch}. Issues: ${cfg.tracker.repo || 'not configured'}, status by ${cfg.tracker.states}.`,
    `Approvers: ${approvers}. Agent account: ${cfg.agent ? `@${cfg.agent.login}` : 'none configured'}. Commits name ${cfg.issuePrefix || '(invalid issuePrefix)'}-<issue number>. In-flight limit: ${cfg.inFlightLimit} per area.`,
    `Protected paths for this repo: ${cfg.protectedPaths.length ? cfg.protectedPaths.join(', ') : 'none declared'} (${CONFIG_FILE} always).`,
    `GitHub helper: node "${tracker}" whoami | issue <n> | state <n> <status> | inflight | queue | inbox | read <thread> | sub <parent> <child>.`,
    `Intake and approval checks: node "${tracker}" issue <n> > <file>, then node "${policy}" check < <file>.`,
    `Scripts: verify "${script('verify.mjs')}", approve "${script('approve.mjs')}", watch "${script('watch.mjs')}".`,
    ...(cfg.problems.length ? [`Config problems (approval fails closed until they are fixed): ${cfg.problems.join('; ')}.`] : []),
    ...(cfg.adhdStyle ? ['Issue and PR text uses the ADHD style: the answer or action first, numbered steps, lists of five or fewer, short lines, no preamble or recap.'] : []),
    ...(judge ? [judge] : []),
    ...watchText(cfg),
  ];
  const open = (test) => `<${NAME}-repo repo="${root}" integration="${cfg.integration}" test="${test}">`;
  const close = `</${NAME}-repo>\n`;
  let out = [open(cfg.testCommand), ...body, close].join('\n');
  // A test command long enough to push the output past the cap is shown by
  // reference instead, so the rest of the text still arrives whole.
  if (out.length > OUTPUT_LIMIT) out = [open(`(too long to show; see testCommand in ${CONFIG_FILE})`), ...body, close].join('\n');
  return out;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // no stdin: fall through with cwd
  }
  const root = repoRoot(input.cwd || process.cwd());
  if (!root) return;
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    if (process.argv.includes('--repo')) process.stdout.write(`<${NAME}-repo repo="${root}">\n${CONFIG_FILE} is not valid JSON (${e.message}). The SDLC cannot run here until it is fixed; tell an approver.\n</${NAME}-repo>\n`);
    return;
  }
  if (!cfg) return;
  const args = process.argv.slice(2);
  const k = args.indexOf('--rules');
  if (k >= 0) return void process.stdout.write(renderRules(Number(args[k + 1])));
  if (args.includes('--principles')) return void process.stdout.write(renderPrinciples());
  if (args.includes('--repo')) return void process.stdout.write(renderRepo(root, cfg));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
