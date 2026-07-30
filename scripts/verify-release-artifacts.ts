import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const yaml = require('js-yaml') as typeof import('js-yaml');

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

export const UPDATER_MANIFESTS = [
  { name: 'latest-linux.yml', files: ['Mkrate-x64.AppImage'] },
  // The updater manifest intentionally remains arm64-primary. Intel macOS
  // artifacts are published for manual installation, matching the parent.
  { name: 'latest-mac.yml', files: ['Mkrate-arm64.dmg', 'Mkrate-arm64.zip'] },
  { name: 'latest.yml', files: ['Mkrate-x64.exe'] },
] as const;

type ApiAsset = {
  digest?: unknown;
  name?: unknown;
  size?: unknown;
  state?: unknown;
};

type VerifyOptions = {
  assetDir: string;
  expectedVersion: string;
  apiAssetsPath?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function assertExactNames(actual: readonly string[], expected: readonly string[], context: string): void {
  assert(new Set(actual).size === actual.length, `${context} names must be unique`);
  assert(
    JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected)),
    `${context} set is not exact: ${actual.join(', ')}`,
  );
}

function verifyApiAssets(assetDir: string, apiAssetsPath: string): number {
  const apiAssets = JSON.parse(readFileSync(apiAssetsPath, 'utf8')) as ApiAsset[];
  assert(Array.isArray(apiAssets), 'GitHub assets response must be an array');
  assert(apiAssets.length === EXPECTED_RELEASE_ASSETS.length, `expected 14 GitHub assets, found ${apiAssets.length}`);

  const apiNames = apiAssets.map((asset) => asset.name);
  assert(apiNames.every((name): name is string => typeof name === 'string'), 'GitHub asset names must be strings');
  assertExactNames(apiNames, EXPECTED_RELEASE_ASSETS, 'GitHub asset');

  let verifiedApiDigests = 0;
  for (const asset of apiAssets) {
    const name = asset.name as string;
    assert(asset.state === 'uploaded', `asset is not fully uploaded: ${name}`);
    assert(Number.isInteger(asset.size) && Number(asset.size) > 0, `invalid API size for ${name}`);
    const file = join(assetDir, name);
    const size = statSync(file).size;
    assert(size === asset.size, `API size mismatch for ${name}: ${asset.size} != ${size}`);

    if (asset.digest != null && asset.digest !== '') {
      assert(typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest), `invalid GitHub digest for ${name}`);
      const actual = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
      assert(actual === asset.digest, `GitHub SHA-256 mismatch for ${name}`);
      verifiedApiDigests++;
    }
  }
  return verifiedApiDigests;
}

export function verifyReleaseArtifacts(options: VerifyOptions): { verifiedApiDigests: number } {
  const { assetDir, expectedVersion, apiAssetsPath } = options;
  assert(/^\d+\.\d+\.\d+$/.test(expectedVersion), `expected version must be MAJOR.MINOR.PATCH: ${expectedVersion}`);

  const downloadedNames = readdirSync(assetDir);
  assert(downloadedNames.every((name) => statSync(join(assetDir, name)).isFile()), 'downloaded asset directory must contain files only');
  assert(downloadedNames.length === EXPECTED_RELEASE_ASSETS.length, `expected 14 downloaded assets, found ${downloadedNames.length}`);
  assertExactNames(downloadedNames, EXPECTED_RELEASE_ASSETS, 'downloaded asset');

  for (const name of EXPECTED_RELEASE_ASSETS) {
    assert(basename(name) === name, `unsafe expected asset name: ${name}`);
    assert(statSync(join(assetDir, name)).size > 0, `release asset must be nonempty: ${name}`);
  }

  const verifiedApiDigests = apiAssetsPath ? verifyApiAssets(assetDir, apiAssetsPath) : 0;

  for (const spec of UPDATER_MANIFESTS) {
    const document = yaml.load(readFileSync(join(assetDir, spec.name), 'utf8')) as Record<string, any> | undefined;
    assert(document && typeof document === 'object', `${spec.name} must contain a YAML object`);
    assert(document.version === expectedVersion, `${spec.name} version mismatch: ${document.version}`);
    assert(Array.isArray(document.files) && document.files.length > 0, `${spec.name} files must be nonempty`);

    const urls = document.files.map((entry: any) => entry?.url);
    assert(urls.every((url: unknown): url is string => typeof url === 'string' && url.length > 0), `${spec.name} has an empty file URL`);
    assertExactNames(urls, spec.files, `${spec.name} file`);
    assert(typeof document.path === 'string' && document.path.length > 0, `${spec.name} path must be nonempty`);
    assert(urls.includes(document.path), `${spec.name} path must identify one files[] entry`);
    assert(basename(document.path) === document.path, `${spec.name} path must be a release asset filename`);

    for (const entry of document.files) {
      assert(basename(entry.url) === entry.url, `${spec.name} contains a non-filename URL: ${entry.url}`);
      const file = join(assetDir, entry.url);
      const size = statSync(file).size;
      assert(Number.isInteger(entry.size) && entry.size > 0, `${spec.name} has invalid size for ${entry.url}`);
      assert(entry.size === size, `${spec.name} size mismatch for ${entry.url}: ${entry.size} != ${size}`);
      assert(typeof entry.sha512 === 'string', `${spec.name} lacks SHA-512 for ${entry.url}`);
      const decoded = Buffer.from(entry.sha512, 'base64');
      assert(
        decoded.length === 64 && decoded.toString('base64') === entry.sha512,
        `${spec.name} has invalid SHA-512 base64 for ${entry.url}`,
      );
      const actual = createHash('sha512').update(readFileSync(file)).digest('base64');
      assert(actual === entry.sha512, `${spec.name} SHA-512 mismatch for ${entry.url}`);
    }

    const primary = document.files.find((entry: any) => entry.url === document.path);
    assert(primary, `${spec.name} primary path entry is missing`);
    assert(document.sha512 === primary.sha512, `${spec.name} top-level SHA-512 does not match path entry`);
  }

  return { verifiedApiDigests };
}

function option(args: string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`missing required option: ${name}`);
  return value;
}

if (import.meta.main) {
  const assetDir = option(process.argv.slice(2), '--asset-dir')!;
  const expectedVersion = option(process.argv.slice(2), '--expected-version')!;
  const apiAssetsPath = option(process.argv.slice(2), '--api-assets', false);
  const result = verifyReleaseArtifacts({ assetDir, expectedVersion, apiAssetsPath });
  console.log(
    `Verified 14 exact Mkrate assets, 3 updater manifests, arm64-primary macOS identity, and ${result.verifiedApiDigests} available GitHub SHA-256 digests.`,
  );
}
