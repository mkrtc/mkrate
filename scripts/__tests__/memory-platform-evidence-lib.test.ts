import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REQUIRED_COMMAND_IDS,
  SERVER_REQUIRED_CASES,
  assertArtifactSanitized,
  caseManifestHash,
  fingerprintProtectedStore,
  parseBunJUnit,
  sanitizePaths,
  validateCommandEvidence,
  validateJUnitEvidence,
  validateSourceManifestProvenance,
  type CommandEvidence,
  type JUnitCase,
  type JUnitReport,
} from '../memory-platform-evidence-lib.ts';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="3" failures="0" skipped="0" time="0.1">
  <testsuite name="suite.ts" tests="2" assertions="3" failures="0" skipped="0">
    <testsuite name="security &amp; durability" tests="2" assertions="3" failures="0" skipped="0">
      <testcase name="rejects &quot;unsafe&quot; input" classname="security &amp; durability" file="suite.ts" assertions="2" />
      <testcase name="serializes two processes" classname="security &amp; durability" file="suite.ts" assertions="1" />
    </testsuite>
  </testsuite>
</testsuites>`;

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-evidence-lib-'));
  tempRoots.push(root);
  return root;
}

function passingReport(names: readonly string[]): JUnitReport {
  const cases: JUnitCase[] = names.map(fullName => {
    const separator = fullName.indexOf(' > ');
    return {
      classname: fullName.slice(0, separator),
      name: fullName.slice(separator + 3),
      fullName,
      status: 'passed',
    };
  });
  return {
    counts: { tests: cases.length, assertions: cases.length, failures: 0, skipped: 0 },
    cases,
  };
}

function passingCommands(): CommandEvidence[] {
  const testReport = passingReport(['suite > required']);
  return REQUIRED_COMMAND_IDS.map(id => ({
    id,
    kind: id.endsWith('-tests') ? 'test' : 'typecheck',
    cwd: '.',
    command: ['bun', id.endsWith('-tests') ? 'test' : 'run', id],
    status: 'passed',
    exitCode: 0,
    ...(id.endsWith('-tests') ? {
      counts: testReport.counts,
      cases: testReport.cases,
      requiredCases: ['suite > required'],
    } : {}),
  }));
}

describe('memory platform evidence library', () => {
  test('parses Bun JUnit counts and exact decoded case names', () => {
    const report = parseBunJUnit(JUNIT);
    expect(report.counts).toEqual({ tests: 2, assertions: 3, failures: 0, skipped: 0 });
    expect(report.cases.map(testCase => testCase.fullName)).toEqual([
      'security & durability > rejects "unsafe" input',
      'security & durability > serializes two processes',
    ]);
    validateJUnitEvidence(report, ['security & durability > serializes two processes']);
  });

  test('rejects skips, missing required cases, and duplicate exact names', () => {
    const report = parseBunJUnit(JUNIT);
    expect(() => validateJUnitEvidence(report, ['missing > case'])).toThrow(/missing required exact case/);

    const skipped = JUNIT
      .replace('skipped="0"', 'skipped="1"')
      .replace('<testcase name="serializes two processes" classname="security &amp; durability" file="suite.ts" assertions="1" />', '<testcase name="serializes two processes" classname="security &amp; durability" file="suite.ts" assertions="1"><skipped /></testcase>');
    expect(() => validateJUnitEvidence(parseBunJUnit(skipped), [])).toThrow(/unexpected skip/);

    const duplicate = parseBunJUnit(JUNIT);
    duplicate.cases[1] = { ...duplicate.cases[0]! };
    expect(() => validateJUnitEvidence(duplicate, [])).toThrow(/duplicate case/);
  });

  test('enforces every exact critical server case', () => {
    const complete = passingReport(SERVER_REQUIRED_CASES);
    expect(() => validateJUnitEvidence(complete, SERVER_REQUIRED_CASES)).not.toThrow();
    expect(() => validateJUnitEvidence(
      passingReport(SERVER_REQUIRED_CASES.slice(0, -1)),
      SERVER_REQUIRED_CASES,
    )).toThrow(/missing required exact case/);
  });

  test('requires one passing structured record for every evidence command', () => {
    const commands = passingCommands();
    expect(() => validateCommandEvidence(commands)).not.toThrow();
    expect(() => validateCommandEvidence(commands.slice(1))).toThrow(/missing required command/);

    const failed = passingCommands();
    failed[2] = { ...failed[2]!, status: 'failed', exitCode: 1 };
    expect(() => validateCommandEvidence(failed)).toThrow(/required command did not pass/);

    const unstructured = passingCommands();
    unstructured[0] = { ...unstructured[0]!, cases: undefined };
    expect(() => validateCommandEvidence(unstructured)).toThrow(/missing structured JUnit evidence/);
  });

  test('rejects untracked or duplicate source-manifest provenance', () => {
    const tracked = new Set(['tracked.ts', 'nested/tracked.test.ts']);
    expect(() => validateSourceManifestProvenance(['tracked.ts', 'nested/tracked.test.ts'], tracked)).not.toThrow();
    expect(() => validateSourceManifestProvenance(['tracked.ts', 'untracked.test.ts'], tracked)).toThrow(/not tracked in HEAD/);
    expect(() => validateSourceManifestProvenance(['tracked.ts', 'tracked.ts'], tracked)).toThrow(/duplicate path/);
  });

  test('fingerprints config, credential variants, and memory recursively with sanitized paths', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'memory', 'nested'), { recursive: true });
    writeFileSync(join(root, 'config.json'), 'config-v1');
    writeFileSync(join(root, 'credentials.enc'), 'credential-v1');
    writeFileSync(join(root, 'credentials.enc.quarantine'), 'credential-q');
    writeFileSync(join(root, 'memory', 'nested', 'journal.json'), 'journal-v1');
    writeFileSync(join(root, 'ignored-session.json'), 'volatile');

    const first = fingerprintProtectedStore(root);
    expect(first.map(entry => entry.path)).toEqual([
      '<REAL_CONFIG_DIR>/config.json',
      '<REAL_CONFIG_DIR>/credentials.enc',
      '<REAL_CONFIG_DIR>/credentials.enc.quarantine',
      '<REAL_CONFIG_DIR>/memory',
      '<REAL_CONFIG_DIR>/memory/nested',
      '<REAL_CONFIG_DIR>/memory/nested/journal.json',
    ]);
    expect(JSON.stringify(first)).not.toContain(root);

    writeFileSync(join(root, 'memory', 'nested', 'journal.json'), 'journal-v2');
    expect(fingerprintProtectedStore(root)).not.toEqual(first);
    unlinkSync(join(root, 'credentials.enc.quarantine'));
    expect(fingerprintProtectedStore(root).some(entry => entry.path.endsWith('credentials.enc.quarantine'))).toBe(false);
    writeFileSync(join(root, 'credentials.enc.recovered'), 'new-file');
    expect(fingerprintProtectedStore(root).some(entry => entry.path.endsWith('credentials.enc.recovered'))).toBe(true);
  });

  test('protected-store traversal is bounded and refuses symlinks', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory', 'large'), '12345');
    expect(() => fingerprintProtectedStore(root, {
      maxFiles: 10,
      maxFileBytes: 4,
      maxTotalBytes: 10,
      maxDepth: 4,
    })).toThrow(/per-file byte limit/);

    unlinkSync(join(root, 'memory', 'large'));
    const target = join(root, 'target');
    writeFileSync(target, 'target');
    symlinkSync(target, join(root, 'memory', 'link'));
    expect(() => fingerprintProtectedStore(root)).toThrow(/refuses symlink/);
  });

  test('sanitizes known roots and rejects raw paths or secret-like environment values', () => {
    const home = '/home/example';
    const repo = '/home/example/project';
    const sanitized = sanitizePaths(
      `failure at ${repo}/file.ts under ${home}`,
      [
        { path: repo, replacement: '<REPOSITORY>' },
        { path: home, replacement: '<HOME>' },
      ],
    );
    expect(sanitized).toBe('failure at <REPOSITORY>/file.ts under <HOME>');
    expect(() => assertArtifactSanitized(sanitized, [home, repo], ['production-token-value'])).not.toThrow();
    expect(() => assertArtifactSanitized('token=production-token-value', [], ['production-token-value'])).toThrow(/secret-like/);
    expect(() => assertArtifactSanitized('value=sk-example123', [], [])).toThrow(/secret-shaped/);
    expect(() => assertArtifactSanitized('Authorization: Bearer example.token.value', [], [])).toThrow(/secret-shaped/);
  });

  test('case manifest hash is stable across report order', () => {
    const report = parseBunJUnit(JUNIT);
    expect(caseManifestHash(report.cases)).toBe(caseManifestHash([...report.cases].reverse()));
  });
});
