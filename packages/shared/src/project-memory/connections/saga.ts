/**
 * A5 durable memory config/credential saga coordinator (write-ahead / WAL).
 *
 * Every operation that must keep the connections config and the credential store
 * consistent runs as an ordered list of durable **barriers** (side effects). Each
 * barrier is bracketed by a write-ahead journal record: `<kind>:doing` is written
 * *before* the effect, `<kind>:done` *after*. A crash between them leaves the
 * status at `:doing`; recovery then **inspects the actual on-disk state** and
 * classifies the barrier as pre-effect, post-effect, or **ambiguous** — the last
 * fails closed (quarantine + subsystem blocked). The journal status is never
 * trusted to imply an effect landed; it only bounds where recovery must look.
 *
 * **Commit point.** Each op names one barrier as its commit. Crossing it means the
 * operation is committed → roll forward (complete remaining barriers). Failing
 * before it → roll back (compensate the landed barriers to the pre-saga state).
 * For config-changing operations the commit is the durable **config** barrier
 * (never the credential write), and it is inspected by exact intended state.
 *
 * **Delete is forward-only.** Order is intent → config delete → credential delete.
 * Once the config delete lands, recovery only rolls forward (deletes the
 * credential); it NEVER reconstructs a deleted connection.
 *
 * Concurrency: the OUTER {@link SagaLease} serializes whole sagas (this process and
 * others); the repository's INNER lock serializes each config write. The lease is
 * taken first; the lock graph is acyclic by construction (sagas never nest).
 *
 * Secrecy: the journal, logs, errors, and paths never carry secret material.
 * before/after secrets live only in encrypted `memory_saga_stage` identities;
 * unresolved secrets move to `memory_saga_quarantine` identities (evidence).
 */

import type { MemoryConnectionRepository, MemorySpaceMutationResult } from './repository.ts';
import type { CredentialManager } from '../../credentials/manager.ts';
import { SagaLease } from './saga-lease.ts';
import {
  SagaJournalStore,
  SAGA_JOURNAL_FILE,
  type MemoryConfigPatch,
  type SagaBarrierKind,
  type SagaJournalEntry,
  type SagaOperation,
  type SagaPreconditions,
  type SagaStageSlot,
  type SagaStatus,
} from './saga-journal.ts';
import { randomUuid, randomHex } from '../../utils/uuid.ts';
import {
  MemoryError,
  type CreateMemoryConnectionInput,
  type CreateMemorySpaceInput,
  type MemoryConnectionConfig,
  type MemoryCredentialMode,
  type UpdateMemorySpaceInput,
} from './types.ts';

/** File name of the saga lease (relative to `${CONFIG_DIR}/memory/`). */
export const SAGA_LEASE_FILE = 'saga.lease';

export type { SagaBarrierKind } from './saga-journal.ts';

export type SagaStepPhase = 'before' | 'after';
export type SagaRunMode = 'live' | 'recover';

export interface SagaHookContext {
  barrier: SagaBarrierKind;
  phase: SagaStepPhase;
  operation: SagaOperation;
  sagaId: string;
  connectionId?: string;
  mode: SagaRunMode;
}

/** Deterministic failure/crash injection hook (tests + child-process crash worker). */
export type SagaStepHook = (ctx: SagaHookContext) => void | Promise<void>;

export interface MemorySagaHooks {
  onStep?: SagaStepHook;
}

/** Thrown by a hook to simulate a hard crash at a barrier boundary. Not compensated. */
export class SagaAbortError extends Error {
  constructor(message = 'saga aborted (simulated crash)') {
    super(message);
    this.name = 'SagaAbortError';
  }
}

/** A saga barrier failed in-process. `phase` maps to the service error taxonomy. */
export class SagaStepError extends Error {
  readonly phase: 'config' | 'credential';
  readonly cause: unknown;
  constructor(phase: 'config' | 'credential', message: string, cause: unknown) {
    super(message);
    this.name = 'SagaStepError';
    this.phase = phase;
    this.cause = cause;
  }
}

/** A saga rollback failed — the most severe outcome (state may be inconsistent). */
export class SagaRollbackError extends Error {
  readonly details: Record<string, unknown>;
  readonly cause: unknown;
  constructor(message: string, details: Record<string, unknown>, cause: unknown) {
    super(message);
    this.name = 'SagaRollbackError';
    this.details = details;
    this.cause = cause;
  }
}

/**
 * Recovery hit an ambiguous or unresolvable state. The subsystem is now blocked:
 * `ensureRecovered` rejects and keeps rejecting until an operator removes the
 * quarantined journal entry. Secret evidence is preserved in quarantine.
 */
export class SagaBlockedError extends Error {
  readonly sagaId: string;
  constructor(sagaId: string, message: string) {
    super(message);
    this.name = 'SagaBlockedError';
    this.sagaId = sagaId;
  }
}

/** Legacy migration found an unsafe collision and refused to proceed (fail closed). */
export class MigrationCollisionError extends Error {
  readonly connectionIds: string[];
  constructor(connectionIds: string[]) {
    super(`legacy memory credential migration aborted: ${connectionIds.length} conflicting connection id(s)`);
    this.name = 'MigrationCollisionError';
    this.connectionIds = connectionIds;
  }
}

export interface MigrationResult {
  migratedConnectionIds: string[];
}

export interface MemorySagaCoordinatorDeps {
  repository: MemoryConnectionRepository;
  credentialManager: CredentialManager;
  /** Directory holding the memory artifacts (config, journal, lease). */
  dir: string;
  now?: () => number;
  /** Canonical-UUID generator (overridable for deterministic tests). */
  newId?: () => string;
  actor?: string;
  hooks?: MemorySagaHooks;
  /** Overridable lease timeout (tests). */
  leaseTimeoutMs?: number;
  /** Instrumentation fired around every lease-held critical section (tests). */
  onCritical?: (phase: 'enter' | 'exit') => void;
}

type BarrierInspect = 'pre' | 'post' | 'ambiguous';

interface Barrier {
  kind: SagaBarrierKind;
  isCommit: boolean;
  /** Apply the side effect (idempotent). */
  effect(mode: SagaRunMode): Promise<void>;
  /** Classify the actual on-disk state vs the intended effect. */
  inspect(): Promise<BarrierInspect>;
  /** Undo toward the pre-saga state (idempotent, actual-state aware). */
  compensate(): Promise<void>;
}

interface OpPlan {
  operation: SagaOperation;
  connectionId: string;
  barriers: Barrier[];
  stagedSlots: SagaStageSlot[];
  returnsConnection: boolean;
  /**
   * Recovery always rolls FORWARD (never back), because this op's pre-state may be
   * an invalid/inconsistent state it exists to repair (setCredentialMode drift
   * repair). Once the intent is durably journaled, recovery must complete it so the
   * store never rests in the inconsistent pre-state. Live failures still roll back.
   */
  recoverForward?: boolean;
  /** Optional up-front validation (live only). Throws MemoryError. */
  precheck?(): Promise<void>;
}

export class MemorySagaCoordinator {
  private readonly repo: MemoryConnectionRepository;
  private readonly cred: CredentialManager;
  private readonly journal: SagaJournalStore;
  private readonly lease: SagaLease;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly actor: string;
  private readonly hooks?: MemorySagaHooks;
  private recoveryPromise: Promise<void> | null = null;

  constructor(deps: MemorySagaCoordinatorDeps) {
    this.repo = deps.repository;
    this.cred = deps.credentialManager;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUuid());
    this.actor = deps.actor ?? 'server';
    this.hooks = deps.hooks;
    this.journal = new SagaJournalStore({ dir: deps.dir, filePath: joinPath(deps.dir, SAGA_JOURNAL_FILE) });
    this.lease = new SagaLease({
      dir: deps.dir,
      leasePath: joinPath(deps.dir, SAGA_LEASE_FILE),
      now: this.now,
      acquireTimeoutMs: deps.leaseTimeoutMs,
      onCritical: deps.onCritical,
    });
  }

  getJournalStore(): SagaJournalStore {
    return this.journal;
  }

  // -------------------------------------------------------------------------
  // Startup recovery (memoized, fail-closed). Must complete or reject before the
  // next outer memory mutation. Quarantined/ambiguous state keeps rejecting.
  // -------------------------------------------------------------------------

  ensureRecovered(): Promise<void> {
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.runStartupRecovery().catch((error) => {
        this.recoveryPromise = null; // allow a retry once the operator resolves it
        throw error;
      });
    }
    return this.recoveryPromise;
  }

  private async runStartupRecovery(): Promise<void> {
    await this.lease.withLease(async () => {
      for (const entry of this.journal.listEntries()) {
        await this.recoverEntry(entry);
      }
      // Orphan-stage sweep: after journaled sagas are resolved (rolled forward /
      // back, cleaning their own staging), any remaining `memory_saga_stage`
      // secret has NO owning journal entry. That means the journal was lost or
      // truncated while a secret persisted — a corruption signal. Quarantine the
      // orphan as evidence (leaving the staging in place so it is re-detected) and
      // fail closed. The subsystem stays blocked until an operator resolves it.
      await this.sweepOrphanStaging();
    });
  }

  private async sweepOrphanStaging(): Promise<void> {
    const journaled = new Set(this.journal.listEntries().map(e => e.sagaId));
    const stageIds = await this.cred.listSagaStageSagaIds();
    const orphans = stageIds.filter(id => !journaled.has(id));
    if (orphans.length === 0) return;
    for (const sagaId of orphans) {
      for (const slot of ['before', 'after'] as const) {
        const secret = await this.cred.readStagedSagaSecret(sagaId, slot).catch(() => null);
        if (secret !== null) {
          await this.cred.quarantineSagaSecret(sagaId, slot, deterministicToken(sagaId), secret).catch(() => undefined);
        }
      }
    }
    throw new SagaBlockedError(orphans.sort()[0]!, `orphan saga staging without a journal entry: ${orphans.sort().join(', ')}`);
  }

  private async recoverEntry(entry: SagaJournalEntry): Promise<void> {
    entry.attempt += 1;

    if (entry.status === 'completed' || entry.status === 'rolled_back') {
      await this.cleanupStaging(entry);
      this.journal.remove(entry.sagaId);
      return;
    }
    // A quarantined entry blocks the subsystem until an operator removes it.
    if (entry.status === 'quarantined') {
      throw new SagaBlockedError(entry.sagaId, `memory subsystem blocked by quarantined saga ${entry.sagaId} (${entry.operation})`);
    }
    // Migration entries are resolved by the explicit migration pass at the gate.
    if (entry.operation === 'migrateLegacyUppercaseCredentials') {
      this.journal.remove(entry.sagaId);
      return;
    }

    const plan = this.buildPlan(entry.operation, entry.sagaId, entry.connectionId!, entry.preconditions, undefined);
    try {
      await this.settle(entry, plan, 'recover');
    } catch (error) {
      if (error instanceof SagaAbortError) throw error;
      // Ambiguous/unresolvable → preserve secret evidence, mark quarantined
      // durably, then fail closed so the subsystem stays unavailable.
      await this.quarantineEntry(entry);
      throw new SagaBlockedError(entry.sagaId, `recovery could not resolve saga ${entry.sagaId} (${entry.operation}); quarantined and blocked`);
    }
  }

  private async quarantineEntry(entry: SagaJournalEntry): Promise<void> {
    for (const slot of entry.stagedSlots) {
      const secret = await this.cred.readStagedSagaSecret(entry.sagaId, slot).catch(() => null);
      if (secret !== null) {
        await this.cred.quarantineSagaSecret(entry.sagaId, slot, randomHex(8), secret).catch(() => undefined);
      }
      await this.cred.deleteStagedSagaSecret(entry.sagaId, slot).catch(() => undefined);
    }
    entry.status = 'quarantined';
    entry.updatedAtMs = this.now();
    this.journal.upsert(entry);
  }

  // -------------------------------------------------------------------------
  // Public operations (each awaits recovery, then runs under the outer lease)
  // -------------------------------------------------------------------------

  async createConnection(input: CreateMemoryConnectionInput, expectedRootRevision: number, apiKey?: string): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const connectionId = this.newId();
      const preconditions: SagaPreconditions = {
        rootRevision: expectedRootRevision,
        createInput: input,
        credentialModeAfter: apiKey !== undefined ? 'stored-api-key' : 'none',
        hadKeyBefore: false,
      };
      const result = await this.runConnectionSaga('createConnection', connectionId, preconditions, apiKey);
      return this.requireConnection(result, connectionId);
    });
  }

  async updateConnectionConfig(
    connectionId: string,
    patch: MemoryConfigPatch,
    expectedRevision: number,
    apiKeyOp?: { kind: 'set'; apiKey: string } | { kind: 'clear' },
  ): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const existing = this.repo.getConnection(connectionId);
      const hadKeyBefore = existing ? (await this.cred.getMemoryApiKey(connectionId)) !== null : false;
      const modeAfter: MemoryCredentialMode = apiKeyOp === undefined
        ? (existing?.credentialMode ?? 'none')
        : apiKeyOp.kind === 'set' ? 'stored-api-key' : 'none';
      const preconditions: SagaPreconditions = {
        connectionRevision: expectedRevision,
        configBefore: existing ? pickConfigBefore(existing, patch) : normalizePatch(patch),
        configAfter: normalizePatch(patch),
        credentialModeBefore: existing?.credentialMode,
        credentialModeAfter: modeAfter,
        hadKeyBefore,
        keyOp: apiKeyOp?.kind,
      };
      const afterSecret = apiKeyOp?.kind === 'set' ? apiKeyOp.apiKey : undefined;
      const result = await this.runConnectionSaga('updateConnectionConfig', connectionId, preconditions, afterSecret);
      return this.requireConnection(result, connectionId);
    });
  }

  async deleteConnection(connectionId: string, expectedRootRevision: number): Promise<void> {
    await this.ensureRecovered();
    await this.lease.withLease(async () => {
      if (!this.repo.getConnection(connectionId)) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
      const preconditions: SagaPreconditions = { rootRevision: expectedRootRevision };
      await this.runConnectionSaga('deleteConnection', connectionId, preconditions, undefined);
    });
  }

  async setApiKey(connectionId: string, apiKey: string, expectedRevision: number): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const existing = this.repo.getConnection(connectionId);
      const preconditions: SagaPreconditions = {
        connectionRevision: expectedRevision,
        credentialModeBefore: existing?.credentialMode,
        credentialModeAfter: 'stored-api-key',
        hadKeyBefore: false,
      };
      const result = await this.runConnectionSaga('setApiKey', connectionId, preconditions, apiKey);
      return this.requireConnection(result, connectionId);
    });
  }

  async replaceApiKey(connectionId: string, apiKey: string, expectedRevision: number): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const existing = this.repo.getConnection(connectionId);
      const preconditions: SagaPreconditions = {
        connectionRevision: expectedRevision,
        credentialModeBefore: existing?.credentialMode,
        credentialModeAfter: 'stored-api-key',
        hadKeyBefore: true,
      };
      const result = await this.runConnectionSaga('replaceApiKey', connectionId, preconditions, apiKey);
      return this.requireConnection(result, connectionId);
    });
  }

  async clearApiKey(connectionId: string, expectedRevision: number): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const existing = this.repo.getConnection(connectionId);
      const preconditions: SagaPreconditions = {
        connectionRevision: expectedRevision,
        credentialModeBefore: existing?.credentialMode,
        credentialModeAfter: 'none',
        hadKeyBefore: true,
      };
      const result = await this.runConnectionSaga('clearApiKey', connectionId, preconditions, undefined);
      return this.requireConnection(result, connectionId);
    });
  }

  async setCredentialMode(connectionId: string, mode: MemoryCredentialMode, expectedRevision: number): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      const existing = this.repo.getConnection(connectionId);
      const preconditions: SagaPreconditions = {
        connectionRevision: expectedRevision,
        credentialModeBefore: existing?.credentialMode,
        credentialModeAfter: mode,
      };
      const result = await this.runConnectionSaga('setCredentialMode', connectionId, preconditions, undefined);
      return this.requireConnection(result, connectionId);
    });
  }

  // Space mutations are single-store (config only) but MUST run through the sole
  // coordinator under the outer lease after recovery — never bypass it.
  async addSpace(connectionId: string, input: CreateMemorySpaceInput, expectedRevision: number): Promise<MemorySpaceMutationResult> {
    await this.ensureRecovered();
    return this.lease.withLease(() => this.repo.addSpace(connectionId, input, expectedRevision));
  }

  async updateSpace(connectionId: string, spaceId: string, patch: UpdateMemorySpaceInput, expectedRevision: number): Promise<MemorySpaceMutationResult> {
    await this.ensureRecovered();
    return this.lease.withLease(() => this.repo.updateSpace(connectionId, spaceId, patch, expectedRevision));
  }

  async deleteSpace(connectionId: string, spaceId: string, expectedRevision: number): Promise<MemoryConnectionConfig> {
    await this.ensureRecovered();
    return this.lease.withLease(() => this.repo.deleteSpace(connectionId, spaceId, expectedRevision));
  }

  async migrateLegacyUppercaseCredentials(): Promise<MigrationResult> {
    await this.ensureRecovered();
    return this.lease.withLease(() => this.migrateInternal());
  }

  // -------------------------------------------------------------------------
  // Saga engine
  // -------------------------------------------------------------------------

  private async runConnectionSaga(
    operation: SagaOperation,
    connectionId: string,
    preconditions: SagaPreconditions,
    afterSecret: string | undefined,
  ): Promise<MemoryConnectionConfig | null> {
    const sagaId = this.newId();
    const plan = this.buildPlan(operation, sagaId, connectionId, preconditions, afterSecret);

    if (plan.precheck) {
      try {
        await plan.precheck();
      } catch (cause) {
        if (cause instanceof SagaAbortError) throw cause;
        throw new SagaStepError('config', 'saga precheck failed', cause);
      }
    }

    const entry: SagaJournalEntry = {
      sagaId,
      operation,
      idempotencyKey: `${operation}:${connectionId}:${sagaId}`,
      actor: this.actor,
      attempt: 1,
      status: 'prepared',
      connectionId,
      preconditions,
      stagedSlots: plan.stagedSlots,
      createdAtMs: this.now(),
      updatedAtMs: this.now(),
    };
    this.journal.upsert(entry);

    await this.settle(entry, plan, 'live');
    return plan.returnsConnection ? this.repo.getConnection(connectionId) : null;
  }

  /**
   * Drive a saga (from its current journaled position) to a terminal state.
   *
   * `live` starts at `prepared` and drives forward, rolling back on a pre-commit
   * failure and leaving the journal for recovery on a post-commit failure.
   * `recover` resumes: it inspects the in-flight barrier, and — per the commit
   * point — either rolls forward to completion or rolls back to the pre-saga state
   * (a still-prepared entry is abandoned). Ambiguous state fails closed.
   */
  private async settle(entry: SagaJournalEntry, plan: OpPlan, mode: SagaRunMode): Promise<void> {
    const { barriers } = plan;
    const commitIdx = barriers.findIndex(b => b.isCommit);
    const pos = parseStatus(entry.status, barriers);

    let startIndex: number;
    let committed: boolean;

    if (pos.phase === 'prepared') {
      if (mode === 'recover') {
        if (plan.recoverForward) {
          // Forward-only op (drift repair): complete it so the store never rests in
          // its possibly-inconsistent pre-state.
          startIndex = 0;
          committed = true;
        } else {
          // Nothing was committed; abandon the interrupted attempt.
          await this.rollBack(entry, barriers, -1);
          return;
        }
      } else {
        startIndex = 0;
        committed = false;
      }
    } else {
      let idx = pos.index;
      let landed = pos.phase === 'done';
      if (pos.phase === 'doing') {
        const r = await barriers[idx]!.inspect();
        if (r === 'ambiguous') {
          throw new SagaBlockedError(entry.sagaId, `ambiguous ${barriers[idx]!.kind} state for saga ${entry.sagaId}`);
        }
        landed = r === 'post';
        if (landed) this.markStatus(entry, `${barriers[idx]!.kind}:done` as SagaStatus);
      }
      committed = commitIdx >= 0 && (idx > commitIdx || (idx === commitIdx && landed));
      if (!committed) {
        if (mode === 'recover' && plan.recoverForward) {
          // Forward-only op: resume forward from the in-flight barrier instead of
          // rolling back to the (possibly inconsistent) pre-state.
          startIndex = landed ? idx + 1 : idx;
          committed = true;
        } else {
          await this.rollBack(entry, barriers, landed ? idx : idx - 1);
          return;
        }
      } else {
        startIndex = landed ? idx + 1 : idx;
      }
    }

    // Forward drive. Cross the commit barrier as we go.
    try {
      for (let k = startIndex; k < barriers.length; k++) {
        await this.runBarrier(entry, barriers[k]!, mode);
        if (k === commitIdx) committed = true;
      }
      await this.finalize(entry);
    } catch (err) {
      if (err instanceof SagaAbortError || err instanceof SagaBlockedError) throw err;
      if (committed || plan.recoverForward) {
        // Leave the journal at the in-flight `:doing` marker and surface the error:
        // - `committed`: config is durably committed → recovery finishes the
        //   remaining (credential) work.
        // - `recoverForward` (drift repair): the durable intent must be completed
        //   forward on retry/recovery, NOT rolled back to the inconsistent pre-state.
        //   A live failure therefore stays journaled/retryable rather than declaring
        //   a rolled-back inconsistent "success".
        throw err;
      }
      // Pre-commit failure: the failing barrier's effect did not complete (its
      // `:done` was never written). Compensate the barriers below it, then surface.
      const failedIdx = parseStatus(entry.status, barriers).index;
      await this.rollBack(entry, barriers, failedIdx - 1);
      throw err;
    }
  }

  private async runBarrier(entry: SagaJournalEntry, barrier: Barrier, mode: SagaRunMode): Promise<void> {
    this.markStatus(entry, `${barrier.kind}:doing` as SagaStatus);
    await this.hook(barrier.kind, 'before', entry, mode);
    const r = await barrier.inspect();
    if (r === 'ambiguous') {
      throw new SagaBlockedError(entry.sagaId, `ambiguous ${barrier.kind} state for saga ${entry.sagaId}`);
    }
    if (r !== 'post') {
      try {
        await barrier.effect(mode);
      } catch (cause) {
        if (cause instanceof SagaAbortError) throw cause;
        if (cause instanceof SagaBlockedError) throw cause;
        throw new SagaStepError(phaseOf(barrier.kind), `saga ${barrier.kind} effect failed`, cause);
      }
    }
    await this.hook(barrier.kind, 'after', entry, mode);
    this.markStatus(entry, `${barrier.kind}:done` as SagaStatus);
  }

  private async rollBack(entry: SagaJournalEntry, barriers: Barrier[], top: number): Promise<void> {
    try {
      for (let k = top; k >= 0; k--) {
        await barriers[k]!.compensate();
      }
    } catch (cause) {
      throw new SagaRollbackError('memory saga rollback failed', { sagaId: entry.sagaId, connectionId: entry.connectionId, operation: entry.operation }, cause);
    }
    this.markStatus(entry, 'rolled_back');
    await this.cleanupStaging(entry);
    this.journal.remove(entry.sagaId);
  }

  private async finalize(entry: SagaJournalEntry): Promise<void> {
    await this.cleanupStaging(entry);
    this.markStatus(entry, 'completed');
    this.journal.remove(entry.sagaId);
  }

  private markStatus(entry: SagaJournalEntry, status: SagaStatus): void {
    entry.status = status;
    entry.updatedAtMs = this.now();
    this.journal.upsert(entry);
  }

  private async cleanupStaging(entry: SagaJournalEntry): Promise<void> {
    for (const slot of entry.stagedSlots) {
      await this.cred.deleteStagedSagaSecret(entry.sagaId, slot).catch(() => undefined);
    }
  }

  private async hook(barrier: SagaBarrierKind, phase: SagaStepPhase, entry: SagaJournalEntry, mode: SagaRunMode): Promise<void> {
    if (!this.hooks?.onStep) return;
    await this.hooks.onStep({ barrier, phase, operation: entry.operation, sagaId: entry.sagaId, connectionId: entry.connectionId, mode });
  }

  // -------------------------------------------------------------------------
  // Barrier primitives
  // -------------------------------------------------------------------------

  private async stageIfNeeded(sagaId: string, slot: SagaStageSlot, value: string | null): Promise<void> {
    if (value === null) return;
    if ((await this.cred.readStagedSagaSecret(sagaId, slot)) === null) {
      await this.cred.stageSagaSecret(sagaId, slot, value);
    }
  }

  private async ensureKey(connectionId: string, secret: string): Promise<void> {
    if ((await this.cred.getMemoryApiKey(connectionId)) !== secret) {
      await this.cred.setMemoryApiKey(connectionId, secret);
    }
  }

  private async deleteKeyVerified(connectionId: string): Promise<void> {
    if ((await this.cred.getMemoryApiKey(connectionId)) !== null) {
      await this.cred.deleteMemoryApiKey(connectionId);
      if ((await this.cred.getMemoryApiKey(connectionId)) !== null) {
        throw new MemoryError('storage_error', 'credential delete did not remove the API key');
      }
    }
  }

  /** Restore the credential to its pre-saga state (for rollback of a key-set op). */
  private async restoreCredential(sagaId: string, connectionId: string, hadKeyBefore: boolean): Promise<void> {
    if (hadKeyBefore) {
      const before = await this.cred.readStagedSagaSecret(sagaId, 'before');
      if (before === null) {
        throw new MemoryError('storage_error', 'cannot restore API key: before-secret missing');
      }
      await this.ensureKey(connectionId, before);
    } else {
      await this.deleteKeyVerified(connectionId);
    }
  }

  private liveConnRev(preconditions: SagaPreconditions, mode: SagaRunMode, connectionId: string): number {
    if (mode === 'live') return this.requireNum(preconditions.connectionRevision);
    const c = this.repo.getConnection(connectionId);
    if (!c) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
    return c.revision;
  }

  private liveRootRev(preconditions: SagaPreconditions, mode: SagaRunMode): number {
    return mode === 'live' ? this.requireNum(preconditions.rootRevision) : this.repo.getRootRevision();
  }

  // -------------------------------------------------------------------------
  // Per-operation barrier plans
  // -------------------------------------------------------------------------

  private buildPlan(
    operation: SagaOperation,
    sagaId: string,
    connectionId: string,
    pre: SagaPreconditions,
    afterSecret: string | undefined,
  ): OpPlan {
    switch (operation) {
      case 'createConnection': return this.planCreate(sagaId, connectionId, pre, afterSecret);
      case 'deleteConnection': return this.planDelete(sagaId, connectionId, pre);
      case 'setCredentialMode': return this.planSetMode(sagaId, connectionId, pre);
      case 'setApiKey': return this.planSetApiKey(sagaId, connectionId, pre, afterSecret);
      case 'replaceApiKey': return this.planReplaceApiKey(sagaId, connectionId, pre, afterSecret);
      case 'clearApiKey': return this.planClearApiKey(sagaId, connectionId, pre);
      case 'updateConnectionConfig': return this.planUpdate(sagaId, connectionId, pre, afterSecret);
      default:
        throw new MemoryError('invalid_input', `unsupported saga operation for planning: ${String(operation)}`);
    }
  }

  private planCreate(sagaId: string, connectionId: string, pre: SagaPreconditions, afterSecret: string | undefined): OpPlan {
    const withKey = pre.credentialModeAfter === 'stored-api-key';
    const mode: MemoryCredentialMode = withKey ? 'stored-api-key' : 'none';
    const barriers: Barrier[] = [];
    const stagedSlots: SagaStageSlot[] = [];

    if (withKey) {
      stagedSlots.push('after');
      barriers.push({
        kind: 'stage', isCommit: false,
        effect: async () => { await this.stageIfNeeded(sagaId, 'after', afterSecret ?? null); },
        inspect: async () => (await this.cred.readStagedSagaSecret(sagaId, 'after')) !== null ? 'post' : 'pre',
        compensate: async () => { await this.cred.deleteStagedSagaSecret(sagaId, 'after'); },
      });
    }
    // Config create is the commit barrier (config-changing op).
    barriers.push({
      kind: 'config', isCommit: true,
      effect: async (m) => {
        if (this.repo.getConnection(connectionId)) return;
        await this.repo.createConnection(this.requireCreateInput(pre), this.liveRootRev(pre, m), { connectionId, credentialMode: mode });
      },
      inspect: async () => this.repo.getConnection(connectionId) ? 'post' : 'pre',
      compensate: async () => {
        if (this.repo.getConnection(connectionId)) await this.repo.deleteConnection(connectionId, this.repo.getRootRevision());
      },
    });
    if (withKey) {
      barriers.push({
        kind: 'credential', isCommit: false,
        effect: async () => {
          const secret = await this.cred.readStagedSagaSecret(sagaId, 'after');
          if (secret === null) throw new MemoryError('storage_error', 'staged after-secret missing');
          await this.ensureKey(connectionId, secret);
        },
        inspect: async () => {
          const secret = await this.cred.readStagedSagaSecret(sagaId, 'after');
          const key = await this.cred.getMemoryApiKey(connectionId);
          if (secret !== null && key === secret) return 'post';
          if (key === null) return 'pre';
          return 'ambiguous';
        },
        compensate: async () => { await this.deleteKeyVerified(connectionId); },
      });
    }
    return { operation: 'createConnection', connectionId, barriers, stagedSlots, returnsConnection: true };
  }

  private planDelete(sagaId: string, connectionId: string, pre: SagaPreconditions): OpPlan {
    // Fixed order: config delete (commit) → credential delete. Forward-only; never
    // reconstructs a deleted connection.
    const barriers: Barrier[] = [
      {
        kind: 'config', isCommit: true,
        effect: async (m) => { if (this.repo.getConnection(connectionId)) await this.repo.deleteConnection(connectionId, this.liveRootRev(pre, m)); },
        inspect: async () => this.repo.getConnection(connectionId) ? 'pre' : 'post',
        compensate: async () => { /* pre-commit rollback is a no-op; never resurrect */ },
      },
      {
        kind: 'credential', isCommit: false,
        effect: async () => { await this.deleteKeyVerified(connectionId); },
        inspect: async () => (await this.cred.getMemoryApiKey(connectionId)) === null ? 'post' : 'pre',
        compensate: async () => { /* forward-only */ },
      },
    ];
    return { operation: 'deleteConnection', connectionId, barriers, stagedSlots: [], returnsConnection: false };
  }

  private planSetMode(sagaId: string, connectionId: string, pre: SagaPreconditions): OpPlan {
    const target = pre.credentialModeAfter ?? 'none';
    const before = pre.credentialModeBefore;
    const barriers: Barrier[] = [this.configModeBarrier(connectionId, pre, target, before, true)];
    return {
      operation: 'setCredentialMode', connectionId, barriers, stagedSlots: [], returnsConnection: true,
      // Drift repair: recovery must complete the mode change (never roll back to the
      // inconsistent drift pre-state).
      recoverForward: true,
      precheck: async () => {
        const conn = this.requireConnection(this.repo.getConnection(connectionId), connectionId);
        assertRevision(conn, this.requireNum(pre.connectionRevision));
        const keyPresent = (await this.cred.getMemoryApiKey(connectionId)) !== null;
        if (target === 'stored-api-key' && !keyPresent) throw new MemoryError('invalid_input', 'cannot set stored-api-key mode: no API key is stored');
        if (target === 'none' && keyPresent) throw new MemoryError('invalid_input', 'cannot set none mode: an API key is still stored');
      },
    };
  }

  private planSetApiKey(sagaId: string, connectionId: string, pre: SagaPreconditions, afterSecret: string | undefined): OpPlan {
    // Order: credential set → config mode(→stored). Commit = config mode.
    const barriers: Barrier[] = [
      {
        kind: 'credential', isCommit: false,
        effect: async () => { await this.ensureKey(connectionId, this.requireSecret(afterSecret)); },
        inspect: async () => (await this.cred.getMemoryApiKey(connectionId)) !== null ? 'post' : 'pre',
        compensate: async () => { await this.deleteKeyVerified(connectionId); }, // before had no key
      },
      this.configModeBarrier(connectionId, pre, 'stored-api-key', pre.credentialModeBefore, true),
    ];
    return {
      operation: 'setApiKey', connectionId, barriers, stagedSlots: [], returnsConnection: true,
      precheck: async () => {
        const conn = this.requireConnection(this.repo.getConnection(connectionId), connectionId);
        assertRevision(conn, this.requireNum(pre.connectionRevision));
        if ((await this.cred.getMemoryApiKey(connectionId)) !== null) throw new MemoryError('invalid_input', 'cannot set API key: one is already stored (use replace)');
      },
    };
  }

  private planReplaceApiKey(sagaId: string, connectionId: string, pre: SagaPreconditions, afterSecret: string | undefined): OpPlan {
    // Order: stage before → credential set(new) [commit]. No config change.
    const barriers: Barrier[] = [
      {
        kind: 'stage', isCommit: false,
        effect: async () => { await this.stageIfNeeded(sagaId, 'before', await this.cred.getMemoryApiKey(connectionId)); },
        inspect: async () => (await this.cred.readStagedSagaSecret(sagaId, 'before')) !== null ? 'post' : 'pre',
        compensate: async () => { await this.cred.deleteStagedSagaSecret(sagaId, 'before'); },
      },
      {
        kind: 'credential', isCommit: true,
        effect: async () => { await this.ensureKey(connectionId, this.requireSecret(afterSecret)); },
        inspect: async () => {
          const before = await this.cred.readStagedSagaSecret(sagaId, 'before');
          const key = await this.cred.getMemoryApiKey(connectionId);
          if (key === null) return 'ambiguous';
          if (before !== null && key === before) return 'pre';
          return 'post';
        },
        compensate: async () => { await this.restoreCredential(sagaId, connectionId, true); },
      },
    ];
    return {
      operation: 'replaceApiKey', connectionId, barriers, stagedSlots: ['before'], returnsConnection: true,
      precheck: async () => {
        const conn = this.requireConnection(this.repo.getConnection(connectionId), connectionId);
        assertRevision(conn, this.requireNum(pre.connectionRevision));
        if ((await this.cred.getMemoryApiKey(connectionId)) === null) throw new MemoryError('invalid_input', 'cannot replace API key: none is stored');
      },
    };
  }

  private planClearApiKey(sagaId: string, connectionId: string, pre: SagaPreconditions): OpPlan {
    // Order: config mode(→none) [commit] → credential delete. Forward-only after commit.
    const barriers: Barrier[] = [
      this.configModeBarrier(connectionId, pre, 'none', pre.credentialModeBefore, true),
      {
        kind: 'credential', isCommit: false,
        effect: async () => { await this.deleteKeyVerified(connectionId); },
        inspect: async () => (await this.cred.getMemoryApiKey(connectionId)) === null ? 'post' : 'pre',
        compensate: async () => { /* forward-only */ },
      },
    ];
    return {
      operation: 'clearApiKey', connectionId, barriers, stagedSlots: [], returnsConnection: true,
      precheck: async () => {
        const conn = this.requireConnection(this.repo.getConnection(connectionId), connectionId);
        assertRevision(conn, this.requireNum(pre.connectionRevision));
      },
    };
  }

  private planUpdate(sagaId: string, connectionId: string, pre: SagaPreconditions, afterSecret: string | undefined): OpPlan {
    // Derive the key operation from the JOURNALED keyOp, not from afterSecret —
    // afterSecret is only present on the live path, so recovery must not depend on it.
    const isSet = pre.keyOp === 'set';
    const isClear = pre.keyOp === 'clear' && pre.hadKeyBefore === true;
    // Determine whether the mode changes.
    const modeChanges = pre.credentialModeAfter !== undefined && pre.credentialModeAfter !== pre.credentialModeBefore;
    const modeAfter = modeChanges ? pre.credentialModeAfter : undefined;
    const modeBefore = modeChanges ? pre.credentialModeBefore : undefined;

    const barriers: Barrier[] = [];
    const stagedSlots: SagaStageSlot[] = [];

    if (isSet) {
      // stage before (restore on rollback) → credential set → config(fields+mode) [commit]
      stagedSlots.push('before');
      barriers.push({
        kind: 'stage', isCommit: false,
        effect: async () => { await this.stageIfNeeded(sagaId, 'before', await this.cred.getMemoryApiKey(connectionId)); },
        inspect: async () => {
          if (!pre.hadKeyBefore) return 'post'; // nothing to stage
          return (await this.cred.readStagedSagaSecret(sagaId, 'before')) !== null ? 'post' : 'pre';
        },
        compensate: async () => { await this.cred.deleteStagedSagaSecret(sagaId, 'before'); },
      });
      barriers.push({
        kind: 'credential', isCommit: false,
        effect: async () => { await this.ensureKey(connectionId, this.requireSecret(afterSecret)); },
        inspect: async () => {
          const before = await this.cred.readStagedSagaSecret(sagaId, 'before');
          const key = await this.cred.getMemoryApiKey(connectionId);
          if (pre.hadKeyBefore && before !== null && key === before) return 'pre';
          if (!pre.hadKeyBefore && key === null) return 'pre';
          if (key !== null) return 'post';
          return 'pre';
        },
        compensate: async () => { await this.restoreCredential(sagaId, connectionId, pre.hadKeyBefore === true); },
      });
      barriers.push(this.configFieldsBarrier(connectionId, pre, modeAfter, modeBefore, true));
    } else if (isClear) {
      // config(fields+mode none) [commit] → credential delete. Forward-only.
      barriers.push(this.configFieldsBarrier(connectionId, pre, modeAfter, modeBefore, true));
      barriers.push({
        kind: 'credential', isCommit: false,
        effect: async () => { await this.deleteKeyVerified(connectionId); },
        inspect: async () => (await this.cred.getMemoryApiKey(connectionId)) === null ? 'post' : 'pre',
        compensate: async () => { /* forward-only */ },
      });
    } else {
      // config-only update. commit = config.
      barriers.push(this.configFieldsBarrier(connectionId, pre, modeAfter, modeBefore, true));
    }

    return {
      operation: 'updateConnectionConfig', connectionId, barriers, stagedSlots, returnsConnection: true,
      precheck: async () => {
        const conn = this.requireConnection(this.repo.getConnection(connectionId), connectionId);
        assertRevision(conn, this.requireNum(pre.connectionRevision));
      },
    };
  }

  /** A config barrier that applies fields (+ optional mode) atomically. */
  private configFieldsBarrier(connectionId: string, pre: SagaPreconditions, modeAfter: MemoryCredentialMode | undefined, modeBefore: MemoryCredentialMode | undefined, isCommit: boolean): Barrier {
    const patchAfter = pre.configAfter ?? {};
    const patchBefore = pre.configBefore ?? {};
    return {
      kind: 'config', isCommit,
      effect: async (m) => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
        if (configMatches(conn, patchAfter, modeAfter)) return; // already applied (idempotent)
        await this.repo.applyConnectionConfig(connectionId, { patch: patchAfter, credentialMode: modeAfter }, this.liveConnRev(pre, m, connectionId));
      },
      inspect: async () => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn) return 'ambiguous';
        if (configMatches(conn, patchAfter, modeAfter)) return 'post';
        if (configMatches(conn, patchBefore, modeBefore)) return 'pre';
        return 'ambiguous';
      },
      compensate: async () => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn) return;
        if (configMatches(conn, patchBefore, modeBefore)) return; // already at pre-state
        await this.repo.applyConnectionConfig(connectionId, { patch: patchBefore, credentialMode: modeBefore }, conn.revision);
      },
    };
  }

  /** A config barrier that changes only credentialMode. */
  private configModeBarrier(connectionId: string, pre: SagaPreconditions, target: MemoryCredentialMode, before: MemoryCredentialMode | undefined, isCommit: boolean): Barrier {
    return {
      kind: 'config', isCommit,
      effect: async (m) => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
        if (conn.credentialMode === target) return;
        await this.repo.setConnectionCredentialMode(connectionId, target, this.liveConnRev(pre, m, connectionId));
      },
      inspect: async () => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn) return 'ambiguous';
        if (conn.credentialMode === target) return 'post';
        if (before !== undefined && conn.credentialMode === before) return 'pre';
        return 'ambiguous';
      },
      compensate: async () => {
        const conn = this.repo.getConnection(connectionId);
        if (!conn || before === undefined || conn.credentialMode === before) return;
        await this.repo.setConnectionCredentialMode(connectionId, before, conn.revision);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Legacy uppercase migration (208f7c9 → 696a084)
  // -------------------------------------------------------------------------

  private async migrateInternal(): Promise<MigrationResult> {
    const legacy = await this.cred.listLegacyMemoryApiKeyAccounts();
    if (legacy.length === 0) return { migratedConnectionIds: [] };

    const byTarget = new Map<string, { accounts: string[]; value: string | null }>();
    const collisions = new Set<string>();
    for (const { account, connectionId } of legacy) {
      const value = await this.cred.readLegacyMemoryApiKeyValue(account);
      if (value === null) continue;
      const group = byTarget.get(connectionId) ?? { accounts: [], value: null };
      if (group.value !== null && group.value !== value) collisions.add(connectionId);
      if (group.value === null) group.value = value;
      group.accounts.push(account);
      byTarget.set(connectionId, group);
    }
    const orphans = new Set<string>();
    for (const [connectionId, group] of byTarget) {
      if (group.value === null) continue;
      const canonical = await this.cred.getMemoryApiKey(connectionId);
      if (canonical !== null && canonical !== group.value) collisions.add(connectionId);
      // A legacy credential whose (lowercased) connection id has NO stored
      // connection is an orphan. It must NEVER be promoted to a canonical
      // memory_api_key — that would mint a live key for a non-existent connection.
      if (!this.repo.getConnection(connectionId)) orphans.add(connectionId);
    }

    if (collisions.size > 0 || orphans.size > 0) {
      // Preserve each blocked secret as quarantine evidence (deterministic token
      // so re-runs overwrite rather than pile up), leave the legacy accounts in
      // place so the block is re-detected, and fail closed. The subsystem stays
      // blocked until an operator explicitly resolves the conflict/orphan.
      for (const connectionId of new Set([...collisions, ...orphans])) {
        const group = byTarget.get(connectionId);
        if (!group?.value) continue;
        await this.cred.quarantineSagaSecret(connectionId, 'before', deterministicToken(connectionId), group.value).catch(() => undefined);
      }
      if (orphans.size > 0) {
        throw new SagaBlockedError([...orphans].sort()[0]!, `legacy memory credential(s) with no matching stored connection: ${[...orphans].sort().join(', ')}`);
      }
      throw new MigrationCollisionError([...collisions].sort());
    }

    const sagaId = this.newId();
    const entry: SagaJournalEntry = {
      sagaId,
      operation: 'migrateLegacyUppercaseCredentials',
      idempotencyKey: `migrateLegacyUppercaseCredentials:${sagaId}`,
      actor: this.actor,
      attempt: 1,
      status: 'prepared',
      preconditions: {
        migrationMoves: [...byTarget].flatMap(([connectionId, group]) => group.accounts.map(account => ({ legacyAccount: account, connectionId }))),
      },
      stagedSlots: [],
      createdAtMs: this.now(),
      updatedAtMs: this.now(),
    };
    this.journal.upsert(entry);

    const migrated: string[] = [];
    for (const [connectionId, group] of byTarget) {
      if (group.value === null) continue;
      const canonical = await this.cred.getMemoryApiKey(connectionId);
      if (canonical === null) await this.cred.setMemoryApiKey(connectionId, group.value);
      for (const account of group.accounts) await this.cred.deleteLegacyMemoryApiKeyAccount(account);
      migrated.push(connectionId);
    }

    this.journal.remove(sagaId);
    return { migratedConnectionIds: migrated.sort() };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireConnection(conn: MemoryConnectionConfig | null, connectionId: string): MemoryConnectionConfig {
    if (!conn) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
    return conn;
  }

  private requireNum(value: number | undefined): number {
    if (typeof value !== 'number') throw new MemoryError('storage_error', 'saga precondition revision is missing');
    return value;
  }

  private requireCreateInput(pre: SagaPreconditions): CreateMemoryConnectionInput {
    if (!pre.createInput) throw new MemoryError('storage_error', 'saga create input is missing');
    return pre.createInput;
  }

  private requireSecret(afterSecret: string | undefined): string {
    if (afterSecret === undefined) throw new MemoryError('storage_error', 'saga after-secret is missing (recovery cannot re-derive it)');
    return afterSecret;
  }
}

interface StatusPosition {
  index: number; // -1 for prepared
  phase: 'prepared' | 'doing' | 'done';
}

function parseStatus(status: SagaStatus, barriers: Barrier[]): StatusPosition {
  if (status === 'prepared') return { index: -1, phase: 'prepared' };
  const [kind, phase] = status.split(':') as [SagaBarrierKind, 'doing' | 'done'];
  const index = barriers.findIndex(b => b.kind === kind);
  if (index < 0) {
    // Barrier kind not in this op's plan — treat as prepared (defensive; recovery re-runs).
    return { index: -1, phase: 'prepared' };
  }
  return { index, phase };
}

function phaseOf(kind: SagaBarrierKind): 'config' | 'credential' {
  return kind === 'config' ? 'config' : 'credential';
}

function assertRevision(connection: MemoryConnectionConfig, expectedRevision: number): void {
  if (connection.revision !== expectedRevision) {
    throw new MemoryError('revision_conflict', `revision conflict: expected ${expectedRevision}, found ${connection.revision}`, { expected: expectedRevision, actual: connection.revision });
  }
}

function configMatches(conn: MemoryConnectionConfig, patch: MemoryConfigPatch, mode: MemoryCredentialMode | undefined): boolean {
  if (patch.name !== undefined && conn.name !== patch.name) return false;
  if (patch.enabled !== undefined && conn.enabled !== patch.enabled) return false;
  if (patch.proactiveRemoteSearch !== undefined && conn.proactiveRemoteSearch !== patch.proactiveRemoteSearch) return false;
  if (mode !== undefined && conn.credentialMode !== mode) return false;
  return true;
}

function pickConfigBefore(connection: MemoryConnectionConfig, patch: MemoryConfigPatch): MemoryConfigPatch {
  const before: MemoryConfigPatch = {};
  if (patch.name !== undefined) before.name = connection.name;
  if (patch.enabled !== undefined) before.enabled = connection.enabled;
  if (patch.proactiveRemoteSearch !== undefined) before.proactiveRemoteSearch = connection.proactiveRemoteSearch;
  return before;
}

function normalizePatch(patch: MemoryConfigPatch): MemoryConfigPatch {
  const out: MemoryConfigPatch = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.proactiveRemoteSearch !== undefined) out.proactiveRemoteSearch = patch.proactiveRemoteSearch;
  return out;
}

function joinPath(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
}

/** Stable hex quarantine token derived from an id, so re-runs overwrite one entry. */
function deterministicToken(id: string): string {
  return id.replace(/-/g, '').slice(0, 16);
}
