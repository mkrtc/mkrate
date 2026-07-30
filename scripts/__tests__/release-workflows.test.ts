import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EXPECTED_RELEASE_ASSETS,
  UPDATER_MANIFESTS,
  verifyReleaseArtifacts,
} from '../verify-release-artifacts';

const root = join(import.meta.dir, '..', '..');
const releasePath = join(root, '.github/workflows/electron-release.yml');
const evidencePath = join(root, '.github/workflows/electron-pretag-evidence.yml');
const helperPath = join(root, 'scripts/verify-release-artifacts.ts');
const release = readFileSync(releasePath, 'utf8');
const evidence = readFileSync(evidencePath, 'utf8');
const helper = readFileSync(helperPath, 'utf8');
const require = createRequire(join(root, 'package.json'));
const yaml = require('js-yaml') as typeof import('js-yaml');
const tempDirs: string[] = [];

const expectedAssets = [
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
].sort();

function parseWorkflow(source: string): any {
  return yaml.load(source, { schema: yaml.JSON_SCHEMA });
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function uploadedAssetPaths(source: string): string[] {
  return [...source.matchAll(/apps\/electron\/release\/([A-Za-z0-9._-]+)/g)].map((match) => match[1]).sort();
}

function createFixture(version = '0.0.1'): { assetDir: string; apiAssetsPath: string } {
  const assetDir = mkdtempSync(join(tmpdir(), 'mkrate-release-assets-'));
  tempDirs.push(assetDir);

  for (const name of EXPECTED_RELEASE_ASSETS) {
    if (!name.endsWith('.yml')) writeFileSync(join(assetDir, name), `fixture:${name}\n`);
  }
  for (const spec of UPDATER_MANIFESTS) {
    const files = spec.files.map((name) => {
      const content = readFileSync(join(assetDir, name));
      return {
        url: name,
        size: content.length,
        sha512: createHash('sha512').update(content).digest('base64'),
      };
    });
    const primary = spec.name === 'latest-mac.yml' ? files.find((entry) => entry.url.endsWith('.zip'))! : files[0];
    writeFileSync(
      join(assetDir, spec.name),
      yaml.dump({ version, files, path: primary.url, sha512: primary.sha512 }, { lineWidth: -1 }),
    );
  }

  const apiAssetsPath = join(assetDir, '..', `${assetDir.split('/').at(-1)}-api-assets.json`);
  tempDirs.push(apiAssetsPath);
  const apiAssets = EXPECTED_RELEASE_ASSETS.map((name, id) => {
    const content = readFileSync(join(assetDir, name));
    return {
      id: id + 1,
      name,
      state: 'uploaded',
      size: content.length,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    };
  });
  writeFileSync(apiAssetsPath, JSON.stringify(apiAssets));
  return { assetDir, apiAssetsPath };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('workflow YAML and immutable action contracts', () => {
  test('both workflows parse and expose only their intended triggers', () => {
    const releaseDoc = parseWorkflow(release);
    const evidenceDoc = parseWorkflow(evidence);

    expect(Object.keys(releaseDoc.on)).toEqual(['push']);
    expect(releaseDoc.on.push.tags).toEqual(['v*']);
    expect(Object.keys(evidenceDoc.on)).toEqual(['workflow_dispatch']);
    expect(evidenceDoc.permissions).toEqual({ contents: 'read' });
    expect(releaseDoc.permissions).toEqual({ contents: 'write' });
  });

  test('all explicit Bash workflow blocks pass shell syntax checking', () => {
    for (const [workflowName, document] of [
      ['release', parseWorkflow(release)],
      ['evidence', parseWorkflow(evidence)],
    ] as const) {
      for (const [jobName, job] of Object.entries<any>(document.jobs)) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          if (step.shell !== 'bash' || typeof step.run !== 'string') continue;
          const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
          expect(result.status, `${workflowName}/${jobName}/step-${stepIndex}: ${result.stderr}`).toBe(0);
        }
      }
    }
  });

  test('every reusable action is pinned to a reviewed full commit with a version comment', () => {
    const sources = [release, evidence];
    const approvedPins = new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0',
    ]);

    for (const source of sources) {
      const useLines = source.split('\n').filter((line) => line.includes('uses:'));
      expect(useLines.length).toBeGreaterThan(0);
      for (const line of useLines) {
        const match = line.match(/^\s*uses:\s*([^\s#]+@[0-9a-f]{40})\s+#\s+v\d[^\s]*\s*$/);
        expect(match, `mutable or uncommented action: ${line}`).not.toBeNull();
        expect(approvedPins.has(match![1]), `unreviewed action pin: ${match![1]}`).toBeTrue();
      }
    }
  });
});

describe('Mkrate release contract', () => {
  test('contains the exact 14 Mkrate asset identities and no retired Craft release branding', () => {
    const exportedAssets: string[] = [...EXPECTED_RELEASE_ASSETS];
    expect(exportedAssets.sort()).toEqual(expectedAssets);
    expect(EXPECTED_RELEASE_ASSETS).toHaveLength(14);
    expect(uploadedAssetPaths(release)).toEqual(expectedAssets);
    expect(uploadedAssetPaths(evidence)).toEqual(expectedAssets);
    expect(UPDATER_MANIFESTS.find((entry) => entry.name === 'latest-mac.yml')?.files).toEqual([
      'Mkrate-arm64.dmg',
      'Mkrate-arm64.zip',
    ]);

    for (const source of [release, evidence, helper]) {
      expect(source).not.toContain('Craft-Agents');
      expect(source).not.toContain('Craft Agents');
      expect(source).not.toContain('craft-release-run');
    }
    expect(release).toContain('--title "Mkrate $RELEASE_TAG"');
    expect(release).toContain('<!-- mkrate-release-run:');
  });

  test('preserves parent atomicity, ownership, recovery, and publication gates', () => {
    expect(release).not.toContain('workflow_dispatch');
    expect(release).toContain('git fetch --force --tags origin');
    expect(release).toContain('Peeled tag commit');
    expect(release).toContain('apps/electron/package.json version');
    expect(release).toContain('Release notes file does not exist at tag');
    expect(release).toContain('DRAFT_VISIBILITY_MAX_ATTEMPTS');
    expect(release).toContain('Expected exactly one draft');
    expect(release).toContain('release_id=$release_id');
    expect(release).toContain('Deleting partial draft asset id=$asset_id');
    expect(release).toContain('releases/assets/$asset_id');
    expect(count(release, 'Retry must use Re-run all jobs')).toBe(4);
    expect(release).toContain('bun scripts/verify-release-artifacts.ts');
    expect(helper).toContain('GitHub SHA-256 mismatch');
    expect(helper).toContain('SHA-512 mismatch');
    expect(release).toContain('Publish GitHub Release by numeric ID');
    expect(release).toContain('repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID');
    expect(release).toContain('latest.get("id") == expected_id');
    expect(release).toContain('latest.get("tag_name") == expected_tag');
  });

  test('fails closed instead of rerunning after the numeric release is public', () => {
    expect(release).toContain('Release id=$recovered_id is already public');
    expect(release).toContain('Never re-run builders or mutate it');
    expect(release).toContain('verify that exact numeric ID/tag/target/body/assets/latest state');
    expect(release).toContain('Require verified preparation from this attempt');
    expect(release).toContain('Publication cannot reuse preparation from attempt');
    expect(release).toContain('is no longer the verified draft; refuse PATCH');
    expect(release).toContain('read-only exact-ID');
    expect(release).toContain('manual authorization');
  });
});

describe('pre-tag evidence contract', () => {
  test('pins every builder and verifier to one resolved commit and runs the same four build scripts', () => {
    expect(evidence).toContain('commit_sha: ${{ steps.pin.outputs.commit_sha }}');
    expect(count(evidence, 'ref: ${{ needs.prepare-evidence.outputs.commit_sha }}')).toBe(5);
    expect(evidence).toContain('bash apps/electron/scripts/build-linux.sh x64');
    expect(count(evidence, 'bash apps/electron/scripts/build-dmg.sh')).toBe(2);
    expect(evidence).toContain('apps/electron/scripts/build-win.ps1');
    expect(count(evidence, 'actions/upload-artifact@')).toBe(4);
    expect(count(evidence, 'actions/download-artifact@')).toBe(1);
    expect(evidence).toContain('merge-multiple: true');
    expect(evidence).toContain('bun scripts/verify-release-artifacts.ts');
  });

  test('cannot create tags, drafts, releases, S3 uploads, or any GitHub release API mutation', () => {
    expect(evidence).not.toMatch(/\bgh\s+(?:api|release)\b/);
    expect(evidence).not.toContain('uploads.github.com');
    expect(evidence).not.toContain('/releases');
    expect(evidence).not.toContain('contents: write');
    expect(evidence).not.toMatch(/\bgit\s+(?:tag|push)\b/);
    expect(evidence).not.toContain('--upload');
    expect(evidence).not.toContain('S3_');
  });
});

describe('release artifact verifier', () => {
  test('accepts exact files, manifests, sizes, SHA-512, and available GitHub digests', () => {
    const fixture = createFixture();
    expect(verifyReleaseArtifacts({ ...fixture, expectedVersion: '0.0.1' })).toEqual({ verifiedApiDigests: 14 });
  });

  test('rejects an extra asset', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.assetDir, 'unexpected.txt'), 'unexpected');
    expect(() => verifyReleaseArtifacts({ ...fixture, expectedVersion: '0.0.1' })).toThrow(
      'expected 14 downloaded assets, found 15',
    );
  });

  test('rejects a manifest that changes latest-mac away from arm64', () => {
    const fixture = createFixture();
    const x64 = readFileSync(join(fixture.assetDir, 'Mkrate-x64.zip'));
    const sha512 = createHash('sha512').update(x64).digest('base64');
    writeFileSync(
      join(fixture.assetDir, 'latest-mac.yml'),
      yaml.dump({
        version: '0.0.1',
        files: [{ url: 'Mkrate-x64.zip', size: x64.length, sha512 }],
        path: 'Mkrate-x64.zip',
        sha512,
      }),
    );
    expect(() => verifyReleaseArtifacts({ assetDir: fixture.assetDir, expectedVersion: '0.0.1' })).toThrow(
      'latest-mac.yml file set is not exact',
    );
  });

  test('rejects manifest SHA-512 mismatches', () => {
    const fixture = createFixture();
    const manifestPath = join(fixture.assetDir, 'latest-linux.yml');
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8')) as any;
    manifest.files[0].sha512 = Buffer.alloc(64).toString('base64');
    manifest.sha512 = manifest.files[0].sha512;
    writeFileSync(manifestPath, yaml.dump(manifest));
    expect(() => verifyReleaseArtifacts({ assetDir: fixture.assetDir, expectedVersion: '0.0.1' })).toThrow(
      'latest-linux.yml SHA-512 mismatch',
    );
  });
});
