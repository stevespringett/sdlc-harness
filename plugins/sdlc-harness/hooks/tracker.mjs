#!/usr/bin/env node
// The tracker helper (decision 0010). Every read the skills and the watch
// make of the issue tracker, and every write they make to an issue, goes
// through here, so the skills name no tracker's own commands. The config's
// tracker.kind picks the adapter under trackers/: "github" (the default)
// calls gh itself; "linear" (decision 0011) reads the Linear MCP output the
// session saved, on stdin, and names the MCP call for every write. An unknown
// kind refuses every command.
//
// No command closes, reopens, deletes, or transfers an issue, or sets Done:
// only an approver accepts (decision 0003). Every write runs as the agent
// account and refuses any other.
//
// With Linear, whoami, issue, inflight, queue, and inbox read the saved MCP
// output on stdin (trackers/linear.mjs says which call each one reads).
//
// CLI (config from the repo the command runs in). <id> is 12, #12, or <issuePrefix>-12:
//   node tracker.mjs whoami                          is the tracker logged in as the configured agent?
//   node tracker.mjs issue <id>                      the issue as policy.mjs reads it (JSON)
//   node tracker.mjs state <id> <status>             backlog | not-started | in-progress | in-review
//   node tracker.mjs comment <id> <body-file> [--edit-last]
//                                                    post a comment, or replace the agent's latest one
//   node tracker.mjs label <id> [--add a,b] [--remove c]     never a status label
//   node tracker.mjs assign <id> [--add login] [--remove login]
//   node tracker.mjs title <id> <text>               rename the issue
//   node tracker.mjs create --title <t> --body-file <f> [--label <l>]...
//   node tracker.mjs search <words>                  issues in any state that match, for duplicates
//   node tracker.mjs labels                          the tracker's area labels
//   node tracker.mjs inflight                        the area's in-flight count (policy.inFlight)
//   node tracker.mjs queue                           the area's open issues assigned to the agent, oldest first
//   node tracker.mjs inbox                           the agent's unread notifications, each with its owner
//   node tracker.mjs read <thread-id>                mark one notification read, only when this area owns it
//   node tracker.mjs sub <parent-id> <child-id>      make one issue a sub-issue of another

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, repoRoot } from './lib.mjs';
import { adapter as github, TrackerError } from './trackers/github.mjs';
import { adapter as linear } from './trackers/linear.mjs';

export * from './trackers/github.mjs';

export const ADAPTERS = { github, linear };

/** The commands that read the session's saved MCP output on stdin, for an adapter that needs it. */
export const STDIN_COMMANDS = ['whoami', 'issue', 'inflight', 'queue', 'inbox'];

/** The adapter the config names; throws for a kind with none. */
export function adapterFor(cfg) {
  const a = ADAPTERS[cfg.tracker.kind];
  if (!a) throw new TrackerError(`tracker.kind "${cfg.tracker.kind}" has no adapter (known: ${Object.keys(ADAPTERS).join(', ')})`);
  return a;
}

export const USAGE =
  'usage: tracker.mjs whoami | issue <id> | state <id> <status> | comment <id> <body-file> [--edit-last] | label <id> [--add a,b] [--remove c] | assign <id> [--add login] [--remove login] | title <id> <text> | create --title <t> --body-file <f> [--label <l>]... | search <words> | labels | inflight | queue | inbox | read <thread-id> | sub <parent-id> <child-id>';

const OPTIONS = {
  'edit-last': { type: 'boolean' },
  add: { type: 'string', multiple: true },
  remove: { type: 'string', multiple: true },
  label: { type: 'string', multiple: true },
  title: { type: 'string' },
  'body-file': { type: 'string' },
};

/** The command line as { cmd, args, opts }; comma lists in --add, --remove, and --label are split. Throws on an unknown option. */
export function parseCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const list = (v) => (v || []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const [cmd, ...args] = positionals;
  return { cmd, args, opts: { editLast: Boolean(values['edit-last']), add: list(values.add), remove: list(values.remove), labels: list(values.label), title: values.title, bodyFile: values['body-file'] } };
}

function bodyFileOf(path) {
  if (!path || !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) throw new TrackerError(`"${path}" is not a file with a body in it`);
  return path;
}

/** Run one parsed command against the adapter; the result is printed as JSON. `input` is the parsed stdin, for an adapter that reads it. */
export function run(cfg, { cmd, args, opts }, a = adapterFor(cfg), { input } = {}) {
  const o = input === undefined ? {} : { input };
  // An adapter that makes no writes itself says so before any file is checked.
  const body = (p) => (a.writes === false ? p : bodyFileOf(p));
  const id = (x) => a.parseId(x, cfg);
  const need = (n) => {
    if (args.length < n) throw new TrackerError(USAGE);
  };
  switch (cmd) {
    case 'whoami': return a.whoami(cfg, o);
    case 'issue': need(1); return a.issue(cfg, id(args[0]), o);
    case 'state': need(2); return a.state(cfg, id(args[0]), args[1]);
    case 'comment': need(2); return a.comment(cfg, id(args[0]), body(args[1]), { editLast: opts.editLast });
    case 'label': need(1); return a.label(cfg, id(args[0]), { add: opts.add, remove: opts.remove });
    case 'assign': need(1); return a.assign(cfg, id(args[0]), { add: opts.add, remove: opts.remove });
    case 'title': need(2); return a.title(cfg, id(args[0]), args.slice(1).join(' '));
    case 'create': return a.create(cfg, { title: opts.title, bodyFile: body(opts.bodyFile), labels: opts.labels });
    case 'search': need(1); return a.search(cfg, args.join(' '));
    case 'labels': return a.labels(cfg);
    case 'inflight': return a.inflight(cfg, o);
    case 'queue': return a.queue(cfg, o);
    case 'inbox': return a.inbox(cfg, o);
    case 'read': need(1); return a.read(cfg, args[0]);
    case 'sub': need(2); return a.sub(cfg, id(args[0]), id(args[1]));
    default: throw new TrackerError(USAGE);
  }
}

function main() {
  const root = repoRoot(process.cwd());
  const cfg = root && loadConfig(root);
  if (!cfg) {
    console.error('[tracker] no .sdlc-harness/sdlc.json in this repo');
    return 1;
  }
  try {
    const parsed = parseCommand(process.argv.slice(2));
    const a = adapterFor(cfg);
    if (cfg.problems.length && parsed.cmd !== 'whoami') console.error(`[tracker] config problems: ${cfg.problems.join('; ')}`);
    let input;
    if (a.stdin && STDIN_COMMANDS.includes(parsed.cmd)) {
      try {
        input = JSON.parse(readFileSync(0, 'utf8'));
      } catch {
        throw new TrackerError(`${parsed.cmd} reads the saved ${a.kind} output as JSON on stdin`);
      }
    }
    const r = run(cfg, parsed, a, { input });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return parsed.cmd === 'whoami' && !r.ok ? 1 : 0;
  } catch (e) {
    console.error(`[tracker] ${e instanceof TrackerError ? e.message : `${e.message}\n${USAGE}`}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
