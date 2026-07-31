import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'server-lock-worker.ts');
let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mkrate-server-lock-'));
  roots.push(value);
  return value;
}

function sync(configDir: string, mode: string) {
  return Bun.spawnSync([process.execPath, WORKER], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir, SERVER_LOCK_WORKER_MODE: mode },
    stdout: 'pipe', stderr: 'pipe',
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('timed out waiting for subprocess state');
}

describe('shared Craft/Mkrate server lock subprocess behavior', () => {
  test('occupied packaged-like startup reports an actionable owner and exits; free startup succeeds', async () => {
    const configDir = root();
    const holder = Bun.spawn([process.execPath, WORKER], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir, SERVER_LOCK_WORKER_MODE: 'hold' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const lockPath = join(configDir, '.server.lock');
    await waitFor(() => existsSync(lockPath));
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };

    const conflict = sync(configDir, 'probe');
    expect(conflict.exitCode).toBe(23);
    const visible = JSON.parse(conflict.stdout.toString().trim());
    expect(visible).toMatchObject({
      visibleAction: true,
      ownerPid: owner.pid,
      choices: ['close-existing-application', 'explicit-separate-profile'],
    });
    expect(visible.message).toContain('CRAFT_CONFIG_DIR');

    holder.kill('SIGTERM');
    expect(await holder.exited).toBe(0);
    await waitFor(() => !existsSync(lockPath));
    const free = sync(configDir, 'probe');
    expect(free.exitCode, free.stderr.toString()).toBe(0);
    expect(free.stdout.toString()).toContain('STARTED_AND_STOPPED');
  }, 20_000);

  test('a startup failure after lock acquisition releases its own lock', () => {
    const configDir = root();
    const failed = sync(configDir, 'fail-after-lock');
    expect(failed.exitCode).toBe(24);
    expect(failed.stdout.toString()).toContain('EXPECTED_STARTUP_FAILURE');
    expect(existsSync(join(configDir, '.server.lock'))).toBe(false);
  });
});
