/**
 * CONFIG_DIR-backed repository for Memory connections and their spaces.
 *
 * Storage: `${CONFIG_DIR}/memory/connections.json` (+ `.bak` backup).
 *
 * Guarantees:
 * - **Process-local mutation queue + cross-process file lock** for serialized
 *   writes. Writes are fenced by an exclusive sentinel file lock and an
 *   in-process promise chain.
 * - **Durable, symlink-safe atomic writes** — data is written to a unique,
 *   same-dir exclusive (`O_EXCL`) `0600` temp file, `fsync`ed, then renamed
 *   directly over the target (no unlink gap); the directory is `fsync`ed where
 *   supported. Symlinked primary/backup/temp targets are refused, never
 *   followed.
 * - **No silent data loss** — a missing config is a fresh/empty config, but a
 *   *present-but-unreadable/corrupt* primary AND backup surface an explicit
 *   `invalid_config` error rather than silently resetting to empty. A corrupt
 *   primary with a good backup recovers from the backup.
 * - **Fail-closed on bad reads and malformed state** — bounded file reads,
 *   explicit EACCES/EPERM failures, and parse/schema failures are surfaced.
 * - **Restrictive permissions** — dir `0o700`, files `0o600`; existing dir/files
 *   are repaired toward those modes where POSIX-supported.
 * - **Root + per-connection revisions** — the root `revision` bumps on every
 *   committed mutation (connection create/delete guard on it); each connection
 *   also keeps a fine-grained `revision` (update / space mutations guard on it).
 * - **Explicit CRUD** — no whole-config replacement API is exposed.
 * - **No secrets** — API keys are never read or written here.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { getConfigDir } from '../../config/paths.ts';
import { safeJsonParse } from '../../utils/files.ts';
import { randomUuid } from '../../utils/uuid.ts';
import { isCanonicalUuid } from '../../utils/uuid-format.ts';
import { deriveGlobalSpace, deriveGlobalSpaceId } from './global-space.ts';
import { MEMORY_LIMITS } from './limits.ts';
import {
  MEMORY_CONNECTIONS_CONFIG_VERSION,
  MEMORY_CONNECTIONS_FILE,
  MEMORY_GLOBAL_SPACE_NAME,
  MemoryError,
  type CreateMemoryConnectionInput,
  type CreateMemorySpaceInput,
  type MemoryConnectionConfig,
  type MemoryConnectionsConfig,
  type MemorySpaceConfig,
  type StoredMemorySpaceConfig,
  type UpdateMemoryConnectionInput,
  type UpdateMemorySpaceInput,
  type MemoryCredentialMode,
} from './types.ts';
import {
  normalizeNameKey,
  sortConnections,
  sortStoredSpaces,
  validateCreateMemoryConnectionInput,
  validateCreateMemorySpaceInput,
  validateMemoryConnectionsConfig,
  validateUpdateMemoryConnectionInput,
  validateUpdateMemorySpaceInput,
} from './validation.ts';

// Re-export the Global-space derivation so existing importers keep working.
export { deriveGlobalSpace, deriveGlobalSpaceId } from './global-space.ts';

/** Upper bound on the config file size we will read (bounded reads). */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
/** Upper bound for lock metadata, tiny and deterministic. */
const MAX_LOCK_METADATA_BYTES = 4 * 1024;
const MUTATION_LOCK_TIMEOUT_MS = 3_000;
const MUTATION_LOCK_INITIAL_BACKOFF_MS = 8;
const MUTATION_LOCK_MAX_BACKOFF_MS = 128;
const MUTATION_LOCK_STALE_MS = 10_000;

export interface MemoryConnectionRepositoryOptions {
  /** Root config dir (defaults to CONFIG_DIR). Overridable for tests. */
  configDir?: string;
  /** Clock, overridable for tests. */
  now?: () => number;
}

/** Optional overrides for connection creation behavior. */
export interface CreateMemoryConnectionOptions {
  /** Credential strategy for the new connection. */
  credentialMode?: MemoryCredentialMode;
  /**
   * Pre-generated canonical connection id. Used by the A5 saga so the id is
   * journaled *before* the connection is created, making create crash-recoverable.
   * Must be a canonical (lowercase) UUID and not already in use.
   */
  connectionId?: string;
}

/** Result of a space create/update mutation. */
export interface MemorySpaceMutationResult {
  connection: MemoryConnectionConfig;
  space: StoredMemorySpaceConfig;
}

type ReadResult =
  | { status: 'ok'; config: MemoryConnectionsConfig }
  | { status: 'missing' }
  | { status: 'error'; reason: string; code?: string };

type FileReadResult =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'error'; reason: string; code?: string };

interface MutationLockMetadata {
  token: string;
  pid: number;
  createdAtMs: number;
}

export class MemoryConnectionRepository {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly lockOwnerToken: string;
  private mutationChain: Promise<unknown> = Promise.resolve();
  /** Stable ephemeral installationId for a fresh (unwritten) config on this instance. */
  private pendingInstallationId: string | null = null;

  constructor(options: MemoryConnectionRepositoryOptions = {}) {
    this.dir = join(options.configDir ?? getConfigDir(), 'memory');
    this.filePath = join(this.dir, MEMORY_CONNECTIONS_FILE);
    this.backupPath = `${this.filePath}.bak`;
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? (() => Date.now());
    this.lockOwnerToken = randomUuid();
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** The `${CONFIG_DIR}/memory` directory holding all memory artifacts. */
  getDir(): string {
    return this.dir;
  }

  getBackupPath(): string {
    return this.backupPath;
  }

  // -------------------------------------------------------------------------
  // Reads (synchronous, always reflect on-disk state)
  // -------------------------------------------------------------------------

  /**
   * Load the validated, canonical config. Recovers a corrupt primary from the
   * backup. Throws `invalid_config` if a present config is unreadable/corrupt
   * (both primary and backup) — it NEVER silently resets to empty.
   */
  load(): MemoryConnectionsConfig {
    const primary = this.tryReadConfig(this.filePath);
    if (primary.status === 'ok') return primary.config;
    const backup = this.tryReadConfig(this.backupPath);
    if (backup.status === 'ok') return backup.config;
    if (primary.status === 'missing' && backup.status === 'missing') {
      return this.freshEmptyConfig();
    }
    throw new MemoryError(
      'invalid_config',
      `memory connections config is unreadable or corrupt (primary: ${describe(primary)}, backup: ${describe(backup)}); refusing to reset`,
      { primary: describe(primary), backup: describe(backup) },
    );
  }

  getRootRevision(): number {
    return this.load().revision;
  }

  getInstallationId(): string {
    return this.load().installationId;
  }

  /** Ensure the installationId is generated and persisted (stable across restarts). */
  ensureInstallationId(): Promise<string> {
    return this.runExclusive(async () => {
      const existed = existsSync(this.filePath);
      const config = this.load();
      if (!existed) this.persist(config);
      return config.installationId;
    });
  }

  listConnections(): MemoryConnectionConfig[] {
    return this.load().connections;
  }

  getConnection(connectionId: string): MemoryConnectionConfig | null {
    return this.load().connections.find(c => c.connectionId === connectionId) ?? null;
  }

  /** Spaces for a connection, with the derived Read-only Global space first. */
  listSpaces(connectionId: string): MemorySpaceConfig[] {
    const connection = this.requireConnection(this.load(), connectionId);
    return [deriveGlobalSpace(connection), ...connection.spaces];
  }

  getSpace(connectionId: string, spaceId: string): MemorySpaceConfig | null {
    const connection = this.getConnection(connectionId);
    if (!connection) return null;
    const global = deriveGlobalSpace(connection);
    if (global.spaceId === spaceId) return global;
    return connection.spaces.find(s => s.spaceId === spaceId) ?? null;
  }

  /** Deterministic id of a connection's derived Global space. */
  getGlobalSpaceId(connectionId: string): string {
    return deriveGlobalSpaceId(connectionId);
  }

  private freshEmptyConfig(): MemoryConnectionsConfig {
    this.pendingInstallationId ??= randomUuid();
    return { version: MEMORY_CONNECTIONS_CONFIG_VERSION, revision: 0, installationId: this.pendingInstallationId, connections: [] };
  }

  private tryReadConfig(path: string): ReadResult {
    const read = this.readTextFile(path, MAX_CONFIG_BYTES);
    if (read.status === 'missing') return read;
    if (read.status === 'error') return { status: 'error', reason: read.reason, code: read.code };

    let parsed: unknown;
    try {
      parsed = safeJsonParse(read.text);
    } catch {
      return { status: 'error', reason: 'invalid JSON' };
    }

    const result = validateMemoryConnectionsConfig(parsed, { deriveGlobalSpaceId });
    if (!result.valid) return { status: 'error', reason: `invalid schema: ${result.errors[0] ?? 'unknown'}` };
    return { status: 'ok', config: result.config };
  }

  private readTextFile(path: string, maxBytes: number): FileReadResult {
    this.assertNoSymlinkOnPath(path);

    let fd: number | undefined;
    let pathSize = 0;

    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        return { status: 'error', reason: 'target is a symlink' };
      }
      if (!stat.isFile()) {
        return { status: 'error', reason: 'target is not a regular file' };
      }
      if (stat.size > maxBytes) {
        return { status: 'error', reason: 'file exceeds size limit', code: 'EFBIG' };
      }

      fd = openSync(path, 'r');
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) {
        return { status: 'error', reason: 'opened file is not a regular file' };
      }

      pathSize = fileStat.size;
      if (pathSize > maxBytes) {
        return { status: 'error', reason: 'file exceeds size limit', code: 'EFBIG' };
      }

      const readBudget = Math.min(pathSize, maxBytes + 1);
      const buffer = Buffer.alloc(readBudget);
      const bytesRead = readSync(fd, buffer, 0, readBudget, 0);
      const currentStat = fstatSync(fd);

      if (currentStat.size !== pathSize || bytesRead !== pathSize) {
        return { status: 'error', reason: 'file changed while reading' };
      }
      if (currentStat.size > maxBytes || bytesRead > maxBytes) {
        return { status: 'error', reason: 'file exceeds size limit', code: 'EFBIG' };
      }

      return { status: 'ok', text: buffer.toString('utf8', 0, bytesRead) };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
        fd = undefined;
      }

      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'missing' };
      if (code === 'EACCES' || code === 'EPERM') {
        return { status: 'error', reason: `read failed: ${code ?? 'unknown'}`, code };
      }
      return { status: 'error', reason: `read failed: ${code ?? 'unknown'}`, code };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection CRUD (serialized). Create/delete guard on the ROOT revision.
  // -------------------------------------------------------------------------

  createConnection(
    input: CreateMemoryConnectionInput,
    expectedRootRevision: number,
    options?: CreateMemoryConnectionOptions,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(async () => {
      const validation = validateCreateMemoryConnectionInput(input);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const requestedMode = options?.credentialMode;
      const credentialMode: MemoryCredentialMode = requestedMode === 'stored-api-key' || requestedMode === 'none'
        ? requestedMode
        : 'none';
      if (requestedMode !== undefined && requestedMode !== credentialMode) {
        throw new MemoryError('invalid_input', `invalid credential mode: ${requestedMode}`);
      }
      const config = this.load();
      assertRootRevision(config, expectedRootRevision);
      if (config.connections.length >= MEMORY_LIMITS.MAX_CONNECTIONS) {
        throw new MemoryError('limit_exceeded', `at most ${MEMORY_LIMITS.MAX_CONNECTIONS} connections are allowed`);
      }
      assertConnectionNameAvailable(config, value.name);

      let connectionId = options?.connectionId;
      if (connectionId !== undefined) {
        if (!isCanonicalUuid(connectionId)) {
          throw new MemoryError('invalid_input', `pre-generated connection id is not a canonical UUID: ${connectionId}`);
        }
        if (config.connections.some(c => c.connectionId === connectionId)) {
          throw new MemoryError('duplicate_name', `connection already exists: ${connectionId}`);
        }
      } else {
        connectionId = randomUuid();
      }

      const timestamp = this.now();
      const connection: MemoryConnectionConfig = {
        connectionId,
        revision: 1,
        provider: 'qdrant',
        url: value.url,
        collection: value.collection,
        embedding: value.embedding,
        credentialMode,
        name: value.name,
        enabled: value.enabled ?? true,
        proactiveRemoteSearch: value.proactiveRemoteSearch ?? false,
        spaces: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      config.connections.push(connection);
      config.revision += 1;
      this.persist(config);
      return connection;
    });
  }

  updateConnection(
    connectionId: string,
    patch: UpdateMemoryConnectionInput,
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const validation = validateUpdateMemoryConnectionInput(patch);
      if (!validation.valid || !validation.value) {
        const immutable = validation.errors.some(e => e.includes('immutable'));
        throw new MemoryError(immutable ? 'immutable_field' : 'invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);

      const nameChanges = value.name !== undefined && value.name !== connection.name;
      const enabledChanges = value.enabled !== undefined && value.enabled !== connection.enabled;
      const proactiveChanges = value.proactiveRemoteSearch !== undefined && value.proactiveRemoteSearch !== connection.proactiveRemoteSearch;

      // Canonical no-op patch: nothing actually changes → no revision/timestamp
      // bump and no write.
      if (!nameChanges && !enabledChanges && !proactiveChanges) {
        return connection;
      }

      if (nameChanges) {
        if (normalizeNameKey(value.name!) !== normalizeNameKey(connection.name)) {
          assertConnectionNameAvailable(config, value.name!, connectionId);
        }
        connection.name = value.name!;
      }
      if (enabledChanges) connection.enabled = value.enabled!;
      if (proactiveChanges) connection.proactiveRemoteSearch = value.proactiveRemoteSearch!;
      connection.revision += 1;
      connection.updatedAt = this.now();
      config.revision += 1;

      this.persist(config);
      return connection;
    });
  }

  deleteConnection(connectionId: string, expectedRootRevision: number): Promise<void> {
    return this.runExclusive(() => {
      const config = this.load();
      assertRootRevision(config, expectedRootRevision);
      this.requireConnection(config, connectionId);
      config.connections = config.connections.filter(c => c.connectionId !== connectionId);
      config.revision += 1;
      this.persist(config);
    });
  }

  /**
   * Set a stored connection's `credentialMode` (config-side of credential-mode
   * convergence). Guards on the per-connection revision. `legacy-environment` is
   * rejected — it is valid only on the synthetic environment connection, never a
   * stored one. A no-op change neither bumps nor writes.
   *
   * This is a config-only mutation owned by the A5 saga; it never touches secrets.
   */
  setConnectionCredentialMode(
    connectionId: string,
    mode: MemoryCredentialMode,
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      if (mode !== 'none' && mode !== 'stored-api-key') {
        throw new MemoryError('invalid_input', `invalid credential mode for a stored connection: ${mode}`);
      }
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (connection.credentialMode === mode) {
        return connection;
      }
      connection.credentialMode = mode;
      connection.revision += 1;
      connection.updatedAt = this.now();
      config.revision += 1;
      this.persist(config);
      return connection;
    });
  }

  /**
   * Apply mutable config fields (`name`/`enabled`/`proactiveRemoteSearch`) and/or
   * `credentialMode` to a stored connection in ONE atomic, revision-guarded write.
   *
   * The A5 saga uses this as its single durable "config barrier" so that a
   * field+mode change is one crash-atomic step (never two half-committed writes).
   * A no-op (nothing actually changes) neither bumps the revision nor writes.
   * `legacy-environment` mode is rejected on a stored connection.
   */
  applyConnectionConfig(
    connectionId: string,
    change: { patch?: UpdateMemoryConnectionInput; credentialMode?: MemoryCredentialMode },
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const patch = change.patch ?? {};
      const validation = validateUpdateMemoryConnectionInput(patch);
      if (!validation.valid || !validation.value) {
        const immutable = validation.errors.some(e => e.includes('immutable'));
        throw new MemoryError(immutable ? 'immutable_field' : 'invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      if (change.credentialMode !== undefined && change.credentialMode !== 'none' && change.credentialMode !== 'stored-api-key') {
        throw new MemoryError('invalid_input', `invalid credential mode for a stored connection: ${change.credentialMode}`);
      }
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);

      const nameChanges = value.name !== undefined && value.name !== connection.name;
      const enabledChanges = value.enabled !== undefined && value.enabled !== connection.enabled;
      const proactiveChanges = value.proactiveRemoteSearch !== undefined && value.proactiveRemoteSearch !== connection.proactiveRemoteSearch;
      const modeChanges = change.credentialMode !== undefined && change.credentialMode !== connection.credentialMode;

      if (!nameChanges && !enabledChanges && !proactiveChanges && !modeChanges) {
        return connection;
      }
      if (nameChanges) {
        if (normalizeNameKey(value.name!) !== normalizeNameKey(connection.name)) {
          assertConnectionNameAvailable(config, value.name!, connectionId);
        }
        connection.name = value.name!;
      }
      if (enabledChanges) connection.enabled = value.enabled!;
      if (proactiveChanges) connection.proactiveRemoteSearch = value.proactiveRemoteSearch!;
      if (modeChanges) connection.credentialMode = change.credentialMode!;
      connection.revision += 1;
      connection.updatedAt = this.now();
      config.revision += 1;
      this.persist(config);
      return connection;
    });
  }

  // -------------------------------------------------------------------------
  // Space CRUD (serialized; bumps parent connection + root revision)
  // -------------------------------------------------------------------------

  addSpace(
    connectionId: string,
    input: CreateMemorySpaceInput,
    expectedRevision: number,
  ): Promise<MemorySpaceMutationResult> {
    return this.runExclusive(() => {
      const validation = validateCreateMemorySpaceInput(input);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (connection.spaces.length >= MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION) {
        throw new MemoryError('limit_exceeded', `a connection may have at most ${MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION} spaces`);
      }
      assertSpaceNameAvailable(connection, value.name);

      const timestamp = this.now();
      const writable = value.writable ?? true;
      const base = {
        spaceId: randomUuid(),
        name: value.name,
        writable,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(value.instructions !== undefined ? { instructions: value.instructions } : {}),
      };
      const space: StoredMemorySpaceConfig = value.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: value.workspaceId, ...base }
        : value.kind === 'project'
          ? { kind: 'project', workspaceId: value.workspaceId, projectId: value.projectId, ...base }
          : {
            kind: 'custom',
            ...(value.workspaceId !== undefined ? { workspaceId: value.workspaceId } : {}),
            ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
            ...base,
          };

      connection.spaces = sortStoredSpaces([...connection.spaces, space]);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      config.revision += 1;
      this.persist(config);
      return { connection, space };
    });
  }

  updateSpace(
    connectionId: string,
    spaceId: string,
    patch: UpdateMemorySpaceInput,
    expectedRevision: number,
  ): Promise<MemorySpaceMutationResult> {
    return this.runExclusive(() => {
      const validation = validateUpdateMemorySpaceInput(patch);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (spaceId === deriveGlobalSpaceId(connectionId)) {
        throw new MemoryError('read_only', 'the derived Global space is read-only');
      }
      const space = connection.spaces.find(s => s.spaceId === spaceId);
      if (!space) throw new MemoryError('space_not_found', `space not found: ${spaceId}`);

      const nameChanges = value.name !== undefined && value.name !== space.name;
      const instructionsChanges = value.instructions !== undefined
        && (value.instructions === null ? space.instructions !== undefined : value.instructions !== space.instructions);
      const writableChanges = value.writable !== undefined && value.writable !== space.writable;

      // Canonical no-op patch: no revision/timestamp bump, no write.
      if (!nameChanges && !instructionsChanges && !writableChanges) {
        return { connection, space };
      }

      if (nameChanges && normalizeNameKey(value.name!) !== normalizeNameKey(space.name)) {
        assertSpaceNameAvailable(connection, value.name!, spaceId);
      }
      const timestamp = this.now();
      if (nameChanges) space.name = value.name!;
      if (instructionsChanges) {
        if (value.instructions === null) delete space.instructions;
        else space.instructions = value.instructions;
      }
      if (writableChanges) space.writable = value.writable!;
      space.updatedAt = timestamp;

      connection.spaces = sortStoredSpaces(connection.spaces);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      config.revision += 1;
      this.persist(config);
      return { connection, space };
    });
  }

  deleteSpace(
    connectionId: string,
    spaceId: string,
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (spaceId === deriveGlobalSpaceId(connectionId)) {
        throw new MemoryError('read_only', 'the derived Global space is read-only');
      }
      const before = connection.spaces.length;
      connection.spaces = connection.spaces.filter(s => s.spaceId !== spaceId);
      if (connection.spaces.length === before) {
        throw new MemoryError('space_not_found', `space not found: ${spaceId}`);
      }
      connection.revision += 1;
      connection.updatedAt = this.now();
      config.revision += 1;
      this.persist(config);
      return connection;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireConnection(config: MemoryConnectionsConfig, connectionId: string): MemoryConnectionConfig {
    const connection = config.connections.find(c => c.connectionId === connectionId);
    if (!connection) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
    return connection;
  }

  /** Serialize mutations in-process and across processes (lock + chain). */
  private runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.mutationChain.then(() => this.withMutationLock(fn));
    // Keep the chain alive even if a mutation rejects.
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const releaseLock = await this.acquireMutationLock();
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  private async acquireMutationLock(): Promise<() => void> {
    const timeoutAt = Date.now() + MUTATION_LOCK_TIMEOUT_MS;
    let backoffMs = MUTATION_LOCK_INITIAL_BACKOFF_MS;

    while (true) {
      this.ensureDirSecure();
      const token = `${this.lockOwnerToken}-${Date.now()}-${randomUuid()}`;

      try {
        return this.createLockFile(token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          const code = (error as NodeJS.ErrnoException).code;
          throw new MemoryError('storage_error', `failed to acquire memory connection mutation lock: ${code ?? 'unknown'}`, { code, path: this.lockPath });
        }

        if (this.tryStealStaleLock()) {
          continue;
        }

        if (Date.now() >= timeoutAt) {
          throw new MemoryError('storage_error', 'timed out while waiting for memory connection mutation lock', { lockPath: this.lockPath });
        }
        await this.sleep(backoffMs);
        backoffMs = Math.min(MUTATION_LOCK_MAX_BACKOFF_MS, backoffMs * 2);
      }
    }
  }

  private createLockFile(token: string): () => void {
    this.assertNoSymlinkOnPath(this.lockPath);

    const metadata: MutationLockMetadata = {
      token,
      pid: process.pid,
      createdAtMs: Date.now(),
    };

    const payload = JSON.stringify(metadata);

    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, 'wx', 0o600);
      writeSync(fd, payload);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.repairFileMode(this.lockPath);
      return () => this.releaseMutationLock(token);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
        if (code !== 'EEXIST') {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
        }
      }
      throw error;
    }
  }

  private tryStealStaleLock(): boolean {
    const metadata = this.readMutationLockMetadata();

    if (metadata) {
      const processAlive = isProcessAlive(metadata.pid);
      if (processAlive === undefined) {
        if (Date.now() - metadata.createdAtMs < MUTATION_LOCK_STALE_MS) {
          return false;
        }
      } else if (processAlive) {
        return false;
      }
    } else {
      try {
        const stat = statSync(this.lockPath);
        if (Date.now() - stat.mtimeMs < MUTATION_LOCK_STALE_MS) {
          return false;
        }
      } catch {
        return false;
      }
    }

    try {
      unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private readMutationLockMetadata(): MutationLockMetadata | null {
    const read = this.readTextFile(this.lockPath, MAX_LOCK_METADATA_BYTES);
    if (read.status !== 'ok') return null;

    try {
      const parsed = safeJsonParse(read.text);
      if (!isPlainObject(parsed)) return null;
      const raw = parsed as Record<string, unknown>;
      if (typeof raw.token !== 'string' || raw.token.length < 16) return null;
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
      if (typeof raw.createdAtMs !== 'number' || !Number.isFinite(raw.createdAtMs)) return null;
      return {
        token: raw.token,
        pid: raw.pid,
        createdAtMs: raw.createdAtMs,
      };
    } catch {
      return null;
    }
  }

  private releaseMutationLock(token: string): void {
    try {
      const metadata = this.readMutationLockMetadata();
      if (!metadata || metadata.token !== token) {
        return;
      }
      unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private persist(config: MemoryConnectionsConfig): void {
    this.ensureDirSecure();

    const current = this.tryReadConfig(this.filePath);
    if (current.status === 'error') {
      if (current.code === 'EACCES' || current.code === 'EPERM') {
        throw new MemoryError('storage_error', `memory connections config is not readable: ${current.reason}`, {
          path: this.filePath,
          code: current.code,
        });
      }
      if (current.reason === 'target is a symlink') {
        throw new MemoryError('invalid_config', 'cannot write through a symlinked config file', { path: this.filePath });
      }
      // If unreadable/corrupt, continue from loaded in-memory config and do not
      // promote a corrupt snapshot into backup.
    }

    if (current.status === 'ok') {
      this.atomicWriteSecure(this.backupPath, serialize(current.config));
      this.repairFileMode(this.backupPath);
    }

    const canonical: MemoryConnectionsConfig = {
      version: MEMORY_CONNECTIONS_CONFIG_VERSION,
      revision: config.revision,
      installationId: config.installationId,
      connections: sortConnections(config.connections.map(c => ({ ...c, spaces: sortStoredSpaces(c.spaces) }))),
    };

    this.atomicWriteSecure(this.filePath, serialize(canonical));
    this.repairFileMode(this.filePath);
  }

  private ensureDirSecure(): void {
    this.assertNoSymlinkOnPath(this.dir);
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } else if (process.platform !== 'win32') {
      try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    }
  }

  private assertNoSymlinkOnPath(path: string): void {
    const absolute = resolve(path);
    let cursor = absolute;

    while (true) {
      try {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          throw new MemoryError('invalid_config', `refusing to operate on symlink path: ${path}`);
        }
      } catch (error) {
        if (error instanceof MemoryError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new MemoryError('invalid_config', `cannot stat path ${path}: ${code ?? 'unknown'}`);
        }
      }

      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  private repairFileMode(path: string): void {
    if (process.platform === 'win32') return;
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  /**
   * Write `data` to `path` durably and symlink-safely: unique same-dir exclusive
   * `0600` temp → fsync → direct atomic rename over the target (no unlink gap) →
   * fsync dir (where supported).
   */
  private atomicWriteSecure(path: string, data: string): void {
    const tmp = join(this.dir, `.${basename(path)}.${randomUuid()}.tmp`);
    this.assertNoSymlinkOnPath(path);
    this.assertNoSymlinkOnPath(tmp);

    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600); // O_CREAT | O_EXCL | O_WRONLY, mode 0600
      writeSync(fd, data, null, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      try { unlinkSync(tmp); } catch { /* ignore */ }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new MemoryError('storage_error', `failed to write memory connections config: ${code}`, { path, code });
      }
      throw error;
    }
    this.fsyncDir();
  }

  private fsyncDir(): void {
    if (process.platform === 'win32') return; // directory fsync unsupported
    let dfd: number | undefined;
    try {
      dfd = openSync(this.dir, 'r');
      fsyncSync(dfd);
    } catch {
      // Best effort: some filesystems reject directory fsync.
    } finally {
      if (dfd !== undefined) { try { closeSync(dfd); } catch { /* ignore */ } }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function serialize(config: MemoryConnectionsConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function describe(result: ReadResult): string {
  return result.status === 'error' ? result.reason : result.status;
}

function assertRootRevision(config: MemoryConnectionsConfig, expectedRootRevision: number): void {
  if (config.revision !== expectedRootRevision) {
    throw new MemoryError(
      'revision_conflict',
      `root revision conflict: expected ${expectedRootRevision}, found ${config.revision}`,
      { expected: expectedRootRevision, actual: config.revision },
    );
  }
}

function assertRevision(connection: MemoryConnectionConfig, expectedRevision: number): void {
  if (connection.revision !== expectedRevision) {
    throw new MemoryError(
      'revision_conflict',
      `revision conflict: expected ${expectedRevision}, found ${connection.revision}`,
      { expected: expectedRevision, actual: connection.revision },
    );
  }
}

function assertConnectionNameAvailable(config: MemoryConnectionsConfig, name: string, exceptId?: string): void {
  const key = normalizeNameKey(name);
  const clash = config.connections.some(c => c.connectionId !== exceptId && normalizeNameKey(c.name) === key);
  if (clash) throw new MemoryError('duplicate_name', `a connection named "${name}" already exists`);
}

function assertSpaceNameAvailable(connection: MemoryConnectionConfig, name: string, exceptSpaceId?: string): void {
  const key = normalizeNameKey(name);
  if (key === normalizeNameKey(MEMORY_GLOBAL_SPACE_NAME)) {
    throw new MemoryError('duplicate_name', `"${MEMORY_GLOBAL_SPACE_NAME}" is reserved by the derived Global space`);
  }
  const clash = connection.spaces.some(s => s.spaceId !== exceptSpaceId && normalizeNameKey(s.name) === key);
  if (clash) throw new MemoryError('duplicate_name', `a space named "${name}" already exists in this connection`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}
