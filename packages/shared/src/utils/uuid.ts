/**
 * UUID helpers (backend-only).
 *
 * The pure *format* helpers (`UUID_PATTERN`, `isUuid`, `isCanonicalUuid`,
 * `toCanonicalUuid`, …) live in `./uuid-format.ts` and are re-exported here for
 * convenience. UUID *generation* below requires Node's `crypto` module and is
 * therefore backend-only — importing this file pulls `crypto` into the graph.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';

export {
  CANONICAL_UUID_PATTERN,
  UUID_PATTERN,
  isUuid,
  isCanonicalUuid,
  toCanonicalUuid,
  equalUuid,
} from './uuid-format.ts';

import { isUuid } from './uuid-format.ts';

/** Generate a random (v4) UUID in canonical lowercase form. */
export function randomUuid(): string {
  // Node's randomUUID() already returns canonical lowercase.
  return randomUUID();
}

/** Generate `bytes` random bytes as a lowercase hex string (`2 * bytes` chars). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Standards-correct RFC-4122 **version 5** (name-based, SHA-1) UUID.
 *
 * `namespace` must itself be a UUID; `name` is hashed together with the
 * namespace's 16 raw bytes exactly as the RFC prescribes. The result is a
 * stable, canonical lowercase UUID with the version nibble set to 5 and the
 * RFC-4122 variant bits set. Deterministic: same (name, namespace) → same UUID.
 *
 * Use this for every derived/synthetic identifier (environment-compat
 * connection id, a connection's derived Global space id) so the identifiers are
 * real, verifiable v5 UUIDs rather than an ad-hoc hash shaped to look like one.
 */
export function uuidV5(name: string, namespace: string): string {
  if (!isUuid(namespace)) {
    throw new Error(`uuidV5 namespace must be a UUID, got: ${namespace}`);
  }
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  return bytesToUuid(bytes);
}
