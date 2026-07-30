import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXPECTED_RELEASE_ASSETS = [
  'Mkrate-x64.AppImage',
  'latest-linux.yml',
  'Mkrate-arm64.dmg',
  'Mkrate-arm64.zip',
  'Mkrate-arm64.dmg.blockmap',
  'Mkrate-arm64.zip.blockmap',
  'latest-mac.yml',
  'Mkrate-x64.dmg',
  'Mkrate-x64.zip',
  'Mkrate-x64.dmg.blockmap',
  'Mkrate-x64.zip.blockmap',
  'Mkrate-x64.exe',
  'Mkrate-x64.exe.blockmap',
  'latest.yml',
] as const;

export const PRETAG_ATTESTATION_SCHEMA = 'mkrate-electron-pretag-evidence/v1';
export const PRETAG_WORKFLOW_PATH = '.github/workflows/electron-pretag-evidence.yml';
export const RELEASE_ASSET_FINGERPRINT_SCHEMA = 'mkrate-github-release-assets/v1';

export type NormalizedReleaseAsset = {
  id: number;
  name: string;
  size: number;
  state: 'uploaded';
  digest: string | null;
};

export type ReleaseAssetFingerprint = {
  schema: typeof RELEASE_ASSET_FINGERPRINT_SCHEMA;
  fingerprint: string;
  assets: NormalizedReleaseAsset[];
};

export type EvidenceAsset = {
  name: string;
  size: number;
  sha256: string;
};

export type PretagEvidenceAttestation = {
  schema: typeof PRETAG_ATTESTATION_SCHEMA;
  repository: string;
  workflow: typeof PRETAG_WORKFLOW_PATH;
  commit_sha: string;
  version: string;
  run_id: string;
  run_attempt: number;
  asset_contract: {
    count: number;
    fingerprint: string;
    assets: EvidenceAsset[];
  };
};

type CreateAttestationOptions = {
  assetDir: string;
  commitSha: string;
  version: string;
  repository: string;
  runId: string;
  runAttempt: number;
};

type VerifyAttestationOptions = Omit<CreateAttestationOptions, 'assetDir'>;

type VerifyReleaseOptions = {
  release: unknown;
  apiAssets: unknown;
  notesBody: string;
  tag: string;
  targetCommitish: string;
  releaseId: number;
  runId: string;
  state: 'draft' | 'public';
  expectedAssetFingerprint?: string;
  latest?: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, context: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${context} must be an object`);
  return value as Record<string, unknown>;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertExactAssetNames(names: readonly string[], context: string): void {
  assert(new Set(names).size === names.length, `${context} names must be unique`);
  assert(
    JSON.stringify(sorted(names)) === JSON.stringify(sorted(EXPECTED_RELEASE_ASSETS)),
    `${context} set is not exact: ${names.join(', ')}`,
  );
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function assertCommitSha(value: string, context: string): void {
  assert(/^[0-9a-f]{40}$/.test(value), `${context} must be a lowercase full commit SHA: ${value}`);
}

function assertVersion(value: string): void {
  assert(/^\d+\.\d+\.\d+$/.test(value), `version must be MAJOR.MINOR.PATCH: ${value}`);
}

function assertRepository(value: string): void {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), `repository must be owner/name: ${value}`);
}

function assertRunId(value: string): void {
  assert(/^[1-9][0-9]*$/.test(value), `run id must be a positive integer string: ${value}`);
}

function assertRunAttempt(value: number): void {
  assert(Number.isInteger(value) && value > 0, `run attempt must be a positive integer: ${value}`);
}

function canonicalFingerprint(schema: string, assets: readonly unknown[]): string {
  return sha256(JSON.stringify({ schema, assets }));
}

export function normalizeReleaseAssets(value: unknown): ReleaseAssetFingerprint {
  assert(Array.isArray(value), 'GitHub assets response must be an array');
  assert(value.length === EXPECTED_RELEASE_ASSETS.length, `expected 14 GitHub assets, found ${value.length}`);

  const assets = value.map((entry, index): NormalizedReleaseAsset => {
    const asset = object(entry, `GitHub asset ${index}`);
    const { id, name, size, state } = asset;
    assert(Number.isInteger(id) && Number(id) > 0, `GitHub asset ${index} has an invalid immutable id`);
    assert(typeof name === 'string', `GitHub asset ${index} name must be a string`);
    assert(Number.isInteger(size) && Number(size) > 0, `GitHub asset ${name} has an invalid size`);
    assert(state === 'uploaded', `GitHub asset ${name} is not fully uploaded`);

    let digest: string | null = null;
    if (asset.digest != null && asset.digest !== '') {
      assert(
        typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest),
        `GitHub asset ${name} has an invalid digest`,
      );
      digest = asset.digest;
    }

    return { id: Number(id), name, size: Number(size), state: 'uploaded', digest };
  });

  assertExactAssetNames(
    assets.map((asset) => asset.name),
    'GitHub asset',
  );
  assert(new Set(assets.map((asset) => asset.id)).size === assets.length, 'GitHub asset immutable ids must be unique');
  assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    schema: RELEASE_ASSET_FINGERPRINT_SCHEMA,
    fingerprint: canonicalFingerprint(RELEASE_ASSET_FINGERPRINT_SCHEMA, assets),
    assets,
  };
}

export function createPretagEvidenceAttestation(options: CreateAttestationOptions): PretagEvidenceAttestation {
  const { assetDir, commitSha, version, repository, runId, runAttempt } = options;
  assertCommitSha(commitSha, 'attestation commit SHA');
  assertVersion(version);
  assertRepository(repository);
  assertRunId(runId);
  assertRunAttempt(runAttempt);

  const names = readdirSync(assetDir);
  assert(names.length === EXPECTED_RELEASE_ASSETS.length, `expected 14 attested assets, found ${names.length}`);
  assertExactAssetNames(names, 'attested asset');

  const assets = sorted(names).map((name): EvidenceAsset => {
    const path = join(assetDir, name);
    const stat = statSync(path);
    assert(stat.isFile(), `attested asset must be a file: ${name}`);
    assert(stat.size > 0, `attested asset must be nonempty: ${name}`);
    return { name, size: stat.size, sha256: sha256(readFileSync(path)) };
  });

  return {
    schema: PRETAG_ATTESTATION_SCHEMA,
    repository,
    workflow: PRETAG_WORKFLOW_PATH,
    commit_sha: commitSha,
    version,
    run_id: runId,
    run_attempt: runAttempt,
    asset_contract: {
      count: assets.length,
      fingerprint: canonicalFingerprint(PRETAG_ATTESTATION_SCHEMA, assets),
      assets,
    },
  };
}

export function verifyPretagEvidenceAttestation(
  value: unknown,
  options: VerifyAttestationOptions,
): PretagEvidenceAttestation {
  const attestation = object(value, 'pre-tag evidence attestation');
  assertCommitSha(options.commitSha, 'expected attestation commit SHA');
  assertVersion(options.version);
  assertRepository(options.repository);
  assertRunId(options.runId);
  assertRunAttempt(options.runAttempt);

  const checks: Record<string, boolean> = {
    schema: attestation.schema === PRETAG_ATTESTATION_SCHEMA,
    repository: attestation.repository === options.repository,
    workflow: attestation.workflow === PRETAG_WORKFLOW_PATH,
    commit_sha: attestation.commit_sha === options.commitSha,
    version: attestation.version === options.version,
    run_id: attestation.run_id === options.runId,
    run_attempt: attestation.run_attempt === options.runAttempt,
  };
  const metadataFailures = Object.entries(checks)
    .filter(([, valid]) => !valid)
    .map(([name]) => name);
  assert(metadataFailures.length === 0, `pre-tag evidence attestation mismatch: ${metadataFailures.join(', ')}`);

  const contract = object(attestation.asset_contract, 'attested asset contract');
  assert(Array.isArray(contract.assets), 'attested asset contract assets must be an array');
  assert(contract.count === EXPECTED_RELEASE_ASSETS.length, 'attested asset contract count must be 14');
  assert(contract.assets.length === EXPECTED_RELEASE_ASSETS.length, 'attested asset contract must contain 14 assets');

  const assets = contract.assets.map((entry, index): EvidenceAsset => {
    const asset = object(entry, `attested asset ${index}`);
    assert(typeof asset.name === 'string', `attested asset ${index} name must be a string`);
    assert(Number.isInteger(asset.size) && Number(asset.size) > 0, `attested asset ${asset.name} has an invalid size`);
    assert(
      typeof asset.sha256 === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.sha256),
      `attested asset ${asset.name} has an invalid SHA-256`,
    );
    return { name: asset.name, size: Number(asset.size), sha256: asset.sha256 };
  });
  assertExactAssetNames(
    assets.map((asset) => asset.name),
    'attested asset',
  );
  const normalizedAssets = [...assets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assert(
    JSON.stringify(assets) === JSON.stringify(normalizedAssets),
    'attested asset contract must use normalized name ordering',
  );
  assert(
    contract.fingerprint === canonicalFingerprint(PRETAG_ATTESTATION_SCHEMA, normalizedAssets),
    'attested asset contract fingerprint mismatch',
  );

  return attestation as unknown as PretagEvidenceAttestation;
}

function expectedReleaseBody(notesBody: string, state: 'draft' | 'public', runId: string): string {
  if (state === 'public') return notesBody;
  return `${notesBody}${notesBody.endsWith('\n') ? '' : '\n'}\n<!-- mkrate-release-run:${runId} -->\n`;
}

function verifyReleaseMetadata(
  value: unknown,
  options: VerifyReleaseOptions,
  context: string,
  assetFingerprint: ReleaseAssetFingerprint,
): void {
  const release = object(value, context);
  const expectedBody = expectedReleaseBody(options.notesBody, options.state, options.runId);
  const checks: Record<string, boolean> = {
    id: release.id === options.releaseId,
    tag: release.tag_name === options.tag,
    title: release.name === `Mkrate ${options.tag}`,
    target: release.target_commitish === options.targetCommitish,
    body: (release.body ?? '') === expectedBody,
    not_prerelease: release.prerelease === false,
    draft: release.draft === (options.state === 'draft'),
    published_at:
      options.state === 'draft'
        ? release.published_at == null
        : typeof release.published_at === 'string' && release.published_at.length > 0,
  };
  const failures = Object.entries(checks)
    .filter(([, valid]) => !valid)
    .map(([name]) => name);
  assert(failures.length === 0, `${context} mismatch: ${failures.join(', ')}`);

  if (release.assets !== undefined) {
    const embeddedFingerprint = normalizeReleaseAssets(release.assets);
    assert(
      embeddedFingerprint.fingerprint === assetFingerprint.fingerprint,
      `${context} embedded asset fingerprint mismatch`,
    );
  }
}

export function verifyReleaseContract(options: VerifyReleaseOptions): ReleaseAssetFingerprint {
  assert(/^v\d+\.\d+\.\d+$/.test(options.tag), `release tag must be vMAJOR.MINOR.PATCH: ${options.tag}`);
  assertCommitSha(options.targetCommitish, 'release target');
  assert(Number.isInteger(options.releaseId) && options.releaseId > 0, 'release id must be a positive integer');
  assertRunId(options.runId);

  const assetFingerprint = normalizeReleaseAssets(options.apiAssets);
  if (options.expectedAssetFingerprint !== undefined) {
    assert(
      assetFingerprint.fingerprint === options.expectedAssetFingerprint,
      `release asset fingerprint mismatch: ${assetFingerprint.fingerprint} != ${options.expectedAssetFingerprint}`,
    );
  }

  verifyReleaseMetadata(options.release, options, `${options.state} release`, assetFingerprint);
  if (options.state === 'public') {
    assert(options.latest !== undefined, 'latest release response is required for public verification');
    verifyReleaseMetadata(options.latest, options, 'latest release', assetFingerprint);
  } else {
    assert(options.latest === undefined, 'latest release response is not valid for draft verification');
  }

  return assetFingerprint;
}

function option(args: string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`missing required option: ${name}`);
  return value;
}

function positiveInteger(value: string, context: string): number {
  assert(/^[1-9][0-9]*$/.test(value), `${context} must be a positive integer`);
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed), `${context} exceeds the safe integer range`);
  return parsed;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'create-attestation') {
    const output = option(args, '--output')!;
    const attestation = createPretagEvidenceAttestation({
      assetDir: option(args, '--asset-dir')!,
      commitSha: option(args, '--commit-sha')!,
      version: option(args, '--version')!,
      repository: option(args, '--repository')!,
      runId: option(args, '--run-id')!,
      runAttempt: positiveInteger(option(args, '--run-attempt')!, 'run attempt'),
    });
    writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`);
    console.log(`Created exact 14-asset pre-tag evidence attestation at ${output}`);
  } else if (command === 'verify-attestation') {
    const value = JSON.parse(readFileSync(option(args, '--attestation')!, 'utf8')) as unknown;
    verifyPretagEvidenceAttestation(value, {
      commitSha: option(args, '--commit-sha')!,
      version: option(args, '--version')!,
      repository: option(args, '--repository')!,
      runId: option(args, '--run-id')!,
      runAttempt: positiveInteger(option(args, '--run-attempt')!, 'run attempt'),
    });
    console.log('Verified successful exact-SHA pre-tag evidence attestation contract.');
  } else if (command === 'verify-release') {
    const state = option(args, '--state')!;
    assert(state === 'draft' || state === 'public', `state must be draft or public: ${state}`);
    const latestPath = option(args, '--latest', false);
    const result = verifyReleaseContract({
      release: JSON.parse(readFileSync(option(args, '--release')!, 'utf8')) as unknown,
      apiAssets: JSON.parse(readFileSync(option(args, '--api-assets')!, 'utf8')) as unknown,
      notesBody: readFileSync(option(args, '--notes-file')!, 'utf8'),
      tag: option(args, '--tag')!,
      targetCommitish: option(args, '--target')!,
      releaseId: positiveInteger(option(args, '--release-id')!, 'release id'),
      runId: option(args, '--run-id')!,
      state,
      expectedAssetFingerprint: option(args, '--expected-asset-fingerprint', false),
      latest: latestPath ? (JSON.parse(readFileSync(latestPath, 'utf8')) as unknown) : undefined,
    });
    console.log(result.fingerprint);
  } else {
    throw new Error(`unknown command: ${command ?? '<missing>'}`);
  }
}
