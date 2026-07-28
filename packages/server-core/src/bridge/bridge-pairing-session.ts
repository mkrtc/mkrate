import type { BridgeCommandCapability } from '@mkrate/bridge-protocol';
import {
  type BindingRevokedMessage,
  type PairingApprovedMessage,
  type PairingOpenedMessage,
  type PairingRejectReason,
  type PairingRejectedMessage,
  type PairingRequestMessage,
} from './bridge-connector-service.ts';
import { NULL_BRIDGE_LOGGER, type BridgeLogger } from './bridge-logging.ts';

export type BridgePairingSessionState =
  | 'open'
  | 'deciding'
  | 'approved'
  | 'rejected'
  | 'decision-unknown'
  | 'expired'
  | 'lost'
  | 'closed';

/** Public Desktop metadata. Long-lived mobile credentials and hashes are absent by design. */
export interface BridgePairingRequestMetadata {
  pairingRequestId: string;
  deviceId: string;
  deviceName: string;
  bindingId: string;
  requestedCapabilities: readonly BridgeCommandCapability[];
  requestedAtMs: number;
  expiresAtMs: number;
}

export interface BridgePairingDisplayMetadata {
  pairingSessionId: string;
  qrPayload: string;
  manualCodeEnabled: boolean;
  manualCode?: string;
  expiresAtMs: number;
  renewEveryMs: number;
  leaseLostAfterMs: number;
}

export interface BridgePairingChannel {
  approvePairing(input: {
    pairingSessionId: string;
    pairingRequestId: string;
    bindingId: string;
    grantedCapabilities: readonly BridgeCommandCapability[];
  }): Promise<PairingApprovedMessage>;
  rejectPairing(input: {
    pairingSessionId: string;
    pairingRequestId: string;
    reason: PairingRejectReason;
  }): Promise<PairingRejectedMessage>;
  revokeBinding(bindingId: string): Promise<BindingRevokedMessage>;
}

export interface BridgePairingSessionOptions {
  opened: PairingOpenedMessage;
  generation: number;
  channel: BridgePairingChannel;
  isGenerationCurrent: (generation: number) => boolean;
  now?: () => number;
  logger?: BridgeLogger;
  onStateChange?: (state: BridgePairingSessionState) => void;
}

/**
 * A single leased pairing epoch. At most one request may be pending and approval
 * is not successful until the exact Desktop-recipient durable metadata ack arrives.
 */
export class BridgePairingSession {
  readonly #opened: PairingOpenedMessage;
  readonly #generation: number;
  readonly #channel: BridgePairingChannel;
  readonly #isGenerationCurrent: (generation: number) => boolean;
  readonly #now: () => number;
  readonly #logger: BridgeLogger;
  readonly #onStateChange?: BridgePairingSessionOptions['onStateChange'];
  readonly #revokedBindings = new Set<string>();
  readonly #revocationsInFlight = new Map<string, Promise<void>>();

  #state: BridgePairingSessionState = 'open';
  #pending: BridgePairingRequestMetadata | null = null;
  #decisionBindingId: string | null = null;

  constructor(options: BridgePairingSessionOptions) {
    this.#opened = options.opened;
    this.#generation = options.generation;
    this.#channel = options.channel;
    this.#isGenerationCurrent = options.isGenerationCurrent;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? NULL_BRIDGE_LOGGER;
    this.#onStateChange = options.onStateChange;
  }

  get state(): BridgePairingSessionState {
    return this.#state;
  }

  get displayMetadata(): Readonly<BridgePairingDisplayMetadata> {
    const metadata: BridgePairingDisplayMetadata = {
      pairingSessionId: this.#opened.pairingSessionId,
      qrPayload: this.#opened.qrPayload,
      manualCodeEnabled: this.#opened.manualCodeEnabled,
      expiresAtMs: this.#opened.expiresAtMs,
      renewEveryMs: this.#opened.renewEveryMs,
      leaseLostAfterMs: this.#opened.leaseLostAfterMs,
    };
    if (this.#opened.manualCode !== null) metadata.manualCode = this.#opened.manualCode;
    return Object.freeze(metadata);
  }

  get pendingRequest(): Readonly<BridgePairingRequestMetadata> | null {
    return this.#pending;
  }

  acceptRequest(message: PairingRequestMessage): boolean {
    if (!this.#isLive() || message.pairingSessionId !== this.#opened.pairingSessionId) return false;
    if (message.expiresAtMs <= this.#now() || message.expiresAtMs > this.#opened.expiresAtMs) return false;
    if (this.#pending) return false;
    this.#pending = Object.freeze({
      pairingRequestId: message.pairingRequestId,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      bindingId: message.bindingId,
      requestedCapabilities: Object.freeze([...message.requestedCapabilities]),
      requestedAtMs: message.requestedAtMs,
      expiresAtMs: message.expiresAtMs,
    });
    this.#logger.log('info', 'pairing.request-received', { generation: this.#generation });
    return true;
  }

  async approve(grantedCapabilities: readonly BridgeCommandCapability[]): Promise<Readonly<PairingApprovedMessage>> {
    const request = this.#requirePending();
    if (request.expiresAtMs <= this.#now()) {
      this.expire();
      throw new Error('Pairing request expired');
    }
    const requested = new Set(request.requestedCapabilities);
    if (grantedCapabilities.length === 0 || grantedCapabilities.some((capability) => !requested.has(capability))) {
      throw new Error('Granted capabilities must be a non-empty subset of requested capabilities');
    }

    this.#decisionBindingId = request.bindingId;
    this.#setState('deciding');
    try {
      const ack = await this.#channel.approvePairing({
        pairingSessionId: this.#opened.pairingSessionId,
        pairingRequestId: request.pairingRequestId,
        bindingId: request.bindingId,
        grantedCapabilities,
      });
      if (!this.#isLiveGeneration() || this.#state !== 'deciding') {
        await this.#revokeOnce(request.bindingId).catch(() => {});
        this.#setState('lost');
        throw new Error('Late pairing approval fenced by a newer lease generation');
      }
      this.#pending = null;
      this.#setState('approved');
      this.#logger.log('info', 'pairing.decision-committed', { generation: this.#generation, operation: 'pairing-approve' });
      return Object.freeze({ ...ack });
    } catch (error) {
      if (this.#state === 'deciding') {
        // An approve may have committed remotely even when its ack was lost.
        this.#setState('decision-unknown');
        await this.#revokeOnce(request.bindingId).catch(() => {});
      }
      throw error;
    }
  }

  async reject(reason: PairingRejectReason): Promise<Readonly<PairingRejectedMessage>> {
    const request = this.#requirePending();
    this.#setState('deciding');
    try {
      const ack = await this.#channel.rejectPairing({
        pairingSessionId: this.#opened.pairingSessionId,
        pairingRequestId: request.pairingRequestId,
        reason,
      });
      if (!this.#isLiveGeneration() || this.#state !== 'deciding') {
        this.#setState('lost');
        throw new Error('Late pairing rejection fenced by a newer lease generation');
      }
      this.#pending = null;
      this.#setState('rejected');
      this.#logger.log('info', 'pairing.decision-committed', { generation: this.#generation, operation: 'pairing-reject' });
      return Object.freeze({ ...ack });
    } catch (error) {
      if (this.#state === 'deciding') this.#setState('decision-unknown');
      throw error;
    }
  }

  /** Apply an authoritative Bridge rejection/expiry for the pending request. */
  handleRejected(message: PairingRejectedMessage): boolean {
    if (!this.#pending || message.pairingRequestId !== this.#pending.pairingRequestId) return false;
    this.#pending = null;
    this.#setState(message.reason === 'expired' ? 'expired' : 'rejected');
    return true;
  }

  async revokeApprovedBinding(): Promise<boolean> {
    const bindingId = this.#decisionBindingId ?? this.#pending?.bindingId;
    if (!bindingId) return false;
    await this.#revokeOnce(bindingId);
    return true;
  }

  close(): void {
    this.#pending = null;
    this.#setState('closed');
  }

  lose(): void {
    this.#pending = null;
    this.#setState('lost');
  }

  expire(): void {
    this.#pending = null;
    this.#setState('expired');
  }

  #requirePending(): BridgePairingRequestMetadata {
    if (!this.#isLive()) throw new Error('Pairing lease is not active');
    if (!this.#pending) throw new Error('No pending pairing request');
    return this.#pending;
  }

  #isLive(): boolean {
    return this.#state === 'open' && this.#isLiveGeneration() && this.#opened.expiresAtMs > this.#now();
  }

  #isLiveGeneration(): boolean {
    return this.#isGenerationCurrent(this.#generation);
  }

  async #revokeOnce(bindingId: string): Promise<void> {
    if (this.#revokedBindings.has(bindingId)) return;
    const existing = this.#revocationsInFlight.get(bindingId);
    if (existing) return existing;
    const operation = this.#channel.revokeBinding(bindingId).then(() => {
      this.#revokedBindings.add(bindingId);
      this.#logger.log('info', 'pairing.binding-revoked', { operation: 'binding-revoke' });
    }).finally(() => {
      this.#revocationsInFlight.delete(bindingId);
    });
    this.#revocationsInFlight.set(bindingId, operation);
    return operation;
  }

  #setState(state: BridgePairingSessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange?.(state);
  }
}
