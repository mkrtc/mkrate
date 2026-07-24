/**
 * Credential Backend Interface
 *
 * All credential storage backends must implement this interface.
 * Backends are tried in priority order until one succeeds.
 */

import type { CredentialId, StoredCredential } from '../types.ts';

export interface CredentialBackend {
  /** Backend name for logging/debugging */
  readonly name: string;

  /** Priority (higher = tried first) */
  readonly priority: number;

  /** Check if this backend is available on the current platform */
  isAvailable(): Promise<boolean>;

  /** Get a credential by ID */
  get(id: CredentialId): Promise<StoredCredential | null>;

  /** Set/update a credential */
  set(id: CredentialId, credential: StoredCredential): Promise<void>;

  /** Delete a credential */
  delete(id: CredentialId): Promise<boolean>;

  /** Delete a credential synchronously, when supported by the backend. */
  deleteSync?(id: CredentialId): boolean;

  /** List all credentials (optionally filtered by partial ID) */
  list(filter?: Partial<CredentialId>): Promise<CredentialId[]>;

  // --- Raw account access (optional) -------------------------------------
  // Used only by the A5 legacy-credential migration, which must operate on
  // account strings that no longer parse into a canonical CredentialId (e.g. a
  // legacy uppercase-UUID memory account). Backends that cannot enumerate raw
  // account strings simply omit these; the migration then reports no legacy work.

  /** List every stored account string verbatim (no CredentialId parsing). */
  listRawAccounts?(): Promise<string[]>;

  /** Read a credential by its raw account string. */
  getByAccount?(account: string): Promise<StoredCredential | null>;

  /** Delete a credential by its raw account string. Returns true if removed. */
  deleteByAccount?(account: string): Promise<boolean>;
}
