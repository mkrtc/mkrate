import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isCanonicalUuid } from '../../../utils/uuid-format.ts';
import { MEMORY_GLOBAL_SPACE_NAME, MemoryError, type CreateMemoryConnectionInput } from '../types.ts';
import { MemoryConnectionRepository, deriveGlobalSpaceId } from '../repository.ts';

let dir: string;
let clock: number;

function makeRepo(times?: number[]): MemoryConnectionRepository {
  if (times) {
    const queue = [...times];
    return new MemoryConnectionRepository({ configDir: dir, now: () => queue.shift() ?? 9999 });
  }
  clock = 1000;
  return new MemoryConnectionRepository({ configDir: dir, now: () => clock++ });
}

const CONN: CreateMemoryConnectionInput = {
  name: 'Alpha',
  url: 'http://127.0.0.1:6333',
  collection: 'craft_memory',
  embedding: { model: 'craft-local-hash-v1', dimension: 384 },
};

const RACE_WORKER_PATH = fileURLToPath(new URL('./repository-race-worker.ts', import.meta.url));

interface RaceWorkerResult {
  ok: boolean;
  code?: string | null;
  message?: string;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for subprocess race barrier');
    await Bun.sleep(10);
  }
}

async function runCreateRaceWorker(request: Record<string, string>): Promise<RaceWorkerResult> {
  const child = Bun.spawn([process.execPath, RACE_WORKER_PATH, JSON.stringify({ action: 'create', ...request })], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`race worker exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout.trim()) as RaceWorkerResult;
}

function setWindowsReadDenied(path: string, denied: boolean): void {
  const args = denied
    ? [path, '/deny', '*S-1-1-0:(RD)', '/Q']
    : [path, '/remove:d', '*S-1-1-0', '/Q'];
  const result = spawnSync('icacls.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Windows ACL capability probe failed (${denied ? 'deny' : 'restore'}, exit ${result.status ?? 'unknown'})`);
  }
}

/** Create a connection using the repo's current root revision. */
function create(repo: MemoryConnectionRepository, input: CreateMemoryConnectionInput = CONN) {
  return repo.createConnection(input, repo.getRootRevision());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-repo-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryConnectionRepository — connection CRUD + root revision', () => {
  test('creates a connection with a canonical UUID, revision 1, and bumps the root revision', async () => {
    const repo = makeRepo();
    expect(repo.getRootRevision()).toBe(0);
    const conn = await create(repo);
    expect(isCanonicalUuid(conn.connectionId)).toBe(true);
    expect(conn.revision).toBe(1);
    expect(conn.credentialMode).toBe('none');
    expect(conn.spaces).toEqual([]);
    expect(repo.getRootRevision()).toBe(1);
    // Canonical origin is stored.
    expect(conn.url).toBe('http://127.0.0.1:6333/');
  });

  test('persists a stable installationId across instances', async () => {
    const repo = makeRepo();
    await create(repo);
    const id1 = repo.getInstallationId();
    expect(isCanonicalUuid(id1)).toBe(true);
    const id2 = new MemoryConnectionRepository({ configDir: dir }).getInstallationId();
    expect(id2).toBe(id1);
  });

  test('ensureInstallationId persists a stable id even with no connections', async () => {
    const repo = makeRepo();
    const id = await repo.ensureInstallationId();
    expect(isCanonicalUuid(id)).toBe(true);
    expect(new MemoryConnectionRepository({ configDir: dir }).getInstallationId()).toBe(id);
  });

  test('create guards on the root revision (stale create rejected)', async () => {
    const repo = makeRepo();
    await create(repo); // root 0 -> 1
    await expect(repo.createConnection({ ...CONN, name: 'Beta' }, 0)).rejects.toMatchObject({ code: 'revision_conflict' });
    await repo.createConnection({ ...CONN, name: 'Beta' }, 1); // correct root
    expect(repo.getRootRevision()).toBe(2);
  });

  test('delete guards on the root revision (stale delete rejected)', async () => {
    const repo = makeRepo();
    const conn = await create(repo); // root 1
    await expect(repo.deleteConnection(conn.connectionId, 0)).rejects.toMatchObject({ code: 'revision_conflict' });
    await repo.deleteConnection(conn.connectionId, 1);
    expect(repo.getConnection(conn.connectionId)).toBeNull();
    expect(repo.getRootRevision()).toBe(2);
  });

  test('update guards on the per-connection revision and bumps both revisions', async () => {
    const repo = makeRepo();
    const conn = await create(repo); // root 1, conn rev 1
    const updated = await repo.updateConnection(conn.connectionId, { name: 'Beta', enabled: false, proactiveRemoteSearch: true }, conn.revision);
    expect(updated.name).toBe('Beta');
    expect(updated.revision).toBe(2);
    expect(repo.getRootRevision()).toBe(2);
    await expect(repo.updateConnection(conn.connectionId, { name: 'Gamma' }, 1)).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  test('a canonical no-op patch does NOT bump the revision, timestamp, or root revision', async () => {
    const repo = makeRepo();
    const conn = await create(repo); // root 1
    const before = repo.getConnection(conn.connectionId)!;
    const same = await repo.updateConnection(conn.connectionId, { name: 'Alpha', enabled: true, proactiveRemoteSearch: false }, conn.revision);
    expect(same.revision).toBe(before.revision);
    expect(same.updatedAt).toBe(before.updatedAt);
    expect(repo.getRootRevision()).toBe(1);
  });

  test('rejects immutable-field changes at runtime', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    await expect(
      repo.updateConnection(conn.connectionId, { url: 'http://evil' } as unknown as { name?: string }, conn.revision),
    ).rejects.toMatchObject({ code: 'immutable_field' });
  });

  test('rejects case-insensitive duplicate names but allows renaming own casing', async () => {
    const repo = makeRepo();
    const a = await create(repo, { ...CONN, name: 'A' });
    const b = await create(repo, { ...CONN, name: 'B' });
    await expect(repo.updateConnection(b.connectionId, { name: 'a' }, b.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
    const renamed = await repo.updateConnection(a.connectionId, { name: 'a' }, a.revision);
    expect(renamed.name).toBe('a');
  });

  test('throws not_found for unknown connections', async () => {
    const repo = makeRepo();
    await expect(repo.updateConnection(deriveGlobalSpaceId('x'), { name: 'y' }, 1)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('orders connections deterministically by createdAt regardless of insertion order', async () => {
    const repo = makeRepo([3000, 1000, 2000]);
    await repo.createConnection({ ...CONN, name: 'first' }, repo.getRootRevision());
    await repo.createConnection({ ...CONN, name: 'second' }, repo.getRootRevision());
    await repo.createConnection({ ...CONN, name: 'third' }, repo.getRootRevision());
    expect(repo.listConnections().map(c => c.name)).toEqual(['second', 'third', 'first']);
  });
});

describe('MemoryConnectionRepository — spaces', () => {
  test('lists the derived read-only Global space first, then stored spaces', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const spaces = repo.listSpaces(conn.connectionId);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!.kind).toBe('global');
    expect(spaces[0]!.name).toBe(MEMORY_GLOBAL_SPACE_NAME);
    expect(spaces[0]!.spaceId).toBe(deriveGlobalSpaceId(conn.connectionId));
  });

  test('adds workspace/project/custom spaces, defaults writable true, bumps both revisions', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'workspace', name: 'WS', workspaceId: 'ws-1' }, conn.revision);
    expect(space.kind).toBe('workspace');
    expect(space.writable).toBe(true);
    expect(isCanonicalUuid(space.spaceId)).toBe(true);
    expect(connection.revision).toBe(2);
    expect(repo.getRootRevision()).toBe(2);

    const p = await repo.addSpace(conn.connectionId, { kind: 'project', name: 'Proj', workspaceId: 'ws-1', projectId: 'pr-1', writable: false }, connection.revision);
    expect(p.space.kind).toBe('project');
    expect(p.space.writable).toBe(false);
    const c = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Custom', instructions: 'notes' }, p.connection.revision);
    expect(c.space.kind).toBe('custom');

    expect(repo.listSpaces(conn.connectionId).map(s => s.kind)).toEqual(['global', 'workspace', 'project', 'custom']);
  });

  test('rejects duplicate space names and the reserved Global name', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'notes' }, connection.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Global' }, connection.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  test('updates a stored space (incl. writable) and rejects editing the derived Global space', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    const updated = await repo.updateSpace(conn.connectionId, space.spaceId, { name: 'Renamed', instructions: 'x', writable: false }, connection.revision);
    expect(updated.space.name).toBe('Renamed');
    expect(updated.space.instructions).toBe('x');
    expect(updated.space.writable).toBe(false);

    const globalId = deriveGlobalSpaceId(conn.connectionId);
    await expect(repo.updateSpace(conn.connectionId, globalId, { name: 'nope' }, updated.connection.revision)).rejects.toMatchObject({ code: 'read_only' });
  });

  test('a no-op space patch does not bump revisions', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    const rootBefore = repo.getRootRevision();
    const same = await repo.updateSpace(conn.connectionId, space.spaceId, { name: 'Notes', writable: true }, connection.revision);
    expect(same.connection.revision).toBe(connection.revision);
    expect(repo.getRootRevision()).toBe(rootBefore);
  });

  test('clears instructions with null', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes', instructions: 'hi' }, conn.revision);
    const cleared = await repo.updateSpace(conn.connectionId, space.spaceId, { instructions: null }, connection.revision);
    expect(cleared.space.instructions).toBeUndefined();
  });

  test('deletes a stored space and rejects deleting the derived Global space', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    const globalId = deriveGlobalSpaceId(conn.connectionId);
    await expect(repo.deleteSpace(conn.connectionId, globalId, connection.revision)).rejects.toMatchObject({ code: 'read_only' });
    const after = await repo.deleteSpace(conn.connectionId, space.spaceId, connection.revision);
    expect(after.spaces).toHaveLength(0);
    await expect(repo.deleteSpace(conn.connectionId, space.spaceId, after.revision)).rejects.toMatchObject({ code: 'space_not_found' });
  });

  test('enforces the connection revision on space mutations', async () => {
    const repo = makeRepo();
    const conn = await create(repo);
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'X' }, 999)).rejects.toMatchObject({ code: 'revision_conflict' });
  });
});

describe('MemoryConnectionRepository — durability, security, recovery', () => {
  test('atomic writes leave no legacy fixed-name temporary file', async () => {
    const repo = makeRepo();
    await create(repo);
    await create(repo, { ...CONN, name: 'Beta' }); // second write creates a backup
    expect(existsSync(`${repo.getFilePath()}.tmp`)).toBe(false);
  });

  if (process.platform !== 'win32') {
    test('POSIX capability — writes primary and backup with restrictive file modes', async () => {
      const repo = makeRepo();
      await create(repo);
      await create(repo, { ...CONN, name: 'Beta' });
      expect(statSync(repo.getFilePath()).mode & 0o077).toBe(0);
      expect(statSync(repo.getBackupPath()).mode & 0o077).toBe(0);
    });
  }

  test('recovers from backup when the primary is corrupted', async () => {
    const repo = makeRepo();
    await create(repo);                                 // primary=[Alpha]
    await create(repo, { ...CONN, name: 'Beta' });      // backup=[Alpha], primary=[Alpha,Beta]
    expect(existsSync(repo.getBackupPath())).toBe(true);

    writeFileSync(repo.getFilePath(), 'not valid json {{{');
    const recovered = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(recovered.connections.map(c => c.name)).toEqual(['Alpha']);
  });

  test('throws invalid_config when both primary and backup are corrupt (never silently resets)', async () => {
    const repo = makeRepo();
    await create(repo);
    await create(repo, { ...CONN, name: 'Beta' });
    writeFileSync(repo.getFilePath(), 'garbage');
    writeFileSync(repo.getBackupPath(), 'garbage');
    expect(() => new MemoryConnectionRepository({ configDir: dir }).load()).toThrow(MemoryError);
    try {
      new MemoryConnectionRepository({ configDir: dir }).load();
    } catch (e) {
      expect((e as MemoryError).code).toBe('invalid_config');
    }
  });

  test('a missing config is a fresh empty config (not an error)', () => {
    const repo = new MemoryConnectionRepository({ configDir: dir });
    expect(repo.load().connections).toEqual([]);
    expect(repo.load().revision).toBe(0);
  });

  if (process.platform !== 'win32') {
    test('POSIX capability — refuses to follow a symlinked primary', async () => {
      const repo = makeRepo();
      await create(repo);
      const decoy = join(dir, 'decoy.json');
      writeFileSync(decoy, '{"version":1,"revision":0,"installationId":"x","connections":[]}');
      unlinkSync(repo.getFilePath());
      symlinkSync(decoy, repo.getFilePath());
      expect(lstatSync(repo.getFilePath()).isSymbolicLink()).toBe(true);
      try {
        new MemoryConnectionRepository({ configDir: dir }).load();
        throw new Error('expected load to throw');
      } catch (e) {
        expect((e as MemoryError).code).toBe('invalid_config');
      }
    });

    test('POSIX capability — rejects a symlinked memory directory without writing outside configDir', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'mem-repo-outside-'));
      try {
        symlinkSync(outside, join(dir, 'memory'), 'dir');
        const repo = makeRepo();
        await expect(repo.ensureInstallationId()).rejects.toMatchObject({ code: 'invalid_config' });
        expect(existsSync(join(outside, 'connections.json'))).toBe(false);
        expect(existsSync(join(outside, 'connections.json.bak'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test('POSIX capability — access-denied primary cannot mutate from a stale backup', async () => {
      if (process.getuid?.() === 0) {
        throw new Error('POSIX access-denied capability probe requires a non-root runner');
      }
      const repo = makeRepo();
      await create(repo);                                  // primary=[Alpha]
      await create(repo, { ...CONN, name: 'Beta' });       // backup=[Alpha], primary=[Alpha,Beta]
      const primary = repo.getFilePath();
      chmodSync(primary, 0o000);
      try {
        expect(() => readFileSync(primary, 'utf8')).toThrow();
        const contender = new MemoryConnectionRepository({ configDir: dir, now: () => 5_000 });
        await expect(
          contender.createConnection({ ...CONN, name: 'Gamma' }, 1),
        ).rejects.toMatchObject({ code: 'storage_error' });
      } finally {
        chmodSync(primary, 0o600);
      }
      const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
      expect(reloaded.connections.map(connection => connection.name)).toEqual(['Alpha', 'Beta']);
    });
  } else {
    test('Windows capability — rejects a junctioned memory directory without writing outside configDir', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'mem-repo-outside-'));
      try {
        const junction = join(dir, 'memory');
        symlinkSync(outside, junction, 'junction');
        expect(lstatSync(junction).isSymbolicLink()).toBe(true);
        const repo = makeRepo();
        await expect(repo.ensureInstallationId()).rejects.toMatchObject({ code: 'invalid_config' });
        expect(existsSync(join(outside, 'connections.json'))).toBe(false);
        expect(existsSync(join(outside, 'connections.json.bak'))).toBe(false);
      } finally {
        const junction = join(dir, 'memory');
        if (existsSync(junction)) unlinkSync(junction);
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test('Windows capability — ACL-denied primary cannot mutate from a stale backup', async () => {
      const repo = makeRepo();
      await create(repo);
      await create(repo, { ...CONN, name: 'Beta' });
      const primary = repo.getFilePath();
      setWindowsReadDenied(primary, true);
      try {
        let readCode: string | undefined;
        try {
          readFileSync(primary, 'utf8');
        } catch (error) {
          readCode = (error as NodeJS.ErrnoException).code;
        }
        expect(readCode).toBeDefined();
        expect(['EACCES', 'EPERM']).toContain(readCode!);
        const contender = new MemoryConnectionRepository({ configDir: dir, now: () => 5_000 });
        await expect(
          contender.createConnection({ ...CONN, name: 'Gamma' }, 1),
        ).rejects.toMatchObject({ code: 'storage_error' });
      } finally {
        setWindowsReadDenied(primary, false);
      }
      const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
      expect(reloaded.connections.map(connection => connection.name)).toEqual(['Alpha', 'Beta']);
    });
  }

  test('never backs up a corrupt primary (self-heals on next write)', async () => {
    const repo = makeRepo();
    await create(repo);
    await create(repo, { ...CONN, name: 'Beta' }); // good backup=[Alpha]
    writeFileSync(repo.getFilePath(), 'corrupt');   // primary corrupt, backup still good

    const repo2 = new MemoryConnectionRepository({ configDir: dir, now: () => 5000 });
    const conn = await repo2.createConnection({ ...CONN, name: 'Gamma' }, repo2.getRootRevision());
    expect(conn.name).toBe('Gamma');
    const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(reloaded.connections.map(c => c.name).sort()).toEqual(['Alpha', 'Gamma']);
    const backup = JSON.parse(readFileSync(repo.getBackupPath(), 'utf8'));
    expect(backup.connections.map((c: { name: string }) => c.name)).toEqual(['Alpha']);
  });

  test('concurrent Promise.all creates: exactly one wins the root revision, file stays valid', async () => {
    const repo = makeRepo();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => repo.createConnection({ ...CONN, name: `c${i}` }, 0)),
    );
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const conflicts = results.filter(r => r.status === 'rejected' && (r.reason as MemoryError).code === 'revision_conflict');
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    // Reloaded from disk: exactly one connection, valid config, root revision 1.
    const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(reloaded.connections).toHaveLength(1);
    expect(reloaded.revision).toBe(1);
  });

  test('two real processes cannot both acknowledge create at the same root revision', async () => {
    const gatesDir = join(dir, 'race-gates');
    mkdirSync(gatesDir);
    const requestBase = {
      configDir: dir,
      readyPrefix: join(gatesDir, 'ready'),
      startGate: join(gatesDir, 'start'),
      afterLoadPrefix: join(gatesDir, 'after-load'),
      releaseGate: join(gatesDir, 'release'),
    };
    const workers = [
      runCreateRaceWorker({ ...requestBase, workerId: 'a' }),
      runCreateRaceWorker({ ...requestBase, workerId: 'b' }),
    ];

    await waitUntil(() => existsSync(`${requestBase.readyPrefix}.a`) && existsSync(`${requestBase.readyPrefix}.b`));
    writeFileSync(requestBase.startGate, 'go');
    await waitUntil(() => existsSync(`${requestBase.afterLoadPrefix}.a`) || existsSync(`${requestBase.afterLoadPrefix}.b`));

    // Without a filesystem transaction lock both workers reach their injected
    // post-load barrier. With the lock only one can; give the contender enough
    // time to expose the broken implementation, then release the owner.
    const bothAfterLoad = () => existsSync(`${requestBase.afterLoadPrefix}.a`) && existsSync(`${requestBase.afterLoadPrefix}.b`);
    const deadline = Date.now() + 1_000;
    while (!bothAfterLoad() && Date.now() < deadline) await Bun.sleep(10);
    writeFileSync(requestBase.releaseGate, 'go');

    const results = await Promise.all(workers);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.code === 'revision_conflict')).toHaveLength(1);
    const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(reloaded.connections).toHaveLength(1);
    expect(reloaded.revision).toBe(1);
  }, 15_000);

  test('serialized sequential space additions never interleave', async () => {
    const repo = makeRepo();
    const base = await create(repo);
    let rev = base.revision;
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const res = await repo.addSpace(base.connectionId, { kind: 'custom', name }, rev);
      rev = res.connection.revision;
    }
    expect(repo.getConnection(base.connectionId)?.spaces).toHaveLength(5);
    expect(repo.getConnection(base.connectionId)?.revision).toBe(base.revision + 5);
  });
});
