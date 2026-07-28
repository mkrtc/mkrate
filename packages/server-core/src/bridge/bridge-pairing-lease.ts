import type {
  BridgeConnectorService,
  PairingCloseReason,
  PairingRejectedMessage,
  PairingRequestMessage,
} from './bridge-connector-service.ts';
import { NULL_BRIDGE_LOGGER, type BridgeLogger } from './bridge-logging.ts';
import { BridgePairingSession, type BridgePairingChannel } from './bridge-pairing-session.ts';

export interface BridgePairingLeaseChannel extends BridgePairingChannel {
  readonly isAuthenticated: boolean;
  openPairing(allowManualCode: boolean): ReturnType<BridgeConnectorService['openPairing']>;
  renewPairing(pairingSessionId: string): Promise<void>;
  closePairing(pairingSessionId: string, reason: PairingCloseReason): Promise<void>;
  onPairingRequest(listener: (message: PairingRequestMessage) => void): () => void;
  onPairingRejected(listener: (message: PairingRejectedMessage) => void): () => void;
  onAuthenticatedChange(listener: (authenticated: boolean) => void): () => void;
}

export interface BridgePairingLeaseTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const DEFAULT_TIMERS: BridgePairingLeaseTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

export interface BridgePairingLeaseOptions {
  channel: BridgePairingLeaseChannel;
  timers?: BridgePairingLeaseTimers;
  logger?: BridgeLogger;
  onSessionChange?: (session: BridgePairingSession | null) => void;
}

/**
 * Couples a Bridge pairing epoch to one visible, non-minimized UI owner and an
 * authenticated Desktop connection. Hiding, minimizing, closing, expiry, or
 * authentication loss immediately fences the generation and ends the lease.
 */
export class BridgePairingLease {
  readonly #channel: BridgePairingLeaseChannel;
  readonly #timers: BridgePairingLeaseTimers;
  readonly #logger: BridgeLogger;
  readonly #onSessionChange?: BridgePairingLeaseOptions['onSessionChange'];
  readonly #unsubscribePairing: () => void;
  readonly #unsubscribePairingRejected: () => void;
  readonly #unsubscribeAuth: () => void;

  #ownerId: string | null = null;
  #visible = false;
  #minimized = false;
  #allowManualCode = true;
  #generation = 0;
  #opening = false;
  #session: BridgePairingSession | null = null;
  #renewInterval: ReturnType<typeof setInterval> | null = null;
  #expiryTimeout: ReturnType<typeof setTimeout> | null = null;
  #lastRenewedAtMs = 0;
  #disposed = false;

  constructor(options: BridgePairingLeaseOptions) {
    this.#channel = options.channel;
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#logger = options.logger ?? NULL_BRIDGE_LOGGER;
    this.#onSessionChange = options.onSessionChange;
    this.#unsubscribePairing = this.#channel.onPairingRequest((message) => this.#handlePairingRequest(message));
    this.#unsubscribePairingRejected = this.#channel.onPairingRejected((message) => {
      this.#session?.handleRejected(message);
    });
    this.#unsubscribeAuth = this.#channel.onAuthenticatedChange((authenticated) => {
      if (!authenticated) {
        this.#loseLease();
      } else {
        this.#maybeOpen();
      }
    });
  }

  get session(): BridgePairingSession | null {
    return this.#session;
  }

  get generation(): number {
    return this.#generation;
  }

  show(ownerId: string, options: { allowManualCode?: boolean } = {}): void {
    this.#assertOwnerId(ownerId);
    if (this.#disposed) throw new Error('Pairing lease is disposed');
    if (this.#ownerId && this.#ownerId !== ownerId) {
      this.#closeLocal('ui-closed');
    }
    this.#ownerId = ownerId;
    this.#visible = true;
    this.#minimized = false;
    this.#allowManualCode = options.allowManualCode ?? true;
    this.#maybeOpen();
  }

  hide(ownerId: string): void {
    if (!this.#owns(ownerId)) return;
    this.#visible = false;
    this.#closeLocal('ui-hidden');
  }

  minimize(ownerId: string): void {
    if (!this.#owns(ownerId)) return;
    this.#minimized = true;
    this.#closeLocal('ui-minimized');
  }

  closeOwner(ownerId: string): void {
    if (!this.#owns(ownerId)) return;
    this.#visible = false;
    this.#ownerId = null;
    this.#closeLocal('ui-closed');
  }

  cancel(ownerId: string): void {
    if (!this.#owns(ownerId)) return;
    this.#visible = false;
    this.#closeLocal('user-cancelled');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#visible = false;
    this.#ownerId = null;
    this.#closeLocal('ui-closed');
    this.#unsubscribePairing();
    this.#unsubscribePairingRejected();
    this.#unsubscribeAuth();
  }

  #maybeOpen(): void {
    if (
      this.#disposed
      || this.#opening
      || this.#session
      || !this.#ownerId
      || !this.#visible
      || this.#minimized
      || !this.#channel.isAuthenticated
    ) return;

    const generation = ++this.#generation;
    this.#opening = true;
    void this.#channel.openPairing(this.#allowManualCode).then(async (opened) => {
      this.#opening = false;
      if (!this.#isGenerationVisible(generation)) {
        try {
          await this.#channel.closePairing(opened.pairingSessionId, 'ui-hidden');
        } catch {
          // The local generation fence is authoritative for Desktop behavior.
        }
        return;
      }
      this.#lastRenewedAtMs = this.#timers.now();
      this.#session = new BridgePairingSession({
        opened,
        generation,
        channel: this.#channel,
        isGenerationCurrent: (candidate) => candidate === this.#generation && this.#isGenerationVisible(candidate),
        now: this.#timers.now,
        logger: this.#logger,
      });
      this.#logger.log('info', 'pairing.lease-opened', { generation });
      this.#onSessionChange?.(this.#session);
      this.#scheduleLease(generation);
    }).catch(() => {
      this.#opening = false;
      if (generation === this.#generation && this.#visible && this.#channel.isAuthenticated) {
        this.#loseLease();
      }
    });
  }

  #scheduleLease(generation: number): void {
    const session = this.#session;
    if (!session) return;
    const metadata = session.displayMetadata;
    const expiresIn = Math.max(0, metadata.expiresAtMs - this.#timers.now());
    this.#expiryTimeout = this.#timers.setTimeout(() => {
      if (generation !== this.#generation) return;
      session.expire();
      this.#clearSession(false);
      this.#generation += 1;
      this.#logger.log('info', 'pairing.lease-closed', { generation, reason: 'expired' });
    }, expiresIn);
    this.#renewInterval = this.#timers.setInterval(() => {
      if (!this.#isGenerationVisible(generation) || this.#session !== session) return;
      const now = this.#timers.now();
      if (now - this.#lastRenewedAtMs >= metadata.leaseLostAfterMs) {
        this.#loseLease();
        return;
      }
      void this.#channel.renewPairing(metadata.pairingSessionId).then(() => {
        if (this.#isGenerationVisible(generation) && this.#session === session) {
          this.#lastRenewedAtMs = this.#timers.now();
        }
      }).catch(() => this.#loseLease());
    }, metadata.renewEveryMs);
  }

  #handlePairingRequest(message: PairingRequestMessage): void {
    this.#session?.acceptRequest(message);
  }

  #closeLocal(reason: PairingCloseReason): void {
    const generation = ++this.#generation;
    const sessionId = this.#session?.displayMetadata.pairingSessionId;
    this.#opening = false;
    this.#clearSession(true);
    this.#logger.log('info', 'pairing.lease-closed', { generation, reason });
    if (sessionId && this.#channel.isAuthenticated) {
      void this.#channel.closePairing(sessionId, reason).catch(() => {});
    }
  }

  #loseLease(): void {
    if (!this.#session && !this.#opening) return;
    const generation = ++this.#generation;
    this.#opening = false;
    this.#session?.lose();
    this.#clearSession(false);
    this.#logger.log('warn', 'pairing.lease-lost', { generation, reason: 'lease-lost' });
  }

  #clearSession(close: boolean): void {
    this.#clearTimers();
    if (close) this.#session?.close();
    if (this.#session) {
      this.#session = null;
      this.#onSessionChange?.(null);
    }
  }

  #clearTimers(): void {
    if (this.#renewInterval) {
      this.#timers.clearInterval(this.#renewInterval);
      this.#renewInterval = null;
    }
    if (this.#expiryTimeout) {
      this.#timers.clearTimeout(this.#expiryTimeout);
      this.#expiryTimeout = null;
    }
  }

  #isGenerationVisible(generation: number): boolean {
    return (
      generation === this.#generation
      && !this.#disposed
      && this.#visible
      && !this.#minimized
      && this.#ownerId !== null
      && this.#channel.isAuthenticated
    );
  }

  #owns(ownerId: string): boolean {
    return this.#ownerId === ownerId;
  }

  #assertOwnerId(ownerId: string): void {
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0) throw new Error('Visible pairing owner id is required');
  }
}
