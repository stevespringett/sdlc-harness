#!/usr/bin/env node
// Cuts a release so the version stays in sync everywhere it is written.
//
//   node scripts/release.mjs <x.y.z>        bump, date the changelog, commit, tag
//   node scripts/release.mjs <x.y.z> --dry-run   say what would change, change nothing
//   node scripts/release.mjs --check <x.y.z>     exit 1 unless every version file says x.y.z
//   node scripts/release.mjs --notes        print the newest changelog section
//
// The version lives only in the JSON files below, never in Markdown: the
// changelog's sections are dated, and the tag (vx.y.z) names the version.
// The script never pushes; `git push origin <branch> v<x.y.z>` is the
// person's step, and the release workflow builds the GitHub Release from the tag.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every place the version is written, as [file, path to the field]. */
export const VERSION_FIELDS = [
  ['package.json', ['version']],
  ['plugins/sdlc-harness/.claude-plugin/plugin.json', ['version']],
  ['.claude-plugin/marketplace.json', ['metadata', 'version']],
  ['.claude-plugin/marketplace.json', ['plugins', 0, 'version']],
];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED = '## Unreleased';

const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const writeJson = (root, file, data) => writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`);

/** Each version field with its current value. */
export function readVersions(root = ROOT) {
  return VERSION_FIELDS.map(([file, path]) => ({
    file,
    field: path.join('.'),
    version: path.reduce((v, k) => v?.[k], readJson(root, file)),
  }));
}

/** Writes `version` into every field. */
export function setVersion(root, version) {
  const files = new Map();
  for (const [file, path] of VERSION_FIELDS) {
    const data = files.get(file) ?? readJson(root, file);
    const parent = path.slice(0, -1).reduce((v, k) => v[k], data);
    parent[path.at(-1)] = version;
    files.set(file, data);
  }
  for (const [file, data] of files) writeJson(root, file, data);
}

/** True when `next` is a higher version than `current`. */
export function isNewer(next, current) {
  const a = next.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The changelog with its Unreleased section dated; throws when there is nothing to release. */
export function dateChangelog(text, date) {
  const lines = text.split('\n');
  const at = lines.indexOf(UNRELEASED);
  if (at === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section.`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  const body = lines.slice(at + 1, end === -1 ? undefined : end).join('\n').trim();
  if (!body) throw new Error(`The "${UNRELEASED}" section of CHANGELOG.md is empty.`);
  lines[at] = `## ${date}`;
  return lines.join('\n');
}

/** The body of the newest dated changelog section, for the release notes. */
export function latestNotes(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('## ') && l !== UNRELEASED);
  if (at === -1) return '';
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  return lines.slice(at + 1, end === -1 ? undefined : end).join('\n').trim();
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function check(version) {
  const wrong = readVersions().filter((v) => v.version !== version);
  if (wrong.length) fail(wrong.map((v) => `${v.file} ${v.field} is ${v.version}, not ${version}.`).join('\n'));
  console.log(`Every version field is ${version}.`);
}

function release(version, dryRun) {
  if (!SEMVER.test(version)) fail(`"${version}" is not a version of the form x.y.z.`);
  const versions = readVersions();
  const current = versions[0].version;
  if (versions.some((v) => v.version !== current)) fail(`The version fields disagree:\n${versions.map((v) => `  ${v.file} ${v.field}: ${v.version}`).join('\n')}`);
  if (!isNewer(version, current)) fail(`${version} is not newer than the current ${current}.`);

  const { defaultBranch = 'main' } = readJson(ROOT, '.sdlc-harness/sdlc.json');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== defaultBranch) fail(`Release from ${defaultBranch}; this checkout is on ${branch}.`);
  if (git('status', '--porcelain')) fail('The working tree has changes. Commit or remove them first.');
  if (git('tag', '--list', `v${version}`)) fail(`The tag v${version} already exists.`);

  const date = new Date().toISOString().slice(0, 10);
  let changelog;
  try {
    changelog = dateChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), date);
  } catch (e) {
    fail(e.message);
  }

  if (dryRun) {
    console.log(`Would set ${VERSION_FIELDS.length} version fields from ${current} to ${version}, date the Unreleased section ${date}, commit "Release ${version}", and tag v${version}.`);
    return;
  }
  setVersion(ROOT, version);
  writeFileSync(join(ROOT, 'CHANGELOG.md'), changelog);
  git('add', 'CHANGELOG.md', ...new Set(VERSION_FIELDS.map(([file]) => file)));
  git('commit', '-q', '-m', `Release ${version}`);
  git('tag', '-a', `v${version}`, '-m', `Release ${version}`);
  console.log(`Released ${version} locally. Push it with: git push origin ${defaultBranch} v${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--notes') console.log(latestNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')));
  else if (args[0] === '--check' && args[1]) check(args[1].replace(/^v/, ''));
  else if (args[0] && !args[0].startsWith('--')) release(args[0], args.includes('--dry-run'));
  else fail('Usage: node scripts/release.mjs <x.y.z> [--dry-run] | --check <x.y.z> | --notes');
}
