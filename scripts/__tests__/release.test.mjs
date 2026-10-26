// Tests for the release script, and the two rules it exists for: every
// version field agrees, and no Markdown file names a version.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ROOT, VERSION_FIELDS, readVersions, setVersion, isNewer, dateChangelog, latestNotes } from '../release.mjs';

describe('the repo', () => {
  it('writes one version in every version field', () => {
    const versions = readVersions();
    assert.equal(versions.length, VERSION_FIELDS.length);
    for (const v of versions) assert.match(String(v.version), /^\d+\.\d+\.\d+$/, `${v.file} ${v.field}`);
    assert.equal(new Set(versions.map((v) => v.version)).size, 1, versions.map((v) => `${v.file} ${v.field}: ${v.version}`).join('\n'));
  });

  it('names no version in any Markdown file', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const hits = [];
    for (const file of files) {
      readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        if (/(^|[^\w.])v?\d+\.\d+\.\d+(?![\w.])/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(hits, []);
  });
});

describe('setVersion', () => {
  it('writes every field and keeps the rest of each file', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-'));
    for (const [file] of VERSION_FIELDS) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), readFileSync(join(ROOT, file)));
    }
    setVersion(root, '9.8.7');
    assert.ok(readVersions(root).every((v) => v.version === '9.8.7'));
    const before = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const after = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.deepEqual({ ...after, version: before.version }, before);
  });
});

describe('isNewer', () => {
  it('compares each part as a number', () => {
    assert.equal(isNewer('0.10.0', '0.9.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.1.0', '0.1.0'), false);
    assert.equal(isNewer('0.1.0', '0.2.0'), false);
  });
});

describe('the changelog', () => {
  const log = '# Changelog\n\n## Unreleased\n\n- New thing.\n\n## 2026-10-20\n\n- First release.\n';

  it('dates the Unreleased section and leaves the others', () => {
    assert.equal(dateChangelog(log, '2026-11-01'), '# Changelog\n\n## 2026-11-01\n\n- New thing.\n\n## 2026-10-20\n\n- First release.\n');
  });

  it('refuses a release with no Unreleased section, or an empty one', () => {
    assert.throws(() => dateChangelog('# Changelog\n\n## 2026-10-20\n\n- x\n', '2026-11-01'), /no "## Unreleased"/);
    assert.throws(() => dateChangelog('# Changelog\n\n## Unreleased\n\n## 2026-10-20\n\n- x\n', '2026-11-01'), /empty/);
  });

  it('gives the newest dated section as the release notes', () => {
    assert.equal(latestNotes(log), '- First release.');
    assert.equal(latestNotes(dateChangelog(log, '2026-11-01')), '- New thing.');
  });
});
