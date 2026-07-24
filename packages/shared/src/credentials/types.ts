/**
 * Credential Storage Types
 *
 * Defines the types for secure credential storage using AES-256-GCM encryption.
 * Supports global and source-scoped credentials.
 *
 * Credential key format: "{type}::{scope...}"
 *
 * Examples:
 *   - anthropic_api_key::global
 *   - claude_oauth::global
 *   - source_oauth::{workspaceId}::{sourceId}
 *   - source_bearer::{workspaceId}::{sourceId}
 *
 * Note: Using "::" as delimiter to avoid conflicts with "/" in URLs or paths.
 */

import { isCanonicalUuid, toCanonicalUuid } from '../utils/uuid-format.ts';

/** Types of credentials we store */
export type CredentialType =
  // Global credentials (legacy, kept for backwards compatibility)
  | 'anthropic_api_key'  // Anthropic API key for Claude
  | 'claude_oauth'       // Claude OAuth token (Max subscription)
  // LLM connection credentials (keyed by connection slug)
  | 'llm_api_key'        // API key for LLM connection
  | 'llm_oauth'          // OAuth token for LLM connection
  | 'llm_iam'            // AWS IAM credentials (accessKeyId + secretAccessKey)
  | 'llm_service_account' // GCP service account JSON
  // Workspace credentials
  | 'workspace_oauth'    // Workspace MCP OAuth token
  // Source credentials (stored at ~/.craft-agent/workspaces/{ws}/sources/{slug}/)
  | 'source_oauth'       // OAuth tokens for MCP/API sources
  | 'source_bearer'      // Bearer tokens
  | 'source_apikey'      // API keys
  | 'source_basic'       // Basic auth (base64 encoded user:pass)
  // Messaging gateway credentials (keyed by workspaceId + platform)
  | 'messaging_bearer'   // Platform tokens (e.g., Telegram bot token)
  // Memory connection credentials (keyed by connection UUID)
  | 'memory_api_key'     // API key for a Qdrant Memory connection
  // Internal A5 saga staging/quarantine identities (keyed by saga UUID + slot).
  // These hold before/after secret material for an in-flight saga so a crash is
  // recoverable. They are encrypted at rest like any credential, and are
  // deliberately EXCLUDED from every generic memory listing (they are a distinct
  // type, so a `type: 'memory_api_key'` filter never returns them).
  | 'memory_saga_stage'       // before/after secret staged mid-saga
  | 'memory_saga_quarantine'; // preserved secret material from an unresolved saga

/** Valid credential types for validation */
const VALID_CREDENTIAL_TYPES: readonly CredentialType[] = [
  'anthropic_api_key',
  'claude_oauth',
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
  'workspace_oauth',
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
  'messaging_bearer',
  'memory_api_key',
  'memory_saga_stage',
  'memory_saga_quarantine',
] as const;

/** Check if a string is a valid CredentialType */
function isValidCredentialType(type: string): type is CredentialType {
  return VALID_CREDENTIAL_TYPES.includes(type as CredentialType);
}

/** Credential identifier - determines credential store entry key */
export interface CredentialId {
  type: CredentialType;

  // LLM connection-scoped format
  /** LLM connection slug for llm_api_key/llm_oauth credentials */
  connectionSlug?: string;

  // Workspace-scoped format
  /** Workspace ID for workspace-scoped credentials */
  workspaceId?: string;
  /** Source ID for source credentials */
  sourceId?: string;
  /** Server name or API name */
  name?: string;

  // Memory connection-scoped format
  /** Memory connection UUID for memory_api_key credentials */
  memoryConnectionId?: string;

  // Internal A5 saga staging/quarantine format
  /** Saga UUID for memory_saga_stage / memory_saga_quarantine credentials */
  sagaId?: string;
  /** Which secret slot this staging/quarantine entry holds. */
  sagaSlot?: 'before' | 'after';
  /** Disambiguating hex token for a quarantine entry (evidence, non-clobbering). */
  quarantineToken?: string;
}

/**
 * Stored credential value in encrypted file.
 *
 * This is a generic type for all credential types (OAuth, bearer tokens, API keys, IAM, service accounts).
 * All fields except `value` are optional since not all credential types use them.
 *
 * Note: `clientId` is optional here unlike `OAuthCredentials` (in storage.ts)
 * where it's required, because this type also covers bearer tokens and API keys
 * which don't have a clientId.
 */
export interface StoredCredential {
  /** The secret value (API key, access token, or primary credential) */
  value: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** OAuth token expiration (Unix timestamp ms) */
  expiresAt?: number;
  /** OAuth client ID (needed for token refresh) */
  clientId?: string;
  /** OAuth client secret (needed for Google token refresh - Google requires both ID and secret) */
  clientSecret?: string;
  /** Token type (e.g., "Bearer") */
  tokenType?: string;
  /** Where the credential came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
  source?: 'native' | 'cli';
  /**
   * OIDC id_token (JWT with user identity claims).
   * Used by OpenAI/Codex which returns both id_token and access_token.
   * The `value` field stores access_token, this field stores id_token.
   */
  idToken?: string;

  // --- AWS IAM credentials (for llm_iam type) ---

  /** AWS Access Key ID (for IAM credentials) */
  awsAccessKeyId?: string;
  /** AWS Secret Access Key (for IAM credentials) - stored in `value` field */
  // awsSecretAccessKey is stored in the `value` field
  /** AWS Region (for IAM credentials) */
  awsRegion?: string;
  /** AWS Session Token (for temporary credentials) */
  awsSessionToken?: string;

  // --- GCP Service Account (for llm_service_account type) ---

  /** GCP Project ID (for service account) */
  gcpProjectId?: string;
  /** GCP Region (for service account) */
  gcpRegion?: string;
  /** Service account email (for identification) */
  serviceAccountEmail?: string;
  // Full service account JSON is stored in the `value` field
}

// Using "::" as delimiter instead of "/" because server names and API names
// could contain "/" (e.g., URLs like "https://api.example.com")
const CREDENTIAL_DELIMITER = '::';

/** Source credential types */
export const SOURCE_CREDENTIAL_TYPES = [
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
] as const;

/** Messaging credential types */
const MESSAGING_CREDENTIAL_TYPES = [
  'messaging_bearer',
] as const;

/** Check if type is a messaging credential */
function isMessagingCredential(type: CredentialType): boolean {
  return (MESSAGING_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** LLM connection credential types */
const LLM_CREDENTIAL_TYPES = [
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
] as const;

/** Memory connection credential types */
export const MEMORY_CREDENTIAL_TYPES = [
  'memory_api_key',
] as const;

/** Internal A5 saga staging/quarantine credential types (never listed generically). */
export const MEMORY_SAGA_CREDENTIAL_TYPES = [
  'memory_saga_stage',
  'memory_saga_quarantine',
] as const;

const QUARANTINE_TOKEN_PATTERN = /^[0-9a-f]{1,64}$/;

/** Check if type is an internal saga staging credential. */
function isMemorySagaStage(type: CredentialType): boolean {
  return type === 'memory_saga_stage';
}

/** Check if type is an internal saga quarantine credential. */
function isMemorySagaQuarantine(type: CredentialType): boolean {
  return type === 'memory_saga_quarantine';
}

/** Check if type is a source credential */
function isSourceCredential(type: CredentialType): boolean {
  return (SOURCE_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Check if type is an LLM connection credential */
function isLlmCredential(type: CredentialType): boolean {
  return (LLM_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Check if type is a Memory connection credential */
function isMemoryCredential(type: CredentialType): boolean {
  return (MEMORY_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Convert CredentialId to credential store account string */
export function credentialIdToAccount(id: CredentialId): string {
  const parts: string[] = [id.type];

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(id.type) && id.connectionSlug) {
    parts.push(id.connectionSlug);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Memory connection-scoped format:
  // memory_api_key::{connectionId}
  // The connection id is a UUID (canonicalized to lowercase), so it never
  // contains the "::" delimiter and case variants map to the same account.
  if (isMemoryCredential(id.type)) {
    const canonical = id.memoryConnectionId ? toCanonicalUuid(id.memoryConnectionId) : null;
    if (!canonical) {
      throw new Error('memory_api_key credential requires a valid UUID memoryConnectionId');
    }
    parts.push(canonical);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Internal saga staging format:
  // memory_saga_stage::{sagaId}::{slot}
  if (isMemorySagaStage(id.type)) {
    const canonical = id.sagaId ? toCanonicalUuid(id.sagaId) : null;
    if (!canonical) throw new Error('memory_saga_stage credential requires a valid UUID sagaId');
    if (id.sagaSlot !== 'before' && id.sagaSlot !== 'after') {
      throw new Error('memory_saga_stage credential requires slot "before" or "after"');
    }
    parts.push(canonical, id.sagaSlot);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Internal saga quarantine format:
  // memory_saga_quarantine::{sagaId}::{slot}::{token}
  if (isMemorySagaQuarantine(id.type)) {
    const canonical = id.sagaId ? toCanonicalUuid(id.sagaId) : null;
    if (!canonical) throw new Error('memory_saga_quarantine credential requires a valid UUID sagaId');
    if (id.sagaSlot !== 'before' && id.sagaSlot !== 'after') {
      throw new Error('memory_saga_quarantine credential requires slot "before" or "after"');
    }
    if (!id.quarantineToken || !QUARANTINE_TOKEN_PATTERN.test(id.quarantineToken)) {
      throw new Error('memory_saga_quarantine credential requires a hex quarantineToken');
    }
    parts.push(canonical, id.sagaSlot, id.quarantineToken);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if (id.type === 'workspace_oauth' && id.workspaceId) {
    parts.push(id.workspaceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(id.type) && id.workspaceId && id.sourceId) {
    parts.push(id.workspaceId);
    parts.push(id.sourceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Messaging-scoped format:
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(id.type) && id.workspaceId && id.name) {
    parts.push(id.workspaceId);
    parts.push(id.name);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  parts.push('global');
  return parts.join(CREDENTIAL_DELIMITER);
}

// ============================================================
// Credential Health Check Types
// ============================================================

/** Types of credential health issues detected at startup */
export type CredentialHealthIssueType =
  | 'file_corrupted'         // Credential file exists but can't be parsed
  | 'decryption_failed'      // File exists but can't be decrypted (machine migration)
  | 'no_default_credentials' // No credentials for the default connection

/** A single credential health issue */
export interface CredentialHealthIssue {
  type: CredentialHealthIssueType
  /** Human-readable error message */
  message: string
  /** Original error if available */
  error?: string
}

/** Result of credential store health check */
export interface CredentialHealthStatus {
  /** True if credential store is healthy and usable */
  healthy: boolean
  /** List of issues found (empty if healthy) */
  issues: CredentialHealthIssue[]
}

/** Typed backend failures for secure credential storage. */
export type CredentialStoreErrorCode =
  | 'file_corrupted'
  | 'decryption_failed'
  | 'permission_denied'
  | 'io_error';

/** Error shape for secure credential backend read/write failures. */
export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  readonly path?: string;

  constructor(code: CredentialStoreErrorCode, message: string, details?: { path?: string; cause?: unknown }) {
    super(message, { cause: details?.cause });
    this.name = 'CredentialStoreError';
    this.code = code;
    if (details?.path !== undefined) {
      this.path = details.path;
    }
  }
}

/** Parse credential store account string back to CredentialId. Returns null if invalid. */
export function accountToCredentialId(account: string): CredentialId | null {
  const parts = account.split(CREDENTIAL_DELIMITER);
  const typeStr = parts[0];

  // Validate the type
  if (!typeStr || !isValidCredentialType(typeStr)) {
    return null;
  }

  const type = typeStr;

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(type) && parts.length === 2) {
    return { type, connectionSlug: parts[1] };
  }

  // Memory connection-scoped format:
  // memory_api_key::{connectionId} — second segment must be a canonical
  // (lowercase) UUID; case variants are rejected so they cannot masquerade as a
  // distinct account.
  if (isMemoryCredential(type) && parts.length === 2 && isCanonicalUuid(parts[1])) {
    return { type, memoryConnectionId: parts[1] };
  }

  // Internal saga staging format:
  // memory_saga_stage::{sagaId}::{slot} — sagaId must be canonical UUID.
  if (isMemorySagaStage(type) && parts.length === 3 && isCanonicalUuid(parts[1])
    && (parts[2] === 'before' || parts[2] === 'after')) {
    return { type, sagaId: parts[1], sagaSlot: parts[2] };
  }

  // Internal saga quarantine format:
  // memory_saga_quarantine::{sagaId}::{slot}::{token}
  if (isMemorySagaQuarantine(type) && parts.length === 4 && isCanonicalUuid(parts[1])
    && (parts[2] === 'before' || parts[2] === 'after') && QUARANTINE_TOKEN_PATTERN.test(parts[3] ?? '')) {
    return { type, sagaId: parts[1], sagaSlot: parts[2], quarantineToken: parts[3] };
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if (type === 'workspace_oauth' && parts.length === 2) {
    return { type, workspaceId: parts[1] };
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], sourceId: parts[2] };
  }

  // Messaging-scoped format:
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], name: parts[2] };
  }

  // Memory credentials are always connection-scoped (UUID) — never "global".
  if (parts.length === 2 && parts[1] === 'global' && !isMemoryCredential(type)) {
    return { type };
  }

  // Unknown format
  return null;
}
