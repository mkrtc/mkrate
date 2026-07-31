import { validateBridgeUrl } from '../config/bridge-profile.ts';
import { isCanonicalUuid } from '../utils/uuid-format.ts';

export const BRIDGE_CREDENTIAL_ENVELOPE_VERSION = 1 as const;

/**
 * Versioned secret stored as the encrypted value of
 * `bridge_instance_token::{profileId}`. The outer CredentialManager provides
 * encryption at rest; this envelope binds the bearer token to the exact Desktop
 * identity and canonical Bridge origin where it may be sent.
 */
export interface BridgeCredentialEnvelopeV1 {
  readonly version: typeof BRIDGE_CREDENTIAL_ENVELOPE_VERSION;
  readonly origin: string;
  readonly profileId: string;
  readonly deploymentId: string;
  readonly instanceId: string;
  readonly instanceToken: string;
}

export type BridgeCredentialEnvelope = BridgeCredentialEnvelopeV1;

const ENVELOPE_KEYS = new Set([
  'version', 'origin', 'profileId', 'deploymentId', 'instanceId', 'instanceToken',
]);

export class BridgeCredentialEnvelopeError extends Error {
  constructor(readonly code: 'legacy-unbound' | 'invalid-envelope', message: string) {
    super(message);
    this.name = 'BridgeCredentialEnvelopeError';
  }
}

export function createBridgeCredentialEnvelope(input: Omit<BridgeCredentialEnvelopeV1, 'version'>): BridgeCredentialEnvelopeV1 {
  const origin = validateBridgeUrl(input.origin, { allowInsecureLoopback: true });
  if (!origin.ok || origin.url !== input.origin) throw new BridgeCredentialEnvelopeError('invalid-envelope', 'Bridge credential origin is not canonical');
  if (!isCanonicalUuid(input.profileId)) throw new BridgeCredentialEnvelopeError('invalid-envelope', 'Bridge credential profileId is invalid');
  for (const [field, value] of [
    ['deploymentId', input.deploymentId],
    ['instanceId', input.instanceId],
    ['instanceToken', input.instanceToken],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\u0000-\u001F\u007F]/.test(value)) {
      throw new BridgeCredentialEnvelopeError('invalid-envelope', `Bridge credential ${field} is invalid`);
    }
  }
  return Object.freeze({ version: BRIDGE_CREDENTIAL_ENVELOPE_VERSION, ...input });
}

export function serializeBridgeCredentialEnvelope(envelope: BridgeCredentialEnvelope): string {
  return JSON.stringify(createBridgeCredentialEnvelope(envelope));
}

/** Raw pre-Wave-B token values are deliberately rejected, never auto-migrated. */
export function parseBridgeCredentialEnvelope(raw: string): BridgeCredentialEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeCredentialEnvelopeError('legacy-unbound', 'Legacy unbound Bridge credential requires re-enrollment');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeCredentialEnvelopeError('invalid-envelope', 'Bridge credential envelope is invalid');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !ENVELOPE_KEYS.has(key)) || Object.keys(record).length !== ENVELOPE_KEYS.size) {
    throw new BridgeCredentialEnvelopeError('invalid-envelope', 'Bridge credential envelope fields are invalid');
  }
  if (record.version !== BRIDGE_CREDENTIAL_ENVELOPE_VERSION) {
    throw new BridgeCredentialEnvelopeError('invalid-envelope', `Unsupported Bridge credential envelope version: ${String(record.version)}`);
  }
  return createBridgeCredentialEnvelope({
    origin: record.origin as string,
    profileId: record.profileId as string,
    deploymentId: record.deploymentId as string,
    instanceId: record.instanceId as string,
    instanceToken: record.instanceToken as string,
  });
}

export function bridgeCredentialMatches(
  envelope: BridgeCredentialEnvelope,
  binding: Pick<BridgeCredentialEnvelope, 'origin' | 'profileId' | 'deploymentId' | 'instanceId'>,
): boolean {
  return envelope.origin === binding.origin
    && envelope.profileId === binding.profileId
    && envelope.deploymentId === binding.deploymentId
    && envelope.instanceId === binding.instanceId;
}
