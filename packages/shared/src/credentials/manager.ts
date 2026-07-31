/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */

import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from './types.ts';
import { CredentialStoreError } from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';
import { SecureStorageBackend } from './backends/secure-storage.ts';
import { debug } from '../utils/debug.ts';
import { isUuid, toCanonicalUuid } from '../utils/uuid.ts';
import { isCanonicalUuid } from '../utils/uuid-format.ts';
import {
  parseBridgeCredentialEnvelope,
  serializeBridgeCredentialEnvelope,
  type BridgeCredentialEnvelope,
} from './bridge-credential.ts';

export interface CredentialManagerOptions {
  /** Override the credential config directory (for tests and custom deployments). */
  credentialsConfigDir?: string;

  /** Optional injected backends for advanced test scenarios. */
  backends?: CredentialBackend[];
}

export class CredentialManager {
  private readonly options: Readonly<CredentialManagerOptions>;
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: CredentialManagerOptions = {}) {
    this.options = { ...options };
  }

  /**
   * Explicitly initialize the credential manager.
   * This is optional - methods auto-initialize via ensureInitialized().
   * Use this for eager initialization at app startup if desired.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prevent race condition with concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    // Clear promise on failure so initialization can be retried
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private ensureInitializedSync(): void {
    if (this.initialized) {
      return;
    }

    const backends = this.options.backends?.length
      ? this.options.backends
      : [new SecureStorageBackend({ configDir: this.options.credentialsConfigDir })];

    this.backends = [...backends].sort((a, b) => b.priority - a.priority);
    this.writeBackend = this.backends[0] ?? null;
    this.initialized = true;
    this.initPromise = null;

    for (const backend of this.backends) {
      debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    }
    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    }
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = this.options.backends?.length
      ? [...this.options.backends]
      : [new SecureStorageBackend({ configDir: this.options.credentialsConfigDir })];

    const availableBackends: CredentialBackend[] = [];

    // Check which backends are available
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        availableBackends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // A synchronous caller may have initialized the singleton while the async
    // availability checks above were in flight. In that case, keep the sync state
    // instead of appending duplicate backends.
    if (this.initialized) return;

    // Sort by priority (highest first)
    availableBackends.sort((a, b) => b.priority - a.priority);
    this.backends = availableBackends;

    // Use the first available backend for writing
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** Get the name of the active write backend */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /**
   * Get a credential by ID, trying all backends.
   * Automatically initializes if needed.
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();
    return this.getInternal(id, { strict: false });
  }

  private async getInternal(id: CredentialId, options: { strict: boolean }): Promise<StoredCredential | null> {
    let lastError: unknown = null;

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        lastError = err;
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    if (options.strict && lastError) {
      throw lastError;
    }

    return null;
  }

  /**
   * Set a credential using the write backend.
   * Automatically initializes if needed.
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * Delete a credential from all backends.
   * Automatically initializes if needed.
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();

    let deleted = false;
    for (const backend of this.backends) {
      if (!backend.deleteSync) {
        debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
        continue;
      }

      try {
        if (backend.deleteSync(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  /**
   * List credentials matching a filter.
   * Automatically initializes if needed.
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();
    return this.listInternal(filter, { strict: false });
  }

  private async listInternal(
    filter?: Partial<CredentialId>,
    options: { strict: boolean } = { strict: false }
  ): Promise<CredentialId[]> {
    let lastError: unknown = null;
    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        lastError = err;
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    if (options.strict && results.length === 0 && lastError) {
      throw lastError;
    }

    return results;
  }

  // ============================================================
  // Convenience Methods
  // ============================================================

  /** Get Anthropic API key */
  async getApiKey(): Promise<string | null> {
    const cred = await this.get({ type: 'anthropic_api_key' });
    return cred?.value || null;
  }

  /** Set Anthropic API key */
  async setApiKey(key: string): Promise<void> {
    await this.set({ type: 'anthropic_api_key' }, { value: key });
  }

  /** Get Claude OAuth token */
  async getClaudeOAuth(): Promise<string | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    return cred?.value || null;
  }

  /** Set Claude OAuth token */
  async setClaudeOAuth(token: string): Promise<void> {
    await this.set({ type: 'claude_oauth' }, { value: token });
  }

  /** Get Claude OAuth credentials (with refresh token, expiry, and source) */
  async getClaudeOAuthCredentials(): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import), or undefined (unknown) */
    source?: 'native' | 'cli';
  } | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    if (!cred) return null;

    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      source: cred.source as 'native' | 'cli' | undefined,
    };
  }

  /** Set Claude OAuth credentials (with refresh token, expiry, and source) */
  async setClaudeOAuthCredentials(credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
    source?: 'native' | 'cli';
  }): Promise<void> {
    await this.set({ type: 'claude_oauth' }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      source: credentials.source,
    });
  }

  /** Get workspace MCP OAuth credentials */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** Set workspace MCP OAuth credentials */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  /** Delete all credentials for a workspace (source credentials) */
  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    const allCreds = await this.list({ workspaceId });
    for (const cred of allCreds) {
      await this.delete(cred);
    }
  }

  // Note: OpenAI API key methods removed - Codex uses native ChatGPT OAuth flow

  // ============================================================
  // LLM Connection Credentials
  // ============================================================

  /**
   * Get API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns API key or null if not found
   */
  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', connectionSlug });
    return cred?.value || null;
  }

  /**
   * Set API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param apiKey - The API key to store
   */
  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  /**
   * Delete API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns true if deleted, false if not found
   */
  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  /**
   * Get OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns OAuth credentials or null if not found
   */
  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * Set OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - OAuth credentials to store
   */
  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * Delete all credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   */
  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', connectionSlug });
    await this.delete({ type: 'llm_oauth', connectionSlug });
    await this.delete({ type: 'llm_iam', connectionSlug });
    await this.delete({ type: 'llm_service_account', connectionSlug });
  }

  // ============================================================
  // Memory Connection Credentials
  //
  // Keyed by connection UUID: memory_api_key::{connectionId}.
  // The connection id must be a UUID (no "::" delimiter), so the account
  // string is always unambiguous. Secrets live only here — never in config.
  // ============================================================

  private assertMemoryConnectionId(connectionId: string): void {
    if (!isUuid(connectionId)) {
      throw new Error(`Invalid memory connection id: ${connectionId}`);
    }
  }

  /** Get the API key for a Memory connection. */
  async getMemoryApiKey(connectionId: string): Promise<string | null> {
    await this.ensureInitialized();
    this.assertMemoryConnectionId(connectionId);
    const cred = await this.getInternal({ type: 'memory_api_key', memoryConnectionId: connectionId }, { strict: true });
    return cred?.value || null;
  }

  /** Set the API key for a Memory connection. */
  async setMemoryApiKey(connectionId: string, apiKey: string): Promise<void> {
    this.assertMemoryConnectionId(connectionId);
    // Reject empty and whitespace-only keys (a blank key is never a valid secret).
    if (!apiKey || apiKey.trim().length === 0) throw new Error('Memory API key must not be empty');
    await this.set({ type: 'memory_api_key', memoryConnectionId: connectionId }, { value: apiKey });
  }

  /** Delete the API key for a Memory connection. Returns true if one was removed. */
  async deleteMemoryApiKey(connectionId: string): Promise<boolean> {
    this.assertMemoryConnectionId(connectionId);
    return this.delete({ type: 'memory_api_key', memoryConnectionId: connectionId });
  }

  /** Whether a Memory connection has an API key stored. */
  async hasMemoryApiKey(connectionId: string): Promise<boolean> {
    return !!(await this.getMemoryApiKey(connectionId));
  }

  /** List the canonical (lowercase) connection ids that have a Memory API key stored. */
  async listMemoryApiKeyConnectionIds(): Promise<string[]> {
    await this.ensureInitialized();
    const ids = await this.listInternal({ type: 'memory_api_key' }, { strict: true });
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of ids) {
      const canonical = id.memoryConnectionId ? toCanonicalUuid(id.memoryConnectionId) : null;
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        result.push(canonical);
      }
    }
    return result;
  }

  // ============================================================
  // Trusted Bridge Instance Token
  //
  // Keyed by Bridge profile UUID: bridge_instance_token::{bridgeProfileId}.
  // This is the ONLY persisted Bridge secret. A bootstrap/enrollment/pairing
  // code is one-shot and intentionally has no persisted representation here —
  // there is no set*BootstrapToken helper and no such credential type. The
  // non-secret Bridge profile is stored separately via config/bridge-config.ts.
  // ============================================================

  private assertBridgeProfileId(bridgeProfileId: string): void {
    if (!isUuid(bridgeProfileId)) {
      throw new Error(`Invalid Bridge profile id: ${bridgeProfileId}`);
    }
  }

  /** Get and strictly parse the encrypted, origin-bound credential envelope. */
  async getBridgeInstanceCredential(bridgeProfileId: string): Promise<BridgeCredentialEnvelope | null> {
    await this.ensureInitialized();
    this.assertBridgeProfileId(bridgeProfileId);
    const cred = await this.getInternal({ type: 'bridge_instance_token', bridgeProfileId }, { strict: true });
    return cred ? parseBridgeCredentialEnvelope(cred.value) : null;
  }

  /** Store the versioned envelope in the encrypted credential backend. */
  async setBridgeInstanceCredential(envelope: BridgeCredentialEnvelope): Promise<void> {
    this.assertBridgeProfileId(envelope.profileId);
    await this.set(
      { type: 'bridge_instance_token', bridgeProfileId: envelope.profileId },
      { value: serializeBridgeCredentialEnvelope(envelope) },
    );
  }

  /** Delete the per-instance Bridge token for a profile. Returns true if one was removed. */
  async deleteBridgeInstanceToken(bridgeProfileId: string): Promise<boolean> {
    this.assertBridgeProfileId(bridgeProfileId);
    return this.delete({ type: 'bridge_instance_token', bridgeProfileId });
  }

  /** Whether a Bridge profile has an instance token stored. */
  async hasBridgeInstanceToken(bridgeProfileId: string): Promise<boolean> {
    return !!(await this.getBridgeInstanceCredential(bridgeProfileId));
  }

  /** List the canonical (lowercase) Bridge profile ids that have an instance token stored. */
  async listBridgeInstanceTokenProfileIds(): Promise<string[]> {
    await this.ensureInitialized();
    const ids = await this.listInternal({ type: 'bridge_instance_token' }, { strict: true });
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of ids) {
      const canonical = id.bridgeProfileId ? toCanonicalUuid(id.bridgeProfileId) : null;
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        result.push(canonical);
      }
    }
    return result;
  }

  // ============================================================
  // Bridge enrollment/profile saga staging (internal)
  //
  // Only post-enrollment instance credential envelopes may be staged here.
  // Bootstrap/enrollment tokens have no credential identity or API.
  // ============================================================

  async stageBridgeSagaCredential(sagaId: string, slot: 'before' | 'after', envelope: BridgeCredentialEnvelope): Promise<void> {
    this.assertSagaId(sagaId);
    await this.set({ type: 'bridge_saga_stage', sagaId, sagaSlot: slot }, { value: serializeBridgeCredentialEnvelope(envelope) });
  }

  async readStagedBridgeSagaCredential(sagaId: string, slot: 'before' | 'after'): Promise<BridgeCredentialEnvelope | null> {
    this.assertSagaId(sagaId);
    await this.ensureInitialized();
    const cred = await this.getInternal({ type: 'bridge_saga_stage', sagaId, sagaSlot: slot }, { strict: true });
    return cred ? parseBridgeCredentialEnvelope(cred.value) : null;
  }

  async deleteStagedBridgeSagaCredential(sagaId: string, slot: 'before' | 'after'): Promise<boolean> {
    this.assertSagaId(sagaId);
    return this.delete({ type: 'bridge_saga_stage', sagaId, sagaSlot: slot });
  }

  async quarantineBridgeSagaCredential(sagaId: string, slot: 'before' | 'after', token: string, envelope: BridgeCredentialEnvelope): Promise<void> {
    this.assertSagaId(sagaId);
    await this.set(
      { type: 'bridge_saga_quarantine', sagaId, sagaSlot: slot, quarantineToken: token },
      { value: serializeBridgeCredentialEnvelope(envelope) },
    );
  }

  async listBridgeSagaStageSagaIds(): Promise<string[]> {
    await this.ensureInitialized();
    const prefix = 'bridge_saga_stage::';
    const seen = new Set<string>();
    for (const backend of this.backends) {
      if (!backend.listRawAccounts) continue;
      for (const account of await backend.listRawAccounts()) {
        if (!account.startsWith(prefix)) continue;
        const sagaId = account.slice(prefix.length).split('::')[0];
        if (sagaId && isCanonicalUuid(sagaId)) seen.add(sagaId);
      }
    }
    return [...seen];
  }

  // ============================================================
  // A5 Saga Staging / Quarantine (internal)
  //
  // Encrypted before/after secret material for an in-flight memory saga, plus
  // quarantine identities that preserve secret evidence when a saga cannot be
  // resolved cleanly. Keyed by saga UUID + slot; a distinct credential type keeps
  // them OUT of every generic memory listing.
  // ============================================================

  /** Stage a saga's before/after secret. */
  async stageSagaSecret(sagaId: string, slot: 'before' | 'after', value: string): Promise<void> {
    this.assertSagaId(sagaId);
    await this.set({ type: 'memory_saga_stage', sagaId, sagaSlot: slot }, { value });
  }

  /** Read a saga's staged before/after secret, or null if absent. */
  async readStagedSagaSecret(sagaId: string, slot: 'before' | 'after'): Promise<string | null> {
    this.assertSagaId(sagaId);
    await this.ensureInitialized();
    const cred = await this.getInternal({ type: 'memory_saga_stage', sagaId, sagaSlot: slot }, { strict: true });
    return cred?.value ?? null;
  }

  /** Delete a saga's staged before/after secret. Returns true if one was removed. */
  async deleteStagedSagaSecret(sagaId: string, slot: 'before' | 'after'): Promise<boolean> {
    this.assertSagaId(sagaId);
    return this.delete({ type: 'memory_saga_stage', sagaId, sagaSlot: slot });
  }

  /** Move a saga's staged secret into a non-clobbering quarantine identity (evidence). */
  async quarantineSagaSecret(sagaId: string, slot: 'before' | 'after', token: string, value: string): Promise<void> {
    this.assertSagaId(sagaId);
    await this.set({ type: 'memory_saga_quarantine', sagaId, sagaSlot: slot, quarantineToken: token }, { value });
  }

  private assertSagaId(sagaId: string): void {
    if (!isCanonicalUuid(sagaId)) {
      throw new Error(`Invalid saga id: ${sagaId}`);
    }
  }

  private static readonly SAGA_STAGE_PREFIX = 'memory_saga_stage::';

  /**
   * List the distinct saga ids that currently have staging secrets. Used by
   * startup recovery to detect orphan staging (a staged secret with no journal
   * entry), which must fail closed.
   */
  async listSagaStageSagaIds(): Promise<string[]> {
    await this.ensureInitialized();
    const prefix = CredentialManager.SAGA_STAGE_PREFIX;
    const seen = new Set<string>();
    for (const backend of this.backends) {
      if (!backend.listRawAccounts) continue;
      for (const account of await backend.listRawAccounts()) {
        if (!account.startsWith(prefix)) continue;
        const sagaId = account.slice(prefix.length).split('::')[0];
        if (sagaId && isCanonicalUuid(sagaId)) seen.add(sagaId);
      }
    }
    return [...seen];
  }

  // ============================================================
  // A5 Legacy Memory Credential Migration (internal)
  //
  // Pre-canonicalization builds wrote memory accounts verbatim, so a connection
  // whose UUID contained uppercase produced `memory_api_key::{UPPERCASE}`. Those
  // accounts no longer parse into a canonical CredentialId and are orphaned. The
  // migration enumerates them RAW (bypassing CredentialId parsing) so it can move
  // each to its canonical lowercase account.
  // ============================================================

  private static readonly MEMORY_ACCOUNT_PREFIX = 'memory_api_key::';

  /**
   * List legacy (non-canonical) memory API-key accounts across all backends.
   * Returns the raw account string and the canonical connection id it should move
   * to. Never returns secret values.
   */
  async listLegacyMemoryApiKeyAccounts(): Promise<Array<{ account: string; connectionId: string }>> {
    await this.ensureInitialized();
    const prefix = CredentialManager.MEMORY_ACCOUNT_PREFIX;
    const seen = new Set<string>();
    const results: Array<{ account: string; connectionId: string }> = [];
    let sawRawCapableBackend = false;

    for (const backend of this.backends) {
      if (!backend.listRawAccounts) continue;
      sawRawCapableBackend = true;
      const accounts = await backend.listRawAccounts();
      for (const account of accounts) {
        if (seen.has(account) || !account.startsWith(prefix)) continue;
        const segment = account.slice(prefix.length);
        // Legacy iff the segment is a UUID (any case) that is NOT already canonical.
        if (segment.includes('::') || !isUuid(segment) || isCanonicalUuid(segment)) continue;
        const canonical = toCanonicalUuid(segment);
        if (!canonical) continue;
        seen.add(account);
        results.push({ account, connectionId: canonical });
      }
    }

    if (!sawRawCapableBackend) {
      // No backend can enumerate raw accounts (e.g. injected fake without raw
      // support): there is provably no legacy work this manager can see.
      return [];
    }
    return results;
  }

  /** Read the secret value for a raw legacy memory account. */
  async readLegacyMemoryApiKeyValue(account: string): Promise<string | null> {
    if (!account.startsWith(CredentialManager.MEMORY_ACCOUNT_PREFIX)) {
      throw new Error('not a memory_api_key account');
    }
    await this.ensureInitialized();
    for (const backend of this.backends) {
      if (!backend.getByAccount) continue;
      const cred = await backend.getByAccount(account);
      if (cred) return cred.value ?? null;
    }
    return null;
  }

  /** Delete a raw legacy memory account from every backend that supports it. */
  async deleteLegacyMemoryApiKeyAccount(account: string): Promise<boolean> {
    if (!account.startsWith(CredentialManager.MEMORY_ACCOUNT_PREFIX)) {
      throw new Error('not a memory_api_key account');
    }
    await this.ensureInitialized();
    let deleted = false;
    for (const backend of this.backends) {
      if (!backend.deleteByAccount) continue;
      if (await backend.deleteByAccount(account)) deleted = true;
    }
    return deleted;
  }

  // ============================================================
  // IAM Credentials (AWS Bedrock)
  // ============================================================

  /**
   * Get IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns IAM credentials or null if not found
   */
  async getLlmIamCredentials(connectionSlug: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', connectionSlug });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // Secret key stored in value field
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * Set IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - IAM credentials to store
   */
  async setLlmIamCredentials(connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', connectionSlug }, {
      value: credentials.secretAccessKey, // Primary secret in value field
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // Service Account Credentials (GCP Vertex)
  // ============================================================

  /**
   * Get service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns Service account JSON and metadata or null if not found
   */
  async getLlmServiceAccount(connectionSlug: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', connectionSlug });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // Full JSON stored in value field
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * Set service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - Service account credentials to store
   */
  async setLlmServiceAccount(connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', connectionSlug }, {
      value: credentials.serviceAccountJson, // Full JSON in value field
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // Unified Credential Checking
  // ============================================================

  /**
   * Check if an LLM connection has valid credentials.
   * Uses the new LlmAuthType system - routes by auth mechanism.
   *
   * @param connectionSlug - The connection slug
   * @param authType - The auth type to check
   * @param providerType - Optional provider type for OAuth routing
   * @returns true if credentials exist and are valid
   */
  async hasLlmCredentials(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    switch (authType) {
      // No credentials needed
      case 'none':
      case 'environment':
        return true;

      // API key variants - all use the same storage
      case 'api_key':
      case 'api_key_with_endpoint':
      case 'bearer_token':
        return this.hasLlmApiKeyCredential(connectionSlug);

      // OAuth - browser flow
      case 'oauth':
        return this.hasLlmOAuthCredential(connectionSlug, providerType);

      // AWS IAM credentials
      case 'iam_credentials':
        return this.hasLlmIamCredential(connectionSlug);

      // GCP service account
      case 'service_account_file':
        return this.hasLlmServiceAccountCredential(connectionSlug);

      default:
        // Exhaustive check - TypeScript will error if we miss a case
        const _exhaustive: never = authType;
        return false;
    }
  }

  /**
   * Check if connection has valid API key credential.
   * @internal
   */
  private async hasLlmApiKeyCredential(connectionSlug: string): Promise<boolean> {
    const apiKey = await this.getLlmApiKey(connectionSlug);
    return !!apiKey;
  }

  /**
   * Check if connection has valid OAuth credential.
   * @internal
   */
  private async hasLlmOAuthCredential(
    connectionSlug: string,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    const oauth = await this.getLlmOAuth(connectionSlug);
    if (!oauth) return false;

    // Check if expired
    if (oauth.expiresAt && this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
      return !!oauth.refreshToken; // Can refresh
    }
    return true;
  }

  /**
   * Check if connection has valid IAM credential.
   * @internal
   */
  private async hasLlmIamCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmIamCredentials(connectionSlug);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
  }

  /**
   * Check if connection has valid service account credential.
   * @internal
   */
  private async hasLlmServiceAccountCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmServiceAccount(connectionSlug);
    return !!cred?.serviceAccountJson;
  }

  /**
   * Check if a credential is expired (with 5-minute buffer).
   *
   * If expiresAt is not set:
   * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
   * - API keys (no refreshToken): treated as never expiring
   *
   * This prevents OAuth tokens from being treated as valid forever when
   * the provider doesn't return expires_in in the token response.
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // Consider expired if within 5 minutes of expiry
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
      // OAuth token without expiry - treat as expired to force refresh
      // This is safer than assuming it's valid forever
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // API key without expiry - these typically don't expire
    return false;
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check the health of the credential store.
   *
   * This validates:
   * 1. The credential file can be read and decrypted (if it exists)
   * 2. The default LLM connection has valid credentials
   *
   * Use this on app startup to detect issues before users hit cryptic errors.
   *
   * @returns Health status with any issues found
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. Try to list credentials - this triggers decryption and validation.
      await this.listInternal({}, { strict: true });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof CredentialStoreError ? error.code : 'unknown';

      if (errorCode === 'decryption_failed') {
        issues.push({
          type: 'decryption_failed',
          message: 'Credentials from another machine detected. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. Check if default connection has credentials
    // Import lazily to avoid circular dependency
    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const defaultSlug = getDefaultLlmConnection();

      if (defaultSlug) {
        const connection = getLlmConnection(defaultSlug);
        if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
          const hasCredentials = await this.hasLlmCredentials(
            defaultSlug,
            connection.authType,
            connection.providerType
          );
          if (!hasCredentials) {
            issues.push({
              type: 'no_default_credentials',
              message: `No credentials found for default connection "${connection.name}".`,
            });
          }
        }
      }
    } catch (configError) {
      // Config not yet initialized - skip this check
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
  if (!manager) {
    manager = new CredentialManager();
  }
  return manager;
}
