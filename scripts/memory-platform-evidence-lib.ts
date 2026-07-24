import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_REQUIRED_CASES = [
  'project memory RPC handlers > enforces root and connection revision guards across connection/space mutations',
  'project memory RPC handlers > routes space mutations through the coordinator: a space create racing a credential update serializes',
  'project memory RPC handlers > fails closed at the server gate when an orphan saga staging secret has no journal entry',
  'project memory RPC handlers > fails closed when startup saga recovery cannot complete (corrupt journal)',
  'SessionManager external Memory reconciliation > a fresh manager persistence cannot re-persist stale local A over existing disk B',
  'Session memory runtime selection helpers > rejects non-member references without invoking credential callbacks',
] as const;

export const REQUIRED_COMMAND_IDS = [
  'shared-memory-tests',
  'server-memory-tests',
  'core-typecheck',
  'shared-typecheck',
  'server-core-typecheck',
] as const;

export interface CommandEvidence {
  id: typeof REQUIRED_COMMAND_IDS[number];
  kind: 'test' | 'typecheck';
  cwd: string;
  command: string[];
  status: 'passed' | 'failed' | 'not-run';
  exitCode: number | null;
  counts?: JUnitReport['counts'];
  requiredCases?: string[];
  cases?: JUnitCase[];
}

export interface ProtectedStoreFingerprint {
  path: string;
  kind: 'file' | 'directory';
  bytes?: number;
  sha256: string;
}

export interface ProtectedStoreLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const DEFAULT_PROTECTED_STORE_LIMITS: ProtectedStoreLimits = {
  maxFiles: 2_048,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 32,
};

export const MAX_JUNIT_FAILURE_TYPE_CHARS = 128;
export const MAX_JUNIT_FAILURE_MESSAGE_CHARS = 512;

export interface JUnitFailureDiagnostic {
  kind: 'failure' | 'error';
  type?: string;
  message?: string;
  typeTruncated?: boolean;
  messageTruncated?: boolean;
}

export interface JUnitCase {
  classname: string;
  name: string;
  fullName: string;
  file?: string;
  status: 'passed' | 'failed' | 'skipped';
  failure?: JUnitFailureDiagnostic;
}

export interface JUnitReport {
  counts: {
    tests: number;
    assertions: number;
    failures: number;
    skipped: number;
  };
  cases: JUnitCase[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]!] = decodeXml(match[2]!);
  }
  return attributes;
}

function parseCount(attributes: Record<string, string>, key: string): number {
  const value = Number(attributes[key]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`JUnit root has invalid ${key} count`);
  }
  return value;
}

/** Parse the stable JUnit shape emitted by `bun test --reporter=junit`. */
export function parseBunJUnit(xml: string): JUnitReport {
  const root = xml.match(/<testsuites\b((?:"[^"]*"|[^>])*)>/);
  if (!root) throw new Error('JUnit report is missing the testsuites root');
  const rootAttributes = parseAttributes(root[1]!);
  const counts = {
    tests: parseCount(rootAttributes, 'tests'),
    assertions: parseCount(rootAttributes, 'assertions'),
    failures: parseCount(rootAttributes, 'failures'),
    skipped: parseCount(rootAttributes, 'skipped'),
  };

  const cases: JUnitCase[] = [];
  const testcasePattern = /<testcase\b((?:"[^"]*"|[^>])*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcasePattern)) {
    const attributes = parseAttributes(match[1]!);
    const name = attributes.name;
    const classname = attributes.classname;
    if (!name || !classname) throw new Error('JUnit testcase is missing name or classname');
    const body = match[2] ?? '';
    const failureElement = body.match(/<(failure|error)\b((?:"[^"]*"|[^>])*)\/?\s*>/);
    const status = failureElement
      ? 'failed'
      : /<skipped\b/.test(body)
        ? 'skipped'
        : 'passed';
    let failure: JUnitFailureDiagnostic | undefined;
    if (failureElement) {
      const failureAttributes = parseAttributes(failureElement[2] ?? '');
      failure = {
        kind: failureElement[1] as JUnitFailureDiagnostic['kind'],
        ...(failureAttributes.type ? { type: failureAttributes.type } : {}),
        ...(failureAttributes.message ? { message: failureAttributes.message } : {}),
      };
    }
    cases.push({
      classname,
      name,
      fullName: `${classname} > ${name}`,
      ...(attributes.file ? { file: normalizeRelativePath(attributes.file) } : {}),
      status,
      ...(failure ? { failure } : {}),
    });
  }

  if (cases.length !== counts.tests) {
    throw new Error(`JUnit testcase count mismatch: root=${counts.tests}, parsed=${cases.length}`);
  }
  return { counts, cases };
}

export function validateJUnitEvidence(report: JUnitReport, requiredCases: readonly string[]): void {
  if (report.counts.failures !== 0) {
    throw new Error(`test report contains ${report.counts.failures} failure(s)`);
  }
  if (report.counts.skipped !== 0) {
    throw new Error(`test report contains ${report.counts.skipped} unexpected skip(s)`);
  }
  const failed = report.cases.filter(testCase => testCase.status !== 'passed');
  if (failed.length > 0) {
    throw new Error(`test report contains non-passing case: ${failed[0]!.fullName}`);
  }

  const occurrences = new Map<string, number>();
  for (const testCase of report.cases) {
    occurrences.set(testCase.fullName, (occurrences.get(testCase.fullName) ?? 0) + 1);
  }
  for (const [name, count] of occurrences) {
    if (count !== 1) throw new Error(`test report contains duplicate case (${count}x): ${name}`);
  }
  for (const required of requiredCases) {
    if ((occurrences.get(required) ?? 0) !== 1) {
      throw new Error(`test report is missing required exact case: ${required}`);
    }
  }
}

export function validateCommandEvidence(commands: readonly CommandEvidence[]): void {
  const occurrences = new Map<string, number>();
  for (const command of commands) {
    occurrences.set(command.id, (occurrences.get(command.id) ?? 0) + 1);
  }
  for (const id of REQUIRED_COMMAND_IDS) {
    if ((occurrences.get(id) ?? 0) !== 1) throw new Error(`evidence is missing required command: ${id}`);
  }
  for (const [id, count] of occurrences) {
    if (count !== 1) throw new Error(`evidence contains duplicate command (${count}x): ${id}`);
  }
  for (const command of commands) {
    if (command.status !== 'passed' || command.exitCode !== 0) {
      throw new Error(`required command did not pass: ${command.id}`);
    }
    if (command.kind === 'test') {
      if (!command.counts || !command.cases || !command.requiredCases) {
        throw new Error(`test command is missing structured JUnit evidence: ${command.id}`);
      }
      validateJUnitEvidence({ counts: command.counts, cases: command.cases }, command.requiredCases);
    }
  }
}

export function validateSourceManifestProvenance(
  sourceFiles: readonly string[],
  trackedHeadPaths: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const rawPath of sourceFiles) {
    const path = normalizeRelativePath(rawPath);
    if (seen.has(path)) throw new Error(`source manifest contains duplicate path: ${path}`);
    seen.add(path);
    if (!trackedHeadPaths.has(path)) {
      throw new Error(`source manifest file is not tracked in HEAD: ${path}`);
    }
  }
}

export function fingerprintProtectedStore(
  realConfigDir: string,
  limits: ProtectedStoreLimits = DEFAULT_PROTECTED_STORE_LIMITS,
): ProtectedStoreFingerprint[] {
  let rootStat;
  try {
    rootStat = lstatSync(realConfigDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (rootStat.isSymbolicLink()) throw new Error('protected store root must not be a symlink');
  if (!rootStat.isDirectory()) throw new Error('protected store root is not a directory');

  const fingerprints: ProtectedStoreFingerprint[] = [];
  let totalBytes = 0;

  const record = (relativePath: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error('protected store exceeds maximum traversal depth');
    const absolutePath = join(realConfigDir, relativePath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`protected store refuses symlink: ${normalizeRelativePath(relativePath)}`);
    if (fingerprints.length >= limits.maxFiles) throw new Error('protected store exceeds maximum entry count');
    const path = `<REAL_CONFIG_DIR>/${normalizeRelativePath(relativePath)}`;
    if (stat.isDirectory()) {
      fingerprints.push({ path, kind: 'directory', sha256: sha256Text('directory') });
      for (const child of readdirSync(absolutePath).sort()) record(join(relativePath, child), depth + 1);
      return;
    }
    if (!stat.isFile()) throw new Error(`protected store contains unsupported entry: ${normalizeRelativePath(relativePath)}`);
    if (stat.size > limits.maxFileBytes) throw new Error(`protected store file exceeds per-file byte limit: ${normalizeRelativePath(relativePath)}`);
    totalBytes += stat.size;
    if (totalBytes > limits.maxTotalBytes) throw new Error('protected store exceeds total byte limit');
    fingerprints.push({ path, kind: 'file', bytes: stat.size, sha256: sha256File(absolutePath) });
  };

  record('config.json', 0);
  for (const name of readdirSync(realConfigDir).filter(name => name === 'credentials.enc' || name.startsWith('credentials.enc.')).sort()) {
    record(name, 0);
  }
  record('memory', 0);
  return fingerprints.sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function caseManifestHash(cases: readonly JUnitCase[]): string {
  const canonical = [...cases]
    .map(testCase => `${testCase.fullName}\0${testCase.status}`)
    .sort()
    .join('\n');
  return sha256Text(`${canonical}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PhysicalTempEnvironment {
  root: string;
  childTempRoot: string;
}

/** Create the evidence sandbox and child temp directory beneath a physical OS temp path. */
export function createPhysicalTempEnvironment(
  osTempDirectory: string,
  prefix = 'mkrate-memory-evidence-',
): PhysicalTempEnvironment {
  const physicalTempDirectory = realpathSync.native(osTempDirectory);
  const root = realpathSync.native(mkdtempSync(join(physicalTempDirectory, prefix)));
  const childTempRoot = join(root, 'tmp');
  mkdirSync(childTempRoot, { recursive: true });
  return { root, childTempRoot: realpathSync.native(childTempRoot) };
}

/** Replace known absolute roots in diagnostic text before it can enter an artifact. */
export function sanitizePaths(text: string, roots: ReadonlyArray<{ path: string; replacement: string }>): string {
  let sanitized = text;
  const variants = roots.flatMap(({ path, replacement }) => {
    const forward = path.replaceAll('\\', '/').replace(/\/$/, '');
    const backward = forward.replaceAll('/', '\\');
    return [
      { value: path.replace(/[\\/]$/, ''), replacement },
      { value: forward, replacement },
      { value: backward, replacement },
    ];
  });
  variants.sort((a, b) => b.value.length - a.value.length);
  for (const { value, replacement } of variants) {
    if (!value) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'gi'), replacement);
  }
  return sanitized;
}

function containsSecretMaterial(text: string, secretValues: readonly string[]): boolean {
  if (secretValues.some(value => value.length >= 8 && text.includes(value))) return true;
  return /\bsk-[A-Za-z0-9_-]{4,}\b/i.test(text)
    || /\bbearer\s+[A-Za-z0-9._~-]{8,}\b/i.test(text)
    || /\b(?:api[_-]?key|token|password|credential|secret)\s*[:=]\s*[^\s,;]{8,}/i.test(text);
}

function redactUnknownAbsolutePaths(text: string): string {
  const uncRedacted = text
    .replace(/(?:\\\\\?\\|\\\\)[^\s"'<>]*/g, '<ABSOLUTE_PATH>')
    .replace(/\/\/[^\s"'<>]*/g, '<ABSOLUTE_PATH>');
  const driveRedacted = uncRedacted.replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '<ABSOLUTE_PATH>');
  return driveRedacted.replace(/(?<![A-Za-z0-9_>])\/(?!\/)[^\s"'<>]*/g, '<ABSOLUTE_PATH>');
}

function bounded(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  return { value: value.slice(0, maximum), truncated: true };
}

/**
 * Sanitize only structured JUnit failure attributes. Failure bodies and process
 * output never enter this function or the artifact.
 */
export function sanitizeJUnitFailureDiagnostics(
  report: JUnitReport,
  roots: ReadonlyArray<{ path: string; replacement: string }>,
  secretValues: readonly string[],
): JUnitReport {
  const cases = report.cases.map(testCase => {
    if (!testCase.failure) return { ...testCase };
    const failure: JUnitFailureDiagnostic = { kind: testCase.failure.kind };

    if (testCase.failure.type && !containsSecretMaterial(testCase.failure.type, secretValues)) {
      const cleaned = testCase.failure.type.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (/^[A-Za-z0-9_.:$ -]+$/.test(cleaned)) {
        const limited = bounded(cleaned, MAX_JUNIT_FAILURE_TYPE_CHARS);
        failure.type = limited.value;
        if (limited.truncated) failure.typeTruncated = true;
      }
    }

    if (testCase.failure.message && !containsSecretMaterial(testCase.failure.message, secretValues)) {
      const withoutControls = testCase.failure.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      const cleaned = redactUnknownAbsolutePaths(sanitizePaths(withoutControls, roots));
      if (!containsSecretMaterial(cleaned, secretValues)) {
        const limited = bounded(cleaned, MAX_JUNIT_FAILURE_MESSAGE_CHARS);
        failure.message = limited.value;
        if (limited.truncated) failure.messageTruncated = true;
      }
    }

    return { ...testCase, failure };
  });
  return { counts: { ...report.counts }, cases };
}

export function assertArtifactSanitized(
  content: string,
  forbiddenPaths: readonly string[],
  forbiddenSecretValues: readonly string[],
): void {
  for (const path of forbiddenPaths) {
    const variants = [path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')].filter(Boolean);
    if (variants.some(variant => content.toLowerCase().includes(variant.toLowerCase()))) {
      throw new Error('evidence artifact contains an unsanitized absolute path');
    }
  }
  for (const value of forbiddenSecretValues) {
    if (value.length >= 8 && content.includes(value)) {
      throw new Error('evidence artifact contains a value sourced from a secret-like environment variable');
    }
  }
  if (containsSecretMaterial(content, [])) {
    throw new Error('evidence artifact contains secret-shaped material');
  }
}
