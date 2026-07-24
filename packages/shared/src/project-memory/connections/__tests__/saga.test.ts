/**
 * A5 saga coordinator tests: barrier state machine, config-commit points,
 * write-ahead crash recovery (in-process), forward-only delete, hard-fail
 * quarantine, credentialMode convergence, legacy migration, lease serialization.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../../../credentials/manager.ts';
import type { CredentialBackend } from '../../../credentials/backends/types.ts';
import { accountToCredentialId, credentialIdToAccount, type CredentialId, type StoredCredential } from '../../../credentials/types.ts';
import { MemoryConnectionRepository } from '../repository.ts';
import {
  MemorySagaCoordinator,
  MigrationCollisionError,
  SagaAbortError,
  SagaBlockedError,
  SagaLease,
  SAGA_LEASE_FILE,
  type MemorySagaHooks,
  type SagaBarrierKind,
  type SagaHookContext,
  type SagaStepPhase,
} from '../index.ts';
import type { CreateMemoryConnectionInput } from '../types.ts';
import { randomUuid } from '../../../utils/uuid.ts';

let dir: string;
let store: Map<string, StoredCredential>;

const CONN: CreateMemoryConnectionInput = {
  name: 'Alpha',
  url: 'http://127.0.0.1:6333',
  collection: 'craft_memory',
  embedding: { model: 'craft-local-hash-v1', dimension: 384 },
};

function makeBackend(faults: { failSet?: (id: CredentialId) => boolean; failDelete?: (id: CredentialId) => boolean } = {}): CredentialBackend {
  return {
    name: 'saga-test-backend',
    priority: 100,
    async isAvailable() { return true; },
    async get(id) { return store.get(credentialIdToAccount(id)) ?? null; },
    async set(id, cred) {
      if (faults.failSet?.(id)) throw new Error(`injected set failure for ${credentialIdToAccount(id)}`);
      store.set(credentialIdToAccount(id), cred);
    },
    async delete(id) {
      if (faults.failDelete?.(id)) throw new Error(`injected delete failure for ${credentialIdToAccount(id)}`);
      return store.delete(credentialIdToAccount(id));
    },
    deleteSync(id) { return store.delete(credentialIdToAccount(id)); },
    async list(filter) {
      const ids = [...store.keys()].map(accountToCredentialId).filter((x): x is CredentialId => x !== null);
      if (!filter) return ids;
      return ids.filter(id => (!filter.type || id.type === filter.type) && (!filter.memoryConnectionId || id.memoryConnectionId === filter.memoryConnectionId));
    },
    async listRawAccounts() { return [...store.keys()]; },
    async getByAccount(account) { return store.get(account) ?? null; },
    async deleteByAccount(account) { return store.delete(account); },
  };
}

function makeStack(faults: { failSet?: (id: CredentialId) => boolean; failDelete?: (id: CredentialId) => boolean } = {}) {
  const repo = new MemoryConnectionRepository({ configDir: dir });
  const manager = new CredentialManager({ backends: [makeBackend(faults)] });
  return { repo, manager };
}

function makeCoordinator(hooks?: MemorySagaHooks, faults?: { failSet?: (id: CredentialId) => boolean; failDelete?: (id: CredentialId) => boolean }) {
  const { repo, manager } = makeStack(faults);
  const coordinator = new MemorySagaCoordinator({ repository: repo, credentialManager: manager, dir: repo.getDir(), hooks, leaseTimeoutMs: 4_000 });
  return { repo, manager, coordinator };
}

function coordinatorOn(repo: MemoryConnectionRepository, manager: CredentialManager, hooks?: MemorySagaHooks) {
  return new MemorySagaCoordinator({ repository: repo, credentialManager: manager, dir: repo.getDir(), hooks, leaseTimeoutMs: 4_000 });
}

function crashAt(barrier: SagaBarrierKind, phase: SagaStepPhase): MemorySagaHooks {
  return { onStep: (ctx: SagaHookContext) => { if (ctx.mode === 'live' && ctx.barrier === barrier && ctx.phase === phase) throw new SagaAbortError(); } };
}

function journalPath(): string {
  return join(dir, 'memory', 'saga-journal.json');
}

function stagingKeys(): string[] {
  return [...store.keys()].filter(k => k.startsWith('memory_saga_stage'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saga-'));
  store = new Map();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lifecycle & credentialMode convergence', () => {
  test('create without key: mode none, no key, journal drained', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const conn = await coordinator.createConnection(CONN, 0);
    expect(conn.credentialMode).toBe('none');
    expect(await manager.getMemoryApiKey(conn.connectionId)).toBeNull();
    expect(repo.getConnection(conn.connectionId)).not.toBeNull();
    expect(coordinator.getJournalStore().listEntries()).toEqual([]);
    expect(store.size).toBe(0);
  });

  test('create with key: mode stored-api-key, key stored, staging cleaned', async () => {
    const { manager, coordinator } = makeCoordinator();
    const conn = await coordinator.createConnection(CONN, 0, 'sk-alpha');
    expect(conn.credentialMode).toBe('stored-api-key');
    expect(await manager.getMemoryApiKey(conn.connectionId)).toBe('sk-alpha');
    expect(await manager.listMemoryApiKeyConnectionIds()).toEqual([conn.connectionId]);
    expect(stagingKeys()).toHaveLength(0);
    expect(coordinator.getJournalStore().listEntries()).toEqual([]);
  });

  test('setApiKey converges keyless → stored-api-key', async () => {
    const { manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0);
    const updated = await coordinator.setApiKey(created.connectionId, 'sk-new', created.revision);
    expect(updated.credentialMode).toBe('stored-api-key');
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-new');
  });

  test('setApiKey refuses when a key already exists', async () => {
    const { coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0, 'sk-first');
    await expect(coordinator.setApiKey(created.connectionId, 'sk-again', created.revision)).rejects.toMatchObject({ cause: { code: 'invalid_input' } });
  });

  test('replaceApiKey replaces and fails closed when none exists', async () => {
    const { manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0);
    await expect(coordinator.replaceApiKey(created.connectionId, 'sk-x', created.revision)).rejects.toMatchObject({ cause: { code: 'invalid_input' } });
    const withKey = await coordinator.setApiKey(created.connectionId, 'sk-first', created.revision);
    const replaced = await coordinator.replaceApiKey(created.connectionId, 'sk-second', withKey.revision);
    expect(replaced.credentialMode).toBe('stored-api-key');
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-second');
  });

  test('clearApiKey removes the key and converges to none', async () => {
    const { manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0, 'sk-key');
    const cleared = await coordinator.clearApiKey(created.connectionId, created.revision);
    expect(cleared.credentialMode).toBe('none');
    expect(await manager.getMemoryApiKey(created.connectionId)).toBeNull();
    expect(stagingKeys()).toHaveLength(0);
  });

  test('setCredentialMode enforces consistency with actual key presence', async () => {
    const { coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0);
    await expect(coordinator.setCredentialMode(created.connectionId, 'stored-api-key', created.revision)).rejects.toMatchObject({ cause: { code: 'invalid_input' } });
    const withKey = await coordinator.setApiKey(created.connectionId, 'sk', created.revision);
    await expect(coordinator.setCredentialMode(created.connectionId, 'none', withKey.revision)).rejects.toMatchObject({ cause: { code: 'invalid_input' } });
    const same = await coordinator.setCredentialMode(created.connectionId, 'stored-api-key', withKey.revision);
    expect(same.credentialMode).toBe('stored-api-key');
  });

  test('delete removes config and credential together', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0, 'sk-del');
    await coordinator.deleteConnection(created.connectionId, repo.getRootRevision());
    expect(repo.getConnection(created.connectionId)).toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBeNull();
    expect(coordinator.getJournalStore().listEntries()).toEqual([]);
  });

  test('config-only update preserves the key; update+set converges mode', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0, 'sk-keep');
    const renamed = await coordinator.updateConnectionConfig(created.connectionId, { name: 'Beta' }, created.revision);
    expect(renamed.name).toBe('Beta');
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-keep');

    const keyless = await coordinator.createConnection({ ...CONN, name: 'Gamma' }, repo.getRootRevision());
    const withKey = await coordinator.updateConnectionConfig(keyless.connectionId, { name: 'Delta' }, keyless.revision, { kind: 'set', apiKey: 'sk-added' });
    expect(withKey.name).toBe('Delta');
    expect(withKey.credentialMode).toBe('stored-api-key');
    expect(await manager.getMemoryApiKey(keyless.connectionId)).toBe('sk-added');
  });
});

describe('secret hygiene', () => {
  test('mid-saga: secret lives only in encrypted staging, never in the journal', async () => {
    const SECRET = 'sk-SECRET-NEEDLE-9f3a';
    const { repo, manager } = makeStack();
    const crashing = coordinatorOn(repo, manager, crashAt('config', 'after'));
    await expect(crashing.createConnection(CONN, 0, SECRET)).rejects.toBeInstanceOf(SagaAbortError);

    const stagedKey = stagingKeys()[0];
    expect(stagedKey).toBeDefined();
    expect(store.get(stagedKey!)?.value).toBe(SECRET);
    const journalText = readFileSync(journalPath(), 'utf8');
    expect(journalText).not.toContain(SECRET);
    expect(journalText).toContain('"stagedSlots"');
  });

  test('staging identities are excluded from the generic memory listing', async () => {
    const { repo, manager } = makeStack();
    const crashing = coordinatorOn(repo, manager, crashAt('stage', 'after'));
    await expect(crashing.createConnection(CONN, 0, 'sk-hidden')).rejects.toBeInstanceOf(SagaAbortError);
    expect(stagingKeys().length).toBeGreaterThan(0);
    expect(await manager.listMemoryApiKeyConnectionIds()).toEqual([]);
  });
});

describe('write-ahead crash recovery (commit = config barrier)', () => {
  test('create+key crash at config:before (effect not landed) → rollback', async () => {
    const { repo, manager } = makeStack();
    await expect(coordinatorOn(repo, manager, crashAt('config', 'before')).createConnection(CONN, 0, 'sk-rb')).rejects.toBeInstanceOf(SagaAbortError);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    expect(repo.listConnections()).toEqual([]);
    expect(await manager.listMemoryApiKeyConnectionIds()).toEqual([]);
    expect(recovered.getJournalStore().listEntries()).toEqual([]);
    expect(stagingKeys()).toHaveLength(0);
  });

  test('create+key crash at config:after (effect landed, marker missing) → roll forward', async () => {
    const { repo, manager } = makeStack();
    await expect(coordinatorOn(repo, manager, crashAt('config', 'after')).createConnection(CONN, 0, 'sk-fw')).rejects.toBeInstanceOf(SagaAbortError);
    // The connection row is on disk but the journal status "lies" at config:doing.
    expect(repo.listConnections()).toHaveLength(1);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    const list = repo.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialMode).toBe('stored-api-key');
    expect(await manager.getMemoryApiKey(list[0]!.connectionId)).toBe('sk-fw');
    expect(recovered.getJournalStore().listEntries()).toEqual([]);
  });

  test('create+key crash at credential:after (past commit) → roll forward complete', async () => {
    const { repo, manager } = makeStack();
    await expect(coordinatorOn(repo, manager, crashAt('credential', 'after')).createConnection(CONN, 0, 'sk-cf')).rejects.toBeInstanceOf(SagaAbortError);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    const list = repo.listConnections();
    expect(list).toHaveLength(1);
    expect(await manager.getMemoryApiKey(list[0]!.connectionId)).toBe('sk-cf');
  });

  test('delete crash at config:after (config deleted, marker missing) → roll forward (never resurrect)', async () => {
    const { repo, manager } = makeStack();
    const setup = coordinatorOn(repo, manager);
    const created = await setup.createConnection(CONN, 0, 'sk-del');
    await expect(coordinatorOn(repo, manager, crashAt('config', 'after')).deleteConnection(created.connectionId, repo.getRootRevision())).rejects.toBeInstanceOf(SagaAbortError);
    // Config already deleted.
    expect(repo.getConnection(created.connectionId)).toBeNull();
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    // Forward-only: connection stays deleted, credential cleaned up. NOT resurrected.
    expect(repo.getConnection(created.connectionId)).toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBeNull();
    expect(recovered.getJournalStore().listEntries()).toEqual([]);
  });

  test('delete crash at config:before (config not yet deleted) → rollback no-op (connection intact)', async () => {
    const { repo, manager } = makeStack();
    const setup = coordinatorOn(repo, manager);
    const created = await setup.createConnection(CONN, 0, 'sk-keep');
    await expect(coordinatorOn(repo, manager, crashAt('config', 'before')).deleteConnection(created.connectionId, repo.getRootRevision())).rejects.toBeInstanceOf(SagaAbortError);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    expect(repo.getConnection(created.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-keep');
  });

  test('replace crash at credential:before → rollback keeps the old key', async () => {
    const { repo, manager } = makeStack();
    const setup = coordinatorOn(repo, manager);
    const created = await setup.createConnection(CONN, 0, 'sk-old');
    await expect(coordinatorOn(repo, manager, crashAt('credential', 'before')).replaceApiKey(created.connectionId, 'sk-new', created.revision)).rejects.toBeInstanceOf(SagaAbortError);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-old');
    expect(stagingKeys()).toHaveLength(0);
  });

  test('clear crash at config:after (mode committed) → roll forward deletes the key', async () => {
    const { repo, manager } = makeStack();
    const setup = coordinatorOn(repo, manager);
    const created = await setup.createConnection(CONN, 0, 'sk-clear');
    await expect(coordinatorOn(repo, manager, crashAt('config', 'after')).clearApiKey(created.connectionId, created.revision)).rejects.toBeInstanceOf(SagaAbortError);
    const recovered = coordinatorOn(repo, manager);
    await recovered.ensureRecovered();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBeNull();
    expect(repo.getConnection(created.connectionId)!.credentialMode).toBe('none');
  });

  test('a still-prepared entry is abandoned on recovery', async () => {
    const { repo, coordinator } = makeCoordinator();
    const sagaId = randomUuid();
    const connectionId = randomUuid();
    coordinator.getJournalStore().upsert({
      sagaId, operation: 'setApiKey', idempotencyKey: `setApiKey:${connectionId}:${sagaId}`, actor: 'test',
      attempt: 1, status: 'prepared', connectionId,
      preconditions: { connectionRevision: 1, credentialModeBefore: 'none', credentialModeAfter: 'stored-api-key' },
      stagedSlots: [], createdAtMs: 1, updatedAtMs: 1,
    });
    await coordinator.ensureRecovered();
    expect(coordinator.getJournalStore().listEntries()).toEqual([]);
    expect(repo.listConnections()).toEqual([]);
  });
});

describe('in-process failure semantics', () => {
  test('create+key: config-commit failure (stale root) rolls the whole create back', async () => {
    const { coordinator, repo } = makeCoordinator();
    // Pass a stale root revision so the config-create barrier (the commit) fails.
    await expect(coordinator.createConnection(CONN, 999, 'sk-x')).rejects.toMatchObject({ name: 'SagaStepError' });
    expect(repo.listConnections()).toEqual([]);
    expect(stagingKeys()).toHaveLength(0);
  });

  test('create+key: credential failure AFTER config commit leaves the connection committed (deferred key)', async () => {
    const { coordinator, repo, manager } = makeCoordinator({}, { failSet: id => id.type === 'memory_api_key' });
    await expect(coordinator.createConnection(CONN, 0, 'sk-deferred')).rejects.toMatchObject({ name: 'SagaStepError', phase: 'credential' });
    // Config committed (roll-forward semantics): the connection exists; the key is pending recovery.
    expect(repo.listConnections()).toHaveLength(1);
    expect(await manager.getMemoryApiKey(repo.listConnections()[0]!.connectionId)).toBeNull();
    // The journal retains the in-flight saga for recovery to complete.
    expect(coordinator.getJournalStore().listEntries()).toHaveLength(1);
  });
});

describe('quarantine blocks the subsystem (fail closed)', () => {
  test('an ambiguous config state quarantines and blocks recovery until resolved', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0);
    // Drive the connection into a state matching neither before nor after.
    await repo.applyConnectionConfig(created.connectionId, { patch: { name: 'Sideways' } }, created.revision);

    const sagaId = randomUuid();
    coordinator.getJournalStore().upsert({
      sagaId, operation: 'updateConnectionConfig', idempotencyKey: `updateConnectionConfig:${created.connectionId}:${sagaId}`,
      actor: 'test', attempt: 1, status: 'config:doing', connectionId: created.connectionId,
      preconditions: { connectionRevision: created.revision, configBefore: { name: 'Alpha' }, configAfter: { name: 'Beta' }, credentialModeBefore: 'none', credentialModeAfter: 'none' },
      stagedSlots: [], createdAtMs: 1, updatedAtMs: 1,
    });

    const fresh = coordinatorOn(repo, manager);
    await expect(fresh.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    // The entry is quarantined and keeps blocking.
    expect(fresh.getJournalStore().getEntry(sagaId)?.status).toBe('quarantined');
    const again = coordinatorOn(repo, manager);
    await expect(again.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    // Removing the quarantined entry unblocks the subsystem.
    again.getJournalStore().remove(sagaId);
    const unblocked = coordinatorOn(repo, manager);
    await expect(unblocked.ensureRecovered()).resolves.toBeUndefined();
  });

  test('an ambiguous credential state (key absent mid-replace) quarantines the staged secret', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0, 'sk-live');
    const sagaId = randomUuid();
    store.set(`memory_saga_stage::${sagaId}::before`, { value: 'sk-precious' });
    await manager.deleteMemoryApiKey(created.connectionId); // key now absent → ambiguous for replace
    coordinator.getJournalStore().upsert({
      sagaId, operation: 'replaceApiKey', idempotencyKey: `replaceApiKey:${created.connectionId}:${sagaId}`,
      actor: 'test', attempt: 1, status: 'credential:doing', connectionId: created.connectionId,
      preconditions: { connectionRevision: created.revision, credentialModeBefore: 'stored-api-key', credentialModeAfter: 'stored-api-key', hadKeyBefore: true },
      stagedSlots: ['before'], createdAtMs: 1, updatedAtMs: 1,
    });

    const fresh = coordinatorOn(repo, manager);
    await expect(fresh.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    const quarantined = [...store.entries()].find(([k]) => k.startsWith('memory_saga_quarantine'));
    expect(quarantined?.[1].value).toBe('sk-precious');
    expect(fresh.getJournalStore().getEntry(sagaId)?.status).toBe('quarantined');
  });
});

describe('orphan staging sweep (fail closed)', () => {
  test('a staged secret with NO journal entry blocks readiness until removed (evidence quarantined)', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const sagaId = randomUuid();
    // Staging exists but the journal is empty (journal lost/truncated).
    store.set(`memory_saga_stage::${sagaId}::before`, { value: 'sk-orphan-stage' });

    await expect(coordinator.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    // Secret preserved in quarantine as evidence; staging left in place → re-detected.
    const quar = [...store.entries()].find(([k]) => k.startsWith('memory_saga_quarantine'));
    expect(quar?.[1].value).toBe('sk-orphan-stage');
    expect(store.has(`memory_saga_stage::${sagaId}::before`)).toBe(true);

    // Stays blocked on a fresh recovery attempt.
    const again = coordinatorOn(repo, manager);
    await expect(again.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    // Explicit resolution: remove the orphan staging → subsystem unblocks.
    await manager.deleteStagedSagaSecret(sagaId, 'before');
    const unblocked = coordinatorOn(repo, manager);
    await expect(unblocked.ensureRecovered()).resolves.toBeUndefined();
  });

  test('a committed create+key whose after-secret is MISSING fails closed (cannot roll forward)', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    // A create+key past its config commit: the connection exists (mode stored-api-key)
    // and recovery must roll forward by setting the key from the `after` staging slot
    // — but that secret was never persisted. Recovery must NOT invent a key; it blocks.
    const conn = await repo.createConnection(CONN, 0, { credentialMode: 'stored-api-key' });
    const sagaId = randomUuid();
    coordinator.getJournalStore().upsert({
      sagaId, operation: 'createConnection', idempotencyKey: `createConnection:${conn.connectionId}:${sagaId}`,
      actor: 'test', attempt: 1, status: 'config:done', connectionId: conn.connectionId,
      preconditions: { rootRevision: 0, credentialModeAfter: 'stored-api-key', hadKeyBefore: false },
      stagedSlots: ['after'], createdAtMs: 1, updatedAtMs: 1,
    });
    const fresh = coordinatorOn(repo, manager);
    await expect(fresh.ensureRecovered()).rejects.toBeInstanceOf(SagaBlockedError);
    // No phantom key was minted; the entry is quarantined and keeps blocking.
    expect(await manager.getMemoryApiKey(conn.connectionId)).toBeNull();
    expect(fresh.getJournalStore().getEntry(sagaId)?.status).toBe('quarantined');
  });
});

describe('outer lease', () => {
  test('concurrent operations are serialized (never overlap) under the lease', async () => {
    const lease = new SagaLease({ dir, leasePath: join(dir, SAGA_LEASE_FILE), acquireTimeoutMs: 2_000 });
    let active = 0, maxActive = 0;
    const body = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 5)); expect(lease.isHeld()).toBe(true); active--; return 'ok'; };
    const results = await Promise.all([lease.withLease(body), lease.withLease(body), lease.withLease(body)]);
    expect(results).toEqual(['ok', 'ok', 'ok']);
    expect(maxActive).toBe(1);
  });

  test('a space mutation cannot temporally overlap a credential saga (lease instrumentation)', async () => {
    const { repo, manager } = makeStack();
    let concurrent = 0, maxConcurrent = 0;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const coordinator = new MemorySagaCoordinator({
      repository: repo, credentialManager: manager, dir: repo.getDir(), leaseTimeoutMs: 4_000,
      onCritical: (phase) => { if (phase === 'enter') { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); } else concurrent -= 1; },
      // Widen the credential saga's critical section so a concurrent space op MUST wait.
      hooks: { onStep: async (ctx) => { if (ctx.operation === 'setApiKey' && ctx.barrier === 'config' && ctx.phase === 'before') await sleep(25); } },
    });
    const created = await coordinator.createConnection(CONN, 0);
    await Promise.all([
      coordinator.setApiKey(created.connectionId, 'sk-x', created.revision),
      coordinator.addSpace(created.connectionId, { kind: 'custom', name: 'S' }, created.revision).catch(() => undefined),
    ]);
    // The space mutation and the credential saga never held the lease at once.
    expect(maxConcurrent).toBe(1);
  });

  test('concurrent createConnection calls serialize under optimistic concurrency', async () => {
    const { repo, coordinator } = makeCoordinator();
    const outcomes = await Promise.allSettled([
      coordinator.createConnection({ ...CONN, name: 'One' }, 0, 'sk-1'),
      coordinator.createConnection({ ...CONN, name: 'Two' }, 0, 'sk-2'),
    ]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);
    expect(repo.listConnections()).toHaveLength(1);
    expect(stagingKeys()).toHaveLength(0);
  });

  test('a credential saga and a concurrent space mutation serialize under one lease', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const created = await coordinator.createConnection(CONN, 0);
    // A key saga and a space mutation both expect the same revision and contend on
    // the one lease → they serialize; exactly one commits, the other sees a
    // revision conflict. Neither corrupts the store, and no saga leaks into the journal.
    const outcomes = await Promise.allSettled([
      coordinator.setApiKey(created.connectionId, 'sk-space', created.revision),
      coordinator.addSpace(created.connectionId, { kind: 'custom', name: 'S1' }, created.revision),
    ]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);
    expect(coordinator.getJournalStore().listEntries()).toEqual([]);
    // The store is internally consistent (mode matches key presence).
    const conn = repo.getConnection(created.connectionId)!;
    const hasKey = (await manager.getMemoryApiKey(created.connectionId)) !== null;
    expect(conn.credentialMode === 'stored-api-key').toBe(hasKey);
  });
});

describe('legacy uppercase migration (208f7c9 → 696a084)', () => {
  test('moves a legacy uppercase account to its canonical lowercase account', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const id = randomUuid();
    await repo.createConnection(CONN, 0, { connectionId: id }); // the real (lowercase) connection exists
    store.set(`memory_api_key::${id.toUpperCase()}`, { value: 'sk-legacy' });
    const result = await coordinator.migrateLegacyUppercaseCredentials();
    expect(result.migratedConnectionIds).toEqual([id]);
    expect(store.has(`memory_api_key::${id.toUpperCase()}`)).toBe(false);
    expect(await manager.getMemoryApiKey(id)).toBe('sk-legacy');
  });

  test('collision quarantines the conflicting secret and fails closed', async () => {
    const { repo, coordinator } = makeCoordinator();
    const id = randomUuid();
    await repo.createConnection(CONN, 0, { connectionId: id });
    store.set(`memory_api_key::${id.toUpperCase()}`, { value: 'sk-legacy' });
    store.set(`memory_api_key::${id}`, { value: 'sk-canonical-different' });
    await expect(coordinator.migrateLegacyUppercaseCredentials()).rejects.toBeInstanceOf(MigrationCollisionError);
    // Both originals preserved; the conflicting legacy secret is also quarantined for evidence.
    expect(store.get(`memory_api_key::${id.toUpperCase()}`)?.value).toBe('sk-legacy');
    expect(store.get(`memory_api_key::${id}`)?.value).toBe('sk-canonical-different');
    expect([...store.keys()].some(k => k.startsWith('memory_saga_quarantine'))).toBe(true);
  });

  test('an uppercase legacy account with NO matching stored connection never promotes; blocks fail-closed', async () => {
    const id = randomUuid(); // no connection with this id will exist
    store.set(`memory_api_key::${id.toUpperCase()}`, { value: 'sk-orphan' });
    const { repo, manager, coordinator } = makeCoordinator();
    expect(repo.getConnection(id)).toBeNull();

    await expect(coordinator.migrateLegacyUppercaseCredentials()).rejects.toBeInstanceOf(SagaBlockedError);
    // Crucially: NO canonical memory_api_key was minted for the non-existent connection.
    expect(store.has(`memory_api_key::${id}`)).toBe(false);
    expect(await manager.getMemoryApiKey(id)).toBeNull();
    // The legacy account is preserved (re-detectable) and the secret is quarantined for evidence.
    expect(store.get(`memory_api_key::${id.toUpperCase()}`)?.value).toBe('sk-orphan');
    expect([...store.keys()].some(k => k.startsWith('memory_saga_quarantine'))).toBe(true);
    // Stays blocked on re-run until the operator removes the orphan.
    const again = coordinatorOn(repo, manager);
    await expect(again.migrateLegacyUppercaseCredentials()).rejects.toBeInstanceOf(SagaBlockedError);
  });

  test('an orphan legacy account blocks migration of otherwise-valid accounts (fail closed, nothing promoted)', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const valid = await coordinator.createConnection(CONN, 0); // real connection, no key
    const orphanId = randomUuid();
    store.set(`memory_api_key::${valid.connectionId.toUpperCase()}`, { value: 'sk-valid' });
    store.set(`memory_api_key::${orphanId.toUpperCase()}`, { value: 'sk-orphan' });

    await expect(coordinator.migrateLegacyUppercaseCredentials()).rejects.toBeInstanceOf(SagaBlockedError);
    // Nothing promoted — not even the valid one — while an orphan is unresolved.
    expect(await manager.getMemoryApiKey(valid.connectionId)).toBeNull();
    expect(await manager.getMemoryApiKey(orphanId)).toBeNull();
  });

  test('dedupes two legacy accounts with the same value; idempotent second run', async () => {
    const { repo, manager, coordinator } = makeCoordinator();
    const id = randomUuid();
    await repo.createConnection(CONN, 0, { connectionId: id });
    store.set(`memory_api_key::${id.toUpperCase()}`, { value: 'sk-same' });
    store.set(`memory_api_key::${id.slice(0, 8).toUpperCase() + id.slice(8)}`, { value: 'sk-same' });
    const first = await coordinator.migrateLegacyUppercaseCredentials();
    expect(first.migratedConnectionIds).toEqual([id]);
    expect(await manager.getMemoryApiKey(id)).toBe('sk-same');
    expect([...store.keys()].filter(k => k.startsWith('memory_api_key::'))).toEqual([`memory_api_key::${id}`]);
    const second = await coordinator.migrateLegacyUppercaseCredentials();
    expect(second.migratedConnectionIds).toEqual([]);
  });
});
