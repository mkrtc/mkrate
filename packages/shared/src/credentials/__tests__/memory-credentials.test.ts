import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../manager.ts';
import { type CredentialBackend } from '../backends/types.ts';
import { SecureStorageBackend } from '../backends/secure-storage.ts';
import { CredentialStoreError, accountToCredentialId, credentialIdToAccount, MEMORY_CREDENTIAL_TYPES } from '../types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID = '00000000-1111-4222-8333-444444444444';

function makeTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'craft-agent-credentials-'));
}

function writeCorruptCredentialFile(path: string): void {
  writeFileSync(path, 'not-valid-credential-bytes');
}

describe('memory_api_key credential conversion', () => {
  test('MEMORY_CREDENTIAL_TYPES lists memory_api_key', () => {
    expect([...MEMORY_CREDENTIAL_TYPES]).toEqual(['memory_api_key']);
  });

  test('credentialIdToAccount produces memory_api_key::{connectionId}', () => {
    expect(credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID })).toBe(`memory_api_key::${UUID}`);
  });

  test('credentialIdToAccount canonicalizes a case-variant UUID to lowercase', () => {
    const upper = UUID.toUpperCase();
    expect(credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: upper })).toBe(`memory_api_key::${UUID}`);
  });

  test('accountToCredentialId rejects a non-canonical (uppercase) account', () => {
    expect(accountToCredentialId(`memory_api_key::${UUID.toUpperCase()}`)).toBeNull();
  });

  test('the account has exactly two "::"-delimited segments (UUID carries no delimiter)', () => {
    const account = credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID });
    expect(account.split('::')).toHaveLength(2);
  });

  test('round-trips through accountToCredentialId', () => {
    const account = credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID });
    expect(accountToCredentialId(account)).toEqual({ type: 'memory_api_key', memoryConnectionId: UUID });
  });

  test('converter throws for a missing or non-UUID connection id', () => {
    expect(() => credentialIdToAccount({ type: 'memory_api_key' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: 'not-a-uuid' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: 'a::b' })).toThrow();
  });

  test('parser rejects a non-UUID second segment (never falls back to global)', () => {
    expect(accountToCredentialId('memory_api_key::not-a-uuid')).toBeNull();
    expect(accountToCredentialId('memory_api_key::global')).toBeNull();
    expect(accountToCredentialId('memory_api_key')).toBeNull();
  });

  test('does not collide with llm_api_key slug parsing', () => {
    expect(accountToCredentialId('llm_api_key::my-slug')).toEqual({ type: 'llm_api_key', connectionSlug: 'my-slug' });
  });
});

/**
 * Round-trip through the CredentialManager memory helpers, backed by an
 * in-memory backend keyed via the REAL account converter. This exercises the full
 * helper → CredentialId → account plumbing (incl. UUID validation and list
 * filtering) deterministically, without touching the encrypted store on disk.
 */
function fakeManager(): { manager: CredentialManager; store: Map<string, StoredCredential> } {
  const store = new Map<string, StoredCredential>();
  const backend: CredentialBackend = {
    name: 'memory-test-backend',
    priority: 100,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async get(id: CredentialId): Promise<StoredCredential | null> {
      return store.get(credentialIdToAccount(id)) ?? null;
    },
    async set(id: CredentialId, cred: StoredCredential): Promise<void> {
      store.set(credentialIdToAccount(id), cred);
    },
    async delete(id: CredentialId): Promise<boolean> {
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
        && (!filter.memoryConnectionId || id.memoryConnectionId === filter.memoryConnectionId));
    },
  };

  const manager = new CredentialManager({ backends: [backend] });
  return { manager, store };
}

describe('A5 saga staging/quarantine credential identities', () => {
  const SAGA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  test('memory_saga_stage encodes and round-trips per slot', () => {
    const before = credentialIdToAccount({ type: 'memory_saga_stage', sagaId: SAGA, sagaSlot: 'before' });
    expect(before).toBe(`memory_saga_stage::${SAGA}::before`);
    expect(accountToCredentialId(before)).toEqual({ type: 'memory_saga_stage', sagaId: SAGA, sagaSlot: 'before' });
    const after = credentialIdToAccount({ type: 'memory_saga_stage', sagaId: SAGA, sagaSlot: 'after' });
    expect(accountToCredentialId(after)).toEqual({ type: 'memory_saga_stage', sagaId: SAGA, sagaSlot: 'after' });
  });

  test('memory_saga_quarantine encodes and round-trips with a hex token', () => {
    const account = credentialIdToAccount({ type: 'memory_saga_quarantine', sagaId: SAGA, sagaSlot: 'before', quarantineToken: 'deadbeef' });
    expect(account).toBe(`memory_saga_quarantine::${SAGA}::before::deadbeef`);
    expect(accountToCredentialId(account)).toEqual({ type: 'memory_saga_quarantine', sagaId: SAGA, sagaSlot: 'before', quarantineToken: 'deadbeef' });
  });

  test('saga identities reject a non-canonical sagaId or bad slot/token', () => {
    expect(() => credentialIdToAccount({ type: 'memory_saga_stage', sagaId: SAGA.toUpperCase(), sagaSlot: 'before' })).not.toThrow();
    // Uppercase sagaId canonicalizes on encode, but a stored uppercase account must not parse.
    expect(accountToCredentialId(`memory_saga_stage::${SAGA.toUpperCase()}::before`)).toBeNull();
    expect(accountToCredentialId(`memory_saga_stage::${SAGA}::sideways`)).toBeNull();
    expect(accountToCredentialId(`memory_saga_quarantine::${SAGA}::before::NOTHEX`)).toBeNull();
    expect(() => credentialIdToAccount({ type: 'memory_saga_stage', sagaId: SAGA } as never)).toThrow();
  });

  test('staging round-trips through the manager and stays out of the generic memory listing', async () => {
    const { manager, store } = fakeManager();
    await manager.setMemoryApiKey(UUID, 'sk-real');
    await manager.stageSagaSecret(SAGA, 'before', 'sk-staged-before');
    await manager.stageSagaSecret(SAGA, 'after', 'sk-staged-after');

    expect(await manager.readStagedSagaSecret(SAGA, 'before')).toBe('sk-staged-before');
    expect(await manager.readStagedSagaSecret(SAGA, 'after')).toBe('sk-staged-after');
    // The staging identities do not appear as memory connections with keys.
    expect(await manager.listMemoryApiKeyConnectionIds()).toEqual([UUID]);
    expect([...store.keys()].filter(k => k.startsWith('memory_saga_stage'))).toHaveLength(2);

    expect(await manager.deleteStagedSagaSecret(SAGA, 'before')).toBe(true);
    expect(await manager.readStagedSagaSecret(SAGA, 'before')).toBeNull();
  });

  test('legacy enumeration + saga-stage enumeration report no work when the backend cannot enumerate raw accounts', async () => {
    const { manager } = fakeManager(); // fake backend has no listRawAccounts
    expect(await manager.listLegacyMemoryApiKeyAccounts()).toEqual([]);
    expect(await manager.listSagaStageSagaIds()).toEqual([]);
  });
});

describe('CredentialManager memory helpers (round-trip)', () => {
  test('set → get → has → list → delete round-trips per connection id', async () => {
    const { manager, store } = fakeManager();

    expect(await manager.hasMemoryApiKey(UUID)).toBe(false);
    await manager.setMemoryApiKey(UUID, 'sk-memory-abc');
    await manager.setMemoryApiKey(OTHER_UUID, 'sk-memory-def');

    // Stored under the connection-scoped account key (no secret in the key).
    expect(store.has(`memory_api_key::${UUID}`)).toBe(true);

    expect(await manager.getMemoryApiKey(UUID)).toBe('sk-memory-abc');
    expect(await manager.hasMemoryApiKey(UUID)).toBe(true);

    const ids = await manager.listMemoryApiKeyConnectionIds();
    expect(ids.sort()).toEqual([UUID, OTHER_UUID].sort());

    expect(await manager.deleteMemoryApiKey(UUID)).toBe(true);
    expect(await manager.getMemoryApiKey(UUID)).toBeNull();
    // The other connection's key is untouched.
    expect(await manager.getMemoryApiKey(OTHER_UUID)).toBe('sk-memory-def');
  });

  test('memory API helper methods propagate typed backend errors', async () => {
    const backend: CredentialBackend = {
      name: 'failing-backend',
      priority: 100,
      async isAvailable(): Promise<boolean> {
        return true;
      },
      async get(): Promise<null> {
        throw new CredentialStoreError('decryption_failed', 'Cannot decrypt credentials from test backend.');
      },
      async set(): Promise<void> {
        // no-op
      },
      async delete(): Promise<boolean> {
        return false;
      },
      deleteSync(): boolean {
        return false;
      },
      async list(): Promise<CredentialId[]> {
        throw new CredentialStoreError('file_corrupted', 'Cannot list corrupted credentials from test backend.');
      },
    };

    const manager = new CredentialManager({ backends: [backend] });

    await expect(manager.getMemoryApiKey(UUID)).rejects.toMatchObject({ name: 'CredentialStoreError', code: 'decryption_failed' });
    await expect(manager.listMemoryApiKeyConnectionIds()).rejects.toMatchObject({ name: 'CredentialStoreError', code: 'file_corrupted' });
  });

  test('rejects a non-UUID connection id and empty/whitespace-only key', async () => {
    const { manager } = fakeManager();
    await expect(manager.setMemoryApiKey('not-a-uuid', 'x')).rejects.toThrow();
    await expect(manager.getMemoryApiKey('not-a-uuid')).rejects.toThrow();
    await expect(manager.deleteMemoryApiKey('not-a-uuid')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '   ')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '\t\n')).rejects.toThrow();
  });

  test('case-variant connection ids resolve to the same canonical account', async () => {
    const { manager } = fakeManager();
    await manager.setMemoryApiKey(UUID.toUpperCase(), 'sk-canon');
    expect(await manager.getMemoryApiKey(UUID)).toBe('sk-canon');
    const ids = await manager.listMemoryApiKeyConnectionIds();
    expect(ids).toEqual([UUID]); // canonical lowercase, de-duplicated
  });
});

describe('SecureStorageBackend behavior', () => {
  test('respects injected config directory for test isolation', async () => {
    const configDir = makeTempConfigDir();
    try {
      const backend = new SecureStorageBackend({ configDir });

      expect(backend.getCredentialsFilePath()).toBe(join(configDir, 'credentials.enc'));
      expect(backend.getCredentialsFilePath()).not.toBe(join(homedir(), '.craft-agent', 'credentials.enc'));

      await backend.set({ type: 'memory_api_key', memoryConnectionId: UUID }, { value: 'isolated-token' });
      expect(existsSync(backend.getCredentialsFilePath())).toBe(true);

      const cred = await backend.get({ type: 'memory_api_key', memoryConnectionId: UUID });
      expect(cred?.value).toBe('isolated-token');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('throws in test mode when no override path is provided', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalConfigDir = process.env.CRAFT_CONFIG_DIR;

    try {
      process.env.NODE_ENV = 'test';
      delete process.env.CRAFT_CONFIG_DIR;
      expect(() => new SecureStorageBackend()).toThrow(/Refusing to initialize credential backend/);
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalConfigDir === undefined) {
        delete process.env.CRAFT_CONFIG_DIR;
      } else {
        process.env.CRAFT_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  test('allows default path via CRAFT_CONFIG_DIR override', () => {
    const tempDir = makeTempConfigDir();
    const originalNodeEnv = process.env.NODE_ENV;
    const originalConfigDir = process.env.CRAFT_CONFIG_DIR;

    try {
      process.env.NODE_ENV = 'test';
      process.env.CRAFT_CONFIG_DIR = tempDir;

      const backend = new SecureStorageBackend();
      expect(backend.getCredentialsFilePath()).toBe(join(tempDir, 'credentials.enc'));
      expect(backend.getCredentialsFilePath()).not.toBe(join(homedir(), '.craft-agent', 'credentials.enc'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalConfigDir === undefined) {
        delete process.env.CRAFT_CONFIG_DIR;
      } else {
        process.env.CRAFT_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  test('preserves and quarantines a corrupted file without deleting it', async () => {
    const configDir = makeTempConfigDir();
    try {
      const backend = new SecureStorageBackend({ configDir });
      const filePath = backend.getCredentialsFilePath();

      writeCorruptCredentialFile(filePath);

      const failure = backend.get({ type: 'memory_api_key', memoryConnectionId: UUID });
      await expect(failure).rejects.toMatchObject({ name: 'CredentialStoreError', code: 'file_corrupted' });

      expect(existsSync(filePath)).toBe(true);
      const hasQuarantine = readdirSync(configDir).some((name) => name.startsWith('credentials.enc.file_corrupted.'));
      expect(hasQuarantine).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('re-reads when another manager updates the same file', async () => {
    const configDir = makeTempConfigDir();
    try {
      const managerA = new CredentialManager({ credentialsConfigDir: configDir });
      const managerB = new CredentialManager({ credentialsConfigDir: configDir });

      await managerA.setMemoryApiKey(UUID, 'alpha');
      await managerB.setMemoryApiKey(OTHER_UUID, 'bravo');

      const ids = await managerA.listMemoryApiKeyConnectionIds();
      expect(ids.sort()).toEqual([UUID, OTHER_UUID].sort());
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
