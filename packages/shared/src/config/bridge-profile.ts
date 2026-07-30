/**
 * Trusted Bridge — pure Desktop profile validation (NON-SECRET, protocol-independent).
 *
 * Bridge profiles are rebuilt from a fixed allowlist on every normal config load
 * and save. The only persisted Bridge secret is the encrypted CredentialManager
 * `bridge_instance_token::{bridgeProfileId}` entry; tokens and bootstrap material
 * are never accepted into this schema.
 *
 * Transport, enrollment, pairing, wire DTOs, and connector/auth state are out of
 * scope for this module.
 */

import { isCanonicalUuid, isUuid, randomUuid, toCanonicalUuid } from '../utils/uuid.ts';

/** Max length (in Unicode code points) of a normalized Bridge display name. */
export const BRIDGE_DISPLAY_NAME_MAX_LENGTH = 100;

/** Max length of the optional opaque deployment/instance identifiers. */
export const BRIDGE_OPAQUE_ID_MAX_LENGTH = 200;

/** Exact hosts eligible for explicit dev/test-only insecure WebSocket access. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True if the string contains any ASCII control character (C0 range or DEL). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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

/** Input accepted by the one-profile setter. Never carries secret material. */
export interface BridgeProfileInput {
  /** Optional explicit profile id (UUID). A new canonical UUID is minted when omitted. */
  profileId?: string;
  /** Bridge WebSocket URL — validated and canonicalized. */
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
   * Permit `ws://` only for an exact loopback host (`127.0.0.1`, `localhost`,
   * `[::1]`). Intended solely for explicit local dev/test wiring.
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
  | 'config-unavailable'
  | 'invalid-enabled'
  | 'invalid-opaque-id'
  | 'opaque-id-too-long'
  | 'opaque-id-control-chars';

export type BridgeUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: BridgeUrlRejectReason };

/** Error thrown when Bridge profile input violates policy. */
export class BridgeConfigError extends Error {
  readonly reason: BridgeUrlRejectReason | BridgeFieldRejectReason;

  constructor(reason: BridgeUrlRejectReason | BridgeFieldRejectReason, message: string) {
    super(message);
    this.name = 'BridgeConfigError';
    this.reason = reason;
  }
}

interface RawAuthority {
  hostname: string;
  port: string | null;
  bracketedIpv6: boolean;
}

/** Parse the raw authority without applying any URL-parser coercions. */
function parseRawAuthority(authority: string): RawAuthority | null {
  if (authority.length === 0 || authority.includes('@')) return null;

  if (authority.startsWith('[')) {
    const closeBracket = authority.indexOf(']');
    if (closeBracket === -1 || authority.indexOf('[', 1) !== -1 || authority.indexOf(']', closeBracket + 1) !== -1) {
      return null;
    }

    const hostname = authority.slice(0, closeBracket + 1);
    const suffix = authority.slice(closeBracket + 1);
    if (hostname.includes('%')) return null; // zone identifiers and escaped variants are ambiguous here
    if (suffix === '') return { hostname, port: null, bracketedIpv6: true };
    if (!suffix.startsWith(':')) return null;
    return { hostname, port: suffix.slice(1), bracketedIpv6: true };
  }

  if (authority.includes('[') || authority.includes(']')) return null;
  const firstColon = authority.indexOf(':');
  const lastColon = authority.lastIndexOf(':');
  if (firstColon !== lastColon) return null; // unbracketed IPv6 is never accepted
  if (lastColon === -1) return { hostname: authority, port: null, bracketedIpv6: false };
  return {
    hostname: authority.slice(0, lastColon),
    port: authority.slice(lastColon + 1),
    bracketedIpv6: false,
  };
}

/**
 * Strictly validate and canonicalize a Bridge WebSocket URL.
 *
 * `wss://` is required, except exact loopback `ws://` under the explicit option.
 * Userinfo, query, fragment, non-root paths, backslashes, controls, ambiguous IPv6,
 * legacy numeric IPv4 forms, IDN/percent coercions, and non-canonical ports fail.
 * Benign scheme/host case, one root slash, and an exact redundant default port
 * are accepted and canonicalized.
 */
export function validateBridgeUrl(input: unknown, options: BridgeUrlOptions = {}): BridgeUrlValidation {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  if (hasControlChar(input)) return { ok: false, reason: 'whitespace' };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'whitespace' };
  if (trimmed.includes('\\')) return { ok: false, reason: 'contains-backslash' };

  const schemeMatch = /^(wss|ws):\/\//i.exec(trimmed);
  if (!schemeMatch) return { ok: false, reason: 'bad-scheme' };
  const rawScheme = schemeMatch[1]!.toLowerCase() as 'wss' | 'ws';

  const authorityStart = schemeMatch[0].length;
  const rest = trimmed.slice(authorityStart);
  const authorityEnd = rest.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = rest.slice(rawAuthority.length);
  if (rawAuthority.includes('@')) return { ok: false, reason: 'userinfo' };
  if (afterAuthority.includes('?')) return { ok: false, reason: 'query' };
  if (afterAuthority.includes('#')) return { ok: false, reason: 'fragment' };
  if (afterAuthority !== '' && afterAuthority !== '/') return { ok: false, reason: 'non-root-path' };
  const authority = parseRawAuthority(rawAuthority);
  if (!authority) return { ok: false, reason: 'ambiguous-host' };
  if (authority.hostname.length === 0) return { ok: false, reason: 'empty-host' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (url.protocol !== `${rawScheme}:`) return { ok: false, reason: 'bad-scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  if (url.search !== '') return { ok: false, reason: 'query' };
  if (url.hash !== '') return { ok: false, reason: 'fragment' };
  if (url.pathname !== '' && url.pathname !== '/') return { ok: false, reason: 'non-root-path' };
  if (url.hostname === '') return { ok: false, reason: 'empty-host' };

  const rawHostname = authority.hostname.toLowerCase();
  const parsedHostname = url.hostname.toLowerCase();
  if (rawHostname !== parsedHostname) {
    return { ok: false, reason: authority.bracketedIpv6 ? 'ambiguous-host' : 'bad-normalization' };
  }

  if (authority.port !== null) {
    // Refuse empty, signed, padded, hex/octal-like, out-of-range, or parser-coerced ports.
    if (!/^(0|[1-9]\d*)$/.test(authority.port)) return { ok: false, reason: 'bad-normalization' };
    const numericPort = Number(authority.port);
    if (!Number.isSafeInteger(numericPort) || numericPort > 65_535) {
      return { ok: false, reason: 'bad-normalization' };
    }
    const defaultPort = rawScheme === 'wss' ? 443 : 80;
    if (numericPort === defaultPort) {
      if (url.port !== '') return { ok: false, reason: 'bad-normalization' };
    } else if (url.port !== authority.port) {
      return { ok: false, reason: 'bad-normalization' };
    }
  }

  if (url.protocol === 'ws:') {
    if (!options.allowInsecureLoopback || !LOOPBACK_HOSTS.has(parsedHostname)) {
      return { ok: false, reason: 'insecure-downgrade' };
    }
  }

  return { ok: true, url: `${url.protocol}//${url.host}` };
}

/** Normalize a Bridge display name to NFC with a bounded code-point length. */
export function normalizeBridgeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const nfc = input.normalize('NFC').trim();
  if (nfc.length === 0 || hasControlChar(nfc)) return null;
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

/**
 * Rebuild a Bridge profile from raw config data using a fixed allowlist.
 * Any missing/invalid field fails closed to `null`; unknown and secret-looking
 * fields are never copied into the returned StoredConfig value.
 */
export function sanitizeStoredBridgeProfile(raw: unknown): BridgeProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const profileId = toCanonicalUuid(r.profileId);
  if (!profileId) return null;

  const urlCheck = validateBridgeUrl(r.url, { allowInsecureLoopback: true });
  if (!urlCheck.ok) return null;

  const displayName = normalizeBridgeDisplayName(r.displayName);
  if (displayName === null || typeof r.enabled !== 'boolean') return null;

  const createdAt = r.createdAt;
  const updatedAt = r.updatedAt;
  if (
    typeof createdAt !== 'number'
    || !Number.isFinite(createdAt)
    || createdAt < 0
    || typeof updatedAt !== 'number'
    || !Number.isFinite(updatedAt)
    || updatedAt < createdAt
  ) {
    return null;
  }

  const profile: BridgeProfile = {
    profileId,
    url: urlCheck.url,
    displayName,
    enabled: r.enabled,
    createdAt,
    updatedAt,
  };

  if (r.deploymentId !== undefined) {
    const deploymentId = normalizeOpaqueId(r.deploymentId);
    if (!deploymentId.ok) return null;
    profile.deploymentId = deploymentId.value;
  }
  if (r.instanceId !== undefined) {
    const instanceId = normalizeOpaqueId(r.instanceId);
    if (!instanceId.ok) return null;
    profile.instanceId = instanceId.value;
  }

  return profile;
}

/** Validate input and construct the next canonical profile without persisting it. */
export function createBridgeProfile(
  input: BridgeProfileInput,
  existing: BridgeProfile | null,
  options: BridgeUrlOptions = {},
): BridgeProfile {
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

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new BridgeConfigError('invalid-enabled', 'Invalid Bridge enabled flag.');
  }

  let deploymentId: string | undefined;
  if (input.deploymentId !== undefined) {
    const normalized = normalizeOpaqueId(input.deploymentId);
    if (!normalized.ok) {
      throw new BridgeConfigError(normalized.reason, `Invalid Bridge deploymentId (${normalized.reason}).`);
    }
    deploymentId = normalized.value;
  }

  let instanceId: string | undefined;
  if (input.instanceId !== undefined) {
    const normalized = normalizeOpaqueId(input.instanceId);
    if (!normalized.ok) {
      throw new BridgeConfigError(normalized.reason, `Invalid Bridge instanceId (${normalized.reason}).`);
    }
    instanceId = normalized.value;
  }

  const now = Date.now();
  const profile: BridgeProfile = {
    profileId,
    url: urlCheck.url,
    displayName,
    enabled: input.enabled ?? true,
    createdAt: existing?.profileId === profileId ? existing.createdAt : now,
    updatedAt: now,
  };
  if (deploymentId !== undefined) profile.deploymentId = deploymentId;
  if (instanceId !== undefined) profile.instanceId = instanceId;
  return profile;
}

/** True when the given value is a usable canonical Bridge profile id. */
export function isValidBridgeProfileId(value: unknown): value is string {
  return isCanonicalUuid(value);
}
