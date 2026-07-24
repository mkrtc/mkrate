/**
 * Durable, secret-free, versioned saga journal (write-ahead log).
 *
 * The journal is the crash-recovery source of truth for the A5 saga. It records
 * *what a saga intends and how far it got* — identifiers, intent, preconditions,
 * idempotency key, actor, attempt, and status — but **never** secret material.
 * Secret bytes live only in the encrypted credential store (before/after staging
 * and quarantine identities); the journal only names which staging slots exist.
 *
 * **Write-ahead protocol.** Every durable side effect is bracketed by two journal
 * writes: a `<barrier>:doing` intent record written *before* the effect, and a
 * `<barrier>:done` record written *after* it. A crash between them leaves the
 * status at `:doing`; recovery then inspects the actual on-disk state and
 * classifies it as pre-effect, post-effect, or ambiguous (which fails closed).
 * The status is therefore never trusted to imply the effect landed — it only
 * bounds where to look.
 *
 * Persistence uses the shared bounded / symlink-safe / durable-atomic primitives
 * in `./durable-file.ts`. All journal mutations run while the caller holds the
 * outer saga lease.
 *
 * The document is versioned and **strictly validated**: unknown root fields,
 * unknown entry fields, unknown nested fields, unknown status/operation values,
 * or a future version all fail closed. A present-but-unparseable journal is never
 * silently discarded.
 */

import {
  atomicWriteSecure,
  readTextFileBounded,
} from './durable-file.ts';
import { safeJsonParse } from '../../utils/files.ts';
import { isCanonicalUuid } from '../../utils/uuid-format.ts';
import { MemoryError, type CreateMemoryConnectionInput, type MemoryCredentialMode } from './types.ts';

/** Schema version of `saga-journal.json`. */
export const SAGA_JOURNAL_VERSION = 1 as const;

/** File name (relative to `${CONFIG_DIR}/memory/`) holding the saga journal. */
export const SAGA_JOURNAL_FILE = 'saga-journal.json';

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/** The A5 saga operations. `startupRecovery` is the driver, not a journaled op. */
export type SagaOperation =
  | 'createConnection'
  | 'updateConnectionConfig'
  | 'deleteConnection'
  | 'setApiKey'
  | 'replaceApiKey'
  | 'clearApiKey'
  | 'setCredentialMode'
  | 'migrateLegacyUppercaseCredentials';

/** The three durable side-effect barriers a saga may cross, in journaled form. */
export type SagaBarrierKind = 'stage' | 'config' | 'credential';

/**
 * Write-ahead status. `<barrier>:doing` is written *before* the barrier's effect,
 * `<barrier>:done` *after*. Terminal: completed / rolled_back / quarantined.
 */
export type SagaStatus =
  | 'prepared'
  | 'stage:doing' | 'stage:done'
  | 'config:doing' | 'config:done'
  | 'credential:doing' | 'credential:done'
  | 'completed'
  | 'rolled_back'
  | 'quarantined';

/** Which encrypted staging slots hold secret material for a saga. */
export type SagaStageSlot = 'before' | 'after';

/** One planned legacy→canonical credential move (ids only — never secret values). */
export interface SagaMigrationMove {
  /** Raw legacy account string (contains only a type + UUID, no secret). */
  legacyAccount: string;
  /** Canonical target connection id (lowercase UUID). */
  connectionId: string;
}

/** Config patch fields (the only mutable connection config fields). */
export interface MemoryConfigPatch {
  name?: string;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
}

/** Secret-free preconditions / intended-state record for a saga. */
export interface SagaPreconditions {
  /** Expected root revision guarding a connection create/delete. */
  rootRevision?: number;
  /** Expected per-connection revision before this saga's config barrier. */
  connectionRevision?: number;
  /** credentialMode before the saga (for rollback). */
  credentialModeBefore?: MemoryCredentialMode;
  /** Intended credentialMode after the config barrier. */
  credentialModeAfter?: MemoryCredentialMode;
  /** Config field values before an update (for rollback + inspection). */
  configBefore?: MemoryConfigPatch;
  /** Config field values the update intends. */
  configAfter?: MemoryConfigPatch;
  /** Validated create input for crash-safe create replay (config carries no secrets). */
  createInput?: CreateMemoryConnectionInput;
  /** Whether an API key existed before the saga (disambiguates credential rollback). */
  hadKeyBefore?: boolean;
  /**
   * The API-key operation an update requested. Journaled so recovery rebuilds the
   * exact barrier plan without the (in-memory, non-recoverable) new secret value.
   */
  keyOp?: 'set' | 'clear';
  /** Planned legacy→canonical moves for migration (ids/accounts only). */
  migrationMoves?: SagaMigrationMove[];
}

/** A single journaled saga. Contains no secret material. */
export interface SagaJournalEntry {
  sagaId: string;
  operation: SagaOperation;
  idempotencyKey: string;
  actor: string;
  attempt: number;
  status: SagaStatus;
  connectionId?: string;
  preconditions: SagaPreconditions;
  stagedSlots: SagaStageSlot[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SagaJournalDocument {
  version: typeof SAGA_JOURNAL_VERSION;
  entries: SagaJournalEntry[];
}

export interface SagaJournalStoreOptions {
  /** Directory holding the journal file (the memory config dir). */
  dir: string;
  /** Full path of the journal file. */
  filePath: string;
}

const VALID_OPERATIONS: ReadonlySet<string> = new Set<SagaOperation>([
  'createConnection',
  'updateConnectionConfig',
  'deleteConnection',
  'setApiKey',
  'replaceApiKey',
  'clearApiKey',
  'setCredentialMode',
  'migrateLegacyUppercaseCredentials',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<SagaStatus>([
  'prepared',
  'stage:doing', 'stage:done',
  'config:doing', 'config:done',
  'credential:doing', 'credential:done',
  'completed',
  'rolled_back',
  'quarantined',
]);

const VALID_CREDENTIAL_MODES: ReadonlySet<string> = new Set<MemoryCredentialMode>(['none', 'stored-api-key', 'legacy-environment']);

// Strict field whitelists — any key outside these fails validation closed.
const ROOT_KEYS: ReadonlySet<string> = new Set(['version', 'entries']);
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'sagaId', 'operation', 'idempotencyKey', 'actor', 'attempt', 'status',
  'connectionId', 'preconditions', 'stagedSlots', 'createdAtMs', 'updatedAtMs',
]);
const PRECONDITION_KEYS: ReadonlySet<string> = new Set([
  'rootRevision', 'connectionRevision', 'credentialModeBefore', 'credentialModeAfter',
  'configBefore', 'configAfter', 'createInput', 'hadKeyBefore', 'keyOp', 'migrationMoves',
]);
const CONFIG_PATCH_KEYS: ReadonlySet<string> = new Set(['name', 'enabled', 'proactiveRemoteSearch']);
const CREATE_INPUT_KEYS: ReadonlySet<string> = new Set(['name', 'url', 'collection', 'embedding', 'enabled', 'proactiveRemoteSearch']);
const EMBEDDING_KEYS: ReadonlySet<string> = new Set(['model', 'dimension']);
const MIGRATION_MOVE_KEYS: ReadonlySet<string> = new Set(['legacyAccount', 'connectionId']);

/**
 * Durable saga journal backed by `saga-journal.json` (+ `.bak`).
 *
 * Reads always reflect on-disk state. Writes are crash-atomic. Callers MUST hold
 * the saga lease across any read-modify-write cycle.
 */
export class SagaJournalStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly backupPath: string;

  constructor(options: SagaJournalStoreOptions) {
    this.dir = options.dir;
    this.filePath = options.filePath;
    this.backupPath = `${this.filePath}.bak`;
  }

  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Load the journal. Missing primary + backup → fresh empty journal. A present
   * but unreadable/corrupt primary recovers from backup; if both are bad, fail
   * closed. Unknown/future version or any schema violation fails closed.
   */
  load(): SagaJournalDocument {
    const primary = this.tryRead(this.filePath);
    if (primary.status === 'ok') return primary.document;
    const backup = this.tryRead(this.backupPath);
    if (backup.status === 'ok') return backup.document;
    if (primary.status === 'missing' && backup.status === 'missing') {
      return { version: SAGA_JOURNAL_VERSION, entries: [] };
    }
    throw new MemoryError(
      'invalid_config',
      `saga journal is unreadable or corrupt (primary: ${describe(primary)}, backup: ${describe(backup)}); refusing to reset`,
      { primary: describe(primary), backup: describe(backup) },
    );
  }

  listEntries(): SagaJournalEntry[] {
    return this.load().entries;
  }

  getEntry(sagaId: string): SagaJournalEntry | null {
    return this.load().entries.find(e => e.sagaId === sagaId) ?? null;
  }

  /** Insert or replace an entry (matched by `sagaId`) and persist atomically. */
  upsert(entry: SagaJournalEntry): void {
    assertSecretFree(entry);
    const doc = this.load();
    const next = doc.entries.filter(e => e.sagaId !== entry.sagaId);
    next.push(entry);
    this.persist({ version: SAGA_JOURNAL_VERSION, entries: next });
  }

  /** Remove an entry by `sagaId` and persist atomically. Missing id is a no-op. */
  remove(sagaId: string): void {
    const doc = this.load();
    const next = doc.entries.filter(e => e.sagaId !== sagaId);
    if (next.length === doc.entries.length) return;
    this.persist({ version: SAGA_JOURNAL_VERSION, entries: next });
  }

  private persist(doc: SagaJournalDocument): void {
    const current = this.tryRead(this.filePath);
    if (current.status === 'ok') {
      atomicWriteSecure(this.dir, this.backupPath, serialize(current.document));
    }
    atomicWriteSecure(this.dir, this.filePath, serialize(doc));
  }

  private tryRead(path: string): ReadOutcome {
    const read = readTextFileBounded(path, MAX_JOURNAL_BYTES);
    if (read.status === 'missing') return { status: 'missing' };
    if (read.status === 'error') return { status: 'error', reason: read.message };

    let parsed: unknown;
    try {
      parsed = safeJsonParse(read.text);
    } catch {
      return { status: 'error', reason: 'invalid JSON' };
    }
    const validated = validateDocument(parsed);
    if (!validated.valid) return { status: 'error', reason: validated.error };
    return { status: 'ok', document: validated.document };
  }
}

type ReadOutcome =
  | { status: 'ok'; document: SagaJournalDocument }
  | { status: 'missing' }
  | { status: 'error'; reason: string };

function describe(outcome: ReadOutcome): string {
  return outcome.status === 'error' ? outcome.reason : outcome.status;
}

function serialize(doc: SagaJournalDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True iff `value` is an object whose keys are all within `allowed`. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function validateDocument(parsed: unknown): { valid: true; document: SagaJournalDocument } | { valid: false; error: string } {
  if (!isPlainObject(parsed)) return { valid: false, error: 'journal is not an object' };
  if (!hasOnlyKeys(parsed, ROOT_KEYS)) return { valid: false, error: 'journal has unknown root field(s)' };
  if (parsed.version !== SAGA_JOURNAL_VERSION) {
    return { valid: false, error: `unsupported journal version: ${String(parsed.version)}` };
  }
  if (!Array.isArray(parsed.entries)) return { valid: false, error: 'entries is not an array' };

  const entries: SagaJournalEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.entries) {
    const validated = validateEntry(raw);
    if (!validated.valid) return { valid: false, error: validated.error };
    if (seen.has(validated.entry.sagaId)) {
      return { valid: false, error: `duplicate sagaId: ${validated.entry.sagaId}` };
    }
    seen.add(validated.entry.sagaId);
    entries.push(validated.entry);
  }
  return { valid: true, document: { version: SAGA_JOURNAL_VERSION, entries } };
}

function validateEntry(raw: unknown): { valid: true; entry: SagaJournalEntry } | { valid: false; error: string } {
  if (!isPlainObject(raw)) return { valid: false, error: 'entry is not an object' };
  if (!hasOnlyKeys(raw, ENTRY_KEYS)) return { valid: false, error: 'entry has unknown field(s)' };
  if (!isCanonicalUuid(raw.sagaId)) return { valid: false, error: 'entry.sagaId is not a canonical UUID' };
  if (typeof raw.operation !== 'string' || !VALID_OPERATIONS.has(raw.operation)) {
    return { valid: false, error: `entry.operation is invalid: ${String(raw.operation)}` };
  }
  if (typeof raw.status !== 'string' || !VALID_STATUSES.has(raw.status)) {
    return { valid: false, error: `entry.status is invalid: ${String(raw.status)}` };
  }
  if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length === 0) {
    return { valid: false, error: 'entry.idempotencyKey is required' };
  }
  if (typeof raw.actor !== 'string') return { valid: false, error: 'entry.actor is required' };
  if (typeof raw.attempt !== 'number' || !Number.isInteger(raw.attempt) || raw.attempt < 1) {
    return { valid: false, error: 'entry.attempt must be a positive integer' };
  }
  if (!Array.isArray(raw.stagedSlots) || !raw.stagedSlots.every(s => s === 'before' || s === 'after')) {
    return { valid: false, error: 'entry.stagedSlots is invalid' };
  }
  if (typeof raw.createdAtMs !== 'number' || typeof raw.updatedAtMs !== 'number') {
    return { valid: false, error: 'entry timestamps are required' };
  }
  if (raw.connectionId !== undefined && !isCanonicalUuid(raw.connectionId)) {
    return { valid: false, error: 'entry.connectionId is not a canonical UUID' };
  }
  const pre = validatePreconditions(raw.preconditions);
  if (!pre.valid) return { valid: false, error: pre.error };
  return { valid: true, entry: raw as unknown as SagaJournalEntry };
}

function validatePreconditions(raw: unknown): { valid: true } | { valid: false; error: string } {
  if (!isPlainObject(raw)) return { valid: false, error: 'entry.preconditions is not an object' };
  if (!hasOnlyKeys(raw, PRECONDITION_KEYS)) return { valid: false, error: 'preconditions has unknown field(s)' };

  if (raw.rootRevision !== undefined && !isFiniteNumber(raw.rootRevision)) return numErr('rootRevision');
  if (raw.connectionRevision !== undefined && !isFiniteNumber(raw.connectionRevision)) return numErr('connectionRevision');
  if (raw.hadKeyBefore !== undefined && typeof raw.hadKeyBefore !== 'boolean') return { valid: false, error: 'preconditions.hadKeyBefore must be boolean' };
  if (raw.keyOp !== undefined && raw.keyOp !== 'set' && raw.keyOp !== 'clear') return { valid: false, error: 'preconditions.keyOp is invalid' };
  for (const key of ['credentialModeBefore', 'credentialModeAfter'] as const) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== 'string' || !VALID_CREDENTIAL_MODES.has(v))) {
      return { valid: false, error: `preconditions.${key} is invalid` };
    }
  }
  for (const key of ['configBefore', 'configAfter'] as const) {
    const v = raw[key];
    if (v !== undefined && !validConfigPatch(v)) return { valid: false, error: `preconditions.${key} is invalid` };
  }
  if (raw.createInput !== undefined && !validCreateInput(raw.createInput)) {
    return { valid: false, error: 'preconditions.createInput is invalid' };
  }
  if (raw.migrationMoves !== undefined && !validMigrationMoves(raw.migrationMoves)) {
    return { valid: false, error: 'preconditions.migrationMoves is invalid' };
  }
  return { valid: true };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function numErr(field: string): { valid: false; error: string } {
  return { valid: false, error: `preconditions.${field} must be a finite number` };
}

function validConfigPatch(v: unknown): boolean {
  if (!isPlainObject(v) || !hasOnlyKeys(v, CONFIG_PATCH_KEYS)) return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  if (v.proactiveRemoteSearch !== undefined && typeof v.proactiveRemoteSearch !== 'boolean') return false;
  return true;
}

function validCreateInput(v: unknown): boolean {
  if (!isPlainObject(v) || !hasOnlyKeys(v, CREATE_INPUT_KEYS)) return false;
  if (typeof v.name !== 'string' || typeof v.url !== 'string' || typeof v.collection !== 'string') return false;
  if (!isPlainObject(v.embedding) || !hasOnlyKeys(v.embedding, EMBEDDING_KEYS)) return false;
  if (typeof v.embedding.model !== 'string' || !isFiniteNumber(v.embedding.dimension)) return false;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  if (v.proactiveRemoteSearch !== undefined && typeof v.proactiveRemoteSearch !== 'boolean') return false;
  return true;
}

function validMigrationMoves(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every(m => isPlainObject(m) && hasOnlyKeys(m, MIGRATION_MOVE_KEYS)
    && typeof m.legacyAccount === 'string' && isCanonicalUuid(m.connectionId));
}

/**
 * Defense-in-depth: reject a journal entry that structurally could not be
 * secret-free. Secrets never have a home in `SagaJournalEntry`, so this guards
 * against a future field being added without thought.
 */
function assertSecretFree(entry: SagaJournalEntry): void {
  const forbidden = ['apikey', 'secret', 'value', 'token', 'password', 'credential'];
  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, v] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (forbidden.some(f => lower === f || lower.endsWith(f))) {
          throw new MemoryError('storage_error', `refusing to journal a potentially secret field: ${path}.${key}`);
        }
        walk(v, `${path}.${key}`);
      }
    }
  };
  walk(entry.preconditions, 'preconditions');
}
