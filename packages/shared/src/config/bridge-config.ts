/**
 * Trusted Bridge — Desktop profile configuration (NON-SECRET, protocol-independent).
 *
 * This module owns the single active "trusted Bridge" profile the Desktop uses to
 * reach a user-self-hosted Bridge server. It is deliberately:
 *
 *  - **Secret-free.** The per-instance Bridge token lives ONLY in the encrypted
 *    CredentialManager (`bridge_instance_token::{bridgeProfileId}`). This config
 *    NEVER stores, accepts, or serializes a token/enrollment/bootstrap field.
 *    `sanitizeStoredProfile` rebuilds the object from a fixed allow-list, so any
 *    stray/hidden secret field on disk is dropped on read.
 *  - **One active profile.** There is a single profile slot; `setBridgeProfile`
 *    replaces it. `enabled` toggles whether the Desktop should use it.
 *  - **Fail-closed.** A missing, unreadable, corrupt, or schema-invalid file reads
 *    back as `null` (no profile) rather than throwing — a corrupt Bridge config can
 *    never crash startup or resurrect a partially-valid profile.
 *  - **Isolated.** Stored in its own `bridge-config.json`, decoupled from the main
 *    `config.json`/workspace registry so corruption in one cannot affect the other.
 *
 * Transport, enrollment, pairing, the wire DTOs, and the connector/auth state
 * machine are intentionally OUT of scope here.
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { isUuid, isCanonicalUuid, toCanonicalUuid, randomUuid } from '../utils/uuid.ts';
import { debug } from '../utils/debug.ts';

const BRIDGE_CONFIG_FILE_NAME = 'bridge-config.json';
const BRIDGE_CONFIG_VERSION = 1 as const;

/** Max length (in Unicode code points) of a normalized Bridge display name. */
export const BRIDGE_DISPLAY_NAME_MAX_LENGTH = 100;

/** Max length of the optional opaque deployment/instance identifiers. */
export const BRIDGE_OPAQUE_ID_MAX_LENGTH = 200;

/**
 * Loopback hosts for which an insecure `ws://` Bridge URL is tolerated (dev/test only).
 * The WHATWG URL parser returns IPv6 hostnames WITH brackets (`[::1]`), so both the
 * bracketed and unbracketed forms are listed.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True if the string contains any ASCII control character (C0 range or DEL). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// ============================================================
// Types
// ============================================================

/**
 * The single active, protocol-independent Bridge profile.
 * Contains NO secret material — the instance token is stored separately in the
 * CredentialManager, keyed by `profileId`.
 */
export interface BridgeProfile {
  /** Canonical (lowercase) UUID identifying this profile; also the credential scope key. */
  profileId: string;
  /** Canonical Bridge WebSocket URL (`wss://…`, or loopback `ws://…` in dev/test). */
  url: string;
  /** NFC-normalized, bounded, user-facing display name. */
  displayName: string;
  /** Whether the Desktop should actively use this profile. */
  enabled: boolean;
  /** Optional opaque server-deployment identifier (non-secret). */
  deploymentId?: string;
  /** Optional opaque Desktop-instance identifier (non-secret). */
  instanceId?: string;
  /** Creation time (Unix ms). */
  createdAt: number;
  /** Last-update time (Unix ms). */
  updatedAt: number;
}

/** Input accepted by {@link setBridgeProfile}. Never carries secret material. */
export interface BridgeProfileInput {
  /** Optional explicit profile id (UUID). A new canonical UUID is minted when omitted. */
  profileId?: string;
  /** Bridge WebSocket URL — validated & canonicalized. */
  url: string;
  /** Display name — NFC-normalized and length-bounded. */
  displayName: string;
  /** Whether the profile is enabled (default: true). */
  enabled?: boolean;
  /** Optional opaque deployment id. */
  deploymentId?: string;
  /** Optional opaque instance id. */
  instanceId?: string;
}

/** Options controlling Bridge URL policy. */
export interface BridgeUrlOptions {
  /**
   * Permit an insecure `ws://` URL, but ONLY for an exact loopback host
   * (`127.0.0.1`, `localhost`, `::1`). Intended for local dev/test wiring.
   * Default: false (require `wss://`).
   */
  allowInsecureLoopback?: boolean;
}

/** Machine-readable reason a Bridge URL was rejected. */
export type BridgeUrlRejectReason =
  | 'not-a-string'
  | 'empty'
  | 'whitespace'
  | 'contains-backslash'
  | 'unparseable'
  | 'bad-scheme'
  | 'insecure-downgrade'
  | 'userinfo'
  | 'query'
  | 'fragment'
  | 'non-root-path'
  | 'empty-host'
  | 'ambiguous-host'
  | 'bad-normalization';

/** Machine-readable reason a display name / id / profile was rejected. */
export type BridgeFieldRejectReason =
  | 'name-not-a-string'
  | 'name-empty'
  | 'name-too-long'
  | 'name-control-chars'
  | 'invalid-profile-id'
  | 'invalid-opaque-id'
  | 'opaque-id-too-long'
  | 'opaque-id-control-chars';

export type BridgeUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: BridgeUrlRejectReason };

/** Error thrown by {@link setBridgeProfile} when the input violates policy. */
export class BridgeConfigError extends Error {
  readonly reason: BridgeUrlRejectReason | BridgeFieldRejectReason;
  constructor(reason: BridgeUrlRejectReason | BridgeFieldRejectReason, message: string) {
    super(message);
    this.name = 'BridgeConfigError';
    this.reason = reason;
  }
}

// ============================================================
// Validation & normalization
// ============================================================

/**
 * Strictly validate and canonicalize a Bridge WebSocket URL.
 *
 * Policy: `wss://` is required (an exact-loopback `ws://` is tolerated only when
 * `allowInsecureLoopback` is set). Userinfo, query strings, fragments, and any
 * non-root path are rejected. The scheme and authority must already be in
 * canonical form — an input whose host would be rewritten by normalization
 * (uppercase host, redundant default port, IPv4/IDN coercion, …) is rejected as
 * ambiguous rather than silently transformed.
 *
 * Returns the canonical `scheme://authority` string (no trailing slash) on success.
 */
export function validateBridgeUrl(input: unknown, options: BridgeUrlOptions = {}): BridgeUrlValidation {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  // Reject any internal whitespace / control characters outright.
  if (/\s/.test(trimmed) || hasControlChar(trimmed)) return { ok: false, reason: 'whitespace' };
  // Special schemes coerce backslashes to slashes — refuse them to avoid ambiguity.
  if (trimmed.includes('\\')) return { ok: false, reason: 'contains-backslash' };

  // Scheme must be exactly-lowercase `wss://` or `ws://` (forces canonical scheme).
  let schemePrefix: 'wss://' | 'ws://';
  if (trimmed.startsWith('wss://')) schemePrefix = 'wss://';
  else if (trimmed.startsWith('ws://')) schemePrefix = 'ws://';
  else return { ok: false, reason: 'bad-scheme' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  // Protocol sanity (URL lowercases; the raw prefix check above already forced it).
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return { ok: false, reason: 'bad-scheme' };

  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  if (url.search !== '') return { ok: false, reason: 'query' };
  if (url.hash !== '') return { ok: false, reason: 'fragment' };
  if (url.pathname !== '' && url.pathname !== '/') return { ok: false, reason: 'non-root-path' };
  if (url.hostname === '') return { ok: false, reason: 'empty-host' };

  // `ws://` is only ever allowed for an exact loopback host, and only on opt-in.
  if (url.protocol === 'ws:') {
    if (!options.allowInsecureLoopback || !LOOPBACK_HOSTS.has(url.hostname)) {
      return { ok: false, reason: 'insecure-downgrade' };
    }
  }

  // Ambiguity / normalization guard: the raw authority the caller typed must
  // already equal the parser's canonical `host` (host[:port]). Any divergence
  // (uppercase host, default-port redundancy, IPv4/IDN rewrite, extra userinfo)
  // is refused instead of being normalized behind the caller's back.
  const rest = trimmed.slice(schemePrefix.length);
  const authEnd = rest.search(/[/?#]/);
  const rawAuthority = authEnd === -1 ? rest : rest.slice(0, authEnd);
  if (rawAuthority.includes('@')) return { ok: false, reason: 'userinfo' };
  if (rawAuthority !== url.host) return { ok: false, reason: 'bad-normalization' };

  // Canonical form: scheme://authority, no trailing slash.
  return { ok: true, url: `${url.protocol}//${url.host}` };
}

/**
 * Normalize a Bridge display name to NFC with a bounded code-point length.
 * Returns the normalized name, or `null` if it is empty / too long / contains
 * control characters.
 */
export function normalizeBridgeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const nfc = input.normalize('NFC').trim();
  if (nfc.length === 0) return null;
  if (hasControlChar(nfc)) return null;
  // Count Unicode code points, not UTF-16 code units, for a stable bound.
  if (Array.from(nfc).length > BRIDGE_DISPLAY_NAME_MAX_LENGTH) return null;
  return nfc;
}

/** Normalize an optional opaque id: NFC, trimmed, bounded, control-char-free, or a reason. */
function normalizeOpaqueId(input: unknown): { ok: true; value: string } | { ok: false; reason: BridgeFieldRejectReason } {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid-opaque-id' };
  const nfc = input.normalize('NFC').trim();
  if (nfc.length === 0) return { ok: false, reason: 'invalid-opaque-id' };
  if (hasControlChar(nfc)) return { ok: false, reason: 'opaque-id-control-chars' };
  if (Array.from(nfc).length > BRIDGE_OPAQUE_ID_MAX_LENGTH) return { ok: false, reason: 'opaque-id-too-long' };
  return { ok: true, value: nfc };
}

// ============================================================
// Storage (own file, fail-closed)
// ============================================================

interface BridgeConfigFile {
  version: typeof BRIDGE_CONFIG_VERSION;
  profile: BridgeProfile | null;
}

function getBridgeConfigFile(): string {
  return join(getConfigDir(), BRIDGE_CONFIG_FILE_NAME);
}

/**
 * Rebuild a {@link BridgeProfile} from raw on-disk data using a fixed allow-list.
 * Returns `null` (fail-closed) if any field is missing/invalid. Because it only
 * copies known fields, any hidden/secret field present on disk is dropped.
 *
 * URL re-validation permits loopback `ws://` so a legitimately-stored dev profile
 * survives a round-trip, while still failing closed on a genuinely garbage URL.
 */
function sanitizeStoredProfile(raw: unknown): BridgeProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const profileId = toCanonicalUuid(r.profileId);
  if (!profileId) return null;

  const urlCheck = validateBridgeUrl(r.url, { allowInsecureLoopback: true });
  if (!urlCheck.ok) return null;

  const displayName = normalizeBridgeDisplayName(r.displayName);
  if (displayName === null) return null;

  if (typeof r.enabled !== 'boolean') return null;

  const createdAt = r.createdAt;
  const updatedAt = r.updatedAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return null;

  const profile: BridgeProfile = {
    profileId,
    url: urlCheck.url,
    displayName,
    enabled: r.enabled,
    createdAt,
    updatedAt,
  };

  if (r.deploymentId !== undefined) {
    const dep = normalizeOpaqueId(r.deploymentId);
    if (!dep.ok) return null;
    profile.deploymentId = dep.value;
  }
  if (r.instanceId !== undefined) {
    const inst = normalizeOpaqueId(r.instanceId);
    if (!inst.ok) return null;
    profile.instanceId = inst.value;
  }

  return profile;
}

/**
 * Read the single active Bridge profile, or `null` if none is configured.
 * Fail-closed: a missing, unreadable, corrupt, or schema-invalid file returns
 * `null` rather than throwing.
 */
export function getBridgeProfile(): BridgeProfile | null {
  const file = getBridgeConfigFile();
  try {
    if (!existsSync(file)) return null;
    const parsed = readJsonFileSync<Partial<BridgeConfigFile>>(file);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.profile === null || parsed.profile === undefined) return null;
    return sanitizeStoredProfile(parsed.profile);
  } catch (error) {
    debug('[bridge-config] getBridgeProfile failed (fail-closed):', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Persist the single active Bridge profile, validating and canonicalizing input.
 * Replaces any existing profile (one active slot). Preserves `createdAt` when the
 * same `profileId` is being updated. Throws {@link BridgeConfigError} on invalid input.
 *
 * NOTE: this API accepts NO secret material. The instance token must be stored via
 * `CredentialManager.setBridgeInstanceToken(profileId, token)`.
 */
export function setBridgeProfile(input: BridgeProfileInput, options: BridgeUrlOptions = {}): BridgeProfile {
  const urlCheck = validateBridgeUrl(input?.url, options);
  if (!urlCheck.ok) {
    throw new BridgeConfigError(urlCheck.reason, `Invalid Bridge URL (${urlCheck.reason}).`);
  }

  const displayName = normalizeBridgeDisplayName(input?.displayName);
  if (displayName === null) {
    throw new BridgeConfigError('name-empty', 'Invalid Bridge display name (empty, too long, or control characters).');
  }

  let profileId: string;
  if (input.profileId !== undefined) {
    if (!isUuid(input.profileId)) {
      throw new BridgeConfigError('invalid-profile-id', `Invalid Bridge profileId: ${String(input.profileId)}`);
    }
    profileId = toCanonicalUuid(input.profileId) as string;
  } else {
    profileId = randomUuid();
  }

  let deploymentId: string | undefined;
  if (input.deploymentId !== undefined) {
    const dep = normalizeOpaqueId(input.deploymentId);
    if (!dep.ok) throw new BridgeConfigError(dep.reason, `Invalid Bridge deploymentId (${dep.reason}).`);
    deploymentId = dep.value;
  }

  let instanceId: string | undefined;
  if (input.instanceId !== undefined) {
    const inst = normalizeOpaqueId(input.instanceId);
    if (!inst.ok) throw new BridgeConfigError(inst.reason, `Invalid Bridge instanceId (${inst.reason}).`);
    instanceId = inst.value;
  }

  const now = Date.now();
  const existing = getBridgeProfile();
  const createdAt = existing && existing.profileId === profileId ? existing.createdAt : now;

  const profile: BridgeProfile = {
    profileId,
    url: urlCheck.url,
    displayName,
    enabled: input.enabled ?? true,
    createdAt,
    updatedAt: now,
  };
  if (deploymentId !== undefined) profile.deploymentId = deploymentId;
  if (instanceId !== undefined) profile.instanceId = instanceId;

  writeBridgeConfigFile({ version: BRIDGE_CONFIG_VERSION, profile });
  return profile;
}

/**
 * Clear the active Bridge profile. Returns true if a profile was present.
 * Does NOT touch the CredentialManager — callers that also want to remove the
 * stored instance token must delete it explicitly.
 */
export function clearBridgeProfile(): boolean {
  const file = getBridgeConfigFile();
  const had = getBridgeProfile() !== null;
  try {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  } catch (error) {
    debug('[bridge-config] clearBridgeProfile failed:', error instanceof Error ? error.message : error);
  }
  return had;
}

function writeBridgeConfigFile(data: BridgeConfigFile): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getBridgeConfigFile(), JSON.stringify(data, null, 2));
}

/** Absolute path to the Bridge config file (for diagnostics/tests). */
export function getBridgeConfigPath(): string {
  return getBridgeConfigFile();
}

/** True when the given value is a usable Bridge profile id (canonical UUID). */
export function isValidBridgeProfileId(value: unknown): value is string {
  return isCanonicalUuid(value);
}
