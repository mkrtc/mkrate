/**
 * Metadata-only logging for the trusted Bridge connector.
 *
 * Callers can emit only the closed event/field vocabulary below. A final
 * redaction pass drops forbidden keys and token-shaped values before invoking
 * the sink. Wire frames, payloads, credentials, close reasons, and arbitrary
 * Error strings are intentionally not representable.
 */

export type BridgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type BridgeLogEvent =
  | 'transport.connecting'
  | 'transport.connected'
  | 'transport.disconnected'
  | 'transport.reconnect-scheduled'
  | 'transport.protocol-rejected'
  | 'transport.heartbeat-timeout'
  | 'transport.send-failed'
  | 'connector.state-changed'
  | 'connector.credential-write-failed'
  | 'connector.authority-write-failed'
  | 'pairing.lease-opened'
  | 'pairing.lease-closed'
  | 'pairing.lease-lost'
  | 'pairing.request-received'
  | 'pairing.decision-committed'
  | 'pairing.binding-revoked';

export interface BridgeLogMetadata {
  attempt?: number;
  code?: number | string;
  delayMs?: number;
  generation?: number;
  operation?:
    | 'negotiate'
    | 'enroll'
    | 'auth'
    | 'rotate'
    | 'pairing-open'
    | 'pairing-renew'
    | 'pairing-close'
    | 'pairing-approve'
    | 'pairing-reject'
    | 'binding-revoke'
    | 'command-result'
    | 'timeline-event'
    | 'subscription-close'
    | 'resync-marker';
  reason?:
    | 'normal'
    | 'network'
    | 'protocol'
    | 'timeout'
    | 'terminal'
    | 'stopped'
    | 'ui-hidden'
    | 'ui-minimized'
    | 'ui-closed'
    | 'user-cancelled'
    | 'expired'
    | 'lease-lost';
  retryable?: boolean;
  state?: string;
}

export interface BridgeLogRecord {
  level: BridgeLogLevel;
  event: BridgeLogEvent;
  metadata: Readonly<BridgeLogMetadata>;
}

export type BridgeLogSink = (record: BridgeLogRecord) => void;

const FORBIDDEN_KEY = /(?:token|secret|credential|authorization|cookie|payload|frame|message|reasonText|stack|error)/iu;
const TOKEN_SHAPED_VALUE = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?:$|[^A-Za-z0-9_-])/u;
const JWT_OR_BEARER = /(?:\bBearer\s+|\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.)/iu;
const ALLOWED_KEYS = new Set<keyof BridgeLogMetadata>([
  'attempt',
  'code',
  'delayMs',
  'generation',
  'operation',
  'reason',
  'retryable',
  'state',
]);

/** Redaction backstop used by both production logging and leakage tests. */
export function sanitizeBridgeLogMetadata(input: unknown): BridgeLogMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const output: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key) || !ALLOWED_KEYS.has(key as keyof BridgeLogMetadata)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (typeof value === 'string' && (TOKEN_SHAPED_VALUE.test(` ${value} `) || JWT_OR_BEARER.test(value))) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = value;
  }
  return output as BridgeLogMetadata;
}

export interface BridgeLogger {
  log(level: BridgeLogLevel, event: BridgeLogEvent, metadata?: BridgeLogMetadata): void;
}

export function createBridgeLogger(sink: BridgeLogSink = () => {}): BridgeLogger {
  return {
    log(level, event, metadata = {}): void {
      sink({ level, event, metadata: Object.freeze(sanitizeBridgeLogMetadata(metadata)) });
    },
  };
}

export const NULL_BRIDGE_LOGGER: BridgeLogger = Object.freeze(createBridgeLogger());
