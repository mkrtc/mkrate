import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialManager } from '../../credentials/manager.ts';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'bridge-saga-worker.ts');
const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECRET = 'instance-token-secret';
let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mkrate-bridge-saga-'));
  roots.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    workspaces: [], activeWorkspaceId: null, activeSessionId: null,
    bridgeProfile: {
      profileId: PROFILE_ID, url: 'wss://bridge.example.test', displayName: 'Desktop',
      enabled: true, createdAt: 1, updatedAt: 1,
    },
  }));
  return root;
}

function run(root: string, mode: 'commit' | 'recover', crash?: string) {
  return Bun.spawnSync([process.execPath, WORKER], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: root,
      BRIDGE_SAGA_WORKER_MODE: mode,
      ...(crash ? { BRIDGE_SAGA_CRASH_POINT: crash } : {}),
    },
    stdout: 'pipe', stderr: 'pipe',
  });
}

function files(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else result.push(path);
    }
  };
  walk(root);
  return result;
}

describe('BridgeCredentialSaga real subprocess crash recovery', () => {
  for (const point of ['credential:before', 'credential:after', 'profile:before', 'profile:after', 'cleanup:after']) {
    test(`converges after hard crash at ${point} without plaintext bootstrap/token journaling`, async () => {
      const root = makeRoot();
      const crashed = run(root, 'commit', point);
      expect(crashed.exitCode).toBe(77);
      for (const path of files(root)) expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);

      const recovered = run(root, 'recover');
      expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
      const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(raw.bridgeProfile).toMatchObject({
        profileId: PROFILE_ID, url: 'wss://bridge.example.test',
        deploymentId: 'deployment-1', instanceId: 'instance-1',
      });
      const manager = new CredentialManager({ credentialsConfigDir: root });
      const envelope = await manager.getBridgeInstanceCredential(PROFILE_ID);
      expect(envelope).toMatchObject({
        version: 1, origin: 'wss://bridge.example.test', profileId: PROFILE_ID,
        deploymentId: 'deployment-1', instanceId: 'instance-1', instanceToken: SECRET,
      });
      expect(readdirSync(join(root, 'bridge')).filter(name => name.includes('saga'))).toEqual([]);
    });
  }
});
