#!/usr/bin/env node
// Creates (or updates) the GitHub labels the SDLC reads, in the tracker repo
// the config names: the three autonomy labels, the three kinds of work,
// Discovered, human-architected, the status labels (when status is kept in
// labels), and one area label per area the config lists. A person runs it once
// per tracker repo, and again after adding an area. It never deletes a label.
//
// A Linear team (decision 0011) keeps status in its workflow states, so it
// gets no status labels, and the labels are made with the Linear MCP tools:
// this prints them, with the call that makes each, for a session to run.
//
// Usage: node setup-labels.mjs [--dry-run]    (inside a repo with .sdlc-harness/sdlc.json)

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, repoRoot } from './lib.mjs';
import { runGh } from './tracker.mjs';

/** Every label the config needs: { name, color, description }. */
export function labelSet(cfg) {
  const labels = [
    { name: 'agent-fully-autonomous', color: '0e8a16', description: 'Defect or Improvement, size S or M, no protected path: built and shipped once approved' },
    { name: 'agent-needs-go', color: 'fbca04', description: 'Feature, size L, or a protected path: an approver replies go on the plan before the push' },
    { name: 'human-only', color: 'b60205', description: 'The agent specs or documents it and never builds it' },
    { name: 'Defect', color: 'd73a4a', description: 'Something is broken' },
    { name: 'Improvement', color: 'a2eeef', description: 'Something works and should work better' },
    { name: 'Feature', color: '0075ca', description: 'Something new' },
    { name: 'Discovered', color: 'c5def5', description: 'Found during a build, outside its ticket, and blocking it' },
    { name: 'human-architected', color: '5319e7', description: 'The body is the design; counts only when an approver applied it' },
  ];
  if (cfg.tracker.kind === 'github' && cfg.tracker.states === 'labels') {
    const s = cfg.tracker.statusLabels;
    labels.push(
      { name: s.notStarted, color: 'ededed', description: 'Status: Not Started (never an approval)' },
      { name: s.inProgress, color: '1d76db', description: 'Status: In Progress (counts toward the in-flight limit)' },
      { name: s.inReview, color: '7057ff', description: 'Status: In Review (waiting for an approver to accept and close)' },
    );
  }
  for (const a of cfg.areas) labels.push({ name: `${cfg.areaLabelPrefix}${a}`, color: 'bfd4f2', description: `Work area ${a}: the repo whose config names this area owns the issue` });
  return labels;
}

/** The Linear MCP calls that create each label in the team, for a session to make. */
export function linearLabelCalls(cfg) {
  return labelSet(cfg).map((l) => ({ tool: 'create_issue_label', name: l.name, color: `#${l.color}`, description: l.description, team: cfg.tracker.team }));
}

/** The gh commands that create or update each label. */
export function labelCommands(cfg) {
  return labelSet(cfg).map((l) => ['label', 'create', l.name, '--repo', cfg.tracker.repo, '--color', l.color, '--description', l.description, '--force']);
}

function main() {
  const root = repoRoot(process.cwd());
  const cfg = root && loadConfig(root);
  if (!cfg) {
    console.error('[setup-labels] no .sdlc-harness/sdlc.json in this repo');
    return 1;
  }
  if (cfg.tracker.kind === 'linear') {
    if (!cfg.tracker.team) {
      console.error('[setup-labels] tracker.team is not set');
      return 1;
    }
    console.log(`Linear team ${cfg.tracker.team}: in a Claude Code session in this repo, ask it to list the team's labels (list_issue_labels team "${cfg.tracker.team}") and create each one below that is missing, with create_issue_label and the team's id from get_user "me". Never rename or delete one.`);
    console.log(JSON.stringify(linearLabelCalls(cfg), null, 2));
    return 0;
  }
  if (cfg.tracker.kind !== 'github') {
    console.error(`[setup-labels] creates GitHub labels, and tracker.kind is "${cfg.tracker.kind}"`);
    return 1;
  }
  if (!cfg.tracker.repo) {
    console.error('[setup-labels] tracker.repo is not set and origin is not a GitHub repo');
    return 1;
  }
  const dry = process.argv.includes('--dry-run');
  let failed = 0;
  for (const args of labelCommands(cfg)) {
    if (dry) {
      console.log(`gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      continue;
    }
    const r = runGh(args);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${args[2]}${r.ok ? '' : `: ${r.err.split('\n')[0]}`}`);
    if (!r.ok) failed++;
  }
  if (!cfg.areas.length) console.log('[setup-labels] the config lists no areas, so no area labels were made. Add "area" (and "areas") to the config.');
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
