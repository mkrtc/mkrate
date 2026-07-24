#!/usr/bin/env bun

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, release, tmpdir, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PROTECTED_STORE_LIMITS,
  REQUIRED_COMMAND_IDS,
  SERVER_REQUIRED_CASES,
  assertArtifactSanitized,
  caseManifestHash,
  fingerprintProtectedStore,
  normalizeRelativePath,
  parseBunJUnit,
  sanitizePaths,
  sha256File,
  sha256Text,
  validateCommandEvidence,
  validateJUnitEvidence,
  validateSourceManifestProvenance,
  type CommandEvidence,
  type JUnitReport,
  type ProtectedStoreFingerprint,
} from './memory-platform-evidence-lib.ts';

const EXACT_BUN_VERSION = '1.3.10';
const REPOSITORY_SUITE = 'MemoryConnectionRepository — durability, security, recovery';
const CRASH_SUITE = 'A5 saga: exhaustive real crash + restart recovery matrix';
const MODE_CRASH_SUITE = 'A5 saga: setCredentialMode mode-only crash recovery';

const CRASH_CASES: ReadonlyArray<{ name: string; barriers: readonly string[] }> = [
  { name: 'create (no key)', barriers: ['config'] },
  { name: 'create (with key)', barriers: ['stage', 'config', 'credential'] },
  { name: 'setApiKey', barriers: ['credential', 'config'] },
  { name: 'replaceApiKey', barriers: ['stage', 'credential'] },
  { name: 'clearApiKey', barriers: ['config', 'credential'] },
  { name: 'deleteConnection', barriers: ['config', 'credential'] },
  { name: 'updateConfig (config-only)', barriers: ['config'] },
  { name: 'updateConfig + set key', barriers: ['stage', 'credential', 'config'] },
];

const SHARED_REQUIRED_CASES = [
  `${REPOSITORY_SUITE} > atomic writes leave no legacy fixed-name temporary file`,
  `${REPOSITORY_SUITE} > two real processes cannot both acknowledge create at the same root revision`,
  'SecureStorageBackend behavior > respects injected config directory for test isolation',
  'SecureStorageBackend behavior > throws in test mode when no override path is provided',
  'SecureStorageBackend behavior > allows default path via CRAFT_CONFIG_DIR override',
  'SagaJournalStore secrecy > a benign config-bearing entry is secret-free on disk',
  'secret hygiene > mid-saga: secret lives only in encrypted staging, never in the journal',
  'outer lease > concurrent operations are serialized (never overlap) under the lease',
  'outer lease > a space mutation cannot temporally overlap a credential saga (lease instrumentation)',
  ...CRASH_CASES.flatMap(({ name, barriers }) => barriers.flatMap(barrier =>
    (['before', 'after'] as const).map(phase => `${CRASH_SUITE} > ${name} — crash at ${barrier}:${phase} converges atomically`),
  )),
  `${MODE_CRASH_SUITE} > crash at config:before converges the mode and never touches the key`,
  `${MODE_CRASH_SUITE} > crash at config:after converges the mode and never touches the key`,
] as const;

const PLATFORM_REQUIRED_CASES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    `${REPOSITORY_SUITE} > POSIX capability — writes primary and backup with restrictive file modes`,
    `${REPOSITORY_SUITE} > POSIX capability — refuses to follow a symlinked primary`,
    `${REPOSITORY_SUITE} > POSIX capability — rejects a symlinked memory directory without writing outside configDir`,
    `${REPOSITORY_SUITE} > POSIX capability — access-denied primary cannot mutate from a stale backup`,
  ],
  linux: [
    `${REPOSITORY_SUITE} > POSIX capability — writes primary and backup with restrictive file modes`,
    `${REPOSITORY_SUITE} > POSIX capability — refuses to follow a symlinked primary`,
    `${REPOSITORY_SUITE} > POSIX capability — rejects a symlinked memory directory without writing outside configDir`,
    `${REPOSITORY_SUITE} > POSIX capability — access-denied primary cannot mutate from a stale backup`,
  ],
  win32: [
    `${REPOSITORY_SUITE} > Windows capability — rejects a junctioned memory directory without writing outside configDir`,
    `${REPOSITORY_SUITE} > Windows capability — ACL-denied primary cannot mutate from a stale backup`,
  ],
};

interface EvidenceReport {
  schemaVersion: 3;
  outcome: 'pass' | 'fail';
  evidenceMode: 'clean-tree-evidence' | 'local-preflight';
  generatedAt: string;
  failure?: string;
  git: {
    commit: string;
    tree: string;
    workingTreeClean: boolean;
    workingTreeStatusEntries: number;
    workingTreeStable: boolean;
  };
  runtime: {
    bun: string;
    requiredBun: string;
    platform: NodeJS.Platform;
    osRelease: string;
    osVersion: string;
    arch: string;
    runnerImage?: string;
    runnerImageVersion?: string;
  };
  commands: CommandEvidence[];
  capabilities: Array<{
    mechanism: string;
    exactCase: string;
    status: 'passed' | 'not-run';
  }>;
  tests?: {
    counts: JUnitReport['counts'];
    requiredCaseCount: number;
    requiredCases: string[];
    cases: JUnitReport['cases'];
  };
  protectedStore: {
    included: string[];
    limits: typeof DEFAULT_PROTECTED_STORE_LIMITS;
    before: ProtectedStoreFingerprint[];
    after: ProtectedStoreFingerprint[];
    unchanged: boolean;
  };
  hashes?: {
    bunLockSha256: string;
    sourceManifestSha256: string;
    sourceFiles: Array<{ path: string; sha256: string }>;
    caseManifestSha256: string;
    resultSha256: string;
  };
}

function outputDirectory(): string {
  const flagIndex = process.argv.findIndex(argument => argument === '--output-dir');
  const flagValue = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const equalsValue = process.argv.find(argument => argument.startsWith('--output-dir='))?.slice('--output-dir='.length);
  return resolve(flagValue ?? equalsValue ?? process.env.MEMORY_EVIDENCE_OUTPUT_DIR ?? join(tmpdir(), 'mkrate-memory-platform-evidence'));
}

function runGit(repositoryRoot: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? 'command'} failed`);
  return result.stdout.toString().trim();
}

function workingTreeStatus(repositoryRoot: string): string {
  return runGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
}

function trackedHeadPaths(repositoryRoot: string): ReadonlySet<string> {
  const output = runGit(repositoryRoot, ['ls-tree', '-r', '--name-only', 'HEAD']);
  return new Set(output.split(/\r?\n/).filter(Boolean).map(normalizeRelativePath));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function listSourceFiles(repositoryRoot: string): string[] {
  const result: string[] = [];
  const roots = [
    'packages/shared/src/project-memory',
    'packages/shared/src/credentials',
    'packages/server-core/src/handlers/rpc/projects-memory.test.ts',
    'packages/server-core/src/handlers/rpc/projects.ts',
    'packages/server-core/src/sessions/SessionManager.ts',
    'packages/server-core/src/sessions/session-memory-reconciliation.test.ts',
    'packages/server-core/src/sessions/session-memory-runtime.test.ts',
    'packages/server-core/src/sessions/session-memory-runtime.ts',
    'packages/core/package.json',
    'packages/core/tsconfig.json',
    'packages/shared/package.json',
    'packages/shared/tsconfig.json',
    'packages/server-core/package.json',
    'packages/server-core/tsconfig.json',
    'scripts/memory-platform-evidence.ts',
    'scripts/memory-platform-evidence-lib.ts',
    'scripts/__tests__/memory-platform-evidence-lib.test.ts',
    '.github/workflows/memory-platform-evidence.yml',
    'package.json',
    'bun.lock',
  ];
  const visit = (relativePath: string): void => {
    const absolutePath = join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) return;
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`source manifest refuses symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) visit(join(relativePath, entry));
    } else if (/\.(?:ts|tsx|json|ya?ml)$/.test(relativePath) || relativePath === 'bun.lock') {
      result.push(normalizeRelativePath(relativePath));
    }
  };
  for (const root of roots) visit(root);
  return [...new Set(result)].sort();
}

function sourceManifest(repositoryRoot: string): Array<{ path: string; sha256: string }> {
  return listSourceFiles(repositoryRoot).map(path => ({ path, sha256: sha256File(join(repositoryRoot, path)) }));
}

function isolatedEnvironment(sandboxConfigDir: string): Record<string, string> {
  const preserved = [
    'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS',
    'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'TZ',
  ];
  const env: Record<string, string> = {};
  for (const key of preserved) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: 'test',
    CRAFT_CONFIG_DIR: sandboxConfigDir,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function commandPlan(platformCases: readonly string[]): CommandEvidence[] {
  return [
    {
      id: 'shared-memory-tests',
      kind: 'test',
      cwd: '.',
      command: ['bun', 'test', 'packages/shared/src/project-memory/', 'packages/shared/src/credentials/'],
      status: 'not-run',
      exitCode: null,
      requiredCases: [...SHARED_REQUIRED_CASES, ...platformCases],
    },
    {
      id: 'server-memory-tests',
      kind: 'test',
      cwd: '.',
      command: [
        'bun', 'test',
        'packages/server-core/src/handlers/rpc/projects-memory.test.ts',
        'packages/server-core/src/sessions/session-memory-reconciliation.test.ts',
        'packages/server-core/src/sessions/session-memory-runtime.test.ts',
      ],
      status: 'not-run',
      exitCode: null,
      requiredCases: [...SERVER_REQUIRED_CASES],
    },
    {
      id: 'core-typecheck',
      kind: 'typecheck',
      cwd: 'packages/core',
      command: ['bun', 'run', 'tsc', '--noEmit'],
      status: 'not-run',
      exitCode: null,
    },
    {
      id: 'shared-typecheck',
      kind: 'typecheck',
      cwd: 'packages/shared',
      command: ['bun', 'run', 'tsc', '--noEmit'],
      status: 'not-run',
      exitCode: null,
    },
    {
      id: 'server-core-typecheck',
      kind: 'typecheck',
      cwd: 'packages/server-core',
      command: ['bun', 'run', 'tsc', '--noEmit'],
      status: 'not-run',
      exitCode: null,
    },
  ];
}

async function runRecordedCommand(
  command: CommandEvidence,
  repositoryRoot: string,
  tempRoot: string,
  env: Record<string, string>,
): Promise<string | null> {
  const actualCommand = [process.execPath, ...command.command.slice(1)];
  let junitPath: string | undefined;
  if (command.kind === 'test') {
    junitPath = join(tempRoot, `${command.id}.xml`);
    actualCommand.push('--reporter=junit', `--reporter-outfile=${junitPath}`);
  }
  const child = Bun.spawn(actualCommand, {
    cwd: resolve(repositoryRoot, command.cwd),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  void stdout;
  void stderr;
  command.exitCode = exitCode;

  if (command.kind === 'test') {
    if (!junitPath || !existsSync(junitPath)) {
      command.status = 'failed';
      return `${command.id} did not produce JUnit output`;
    }
    try {
      const junit = parseBunJUnit(readFileSync(junitPath, 'utf8'));
      command.counts = junit.counts;
      command.cases = junit.cases;
      validateJUnitEvidence(junit, command.requiredCases ?? []);
    } catch (error) {
      command.status = 'failed';
      return `${command.id}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  command.status = exitCode === 0 ? 'passed' : 'failed';
  return exitCode === 0 ? null : `${command.id} exited ${exitCode}`;
}

function aggregateTests(commands: readonly CommandEvidence[]): NonNullable<EvidenceReport['tests']> {
  const testCommands = commands.filter(command => command.kind === 'test');
  const cases = testCommands.flatMap(command => command.cases ?? []);
  const requiredCases = testCommands.flatMap(command => command.requiredCases ?? []);
  return {
    counts: {
      tests: testCommands.reduce((total, command) => total + (command.counts?.tests ?? 0), 0),
      assertions: testCommands.reduce((total, command) => total + (command.counts?.assertions ?? 0), 0),
      failures: testCommands.reduce((total, command) => total + (command.counts?.failures ?? 0), 0),
      skipped: testCommands.reduce((total, command) => total + (command.counts?.skipped ?? 0), 0),
    },
    requiredCaseCount: requiredCases.length,
    requiredCases,
    cases,
  };
}

function platformCapabilities(requiredCases: readonly string[], report?: JUnitReport): EvidenceReport['capabilities'] {
  return requiredCases.map(exactCase => ({
    mechanism: exactCase.includes('junction')
      ? 'windows-junction-containment'
      : exactCase.includes('ACL-denied')
        ? 'windows-acl-read-denial'
        : exactCase.includes('file modes')
          ? 'posix-restrictive-modes'
          : exactCase.includes('symlinked primary')
            ? 'posix-file-symlink-containment'
            : exactCase.includes('symlinked memory directory')
              ? 'posix-directory-symlink-containment'
              : 'posix-mode-read-denial',
    exactCase,
    status: report?.cases.some(testCase => testCase.fullName === exactCase && testCase.status === 'passed') ? 'passed' : 'not-run',
  }));
}

function markdown(report: EvidenceReport): string {
  const lines = [
    '# Cross-platform memory evidence',
    '',
    `- **Outcome:** ${report.outcome.toUpperCase()}`,
    `- **Mode:** ${report.evidenceMode}`,
    `- **Commit:** \`${report.git.commit}\``,
    `- **Git tree:** \`${report.git.tree}\``,
    `- **Platform:** ${report.runtime.platform} / ${report.runtime.arch}`,
    `- **OS:** ${report.runtime.osVersion} (${report.runtime.osRelease})`,
    `- **Bun:** ${report.runtime.bun} (required: ${report.runtime.requiredBun})`,
    `- **Working tree clean/stable:** ${report.git.workingTreeClean} / ${report.git.workingTreeStable}`,
    `- **Protected store unchanged:** ${report.protectedStore.unchanged}`,
  ];
  if (report.failure) lines.push(`- **Failure:** ${report.failure}`);
  if (report.tests) {
    lines.push(
      `- **Cases:** ${report.tests.counts.tests} total, ${report.tests.counts.failures} failed, ${report.tests.counts.skipped} skipped, ${report.tests.counts.assertions} assertions`,
      `- **Required exact cases:** ${report.tests.requiredCaseCount}/${report.tests.requiredCaseCount}`,
    );
  }
  if (report.hashes) {
    lines.push(
      `- **Source manifest SHA-256:** \`${report.hashes.sourceManifestSha256}\``,
      `- **Case manifest SHA-256:** \`${report.hashes.caseManifestSha256}\``,
      `- **Result SHA-256:** \`${report.hashes.resultSha256}\``,
      `- **bun.lock SHA-256:** \`${report.hashes.bunLockSha256}\``,
    );
  }
  lines.push('', '## Recorded commands', '');
  for (const command of report.commands) {
    const counts = command.counts ? `; ${command.counts.tests} tests, ${command.counts.failures} failures, ${command.counts.skipped} skips` : '';
    lines.push(`- **${command.status}:** \`${command.id}\` — exit ${command.exitCode ?? 'not-run'}${counts}`);
  }
  lines.push('', '## Platform capability cases', '');
  for (const capability of report.capabilities) {
    lines.push(`- **${capability.status}:** \`${capability.exactCase}\` (${capability.mechanism})`);
  }
  lines.push(
    '',
    '## Protected store boundary',
    '',
    ...report.protectedStore.included.map(path => `- \`${path}\``),
    '',
    '## Interpretation',
    '',
    report.evidenceMode === 'clean-tree-evidence'
      ? 'This is clean-tree evidence for the exact commit and runtime above.'
      : 'This is a local preflight over an intentionally dirty working tree. It is not clean-commit CI evidence.',
    'The JSON companion contains every exact test case, every recorded command, and per-source SHA-256 hashes. No aggregate historical total is used as a gate.',
    '',
  );
  return lines.join('\n');
}

function writeArtifacts(outputDir: string, report: EvidenceReport, forbiddenPaths: string[], secretValues: string[]): void {
  mkdirSync(outputDir, { recursive: true });
  const stem = `memory-platform-evidence-${report.runtime.platform}-${report.runtime.arch}`;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = markdown(report);
  assertArtifactSanitized(json, forbiddenPaths, secretValues);
  assertArtifactSanitized(md, forbiddenPaths, secretValues);
  writeFileSync(join(outputDir, `${stem}.json`), json, { mode: 0o600 });
  writeFileSync(join(outputDir, `${stem}.md`), md, { mode: 0o600 });
  console.log(`Wrote ${stem}.json and ${stem}.md`);
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, '..');
  const outputDir = outputDirectory();
  const tempRoot = mkdtempSync(join(tmpdir(), 'mkrate-memory-evidence-'));
  const realConfigDir = join(homedir(), '.craft-agent');
  const allowDirty = process.env.MEMORY_EVIDENCE_ALLOW_DIRTY === '1';
  const secretValues = Object.entries(process.env)
    .filter(([key, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key))
    .map(([, value]) => value!);
  const forbiddenPaths = [repositoryRoot, homedir(), tempRoot, outputDir];
  const roots = [
    { path: repositoryRoot, replacement: '<REPOSITORY>' },
    { path: realConfigDir, replacement: '<REAL_CONFIG_DIR>' },
    { path: homedir(), replacement: '<HOME>' },
    { path: tempRoot, replacement: '<EVIDENCE_TMP>' },
    { path: outputDir, replacement: '<OUTPUT_DIR>' },
  ];

  const initialStatus = workingTreeStatus(repositoryRoot);
  const commit = runGit(repositoryRoot, ['rev-parse', 'HEAD']);
  const tree = runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']);
  const currentPlatform = platform();
  const platformCases = PLATFORM_REQUIRED_CASES[currentPlatform] ?? [];
  const commands = commandPlan(platformCases);
  let beforeProtected: ProtectedStoreFingerprint[] = [];
  let report: EvidenceReport = {
    schemaVersion: 3,
    outcome: 'fail',
    evidenceMode: initialStatus ? 'local-preflight' : 'clean-tree-evidence',
    generatedAt: new Date().toISOString(),
    git: {
      commit,
      tree,
      workingTreeClean: initialStatus.length === 0,
      workingTreeStatusEntries: initialStatus ? initialStatus.split(/\r?\n/).length : 0,
      workingTreeStable: false,
    },
    runtime: {
      bun: Bun.version,
      requiredBun: EXACT_BUN_VERSION,
      platform: currentPlatform,
      osRelease: release(),
      osVersion: osVersion(),
      arch: arch(),
      ...(process.env.ImageOS ? { runnerImage: process.env.ImageOS } : {}),
      ...(process.env.ImageVersion ? { runnerImageVersion: process.env.ImageVersion } : {}),
    },
    commands,
    capabilities: platformCapabilities(platformCases),
    protectedStore: {
      included: [
        '<REAL_CONFIG_DIR>/config.json',
        '<REAL_CONFIG_DIR>/credentials.enc*',
        '<REAL_CONFIG_DIR>/memory/**',
      ],
      limits: DEFAULT_PROTECTED_STORE_LIMITS,
      before: [],
      after: [],
      unchanged: false,
    },
  };

  let failure: unknown;
  try {
    if (!['linux', 'darwin', 'win32'].includes(currentPlatform)) {
      throw new Error(`unsupported evidence platform: ${currentPlatform}`);
    }
    if (Bun.version !== EXACT_BUN_VERSION) {
      throw new Error(`Bun version mismatch: required ${EXACT_BUN_VERSION}, found ${Bun.version}`);
    }
    if (initialStatus && !allowDirty) {
      throw new Error('working tree is dirty; clean-tree evidence requires no staged, unstaged, or non-ignored untracked changes');
    }

    beforeProtected = fingerprintProtectedStore(realConfigDir);
    report.protectedStore.before = beforeProtected;
    const sources = sourceManifest(repositoryRoot);
    validateSourceManifestProvenance(sources.map(source => source.path), trackedHeadPaths(repositoryRoot));
    const env = isolatedEnvironment(join(tempRoot, 'isolated-config'));
    const commandFailures: string[] = [];
    for (const command of commands) {
      const commandFailure = await runRecordedCommand(command, repositoryRoot, tempRoot, env);
      if (commandFailure) commandFailures.push(commandFailure);
    }
    if (commandFailures.length > 0) throw new Error(commandFailures.join('; '));
    validateCommandEvidence(commands);

    const finalStatus = workingTreeStatus(repositoryRoot);
    if (finalStatus !== initialStatus) throw new Error('working tree changed while collecting evidence');
    const afterProtected = fingerprintProtectedStore(realConfigDir);
    const protectedStoreUnchanged = stableJson(beforeProtected) === stableJson(afterProtected);
    if (!protectedStoreUnchanged) throw new Error('protected real config/credential/memory store changed while collecting evidence');

    const tests = aggregateTests(commands);
    const sharedCommand = commands.find(command => command.id === 'shared-memory-tests');
    const sharedJunit: JUnitReport | undefined = sharedCommand?.counts && sharedCommand.cases
      ? { counts: sharedCommand.counts, cases: sharedCommand.cases }
      : undefined;
    const sourceManifestSha256 = sha256Text(`${sources.map(file => `${file.path}\0${file.sha256}`).join('\n')}\n`);
    const caseHash = caseManifestHash(tests.cases);
    const resultHash = sha256Text(stableJson({
      commit,
      tree,
      runtime: report.runtime,
      commands,
      counts: tests.counts,
      requiredCases: tests.requiredCases,
      sourceManifestSha256,
      caseHash,
      protectedStore: afterProtected,
    }));

    report = {
      ...report,
      outcome: 'pass',
      git: { ...report.git, workingTreeStable: true },
      capabilities: platformCapabilities(platformCases, sharedJunit),
      tests,
      protectedStore: {
        ...report.protectedStore,
        before: beforeProtected,
        after: afterProtected,
        unchanged: true,
      },
      hashes: {
        bunLockSha256: sha256File(join(repositoryRoot, 'bun.lock')),
        sourceManifestSha256,
        sourceFiles: sources,
        caseManifestSha256: caseHash,
        resultSha256: resultHash,
      },
    };
  } catch (error) {
    failure = error;
    let afterProtected: ProtectedStoreFingerprint[] = [];
    let fingerprintFailure: string | undefined;
    try {
      afterProtected = fingerprintProtectedStore(realConfigDir);
    } catch (fingerprintError) {
      fingerprintFailure = fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError);
    }
    const finalStatus = workingTreeStatus(repositoryRoot);
    const baseFailure = error instanceof Error ? error.message : String(error);
    report = {
      ...report,
      failure: sanitizePaths(fingerprintFailure ? `${baseFailure}; ${fingerprintFailure}` : baseFailure, roots),
      git: { ...report.git, workingTreeStable: finalStatus === initialStatus },
      tests: aggregateTests(commands),
      protectedStore: {
        ...report.protectedStore,
        before: beforeProtected,
        after: afterProtected,
        unchanged: fingerprintFailure === undefined && stableJson(beforeProtected) === stableJson(afterProtected),
      },
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  writeArtifacts(outputDir, report, forbiddenPaths, secretValues);
  if (failure) throw new Error(report.failure);
  console.log(`${report.outcome.toUpperCase()}: ${report.tests?.counts.tests ?? 0} exact cases and ${REQUIRED_COMMAND_IDS.length} commands on ${currentPlatform}/${arch()} with Bun ${Bun.version}`);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
