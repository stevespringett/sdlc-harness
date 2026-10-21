// Session-start output and Claude Code's hook-output cap (decision 0008).
// Claude Code keeps a hook command's stdout whole only up to 10,000
// characters; a longer one reaches the session as a 2,000-character preview.
// The limit is per command, so the text is split across the SessionStart
// commands in hooks.json. These tests run each of those commands the way
// Claude Code would, for every way a session starts, and fail when any output
// grows past OUTPUT_LIMIT (9,500), when RULES.md outgrows the declared
// commands, or when any part of the text stops arriving.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_LIMIT, RULE_PARTS, rulesParts, sections, watchText } from '../session-start.mjs';
import { normalizeConfig } from '../lib.mjs';

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));
const RULES = readFileSync(join(PLUGIN, 'RULES.md'), 'utf8');
const PRINCIPLES = readFileSync(join(PLUGIN, 'PRINCIPLES.md'), 'utf8').trim();
const SOURCES = ['startup', 'resume', 'clear', 'compact'];
const BASE = mkdtempSync(join(tmpdir(), 'sdlc-start-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

// The longest config a real repo is likely to carry: a long test command, many
// protected paths, every optional line printed, and a deep checkout path.
const LONG_TEST = Array.from({ length: 12 }, (_, i) => `node --test packages/module-${i}/__tests__/*.test.mjs || exit 1`).join('; ');
const HEAVY = {
  integration: 'github-flow',
  defaultBranch: 'main',
  testCommand: LONG_TEST,
  protectedPaths: Array.from({ length: 20 }, (_, i) => `services/area-${i}/migrations/`),
  approvers: [{ login: 'octo-lead', id: 101 }, 'second-lead', 'third-lead'],
  agent: { login: 'acme-delivery-bot', id: 303 },
  tracker: { repo: 'acme-holdings-international/engineering-tracker' },
  area: 'customer-portal',
  inFlightLimit: 5,
  adhdStyle: true,
};

function world(cfg = HEAVY) {
  const root = mkdtempSync(join(BASE, `${'deep-path-'.repeat(6)}w-`));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const d of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]) mkdirSync(d, { recursive: true });
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo], { env });
  if (cfg) {
    mkdirSync(join(repo, '.sdlc-harness'));
    writeFileSync(join(repo, '.sdlc-harness', 'sdlc.json'), JSON.stringify(cfg));
  }
  return { root, env, repo };
}

const groups = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart;
const commands = (source) =>
  groups
    .filter((g) => !g.matcher || g.matcher === '*' || new RegExp(`^(?:${g.matcher})$`).test(source))
    .flatMap((g) => g.hooks.map((h) => h.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN)));
const outputs = (w, source = 'startup', plugin = PLUGIN) =>
  commands(source).map((cmd) => {
    const r = spawnSync('/bin/sh', ['-c', cmd.replaceAll(PLUGIN, plugin)], { input: JSON.stringify({ cwd: w.repo, source }), env: w.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });

describe('every output stays under the cap', () => {
  for (const source of SOURCES) {
    test(`on ${source}, each SessionStart command prints at most ${OUTPUT_LIMIT} characters`, () => {
      const outs = outputs(world(), source);
      assert.ok(outs.length >= RULE_PARTS + 2, 'the rules parts, the principles, and the repo text each have a command');
      outs.forEach((o, i) => assert.ok(o.length <= OUTPUT_LIMIT, `command ${i + 1} printed ${o.length} characters`));
      assert.ok(OUTPUT_LIMIT < 10_000, 'the limit stays below Claude Code\'s own');
    });
  }

  test('hooks.json declares exactly RULE_PARTS rules commands, numbered 1 to RULE_PARTS', () => {
    const parts = commands('startup').map((c) => /--rules (\d+)/.exec(c)).filter(Boolean).map((m) => Number(m[1]));
    assert.deepEqual(parts, Array.from({ length: RULE_PARTS }, (_, i) => i + 1));
  });

  test('RULES.md fits in the declared commands, with no section too big for one output', () => {
    const parts = rulesParts(RULES);
    assert.ok(parts.length <= RULE_PARTS, `RULES.md needs ${parts.length} parts and hooks.json declares ${RULE_PARTS}: add a --rules command and raise RULE_PARTS`);
    for (const s of sections(RULES)) assert.ok(s.length < OUTPUT_LIMIT - 400, `section "${s.split('\n')[0]}" is ${s.length} characters, too big for one output`);
  });

  test('a repo output with a test command past the cap shows it by reference and stays under it', () => {
    const outs = outputs(world({ ...HEAVY, testCommand: 'x'.repeat(12_000) }));
    const repo = outs.find((o) => o.includes('<sdlc-harness-repo'));
    assert.ok(repo.length <= OUTPUT_LIMIT, `${repo.length}`);
    assert.match(repo, /too long to show; see testCommand/);
    assert.match(repo, /Watch: this repo runs the GitHub watch/);
  });
});

describe('together, the outputs carry everything', () => {
  test('every section of RULES.md arrives word for word, each in exactly one part', () => {
    const outs = outputs(world());
    for (const s of sections(RULES)) {
      const holders = outs.filter((o) => o.includes(s));
      assert.equal(holders.length, 1, `section "${s.split('\n')[0]}" arrives in ${holders.length} outputs`);
    }
  });

  test('each rules part names itself and holds only whole sections', () => {
    const outs = outputs(world()).filter((o) => o.includes('<sdlc-harness-rules'));
    const n = rulesParts(RULES).length;
    assert.equal(outs.length, n);
    outs.forEach((o, i) => {
      assert.match(o, new RegExp(`part="${i + 1}" of="${n}"`));
      assert.match(o, new RegExp(`SDLC rules, part ${i + 1} of ${n}\\. The other parts arrive as separate blocks, in any order`));
      const body = o.split('\n').slice(2, -2).join('\n').trim();
      const own = sections(body);
      for (const s of own) assert.ok(sections(RULES).includes(s), `part ${i + 1} holds a partial section: "${s.split('\n')[0]}"`);
    });
  });

  test('a spare rules command prints nothing', () => {
    const outs = outputs(world());
    const spare = commands('startup').findIndex((c) => c.endsWith(`--rules ${RULE_PARTS}`));
    if (rulesParts(RULES).length < RULE_PARTS) assert.equal(outs[spare], '');
  });

  test('the principles arrive whole, in an output of their own', () => {
    const outs = outputs(world());
    const at = outs.findIndex((o) => o.includes(PRINCIPLES));
    assert.ok(at >= 0, 'the principles print');
    const out = outs[at];
    assert.match(out, /<sdlc-harness-principles file="\/.+\/PRINCIPLES\.md">/);
    assert.match(out, /may narrow one with a named exception and its reason, never contradict it/);
    assert.match(out, /WCAG 2\.2 AA/);
    assert.match(out, /three real callers/);
    assert.match(out, /Test behavior, not implementation/);
    assert.doesNotMatch(out, /# SDLC rules/);
    assert.doesNotMatch(out, /\bSBOMs?\b|\bSLOs?\b|provenance|signed artifact|security scan/i);
  });

  test('the repo output carries the watch text, the protected paths, the helpers, and the config\'s people', () => {
    const repo = outputs(world()).find((o) => o.includes('<sdlc-harness-repo'));
    assert.match(repo, /Protected paths for this repo: services\/area-0\/migrations\//);
    assert.match(repo, /Intake and approval checks: node ".+\/policy\.mjs" check/);
    assert.match(repo, /GitHub helper: node ".+\/tracker\.mjs"/);
    assert.match(repo, /Approvers: @octo-lead, @second-lead, @third-lead\. Agent account: @acme-delivery-bot\./);
    assert.match(repo, /Commits name GH-<issue number>/);
    assert.match(repo, /ADHD style/);
    const cfg = normalizeConfig(HEAVY);
    for (const line of watchText(cfg)) assert.ok(repo.includes(line), `missing watch line: ${line}`);
  });

  test('the ADHD line prints only when the config asks for it', () => {
    const repo = outputs(world({ ...HEAVY, adhdStyle: false })).find((o) => o.includes('<sdlc-harness-repo'));
    assert.doesNotMatch(repo, /ADHD style/);
  });

  test('config problems are named in the repo output', () => {
    const repo = outputs(world({ ...HEAVY, approvers: [] })).find((o) => o.includes('<sdlc-harness-repo'));
    assert.match(repo, /Config problems \(approval fails closed until they are fixed\): approvers names no GitHub login/);
  });

  test('a config that is not JSON is reported by the repo output, and the rest print nothing', () => {
    const w = world(null);
    mkdirSync(join(w.repo, '.sdlc-harness'));
    writeFileSync(join(w.repo, '.sdlc-harness', 'sdlc.json'), '{ not json');
    const outs = outputs(w);
    const repo = outs.find((o) => o.includes('<sdlc-harness-repo'));
    assert.match(repo, /is not valid JSON/);
    assert.equal(outs.filter((o) => o && o !== repo).length, 0);
  });
});

describe('outside a managed repo, and a damaged plugin', () => {
  test('a repo the SDLC does not manage gets no output at all', () => {
    const w = world(null);
    for (const source of SOURCES) assert.deepEqual(outputs(w, source), commands(source).map(() => ''));
  });

  test('a missing PRINCIPLES.md is said, and the session still starts', () => {
    const w = world();
    const copy = join(w.root, 'plugin');
    cpSync(PLUGIN, copy, { recursive: true, filter: (src) => !src.endsWith('PRINCIPLES.md') });
    const r = spawnSync(process.execPath, [join(copy, 'hooks', 'session-start.mjs'), '--principles'], { input: JSON.stringify({ cwd: w.repo }), env: w.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<sdlc-harness-principles/);
    assert.match(r.stdout, /PRINCIPLES\.md is missing from the plugin/);
  });
});

describe('the splitter', () => {
  test('packs whole sections in order and starts a new part only when the next would pass the limit', () => {
    const text = ['# T\n\nintro', '## A\n' + 'a'.repeat(3000), '## B\n' + 'b'.repeat(3000), '## C\n' + 'c'.repeat(3000)].join('\n\n');
    const parts = rulesParts(text, 7000);
    assert.deepEqual(parts.map((p) => sections(p).map((s) => s.split('\n')[0])), [['# T', '## A', '## B'], ['## C']]);
    assert.equal(parts.join('\n\n'), text);
  });

  test('a section bigger than one output still gets its own part, so the size test can name it', () => {
    const text = ['# T', '## Huge\n' + 'h'.repeat(12_000), '## Small\nok'].join('\n\n');
    const parts = rulesParts(text);
    assert.equal(parts.length, 3);
    assert.ok(parts[1].length > OUTPUT_LIMIT);
  });
});
