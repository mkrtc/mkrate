/**
 * Memory connection service layer.
 *
 * Coordinates MemoryConnectionRepository (config) with CredentialManager
 * (secrets) through the durable A5 saga so a crash mid-operation is recoverable
 * and config/credential state always converges. This layer preserves the stable
 * external contract (method signatures, DTO shapes, and error codes) while the
 * durable saga runs underneath.
 */

import { MemoryConnectionRepository, type MemorySpaceMutationResult } from './repository.ts';
import { toMemoryConnectionSummaryDto, type MemoryConnectionSummaryDto } from './dto.ts';
import type { CreateMemoryConnectionInput, CreateMemorySpaceInput, UpdateMemoryConnectionInput, UpdateMemorySpaceInput, MemoryConnectionConfig, MemoryCredentialMode } from './types.ts';
import { MemoryError } from './types.ts';
import type { CredentialManager } from '../../credentials/manager.ts';
import {
  MemorySagaCoordinator,
  MigrationCollisionError,
  SagaBlockedError,
  SagaRollbackError,
  SagaStepError,
  type MemorySagaHooks,
  type MigrationResult,
} from './saga.ts';

export interface CreateMemoryConnectionServiceInput extends CreateMemoryConnectionInput {
  /** Optional expected root revision for optimistic concurrency. Defaults to current root for direct service callers. */
  expectedRootRevision?: number;
  /** Optional API key to persist in credentials store. */
  apiKey?: string;
}

export interface UpdateMemoryConnectionServiceInput extends UpdateMemoryConnectionInput {
  /** Connection id to patch. */
  connectionId: string;
  /** Expected per-connection revision for optimistic concurrency. */
  expectedRevision: number;
  /**
   * Optional API key operation:
   * - omit: keep existing key untouched
   * - null: delete the stored key
   * - string: set/replace the stored key
   */
  apiKey?: string | null;
}

export interface MemoryConnectionServiceDeps {
  repository: MemoryConnectionRepository;
  credentialManager: CredentialManager;
  /** Deterministic failure hooks (tests + crash-recovery coverage). */
  sagaHooks?: MemorySagaHooks;
  /** Clock override (tests). */
  now?: () => number;
  /** Canonical-UUID generator override (tests). */
  newId?: () => string;
  /** Actor recorded on journal entries. */
  actor?: string;
  /** Saga lease acquisition timeout (tests). */
  leaseTimeoutMs?: number;
}

export type MemoryConnectionServiceCode =
  | 'validation_error'
  | 'config_error'
  | 'credential_error'
  | 'rollback_error'
  | 'not_found';

export class MemoryConnectionServiceError extends Error {
  public readonly code: MemoryConnectionServiceCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: MemoryConnectionServiceCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = 'MemoryConnectionServiceError';
    this.code = code;
    this.details = {
      ...(details ?? {}),
      cause: cause instanceof Error ? {
        name: cause.name,
        message: cause.message,
        code: (cause as { code?: unknown }).code,
      } : { message: String(cause) },
    };
  }
}

function normalizeApiKey(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new MemoryConnectionServiceError('validation_error', 'Memory API key must not be empty');
  }
  return normalized;
}

function serializeCause(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as { code?: unknown }).code,
    };
  }
  return { message: String(error) };
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof MemoryConnectionServiceError) throw error;
  if (error instanceof MemoryError) {
    const code = error.code;
    if (code === 'not_found') {
      throw new MemoryConnectionServiceError('not_found', `Failed to load memory connection: ${error.message}`, { cause: serializeCause(error) });
    }
    if (code === 'invalid_input' || code === 'immutable_field' || code === 'duplicate_name') {
      throw new MemoryConnectionServiceError('validation_error', error.message, { cause: serializeCause(error) });
    }
    throw new MemoryConnectionServiceError('config_error', error.message, { cause: serializeCause(error) });
  }

  throw new MemoryConnectionServiceError('config_error', 'Repository operation failed', { cause: serializeCause(error) });
}

function mapCredentialError(error: unknown): never {
  throw new MemoryConnectionServiceError('credential_error', error instanceof Error ? error.message : 'Credential operation failed', {
    cause: serializeCause(error),
  });
}

/** Translate a saga/coordinator failure into the stable service error taxonomy. */
function mapSagaError(error: unknown): never {
  if (error instanceof MemoryConnectionServiceError) throw error;
  if (error instanceof SagaRollbackError) {
    throw new MemoryConnectionServiceError('rollback_error', error.message, { ...error.details }, error.cause);
  }
  if (error instanceof SagaBlockedError) {
    // Recovery is blocked (ambiguous/quarantined state); the subsystem is fail-closed.
    throw new MemoryConnectionServiceError('config_error', error.message, { sagaId: error.sagaId, blocked: true });
  }
  if (error instanceof MigrationCollisionError) {
    throw new MemoryConnectionServiceError('config_error', error.message, { connectionIds: error.connectionIds });
  }
  if (error instanceof SagaStepError) {
    if (error.phase === 'credential') mapCredentialError(error.cause);
    mapRepositoryError(error.cause);
  }
  mapRepositoryError(error);
}

function pickHasApiKeyFromMode(credentialMode: MemoryConnectionConfig['credentialMode']): boolean {
  return credentialMode === 'stored-api-key';
}

function toSummary(connection: MemoryConnectionConfig): MemoryConnectionSummaryDto {
  return toMemoryConnectionSummaryDto(connection, {
    isEnvironment: false,
    hasApiKey: pickHasApiKeyFromMode(connection.credentialMode),
  });
}

export class MemoryConnectionService {
  public readonly repository: MemoryConnectionRepository;
  public readonly credentialManager: CredentialManager;
  public readonly coordinator: MemorySagaCoordinator;

  constructor(deps: MemoryConnectionServiceDeps) {
    this.repository = deps.repository;
    this.credentialManager = deps.credentialManager;
    this.coordinator = new MemorySagaCoordinator({
      repository: deps.repository,
      credentialManager: deps.credentialManager,
      dir: deps.repository.getDir(),
      hooks: deps.sagaHooks,
      now: deps.now,
      newId: deps.newId,
      actor: deps.actor,
      leaseTimeoutMs: deps.leaseTimeoutMs,
    });
  }

  /**
   * Run durable startup recovery once. All memory handlers must gate on this so a
   * crashed saga is resolved (or the subsystem fails closed) before any new
   * outer-memory mutation. Idempotent and memoized.
   */
  async ensureRecovered(): Promise<void> {
    try {
      await this.coordinator.ensureRecovered();
    } catch (error) {
      mapSagaError(error);
    }
  }

  async createConnection(input: CreateMemoryConnectionServiceInput): Promise<MemoryConnectionSummaryDto> {
    const { apiKey, expectedRootRevision: requestedRootRevision, ...connectionInput } = input;
    const normalizedApiKey = apiKey !== undefined ? normalizeApiKey(apiKey) : undefined;
    const expectedRootRevision = requestedRootRevision ?? this.repository.getRootRevision();

    try {
      const connection = await this.coordinator.createConnection(connectionInput, expectedRootRevision, normalizedApiKey);
      return toSummary(connection);
    } catch (error) {
      mapSagaError(error);
    }
  }

  async patchConnection(input: UpdateMemoryConnectionServiceInput): Promise<MemoryConnectionSummaryDto> {
    const { connectionId, expectedRevision, apiKey, ...patch } = input;

    const apiKeyOp = apiKey === undefined
      ? undefined
      : apiKey === null
        ? { kind: 'clear' as const }
        : { kind: 'set' as const, apiKey: normalizeApiKey(apiKey) };

    try {
      const connection = await this.coordinator.updateConnectionConfig(
        connectionId,
        patch as UpdateMemoryConnectionInput,
        expectedRevision,
        apiKeyOp,
      );
      return toSummary(connection);
    } catch (error) {
      mapSagaError(error);
    }
  }

  async deleteConnection(connectionId: string, expectedRootRevision: number): Promise<void> {
    try {
      await this.coordinator.deleteConnection(connectionId, expectedRootRevision);
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Establish or overwrite the API key for a connection (converges credentialMode). */
  async setApiKey(connectionId: string, apiKey: string, expectedRevision: number): Promise<MemoryConnectionSummaryDto> {
    const normalized = normalizeApiKey(apiKey);
    try {
      return toSummary(await this.coordinator.setApiKey(connectionId, normalized, expectedRevision));
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Replace an existing API key. Fails closed if none is stored. */
  async replaceApiKey(connectionId: string, apiKey: string, expectedRevision: number): Promise<MemoryConnectionSummaryDto> {
    const normalized = normalizeApiKey(apiKey);
    try {
      return toSummary(await this.coordinator.replaceApiKey(connectionId, normalized, expectedRevision));
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Remove a connection's API key (converges credentialMode to `none`). */
  async clearApiKey(connectionId: string, expectedRevision: number): Promise<MemoryConnectionSummaryDto> {
    try {
      return toSummary(await this.coordinator.clearApiKey(connectionId, expectedRevision));
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Explicitly set credentialMode, enforcing consistency with actual key presence. */
  async setCredentialMode(connectionId: string, mode: MemoryCredentialMode, expectedRevision: number): Promise<MemoryConnectionSummaryDto> {
    try {
      return toSummary(await this.coordinator.setCredentialMode(connectionId, mode, expectedRevision));
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Migrate legacy (non-canonical) memory credential accounts. Fail-closed on collision. */
  async migrateLegacyUppercaseCredentials(): Promise<MigrationResult> {
    try {
      return await this.coordinator.migrateLegacyUppercaseCredentials();
    } catch (error) {
      mapSagaError(error);
    }
  }

  // Space mutations route through the coordinator (outer lease, after recovery)
  // so they never bypass the sole serialization point, even though they touch
  // only the single config store.

  async addSpace(connectionId: string, input: CreateMemorySpaceInput, expectedRevision: number): Promise<MemorySpaceMutationResult> {
    try {
      return await this.coordinator.addSpace(connectionId, input, expectedRevision);
    } catch (error) {
      mapSagaError(error);
    }
  }

  async updateSpace(connectionId: string, spaceId: string, patch: UpdateMemorySpaceInput, expectedRevision: number): Promise<MemorySpaceMutationResult> {
    try {
      return await this.coordinator.updateSpace(connectionId, spaceId, patch, expectedRevision);
    } catch (error) {
      mapSagaError(error);
    }
  }

  async deleteSpace(connectionId: string, spaceId: string, expectedRevision: number): Promise<MemoryConnectionConfig> {
    try {
      return await this.coordinator.deleteSpace(connectionId, spaceId, expectedRevision);
    } catch (error) {
      mapSagaError(error);
    }
  }

  /** Run durable recovery, then heal legacy credential accounts (fail-closed). */
  async ensureReady(): Promise<void> {
    await this.ensureRecovered();
    try {
      await this.coordinator.migrateLegacyUppercaseCredentials();
    } catch (error) {
      mapSagaError(error);
    }
  }
}
