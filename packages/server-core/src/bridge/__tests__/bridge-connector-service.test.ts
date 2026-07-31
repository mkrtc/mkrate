import { describe, expect, test } from 'bun:test';
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_PROTOCOL_VERSION,
  COMMAND_CAPABILITIES,
  encodeBase64Url,
  type DesktopClientMessage,
  type DesktopServerMessage,
} from '@mkrate/bridge-protocol';
import type { BridgeProfile } from '@craft-agent/shared/config';
import { createBridgeCredentialEnvelope, type BridgeCredentialEnvelope } from '@craft-agent/shared/credentials';
import {
  BridgeConnectorService,
  type BridgeCredentialAccess,
  type BridgeTransportPort,
} from '../bridge-connector-service.ts';
import { createBridgeLogger, type BridgeLogRecord } from '../bridge-logging.ts';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000';
const DEPLOYMENT_ID = opaque(1);
const INSTANCE_ID = opaque(2);
const ENROLLMENT_TOKEN = token(3);
const INSTANCE_TOKEN = token(4);
const ROTATED_TOKEN = token(5);

function opaque(byte: number): string {
  return encodeBase64Url(new Uint8Array(16).fill(byte));
}
function token(byte: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(byte));
}
function profile(identity = false): BridgeProfile {
  return {
    profileId: PROFILE_ID,
    url: 'wss://bridge.example.test',
    displayName: 'Desktop',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...(identity ? { deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID } : {}),
  };
}

class FakeCredentials implements BridgeCredentialAccess {
  value: string | null;
  failSet = false;
  origin = 'wss://bridge.example.test';
  setCalls: string[] = [];
  deleteCalls = 0;
  constructor(value: string | null) { this.value = value; }
  async getBridgeInstanceCredential(): Promise<BridgeCredentialEnvelope | null> {
    return this.value ? createBridgeCredentialEnvelope({
      origin: this.origin, profileId: PROFILE_ID,
      deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID, instanceToken: this.value,
    }) : null;
  }
  async setBridgeInstanceCredential(envelope: BridgeCredentialEnvelope): Promise<void> {
    this.setCalls.push(envelope.instanceToken);
    if (this.failSet) throw new Error('store failed with secret');
    this.value = envelope.instanceToken;
  }
  async deleteBridgeInstanceToken(): Promise<boolean> {
    this.deleteCalls += 1;
    const existed = this.value !== null;
    this.value = null;
    return existed;
  }
}

class FakeTransport implements BridgeTransportPort {
  connected = false;
  sent: DesktopClientMessage[] = [];
  starts = 0;
  stops = 0;
  retries = 0;
  failNextSend = false;
  constructor(readonly callbacks: {
    onOpen(): void;
    onMessage(message: DesktopServerMessage): void;
    onClose(event: { code: number; retrying: boolean }): void;
  }) {}
  start(): void { this.starts += 1; this.connected = true; this.callbacks.onOpen(); }
  stop(): void { this.stops += 1; this.connected = false; }
  retry(): void { this.retries += 1; this.connected = false; }
  async send(message: DesktopClientMessage): Promise<void> {
    this.sent.push(message);
    if (this.failNextSend) { this.failNextSend = false; throw new Error('send failed'); }
  }
  emit(message: DesktopServerMessage): void { this.callbacks.onMessage(message); }
  close(): void { this.connected = false; this.callbacks.onClose({ code: 1006, retrying: true }); }
  reopen(): void { this.connected = true; this.callbacks.onOpen(); }
}

interface Harness {
  service: BridgeConnectorService;
  transport: FakeTransport;
  credentials: FakeCredentials;
  records: BridgeLogRecord[];
  persisted: BridgeProfile[];
}

function harness(options: {
  identity?: boolean;
  credential?: string | null;
  enrollmentToken?: string;
} = {}): Harness {
  let transport!: FakeTransport;
  let random = 10;
  const credentials = new FakeCredentials(options.credential ?? null);
  const records: BridgeLogRecord[] = [];
  const persisted: BridgeProfile[] = [];
  const service = new BridgeConnectorService({
    profile: profile(options.identity ?? false),
    credentials,
    enrollmentToken: options.enrollmentToken,
    randomBytes: (length) => new Uint8Array(length).fill(random++),
    logger: createBridgeLogger((record) => records.push(record)),
    commitEnrollment: async (next: BridgeProfile, instanceToken: string) => {
      await credentials.setBridgeInstanceCredential(createBridgeCredentialEnvelope({
        origin: next.url, profileId: next.profileId, deploymentId: next.deploymentId!,
        instanceId: next.instanceId!, instanceToken,
      }));
      const stored = { ...next, updatedAt: next.updatedAt + 1 };
      persisted.push(stored);
      return stored;
    },
    transportFactory: (callbacks) => {
      transport = new FakeTransport(callbacks);
      return transport;
    },
  });
  return { service, transport, credentials, records, persisted };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor<T extends DesktopClientMessage['type']>(h: Harness, type: T): Promise<Extract<DesktopClientMessage, { type: T }>> {
  for (let i = 0; i < 20; i += 1) {
    const found = h.transport.sent.find((message) => message.type === type);
    if (found) return found as Extract<DesktopClientMessage, { type: T }>;
    await flush();
  }
  throw new Error(`Missing ${type}`);
}

function accept(requestId: string): Extract<DesktopServerMessage, { type: 'deployment.accepted' }> {
  return {
    type: 'deployment.accepted', endpoint: 'desktop', deploymentId: DEPLOYMENT_ID,
    protocolVersion: 1, capabilities: [...COMMAND_CAPABILITIES], serverTimeMs: 10,
    requestId, version: BRIDGE_PROTOCOL_VERSION,
  };
}
function authenticated(requestId: string): Extract<DesktopServerMessage, { type: 'desktop.authenticated' }> {
  return {
    type: 'desktop.authenticated', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
    connectionId: opaque(8), tokenExpiresAtMs: 99_999, requestId, version: 1,
  };
}

async function driveToAuth(h: Harness): Promise<void> {
  h.service.start();
  const negotiate = await waitFor(h, 'deployment.negotiate');
  h.transport.emit(accept(negotiate.requestId));
  const auth = await waitFor(h, 'desktop.auth');
  h.transport.emit(authenticated(auth.requestId));
  await flush();
  expect(h.service.state).toBe('authenticated');
}

describe('BridgeConnectorService correlation and credential lifecycle', () => {
  test('consumes bootstrap before send, persists only exact enrolled ack, then authenticates', async () => {
    const h = harness({ enrollmentToken: ENROLLMENT_TOKEN });
    h.service.start();
    const negotiate = await waitFor(h, 'deployment.negotiate');
    h.transport.emit(accept(negotiate.requestId));
    const enroll = await waitFor(h, 'desktop.enroll');
    expect(enroll.enrollmentToken).toBe(ENROLLMENT_TOKEN);
    expect(h.credentials.value).toBeNull();

    h.transport.emit({
      type: 'desktop.enrolled', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      instanceToken: INSTANCE_TOKEN, tokenExpiresAtMs: 99_999,
      requestId: enroll.requestId, version: 1,
    });
    const auth = await waitFor(h, 'desktop.auth');
    expect(h.credentials.value).toBe(INSTANCE_TOKEN);
    expect(h.service.profile.instanceId).toBe(INSTANCE_ID);
    h.transport.emit(authenticated(auth.requestId));
    await flush();
    expect(h.service.state).toBe('authenticated');
    expect(h.service.profile).not.toHaveProperty('instanceToken');
  });

  test('ambiguous pre-ack enrollment is terminal enrollment-unknown and never auto-retries', async () => {
    const h = harness({ enrollmentToken: ENROLLMENT_TOKEN });
    h.service.start();
    const negotiate = await waitFor(h, 'deployment.negotiate');
    h.transport.emit(accept(negotiate.requestId));
    await waitFor(h, 'desktop.enroll');
    h.transport.close();
    await flush();
    expect(h.service.state).toBe('enrollment-unknown');
    expect(h.credentials.value).toBeNull();
    const starts = h.transport.starts;
    h.service.start();
    expect(h.transport.starts).toBe(starts);
    expect(() => h.service.replaceEnrollmentToken(token(9))).toThrow();
  });

  test('fails closed on mismatched, unsolicited, and duplicate acknowledgements', async () => {
    const mismatched = harness({ identity: true, credential: INSTANCE_TOKEN });
    mismatched.service.start();
    const negotiate = await waitFor(mismatched, 'deployment.negotiate');
    mismatched.transport.emit({ ...accept(negotiate.requestId), deploymentId: opaque(90) });
    await flush();
    expect(mismatched.service.terminalReason).toBe('deployment-mismatch');

    const unsolicited = harness({ identity: true, credential: INSTANCE_TOKEN });
    unsolicited.service.start();
    unsolicited.transport.emit(authenticated(opaque(91)));
    expect(unsolicited.service.terminalReason).toBe('protocol-error');

    const duplicate = harness({ identity: true, credential: INSTANCE_TOKEN });
    duplicate.service.start();
    const first = await waitFor(duplicate, 'deployment.negotiate');
    duplicate.transport.emit(accept(first.requestId));
    await waitFor(duplicate, 'desktop.auth');
    duplicate.transport.emit(accept(first.requestId));
    expect(duplicate.service.terminalReason).toBe('protocol-error');
  });

  test('never sends a credential bound to another canonical origin', async () => {
    const h = harness({ identity: true, credential: INSTANCE_TOKEN });
    h.credentials.origin = 'wss://old-bridge.example.test';
    h.service.start();
    const negotiate = await waitFor(h, 'deployment.negotiate');
    h.transport.emit(accept(negotiate.requestId));
    for (let i = 0; i < 20 && h.service.state !== 'terminal'; i++) await flush();
    expect(h.service.terminalReason).toBe('credential-binding-invalid');
    expect(h.transport.sent.some(message => message.type === 'desktop.auth')).toBe(false);
  });

  test('uses auth-only reconnect after a previously authenticated connection drops', async () => {
    const h = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(h);
    h.transport.close();
    h.transport.reopen();
    await flush();
    const negotiates = h.transport.sent.filter((message) => message.type === 'deployment.negotiate');
    const reconnectNegotiate = negotiates.at(-1)!;
    h.transport.emit(accept(reconnectNegotiate.requestId));
    for (let i = 0; i < 20 && h.transport.sent.filter(message => message.type === 'desktop.auth').length < 2; i++) await flush();
    const auths = h.transport.sent.filter((message) => message.type === 'desktop.auth');
    expect(auths).toHaveLength(2);
    expect(h.transport.sent.some((message) => message.type === 'desktop.enroll')).toBe(false);
  });

  test('retries transient auth errors but makes invalid/revoked/expired/mismatch terminal', async () => {
    const transient = harness({ identity: true, credential: INSTANCE_TOKEN });
    transient.service.start();
    const negotiate = await waitFor(transient, 'deployment.negotiate');
    transient.transport.emit(accept(negotiate.requestId));
    const auth = await waitFor(transient, 'desktop.auth');
    transient.transport.emit({
      type: 'bridge.error', requestId: auth.requestId, code: BRIDGE_ERROR_CODES.rateLimited,
      retryable: true, retryAfterMs: 100, version: 1,
    });
    await flush();
    expect(transient.transport.retries).toBe(1);
    expect(transient.service.state).toBe('connecting');

    for (const [code, reason] of [
      [BRIDGE_ERROR_CODES.tokenInvalid, 'token-invalid'],
      [BRIDGE_ERROR_CODES.tokenRevoked, 'token-revoked'],
      [BRIDGE_ERROR_CODES.tokenExpired, 'token-expired'],
      [BRIDGE_ERROR_CODES.deploymentMismatch, 'deployment-mismatch'],
    ] as const) {
      const terminal = harness({ identity: true, credential: INSTANCE_TOKEN });
      terminal.service.start();
      const n = await waitFor(terminal, 'deployment.negotiate');
      terminal.transport.emit(accept(n.requestId));
      const a = await waitFor(terminal, 'desktop.auth');
      terminal.transport.emit({ type: 'bridge.error', requestId: a.requestId, code, retryable: false, retryAfterMs: null, version: 1 });
      await flush();
      expect(terminal.service.terminalReason).toBe(reason);
    }
  });

  test('persists Bridge-issued rotation, retains previous-token grace, and fails closed on write failure', async () => {
    const h = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(h);
    const rotation = h.service.rotateInstanceToken();
    const rotate = await waitFor(h, 'desktop.token.rotate');
    h.transport.emit({
      type: 'desktop.token.rotated', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      instanceToken: ROTATED_TOKEN, tokenExpiresAtMs: 200_000,
      previousTokenGraceEndsAtMs: Date.now() + 300_000,
      requestId: rotate.requestId, version: 1,
    });
    await rotation;
    expect(h.credentials.value).toBe(ROTATED_TOKEN);
    expect(h.transport.sent.at(-1)).toMatchObject({
      type: 'desktop.token.rotate-ack',
      deploymentId: DEPLOYMENT_ID,
      instanceId: INSTANCE_ID,
      rotationRequestId: rotate.requestId,
    });
    expect(h.service.state).toBe('authenticated');

    const lostAck = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(lostAck);
    const lostAckRotation = lostAck.service.rotateInstanceToken();
    const lostAckRotate = await waitFor(lostAck, 'desktop.token.rotate');
    lostAck.transport.failNextSend = true;
    lostAck.transport.emit({
      type: 'desktop.token.rotated', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      instanceToken: ROTATED_TOKEN, tokenExpiresAtMs: 200_000,
      previousTokenGraceEndsAtMs: Date.now() + 300_000,
      requestId: lostAckRotate.requestId, version: 1,
    });
    await lostAckRotation;
    expect(lostAck.credentials.value).toBe(ROTATED_TOKEN);
    expect(lostAck.service.state).toBe('authenticated');
    expect(lostAck.records.some(record => record.event === 'transport.send-failed' && record.metadata.operation === 'rotate')).toBe(true);

    const failed = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(failed);
    failed.credentials.failSet = true;
    const failedRotation = failed.service.rotateInstanceToken();
    const failedRotate = await waitFor(failed, 'desktop.token.rotate');
    failed.transport.emit({
      type: 'desktop.token.rotated', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      instanceToken: ROTATED_TOKEN, tokenExpiresAtMs: 200_000,
      previousTokenGraceEndsAtMs: Date.now() + 300_000,
      requestId: failedRotate.requestId, version: 1,
    });
    await failedRotation;
    expect(failed.credentials.value).toBe(INSTANCE_TOKEN);
    expect(failed.transport.sent.some(message => message.type === 'desktop.token.rotate-ack')).toBe(false);
    expect(failed.service.state).toBe('credential-write-failed');
    expect(failed.transport.connected).toBe(false);
    expect(failed.service.retryAfterCredentialWriteFailure()).toBe(true);
    const recoveryNegotiate = failed.transport.sent.filter((m) => m.type === 'deployment.negotiate').at(-1)!;
    failed.transport.emit(accept(recoveryNegotiate.requestId));
    const recoveryAuth = failed.transport.sent.filter((m) => m.type === 'desktop.auth').at(-1)! as Extract<DesktopClientMessage, { type: 'desktop.auth' }>;
    expect(recoveryAuth.instanceToken).toBe(INSTANCE_TOKEN);
  });

  test('handles finite duplicate rotation delivery as explicit recovery and uses fresh correlation IDs', async () => {
    const h = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(h);
    const duplicate = h.service.rotateInstanceToken();
    const first = await waitFor(h, 'desktop.token.rotate');
    h.transport.emit({
      type: 'bridge.error', requestId: first.requestId,
      code: BRIDGE_ERROR_CODES.credentialDeliveryUnknown,
      retryable: false, retryAfterMs: null, version: BRIDGE_PROTOCOL_VERSION,
    });
    await expect(duplicate).rejects.toThrow('bridge');
    expect(h.service.state).toBe('credential-delivery-unknown');
    expect(h.credentials.value).toBe(INSTANCE_TOKEN);
    expect(h.transport.sent.some(message => message.type === 'desktop.token.rotate-ack')).toBe(false);

    h.transport.close();
    h.transport.reopen();
    await flush();
    const reconnectNegotiate = h.transport.sent.filter((message): message is Extract<DesktopClientMessage, { type: 'deployment.negotiate' }> => message.type === 'deployment.negotiate').at(-1)!;
    h.transport.emit(accept(reconnectNegotiate.requestId));
    for (let i = 0; i < 20 && h.transport.sent.filter(message => message.type === 'desktop.auth').length < 2; i++) await flush();
    const reconnectAuth = h.transport.sent.filter((message): message is Extract<DesktopClientMessage, { type: 'desktop.auth' }> => message.type === 'desktop.auth').at(-1)!;
    h.transport.emit(authenticated(reconnectAuth.requestId));
    await flush();
    expect(h.service.state).toBe('credential-delivery-unknown');

    const recovery = h.service.rotateInstanceToken();
    await flush();
    const requests = h.transport.sent.filter((message): message is Extract<DesktopClientMessage, { type: 'desktop.token.rotate' }> => message.type === 'desktop.token.rotate');
    expect(requests).toHaveLength(2);
    const fresh = requests.at(-1)!;
    expect(fresh.requestId).not.toBe(first.requestId);
    expect(fresh.idempotencyKey).not.toBe(first.idempotencyKey);
    h.transport.emit({
      type: 'desktop.token.rotated', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      instanceToken: ROTATED_TOKEN, tokenExpiresAtMs: 200_000,
      previousTokenGraceEndsAtMs: Date.now() + 300_000,
      requestId: fresh.requestId, version: BRIDGE_PROTOCOL_VERSION,
    });
    await recovery;
    expect(h.service.state).toBe('authenticated');
    expect(h.credentials.value).toBe(ROTATED_TOKEN);
  });

  test('does not leak tokens or wire frames through state, profile, or metadata logs', async () => {
    const h = harness({ identity: true, credential: INSTANCE_TOKEN });
    await driveToAuth(h);
    const observable = JSON.stringify({ state: h.service.state, profile: h.service.profile, logs: h.records });
    expect(observable).not.toContain(INSTANCE_TOKEN);
    expect(observable).not.toContain('desktop.auth');
    expect(observable).not.toContain('instanceToken');
  });
});
