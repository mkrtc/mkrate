/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.craft-agent/credentials.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from 'crypto';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { hostname, homedir, userInfo } from 'os';
import { join, resolve } from 'path';

import type { CredentialBackend } from './types.ts';
import { accountToCredentialId, CredentialStoreError, type CredentialId, type CredentialStoreErrorCode, type StoredCredential } from '../types.ts';
import { credentialIdToAccount } from '../types.ts';

// File location
const DEFAULT_CREDENTIALS_DIR = resolve(homedir(), '.craft-agent');
const CREDENTIALS_FILE_NAME = 'credentials.enc';

export interface SecureStorageBackendOptions {
  /** Override the config dir root (defaults to $HOME/.craft-agent or CRAFT_CONFIG_DIR). */
  configDir?: string;
  /**
   * Allow constructing the backend against the implicit default config dir while in
   * test mode. This is blocked by default as a guard against destructive tests
   * touching a real user profile.
   */
  allowUnsafeDefaultPathInTests?: boolean;
}

function isDefaultConfigDir(path: string): boolean {
  return resolve(path) === DEFAULT_CREDENTIALS_DIR;
}

function resolveCredentialsConfigDir(explicitConfigDir?: string): string {
  const envConfigDir = process.env.CRAFT_CONFIG_DIR;
  return explicitConfigDir ?? envConfigDir ?? DEFAULT_CREDENTIALS_DIR;
}

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private readonly credentialsDir: string;
  private readonly credentialsFile: string;

  private cachedStore: CredentialStore | null = null;
  private cachedFileState: string | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(options: SecureStorageBackendOptions = {}) {
    const configDir = resolveCredentialsConfigDir(options.configDir);
    this.credentialsDir = resolve(configDir);
    this.credentialsFile = join(this.credentialsDir, CREDENTIALS_FILE_NAME);

    const hasExplicitConfigDir = options.configDir !== undefined || process.env.CRAFT_CONFIG_DIR !== undefined;
    if (process.env.NODE_ENV === 'test' && !options.allowUnsafeDefaultPathInTests && !hasExplicitConfigDir && isDefaultConfigDir(this.credentialsDir)) {
      throw new Error('Refusing to initialize credential backend against default config dir in test mode; set CRAFT_CONFIG_DIR or pass configDir explicitly.');
    }
  }

  getCredentialsFilePath(): string {
    return this.credentialsFile;
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    let store = await this.loadStore();

    if (!store) {
      // Initialize new store
      store = {
        version: 1,
        credentials: {},
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }

    const key = credentialIdToAccount(id);
    store.credentials[key] = credential;
    store.metadata.updatedAt = Date.now();

    await this.saveStore(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      if (filter.connectionSlug && id.connectionSlug !== filter.connectionSlug) return false;
      if (filter.memoryConnectionId && id.memoryConnectionId !== filter.memoryConnectionId) return false;
      return true;
    });
  }

  /** Raw account enumeration (verbatim keys, no CredentialId parsing). */
  async listRawAccounts(): Promise<string[]> {
    const store = await this.loadStore();
    if (!store) return [];
    return Object.keys(store.credentials);
  }

  /** Read a credential by its raw account string. */
  async getByAccount(account: string): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;
    return store.credentials[account] ?? null;
  }

  /** Delete a credential by its raw account string. */
  async deleteByAccount(account: string): Promise<boolean> {
    const store = this.loadStoreSync();
    if (!store) return false;
    if (!(account in store.credentials)) return false;
    delete store.credentials[account];
    store.metadata.updatedAt = Date.now();
    this.saveStoreSync(store);
    return true;
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    this.invalidateIfStale();

    if (!existsSync(this.credentialsFile)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.credentialsFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CredentialStoreError('permission_denied', 'Cannot read credential file due insufficient permissions.', {
          path: this.credentialsFile,
          cause: error,
        });
      }
      throw new CredentialStoreError('io_error', 'Unable to read credential file.', {
        path: this.credentialsFile,
        cause: error,
      });
    }

    const fileState = this.makeFileState(this.credentialsFile);

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      this.failClosedCorruption('file_corrupted', 'Credential file is too small or truncated.', fileData);
      return null;
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.failClosedCorruption('file_corrupted', 'Credential file has an invalid format.', fileData);
      return null;
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    const newResult = this.tryDecrypt(encryptedData, newKey);

    if (newResult.store) {
      this.cachedStore = newResult.store;
      this.cachedFileState = fileState;
      return newResult.store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    const legacyResult = this.tryDecrypt(encryptedData, legacyKey);

    if (legacyResult.store) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.cachedStore = legacyResult.store;
      this.cachedFileState = fileState;
      this.saveStoreSync(legacyResult.store);
      return legacyResult.store;
    }

    if (legacyResult.parseFailed || newResult.parseFailed) {
      this.failClosedCorruption('file_corrupted', 'Credential file contains invalid JSON payload.', fileData);
      return null;
    }

    this.failClosedCorruption('decryption_failed', 'Credential file cannot be decrypted.', fileData);
    return null;
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): { store: CredentialStore | null; parseFailed: boolean } {
    let decrypted: Buffer;

    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return { store: null, parseFailed: false };
    }

    try {
      return {
        store: JSON.parse(decrypted.toString('utf8')),
        parseFailed: false,
      };
    } catch {
      return { store: null, parseFailed: true };
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = JSON.stringify(store);

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write with restrictive permissions (owner read/write only)
    writeFileSync(this.credentialsFile, fileData, { mode: 0o600 });

    this.cachedStore = store;
    this.cachedFileState = this.makeFileState(this.credentialsFile);
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  private makeFileState(filePath: string): string | null {
    try {
      const stat = statSync(filePath);
      return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  /**
   * Invalidate in-memory state if credentials file changed since last read.
   */
  private invalidateIfStale(): void {
    if (!this.cachedStore) return;

    const currentState = this.makeFileState(this.credentialsFile);
    if (!currentState || currentState !== this.cachedFileState) {
      this.clearCache();
    }
  }

  private failClosedCorruption(code: CredentialStoreErrorCode, message: string, fileData: Buffer): never {
    this.quarantineCorruptedFile(fileData, code);
    this.clearCache();
    throw new CredentialStoreError(code, message, { path: this.credentialsFile, cause: undefined });
  }

  private quarantineCorruptedFile(fileData: Buffer, code: CredentialStoreErrorCode): void {
    const suffix = `${Date.now()}.${randomBytes(4).toString('hex')}`;
    const quarantinePath = `${this.credentialsFile}.${code}.${suffix}`;

    try {
      writeFileSync(quarantinePath, fileData, { mode: 0o600 });
    } catch {
      // Preserve evidence if possible; best-effort only.
    }
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.cachedFileState = null;
    this.encryptionKey = null;
    this.salt = null;
  }
}
