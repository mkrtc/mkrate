/**
 * Service-layer tests for coordinated Memory connection + credential lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../../../credentials/manager.ts';
import type { CredentialBackend } from '../../../credentials/backends/types.ts';
import { accountToCredentialId, credentialIdToAccount, type CredentialId, type StoredCredential } from '../../../credentials/types.ts';
import { MemoryConnectionRepository } from '../repository.ts';
import { MemoryConnectionService, type CreateMemoryConnectionServiceInput, type UpdateMemoryConnectionServiceInput } from '../service.ts';
import type { CreateMemoryConnectionInput } from '../types.ts';

interface BackendFaultConfig {
  failSet?: (id: CredentialId) => boolean;
  failGet?: (id: CredentialId) => boolean;
  failDelete?: (id: CredentialId) => boolean;
}

interface ServiceHarness {
  repo: MemoryConnectionRepository;
  service: MemoryConnectionService;
  manager: CredentialManager;
  store: Map<string, StoredCredential>;
}

let dir: string;

function makeHarness(faults: BackendFaultConfig = {}): ServiceHarness {
  const repo = new MemoryConnectionRepository({ configDir: dir });
  const store = new Map<string, StoredCredential>();
  const backend: CredentialBackend = {
    name: 'memory-service-test-backend',
    priority: 100,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async get(id: CredentialId): Promise<StoredCredential | null> {
      if (faults.failGet?.(id)) {
        throw new Error(`injected get failure for ${credentialIdToAccount(id)}`);
      }
      return store.get(credentialIdToAccount(id)) ?? null;
    },
    async set(id: CredentialId, credential: StoredCredential): Promise<void> {
      if (faults.failSet?.(id)) {
        throw new Error(`injected set failure for ${credentialIdToAccount(id)}`);
      }
      store.set(credentialIdToAccount(id), credential);
    },
    async delete(id: CredentialId): Promise<boolean> {
      if (faults.failDelete?.(id)) {
        throw new Error(`injected delete failure for ${credentialIdToAccount(id)}`);
      }
      return store.delete(credentialIdToAccount(id));
    },
    deleteSync(id: CredentialId): boolean {
      return store.delete(credentialIdToAccount(id));
    },
    async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
      const ids = [...store.keys()].map(accountToCredentialId).filter((x): x is CredentialId => x !== null);
      if (!filter) return ids;
      return ids.filter(id =>
        (!filter.type || id.type === filter.type)
        && (!filter.memoryConnectionId || id.memoryConnectionId === filter.memoryConnectionId),
      );
    },
  };

  const manager = new CredentialManager({ backends: [backend] });
  const service = new MemoryConnectionService({ repository: repo, credentialManager: manager });

  return { repo, service, manager, store };
}

const CONN: CreateMemoryConnectionInput = {
  name: 'Alpha',
  url: 'http://127.0.0.1:6333',
  collection: 'craft_memory',
  embedding: { model: 'craft-local-hash-v1', dimension: 384 },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-service-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function createConnection(
  service: MemoryConnectionService,
  input: CreateMemoryConnectionServiceInput = { ...CONN },
) {
  return service.createConnection(input);
}

function makeUpdate(
  connectionId: string,
  expectedRevision: number,
  patch: Omit<UpdateMemoryConnectionServiceInput, 'connectionId' | 'expectedRevision'>,
): UpdateMemoryConnectionServiceInput {
  return { connectionId, expectedRevision, ...patch };
}

describe('MemoryConnectionService — create', () => {
  test('create writes no secret into DTO/config when apiKey is omitted', async () => {
    const { repo, service, store } = makeHarness();

    const summary = await createConnection(service, CONN);

    const loaded = repo.getConnection(summary.connectionId)!;
    expect(summary.hasApiKey).toBe(false);
    expect(loaded.credentialMode).toBe('none');
    expect('apiKey' in summary).toBe(false);
    expect(store.size).toBe(0);
  });

  test('create with apiKey persists secret only in credential storage and returns hasApiKey true', async () => {
    const { repo, service, manager } = makeHarness();

    const summary = await createConnection(service, { ...CONN, apiKey: '  sk-live-alpha  ' });

    const loaded = repo.getConnection(summary.connectionId)!;
    expect(summary.hasApiKey).toBe(true);
    expect(loaded.credentialMode).toBe('stored-api-key');
    expect('apiKey' in summary).toBe(false);
    expect(await manager.getMemoryApiKey(summary.connectionId)).toBe('sk-live-alpha');
  });

  test('create rejects blank apiKey before persisting either config or credentials', async () => {
    const { repo, service } = makeHarness();

    await expect(createConnection(service, { ...CONN, apiKey: '   ' })).rejects.toMatchObject({
      code: 'validation_error',
    });

    expect(repo.listConnections()).toHaveLength(0);
  });

  test('create commits the connection on config commit; a failed credential write is deferred to recovery', async () => {
    // Commit point = the durable config (connection) create. Once it lands, the
    // saga rolls forward: a failing credential write does NOT undo the connection;
    // the key is completed by recovery. The caller still sees credential_error.
    const { repo, service, manager } = makeHarness({
      failSet: id => id.type === 'memory_api_key',
    });

    await expect(createConnection(service, { ...CONN, apiKey: 'sk-live-beta' })).rejects.toMatchObject({
      code: 'credential_error',
    });

    // Connection is committed; the key is pending (not rolled back).
    expect(repo.listConnections()).toHaveLength(1);
    expect(await manager.getMemoryApiKey(repo.listConnections()[0]!.connectionId)).toBeNull();
    // The in-flight saga survives in the journal for recovery to finish.
    expect(service.coordinator.getJournalStore().listEntries()).toHaveLength(1);
  });

  test('create rolls back fully when the config commit itself fails (stale root)', async () => {
    const { repo, service } = makeHarness();
    await expect(createConnection(service, { ...CONN, apiKey: 'sk-x', expectedRootRevision: 999 }))
      .rejects.toMatchObject({ code: 'config_error' });
    expect(repo.listConnections()).toHaveLength(0);
  });
});

describe('MemoryConnectionService — patch/update', () => {
  test('update without apiKey uses updated config while preserving existing key state', async () => {
    const { repo, service, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-initial' });
    const updated = await service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Alpha Renamed',
    }));

    expect(updated.name).toBe('Alpha Renamed');
    expect(updated.hasApiKey).toBe(true);
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-initial');
    expect(repo.getConnection(created.connectionId)!.revision).toBe(2);
  });

  test('patch does not update key when config patch fails; returns validation/config error', async () => {
    const { service, repo, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-initial' });
    const staleRevision = created.revision + 1;

    await expect(service.patchConnection(makeUpdate(created.connectionId, staleRevision, {
      name: 'Should fail',
      apiKey: 'sk-updated',
    }))).rejects.toMatchObject({ code: 'config_error' });

    expect(repo.getConnection(created.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-initial');
  });

  test('a combined config+apiKey patch is atomic: a failed apiKey write rolls back the config too', async () => {
    // Under the A5 saga a patch that changes config AND the API key is one
    // atomic operation. If the credential write fails, the whole operation is
    // compensated — the config change is rolled back, not left half-applied.
    const { service, repo, manager } = makeHarness({
      failSet: id => id.type === 'memory_api_key',
    });

    const created = await service.createConnection(CONN);
    await expect(service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Edited',
      apiKey: 'sk-bad-update',
    }))).rejects.toMatchObject({ code: 'credential_error' });

    expect(repo.getConnection(created.connectionId)?.name).toBe('Alpha');
    expect(await manager.hasMemoryApiKey(created.connectionId)).toBe(false);
  });

  test('patch rejects blank apiKey before mutating config', async () => {
    const { repo, service } = makeHarness();

    const created = await service.createConnection(CONN);
    await expect(service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Edited',
      apiKey: '   ',
    }))).rejects.toMatchObject({ code: 'validation_error' });
    expect(repo.getConnection(created.connectionId)?.name).toBe('Alpha');
  });
});

describe('MemoryConnectionService — delete', () => {
  test('delete removes both config and credential when both succeed', async () => {
    const { repo, service, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-to-delete' });
    const rootBefore = repo.getRootRevision();

    await service.deleteConnection(created.connectionId, rootBefore);

    expect(repo.getConnection(created.connectionId)).toBeNull();
    expect(await manager.hasMemoryApiKey(created.connectionId)).toBe(false);
  });

  test('delete is forward-only: config delete commits, a failed credential delete is deferred to recovery', async () => {
    // Fixed order: config delete (commit) → credential delete. Once the config
    // delete lands, the saga never resurrects the connection; a failed credential
    // delete is retried by recovery. The caller still sees credential_error.
    const { repo, service, manager } = makeHarness({
      failDelete: id => id.type === 'memory_api_key',
    });

    const created = await service.createConnection({ ...CONN, apiKey: 'sk-to-delete' });
    const rootBefore = repo.getRootRevision();

    await expect(service.deleteConnection(created.connectionId, rootBefore)).rejects.toMatchObject({
      code: 'credential_error',
    });

    // Config is deleted (never resurrected); the orphaned key awaits recovery.
    expect(repo.getConnection(created.connectionId)).toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-to-delete');
    expect(service.coordinator.getJournalStore().listEntries()).toHaveLength(1);
  });

  test('delete config-commit failure (stale root) rolls back with a no-op: connection and key intact', async () => {
    const { repo, service, manager } = makeHarness();

    const first = await createConnection(service, { ...CONN, apiKey: 'sk-stay' });
    const staleRoot = repo.getRootRevision();

    // Make config root change so delete uses a stale revision and its config
    // (commit) barrier fails before landing — a pre-commit failure → no-op rollback.
    await createConnection(service, { ...CONN, name: 'Second' });

    await expect(service.deleteConnection(first.connectionId, staleRoot)).rejects.toMatchObject({
      code: 'config_error',
    });

    expect(repo.getConnection(first.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(first.connectionId)).toBe('sk-stay');
  });
});
