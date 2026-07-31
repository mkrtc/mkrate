import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '@mkrate/bridge-protocol/conformance/manifest.json' with { type: 'json' };
import protocolPackage from '@mkrate/bridge-protocol/package.json' with { type: 'json' };

const ROOT = join(import.meta.dir, '../../../..');

describe('canonical Bridge protocol artifact pin', () => {
  test('binds package, tarball, source commit, and conformance vectors to Wave A 1.0.1', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'bridge-protocol-artifact.lock.json'), 'utf8'));
    const serverCore = JSON.parse(readFileSync(join(ROOT, 'packages/server-core/package.json'), 'utf8'));
    const artifact = join(ROOT, lock.artifact);
    expect(lock).toMatchObject({
      schemaVersion: 1,
      package: '@mkrate/bridge-protocol',
      version: '1.0.1',
      artifact: 'vendor/mkrate-bridge-protocol-1.0.1.tgz',
      sha256: '9ec050cfe35d8fdc960e2e6a345e2268bb59be655a0ff031c1f999dc7b14d637',
      conformanceDigest: 'b0322b8ecdfe84d546f1262bd56b5bb674da1690de06694eebfcab25e1f715f2',
      source: { commit: '6cbc6e8faef8f0766472a2b7fa7b7b359140f06f', protocolEpoch: 'mkrate-bridge/v1' },
    });
    expect(createHash('sha256').update(readFileSync(artifact)).digest('hex')).toBe(lock.sha256);
    expect(serverCore.dependencies['@mkrate/bridge-protocol']).toBe('file:../../vendor/mkrate-bridge-protocol-1.0.1.tgz');
    expect(protocolPackage.version).toBe(lock.version);
    expect(manifest.packageVersion).toBe(lock.version);
    expect(manifest.fixtureSetDigestSha256).toBe(lock.conformanceDigest);
    expect(manifest.protocolEpoch).toBe(lock.source.protocolEpoch);
  });
});
