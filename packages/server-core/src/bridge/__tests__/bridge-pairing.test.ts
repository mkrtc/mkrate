import { describe, expect, test } from 'bun:test';
import { encodeBase64Url, type BridgeCommandCapability } from '@mkrate/bridge-protocol';
import type {
  BindingRevokedMessage,
  PairingApprovedMessage,
  PairingCloseReason,
  PairingOpenedMessage,
  PairingRejectReason,
  PairingRejectedMessage,
  PairingRequestMessage,
} from '../bridge-connector-service.ts';
import { BridgePairingLease, type BridgePairingLeaseChannel, type BridgePairingLeaseTimers } from '../bridge-pairing-lease.ts';

function id(byte: number): string { return encodeBase64Url(new Uint8Array(16).fill(byte)); }

class ManualTimers implements BridgePairingLeaseTimers {
  time = 1_000;
  next = 1;
  jobs = new Map<number, { at: number; callback: () => void; interval: number | null }>();
  now = (): number => this.time;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const key = this.next++;
    this.jobs.set(key, { at: this.time + delayMs, callback, interval: null });
    return key as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void { this.jobs.delete(handle as unknown as number); }
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval> {
    const key = this.next++;
    this.jobs.set(key, { at: this.time + delayMs, callback, interval: delayMs });
    return key as unknown as ReturnType<typeof setInterval>;
  }
  clearInterval(handle: ReturnType<typeof setInterval>): void { this.jobs.delete(handle as unknown as number); }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const due = [...this.jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [key, job] = due;
      this.time = job.at;
      if (job.interval === null) this.jobs.delete(key);
      else job.at += job.interval;
      job.callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;
  constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}

class FakeChannel implements BridgePairingLeaseChannel {
  isAuthenticated = true;
  pairingListeners = new Set<(message: PairingRequestMessage) => void>();
  pairingRejectedListeners = new Set<(message: PairingRejectedMessage) => void>();
  authListeners = new Set<(authenticated: boolean) => void>();
  closeCalls: Array<{ pairingSessionId: string; reason: PairingCloseReason }> = [];
  renewCalls = 0;
  renewFails = false;
  revokeCalls: string[] = [];
  approveDeferred: Deferred<PairingApprovedMessage> | null = null;
  opened: PairingOpenedMessage;

  constructor(now: number, ttl = 120_000) {
    this.opened = {
      type: 'pairing.opened', deploymentId: id(1), instanceId: id(2), pairingSessionId: id(3),
      qrPayload: '{"safe":"metadata"}', manualCodeEnabled: true, manualCode: 'ABCD-2345',
      expiresAtMs: now + ttl, renewEveryMs: 3_000, leaseLostAfterMs: 8_000,
      requestId: id(4), version: 1,
    };
  }
  async openPairing(): Promise<PairingOpenedMessage> { return this.opened; }
  async renewPairing(): Promise<void> { this.renewCalls += 1; if (this.renewFails) throw new Error('lost'); }
  async closePairing(pairingSessionId: string, reason: PairingCloseReason): Promise<void> {
    this.closeCalls.push({ pairingSessionId, reason });
  }
  onPairingRequest(listener: (message: PairingRequestMessage) => void): () => void {
    this.pairingListeners.add(listener); return () => this.pairingListeners.delete(listener);
  }
  onPairingRejected(listener: (message: PairingRejectedMessage) => void): () => void {
    this.pairingRejectedListeners.add(listener); return () => this.pairingRejectedListeners.delete(listener);
  }
  onAuthenticatedChange(listener: (authenticated: boolean) => void): () => void {
    this.authListeners.add(listener); return () => this.authListeners.delete(listener);
  }
  setAuthenticated(value: boolean): void {
    this.isAuthenticated = value;
    for (const listener of this.authListeners) listener(value);
  }
  emitRequest(message: PairingRequestMessage): void {
    for (const listener of this.pairingListeners) listener(message);
  }
  emitRejected(message: PairingRejectedMessage): void {
    for (const listener of this.pairingRejectedListeners) listener(message);
  }
  async approvePairing(input: {
    pairingSessionId: string; pairingRequestId: string; bindingId: string;
    grantedCapabilities: readonly BridgeCommandCapability[];
  }): Promise<PairingApprovedMessage> {
    if (this.approveDeferred) return this.approveDeferred.promise;
    return approval(input);
  }
  async rejectPairing(input: {
    pairingSessionId: string; pairingRequestId: string; reason: PairingRejectReason;
  }): Promise<PairingRejectedMessage> {
    return { type: 'pairing.rejected', pairingRequestId: input.pairingRequestId, reason: input.reason, requestId: id(8), version: 1 };
  }
  async revokeBinding(bindingId: string): Promise<BindingRevokedMessage> {
    this.revokeCalls.push(bindingId);
    return { type: 'binding.revoked', deploymentId: id(1), instanceId: id(2), bindingId, revokedAtMs: 2_000, requestId: id(9), version: 1 };
  }
}

function request(byte = 10, expiresAtMs = 100_000): PairingRequestMessage {
  return {
    type: 'pairing.request', pairingSessionId: id(3), pairingRequestId: id(byte), deviceId: id(11),
    deviceName: 'Phone', bindingId: id(12), requestedCapabilities: ['session.list', 'session.snapshot'],
    requestedAtMs: 1_100, expiresAtMs, requestId: id(13), version: 1,
  };
}
function approval(input: {
  pairingSessionId: string; pairingRequestId: string; bindingId: string;
  grantedCapabilities: readonly BridgeCommandCapability[];
}): PairingApprovedMessage {
  return {
    type: 'pairing.approved', recipient: 'desktop', pairingSessionId: input.pairingSessionId,
    pairingRequestId: input.pairingRequestId, bindingId: input.bindingId,
    grantedCapabilities: [...input.grantedCapabilities], committedAtMs: 2_000, requestId: id(14), version: 1,
  };
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }
async function openedLease(ttl = 120_000): Promise<{ lease: BridgePairingLease; channel: FakeChannel; timers: ManualTimers }> {
  const timers = new ManualTimers();
  const channel = new FakeChannel(timers.now(), ttl);
  const lease = new BridgePairingLease({ channel, timers });
  lease.show('dialog');
  await flush();
  expect(lease.session).not.toBeNull();
  return { lease, channel, timers };
}

describe('Bridge leased pairing', () => {
  test('cannot outlive hide, minimize, close, expiry, authentication loss, or renew loss', async () => {
    for (const [action, reason] of [
      ['hide', 'ui-hidden'], ['minimize', 'ui-minimized'], ['closeOwner', 'ui-closed'],
    ] as const) {
      const h = await openedLease();
      h.lease[action]('dialog');
      await flush();
      expect(h.lease.session).toBeNull();
      expect(h.channel.closeCalls.at(-1)?.reason).toBe(reason);
      h.lease.dispose();
    }

    const expired = await openedLease(100);
    await expired.timers.advance(100);
    expect(expired.lease.session).toBeNull();

    const authLost = await openedLease();
    authLost.channel.setAuthenticated(false);
    expect(authLost.lease.session).toBeNull();

    const renewLost = await openedLease();
    renewLost.channel.renewFails = true;
    await renewLost.timers.advance(3_000);
    expect(renewLost.lease.session).toBeNull();
  });

  test('accepts only one pending request and exposes metadata without binding token/hash', async () => {
    const h = await openedLease();
    h.channel.emitRequest(request(20));
    h.channel.emitRequest(request(21));
    expect(h.lease.session?.pendingRequest?.pairingRequestId).toBe(id(20));
    const visible = JSON.stringify({
      display: h.lease.session?.displayMetadata,
      request: h.lease.session?.pendingRequest,
    });
    expect(visible).not.toContain('bindingToken');
    expect(visible).not.toContain('tokenHash');
    expect(visible).not.toContain('pairingSecret');
  });

  test('does not report approval before authoritative Desktop ack', async () => {
    const h = await openedLease();
    h.channel.emitRequest(request(30));
    const deferred = new Deferred<PairingApprovedMessage>();
    h.channel.approveDeferred = deferred;
    const approvalPromise = h.lease.session!.approve(['session.list']);
    await flush();
    expect(h.lease.session?.state).toBe('deciding');
    deferred.resolve(approval({
      pairingSessionId: id(3), pairingRequestId: id(30), bindingId: id(12), grantedCapabilities: ['session.list'],
    }));
    await expect(approvalPromise).resolves.toMatchObject({ type: 'pairing.approved', recipient: 'desktop' });
    expect(h.lease.session?.state).toBe('approved');
    await h.lease.session!.revokeApprovedBinding();
    await h.lease.session!.revokeApprovedBinding();
    expect(h.channel.revokeCalls).toEqual([id(12)]);
  });

  test('fences late approval, never treats ambiguity as success, and revokes binding once', async () => {
    const late = await openedLease();
    late.channel.emitRequest(request(40));
    const deferred = new Deferred<PairingApprovedMessage>();
    late.channel.approveDeferred = deferred;
    const decision = late.lease.session!.approve(['session.list']);
    await flush();
    late.lease.hide('dialog');
    deferred.resolve(approval({
      pairingSessionId: id(3), pairingRequestId: id(40), bindingId: id(12), grantedCapabilities: ['session.list'],
    }));
    await expect(decision).rejects.toThrow('fenced');
    expect(late.channel.revokeCalls).toEqual([id(12)]);

    const ambiguous = await openedLease();
    ambiguous.channel.emitRequest(request(41));
    const failed = new Deferred<PairingApprovedMessage>();
    ambiguous.channel.approveDeferred = failed;
    const unknown = ambiguous.lease.session!.approve(['session.list']);
    failed.reject(new Error('ack lost'));
    await expect(unknown).rejects.toThrow('ack lost');
    expect(ambiguous.lease.session?.state).toBe('decision-unknown');
    expect(ambiguous.channel.revokeCalls).toEqual([id(12)]);
  });

  test('applies authoritative Bridge expiry to the exact pending request', async () => {
    const h = await openedLease();
    h.channel.emitRequest(request(49));
    h.channel.emitRejected({
      type: 'pairing.rejected', pairingRequestId: id(49), reason: 'expired', requestId: id(48), version: 1,
    });
    expect(h.lease.session?.state).toBe('expired');
    expect(h.lease.session?.pendingRequest).toBeNull();
  });

  test('requires explicit reject and records authoritative rejection', async () => {
    const h = await openedLease();
    h.channel.emitRequest(request(50));
    await expect(h.lease.session!.reject('user-rejected')).resolves.toMatchObject({
      type: 'pairing.rejected', reason: 'user-rejected',
    });
    expect(h.lease.session?.state).toBe('rejected');
    expect(h.lease.session?.pendingRequest).toBeNull();
  });
});
