import { describe, expect, test } from 'bun:test';
import { CredentialManager } from '../manager.ts';
import { type CredentialBackend } from '../backends/types.ts';
import {
  CredentialStoreError,
  accountToCredentialId,
  credentialIdToAccount,
  BRIDGE_CREDENTIAL_TYPES,
} from '../types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

const PROFILE = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_PROFILE = '00000000-1111-4222-8333-444444444444';
const SECRET = 'brk_live_super-secret-instance-token';

/** In-memory manager keyed via the REAL account converter (exercises full plumbing). */
function fakeManager(): { manager: CredentialManager; store: Map<string, StoredCredential> } {
  const store = new Map<string, StoredCredential>();
  const backend: CredentialBackend = {
    name: 'bridge-test-backend',
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
      return ids.filter(
        (id) =>
          (!filter.type || id.type === filter.type) &&
          (!filter.bridgeProfileId || id.bridgeProfileId === filter.bridgeProfileId),
      );
    },
  };
  const manager = new CredentialManager({ backends: [backend] });
  return { manager, store };
}

describe('bridge_instance_token account conversion', () => {
  test('BRIDGE_CREDENTIAL_TYPES lists exactly bridge_instance_token (no bootstrap type)', () => {
    expect([...BRIDGE_CREDENTIAL_TYPES]).toEqual(['bridge_instance_token']);
  });

  test('credentialIdToAccount produces bridge_instance_token::{profileId}', () => {
    expect(credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: PROFILE })).toBe(
      `bridge_instance_token::${PROFILE}`,
    );
  });

  test('canonicalizes a case-variant profile id to lowercase', () => {
    expect(credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: PROFILE.toUpperCase() })).toBe(
      `bridge_instance_token::${PROFILE}`,
    );
  });

  test('accountToCredentialId rejects a non-canonical (uppercase) account', () => {
    expect(accountToCredentialId(`bridge_instance_token::${PROFILE.toUpperCase()}`)).toBeNull();
  });

  test('the account has exactly two "::"-delimited segments (UUID carries no delimiter)', () => {
    const account = credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: PROFILE });
    expect(account.split('::')).toHaveLength(2);
  });

  test('round-trips through accountToCredentialId', () => {
    const account = credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: PROFILE });
    expect(accountToCredentialId(account)).toEqual({ type: 'bridge_instance_token', bridgeProfileId: PROFILE });
  });

  test('converter throws for a missing or non-UUID profile id', () => {
    expect(() => credentialIdToAccount({ type: 'bridge_instance_token' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: 'not-a-uuid' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: 'a::b' })).toThrow();
  });

  test('parser rejects a non-UUID second segment (never falls back to global)', () => {
    expect(accountToCredentialId('bridge_instance_token::not-a-uuid')).toBeNull();
    expect(accountToCredentialId('bridge_instance_token::global')).toBeNull();
    expect(accountToCredentialId('bridge_instance_token')).toBeNull();
  });

  test('no persisted bootstrap/enrollment credential type exists', () => {
    // A bootstrap/pairing code is one-shot and must never be a persisted credential.
    expect(accountToCredentialId(`bridge_bootstrap_token::${PROFILE}`)).toBeNull();
    expect(accountToCredentialId(`bridge_enrollment_token::${PROFILE}`)).toBeNull();
    expect(accountToCredentialId(`bridge_pairing_token::${PROFILE}`)).toBeNull();
  });

  test('does not collide with llm_api_key or memory_api_key parsing', () => {
    expect(accountToCredentialId('llm_api_key::my-slug')).toEqual({ type: 'llm_api_key', connectionSlug: 'my-slug' });
    expect(accountToCredentialId(`memory_api_key::${PROFILE}`)).toEqual({
      type: 'memory_api_key',
      memoryConnectionId: PROFILE,
    });
  });
});

describe('CredentialManager bridge helpers (round-trip + isolation)', () => {
  test('set → get → has → list → delete round-trips per profile id', async () => {
    const { manager, store } = fakeManager();

    expect(await manager.hasBridgeInstanceToken(PROFILE)).toBe(false);
    await manager.setBridgeInstanceToken(PROFILE, SECRET);
    await manager.setBridgeInstanceToken(OTHER_PROFILE, 'other-token');

    // Stored under the profile-scoped account key (secret is the VALUE, never the key).
    expect(store.has(`bridge_instance_token::${PROFILE}`)).toBe(true);
    expect([...store.keys()].some((k) => k.includes(SECRET))).toBe(false);

    expect(await manager.getBridgeInstanceToken(PROFILE)).toBe(SECRET);
    expect(await manager.hasBridgeInstanceToken(PROFILE)).toBe(true);

    const ids = await manager.listBridgeInstanceTokenProfileIds();
    expect(ids.sort()).toEqual([PROFILE, OTHER_PROFILE].sort());

    expect(await manager.deleteBridgeInstanceToken(PROFILE)).toBe(true);
    expect(await manager.getBridgeInstanceToken(PROFILE)).toBeNull();
    // The other profile's token is untouched (key isolation).
    expect(await manager.getBridgeInstanceToken(OTHER_PROFILE)).toBe('other-token');
  });

  test('case-variant profile ids resolve to the same canonical account', async () => {
    const { manager } = fakeManager();
    await manager.setBridgeInstanceToken(PROFILE.toUpperCase(), SECRET);
    expect(await manager.getBridgeInstanceToken(PROFILE)).toBe(SECRET);
    expect(await manager.listBridgeInstanceTokenProfileIds()).toEqual([PROFILE]);
  });

  test('bridge tokens do not appear in unrelated typed listings', async () => {
    const { manager } = fakeManager();
    await manager.setBridgeInstanceToken(PROFILE, SECRET);
    // A memory-key listing must not surface the bridge token.
    expect(await manager.listMemoryApiKeyConnectionIds()).toEqual([]);
  });

  test('rejects a non-UUID profile id and empty/whitespace-only token', async () => {
    const { manager } = fakeManager();
    await expect(manager.setBridgeInstanceToken('not-a-uuid', SECRET)).rejects.toThrow();
    await expect(manager.getBridgeInstanceToken('not-a-uuid')).rejects.toThrow();
    await expect(manager.deleteBridgeInstanceToken('not-a-uuid')).rejects.toThrow();
    await expect(manager.setBridgeInstanceToken(PROFILE, '')).rejects.toThrow();
    await expect(manager.setBridgeInstanceToken(PROFILE, '   ')).rejects.toThrow();
  });

  test('bridge helper methods propagate typed backend errors (corrupt store)', async () => {
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

    await expect(manager.getBridgeInstanceToken(PROFILE)).rejects.toMatchObject({
      name: 'CredentialStoreError',
      code: 'decryption_failed',
    });
    await expect(manager.listBridgeInstanceTokenProfileIds()).rejects.toMatchObject({
      name: 'CredentialStoreError',
      code: 'file_corrupted',
    });
  });
});

describe('tokens never serialize into config/status representations', () => {
  test('a listed CredentialId carries no secret value', async () => {
    const { manager } = fakeManager();
    await manager.setBridgeInstanceToken(PROFILE, SECRET);

    const ids = await manager.list({ type: 'bridge_instance_token' });
    expect(ids).toEqual([{ type: 'bridge_instance_token', bridgeProfileId: PROFILE }]);
    // The identity that a config/status layer would surface has no token material.
    for (const id of ids) {
      expect((id as unknown as Record<string, unknown>).value).toBeUndefined();
      expect(JSON.stringify(id).includes(SECRET)).toBe(false);
    }
  });

  test('the account key string never embeds the token value', () => {
    const account = credentialIdToAccount({ type: 'bridge_instance_token', bridgeProfileId: PROFILE });
    expect(account.includes(SECRET)).toBe(false);
    expect(account).toBe(`bridge_instance_token::${PROFILE}`);
  });
});
