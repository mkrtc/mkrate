import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_PROTOCOL_VERSION,
  BYTE_LENGTHS,
  COMMAND_CAPABILITIES,
  SECURITY_LIMITS,
  encodeBase64Url,
  tokenSchema,
  type BridgeCommandCapability,
  type CommandResultBody,
  type DesktopClientMessage,
  type DesktopServerMessage,
  type TimelineEvent,
} from '@mkrate/bridge-protocol';
import type { BridgeProfile } from '@craft-agent/shared/config';
import {
  bridgeCredentialMatches,
  createBridgeCredentialEnvelope,
  type BridgeCredentialEnvelope,
} from '@craft-agent/shared/credentials';
import { NULL_BRIDGE_LOGGER, type BridgeLogger } from './bridge-logging.ts';
import {
  BridgeTransport,
  type BridgeTransportFault,
  type BridgeTransportOptions,
} from './bridge-transport.ts';

export type BridgeConnectorState =
  | 'stopped'
  | 'connecting'
  | 'negotiating'
  | 'enrolling'
  | 'enrollment-unknown'
  | 'authenticating'
  | 'authenticated'
  | 'rotating'
  | 'credential-delivery-unknown'
  | 'credential-write-failed'
  | 'terminal';

export type BridgeTerminalReason =
  | 'configuration-invalid'
  | 'credential-missing'
  | 'credential-store-failed'
  | 'credential-binding-invalid'
  | 'identity-persist-failed'
  | 'protocol-error'
  | 'deployment-mismatch'
  | 'instance-mismatch'
  | 'token-invalid'
  | 'token-expired'
  | 'token-revoked'
  | 'instance-not-found'
  | 'unauthorized'
  | 'enrollment-rejected';

export type PairingOpenedMessage = Extract<DesktopServerMessage, { type: 'pairing.opened' }>;
export type PairingRequestMessage = Extract<DesktopServerMessage, { type: 'pairing.request' }>;
export type PairingApprovedMessage = Extract<DesktopServerMessage, { type: 'pairing.approved' }>;
export type PairingRejectedMessage = Extract<DesktopServerMessage, { type: 'pairing.rejected' }>;
export type DesktopRevokedMessage = Extract<DesktopServerMessage, { type: 'desktop.revoked' }>;
export type BindingRevokedMessage = Extract<DesktopServerMessage, { type: 'binding.revoked' }>;
export type PresenceChangedMessage = Extract<DesktopServerMessage, { type: 'presence.changed' }>;
export type PairingCloseReason = Extract<DesktopClientMessage, { type: 'pairing.close' }>['reason'];
export type PairingRejectReason = Extract<DesktopClientMessage, { type: 'pairing.reject' }>['reason'];
export type SubscriptionCloseReason = Extract<DesktopClientMessage, { type: 'session.subscription.closed' }>['reason'];

export function isValidBridgeEnrollmentToken(value: unknown): value is string {
  return tokenSchema.safeParse(value).success;
}

export interface BridgeCredentialAccess {
  getBridgeInstanceCredential(profileId: string): Promise<BridgeCredentialEnvelope | null>;
  setBridgeInstanceCredential(envelope: BridgeCredentialEnvelope): Promise<void>;
  deleteBridgeInstanceToken(profileId: string): Promise<boolean>;
}

export interface BridgeTransportPort {
  readonly connected: boolean;
  start(): void;
  stop(): void;
  retry(): void;
  send(message: DesktopClientMessage): Promise<void>;
}

interface BridgeTransportCallbacks {
  onOpen(): void;
  onMessage(message: DesktopServerMessage): void;
  onClose(event: { code: number; retrying: boolean }): void;
  onFault(fault: BridgeTransportFault): void;
}

export interface BridgeConnectorTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMERS: BridgeConnectorTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface BridgeConnectorServiceOptions {
  profile: BridgeProfile;
  credentials: BridgeCredentialAccess;
  enrollmentToken?: string;
  clientVersion?: string;
  allowInsecureLoopback?: boolean;
  logger?: BridgeLogger;
  randomBytes?: (length: number) => Uint8Array;
  timers?: BridgeConnectorTimers;
  requestTimeoutMs?: number;
  /** Crash-recoverable profile + encrypted credential commit (required for enrollment). */
  commitEnrollment?: (profile: BridgeProfile, instanceToken: string) => Promise<BridgeProfile>;
  transportFactory?: (callbacks: BridgeTransportCallbacks) => BridgeTransportPort;
  webSocketFactory?: BridgeTransportOptions['webSocketFactory'];
  onStateChange?: (state: BridgeConnectorState, terminalReason: BridgeTerminalReason | null) => void;
  onCommandRequest?: (message: Extract<DesktopServerMessage, { type: 'command.request' }>) => void;
  onPresenceChanged?: (message: PresenceChangedMessage) => void;
}

type DesktopServerMessageType = DesktopServerMessage['type'];
type DesktopServerMessageOf<K extends DesktopServerMessageType> = Extract<DesktopServerMessage, { type: K }>;

interface PendingRequest {
  requestId: string;
  expectedType: DesktopServerMessageType;
  operation: string;
  validate: (message: DesktopServerMessage) => boolean;
  resolve: (message: DesktopServerMessage) => void;
  reject: (error: BridgeRequestError) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class BridgeRequestError extends Error {
  constructor(
    readonly kind: 'transport' | 'timeout' | 'bridge' | 'protocol',
    readonly bridgeCode: string | null = null,
    readonly retryable = false,
  ) {
    super(kind);
    this.name = 'BridgeRequestError';
  }
}

function isTerminalAuthCode(code: string): BridgeTerminalReason | null {
  switch (code) {
    case BRIDGE_ERROR_CODES.tokenInvalid: return 'token-invalid';
    case BRIDGE_ERROR_CODES.tokenExpired: return 'token-expired';
    case BRIDGE_ERROR_CODES.tokenRevoked: return 'token-revoked';
    case BRIDGE_ERROR_CODES.deploymentMismatch: return 'deployment-mismatch';
    case BRIDGE_ERROR_CODES.instanceNotFound: return 'instance-not-found';
    case BRIDGE_ERROR_CODES.unauthorized: return 'unauthorized';
    default: return null;
  }
}

/**
 * One-profile Desktop connector. Lifecycle calls are concrete Bridge operations;
 * there is deliberately no arbitrary method/payload RPC API.
 */
export class BridgeConnectorService {
  readonly #credentials: BridgeCredentialAccess;
  readonly #clientVersion: string;
  readonly #allowInsecureLoopback: boolean;
  readonly #logger: BridgeLogger;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #timers: BridgeConnectorTimers;
  readonly #requestTimeoutMs: number;
  readonly #commitEnrollment?: BridgeConnectorServiceOptions['commitEnrollment'];
  readonly #transport: BridgeTransportPort;
  readonly #onStateChange?: BridgeConnectorServiceOptions['onStateChange'];
  readonly #onCommandRequest?: BridgeConnectorServiceOptions['onCommandRequest'];
  readonly #onPresenceChanged?: BridgeConnectorServiceOptions['onPresenceChanged'];

  #profile: BridgeProfile;
  #state: BridgeConnectorState = 'stopped';
  #terminalReason: BridgeTerminalReason | null = null;
  #bootstrap: string | null;
  #pending = new Map<string, PendingRequest>();
  #settledRequestIds: string[] = [];
  #pairingListeners = new Set<(message: PairingRequestMessage) => void>();
  #pairingRejectedListeners = new Set<(message: PairingRejectedMessage) => void>();
  #authListeners = new Set<(authenticated: boolean) => void>();
  #handshakeGeneration = 0;
  #authenticated = false;
  #stopping = true;
  #enrollmentSubmitted = false;
  #previousCredential: { token: string; graceEndsAtMs: number; attempted: boolean } | null = null;
  #authTokenOverride: string | null = null;
  #rotationRecoveryRequired = false;

  constructor(options: BridgeConnectorServiceOptions) {
    this.#profile = { ...options.profile };
    this.#credentials = options.credentials;
    this.#clientVersion = options.clientVersion ?? '0.0.2';
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.#logger = options.logger ?? NULL_BRIDGE_LOGGER;
    this.#randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? SECURITY_LIMITS.routeTimeoutMs;
    this.#commitEnrollment = options.commitEnrollment;
    this.#onStateChange = options.onStateChange;
    this.#onCommandRequest = options.onCommandRequest;
    this.#onPresenceChanged = options.onPresenceChanged;
    if (options.enrollmentToken !== undefined && !tokenSchema.safeParse(options.enrollmentToken).success) {
      throw new Error('Invalid Bridge enrollment token');
    }
    this.#bootstrap = options.enrollmentToken ?? null;

    const callbacks: BridgeTransportCallbacks = {
      onOpen: () => this.#handleOpen(),
      onMessage: (message) => this.#handleMessage(message),
      onClose: (event) => this.#handleClose(event),
      onFault: (fault) => this.#handleFault(fault),
    };
    this.#transport = options.transportFactory?.(callbacks) ?? new BridgeTransport({
      baseUrl: this.#profile.url,
      allowInsecureLoopback: this.#allowInsecureLoopback,
      webSocketFactory: options.webSocketFactory,
      logger: this.#logger,
      onOpen: callbacks.onOpen,
      onMessage: callbacks.onMessage,
      onClose: callbacks.onClose,
      onFault: callbacks.onFault,
    });
  }

  get state(): BridgeConnectorState {
    return this.#state;
  }

  get terminalReason(): BridgeTerminalReason | null {
    return this.#terminalReason;
  }

  get profile(): Readonly<BridgeProfile> {
    return this.#profile;
  }

  get isAuthenticated(): boolean {
    return this.#authenticated;
  }

  start(): void {
    if (!this.#stopping) return;
    if (this.#state === 'enrollment-unknown' || this.#state === 'terminal') return;
    this.#stopping = false;
    this.#terminalReason = null;
    this.#setState('connecting');
    this.#transport.start();
  }

  stop(): void {
    if (this.#stopping && this.#state === 'stopped') return;
    this.#stopping = true;
    this.#handshakeGeneration += 1;
    this.#setAuthenticated(false);
    this.#rejectAllPending(new BridgeRequestError('transport'));
    this.#transport.stop();
    this.#setState('stopped');
  }

  /**
   * Replace a not-yet-submitted enrollment token. Once an enrollment frame was
   * attempted, ambiguity is terminal and a fresh operator reconciliation is required.
   */
  replaceEnrollmentToken(enrollmentToken: string): void {
    if (this.#enrollmentSubmitted || this.#state === 'enrollment-unknown') {
      throw new Error('Enrollment outcome is unknown; reconcile before using a new bootstrap');
    }
    if (!tokenSchema.safeParse(enrollmentToken).success) throw new Error('Invalid Bridge enrollment token');
    this.#bootstrap = enrollmentToken;
  }

  onPairingRequest(listener: (message: PairingRequestMessage) => void): () => void {
    this.#pairingListeners.add(listener);
    return () => this.#pairingListeners.delete(listener);
  }

  onPairingRejected(listener: (message: PairingRejectedMessage) => void): () => void {
    this.#pairingRejectedListeners.add(listener);
    return () => this.#pairingRejectedListeners.delete(listener);
  }

  onAuthenticatedChange(listener: (authenticated: boolean) => void): () => void {
    this.#authListeners.add(listener);
    return () => this.#authListeners.delete(listener);
  }

  async rotateInstanceToken(): Promise<void> {
    if (!this.#authenticated || (this.#state !== 'authenticated' && this.#state !== 'credential-delivery-unknown')) {
      throw new Error('Bridge Desktop is not authenticated for token rotation');
    }
    const currentCredential = await this.#readBoundCredential();
    if (this.#terminalReason) return;
    const currentToken = currentCredential?.instanceToken ?? null;
    if (!currentToken || !this.#profile.deploymentId || !this.#profile.instanceId) {
      this.#terminal('credential-missing');
      return;
    }

    this.#setState('rotating');
    const requestId = this.#id();
    let response: Extract<DesktopServerMessage, { type: 'desktop.token.rotated' }>;
    try {
      response = await this.#request({
        type: 'desktop.token.rotate',
        deploymentId: this.#profile.deploymentId,
        instanceId: this.#profile.instanceId,
        idempotencyKey: this.#id(),
        currentToken,
        requestId,
        version: BRIDGE_PROTOCOL_VERSION,
      }, 'desktop.token.rotated', 'rotate', (message) => (
        message.deploymentId === this.#profile.deploymentId
        && message.instanceId === this.#profile.instanceId
      ));
    } catch (error) {
      if (error instanceof BridgeRequestError && error.kind === 'bridge') {
        const terminal = isTerminalAuthCode(error.bridgeCode ?? '');
        if (terminal) {
          this.#terminal(terminal);
          return;
        }
        if (error.bridgeCode === BRIDGE_ERROR_CODES.credentialDeliveryUnknown) {
          this.#rotationRecoveryRequired = true;
          this.#logger.log('warn', 'transport.send-failed', { operation: 'rotate' });
          this.#setState('credential-delivery-unknown');
          throw error;
        }
      }
      if (error instanceof BridgeRequestError && (error.kind === 'transport' || error.kind === 'timeout')) {
        this.#rotationRecoveryRequired = true;
        this.#logger.log('warn', 'transport.send-failed', { operation: 'rotate' });
        this.#setState('credential-delivery-unknown');
        throw error;
      }
      if (this.#authenticated) this.#setState('authenticated');
      throw error;
    }

    this.#previousCredential = {
      token: currentToken,
      graceEndsAtMs: response.previousTokenGraceEndsAtMs,
      attempted: false,
    };
    try {
      await this.#credentials.setBridgeInstanceCredential(createBridgeCredentialEnvelope({
        origin: this.#profile.url,
        profileId: this.#profile.profileId,
        deploymentId: this.#profile.deploymentId,
        instanceId: this.#profile.instanceId,
        instanceToken: response.instanceToken,
      }));
    } catch {
      this.#logger.log('error', 'connector.credential-write-failed', { operation: 'rotate' });
      this.#setAuthenticated(false);
      this.#transport.stop();
      this.#stopping = true;
      this.#setState('credential-write-failed');
      return;
    }
    try {
      await this.#transport.send({
        type: 'desktop.token.rotate-ack',
        deploymentId: this.#profile.deploymentId,
        instanceId: this.#profile.instanceId,
        rotationRequestId: requestId,
        requestId: this.#id(),
        version: BRIDGE_PROTOCOL_VERSION,
      });
    } catch {
      // The new token is already durable. A lost ack intentionally leaves the
      // previous token valid only until Bridge grace expiry.
      this.#logger.log('warn', 'transport.send-failed', { operation: 'rotate' });
    }
    this.#rotationRecoveryRequired = false;
    this.#setState('authenticated');
  }

  /** Re-authenticate with the persisted previous token while Bridge grace remains. */
  retryAfterCredentialWriteFailure(): boolean {
    if (this.#state !== 'credential-write-failed' || !this.#previousCredential) return false;
    if (this.#timers.now() >= this.#previousCredential.graceEndsAtMs) return false;
    this.#authTokenOverride = this.#previousCredential.token;
    this.#previousCredential.attempted = true;
    this.#stopping = false;
    this.#setState('connecting');
    this.#transport.start();
    return true;
  }

  async openPairing(allowManualCode: boolean): Promise<PairingOpenedMessage> {
    this.#requireAuthenticated();
    const deploymentId = this.#requiredDeploymentId();
    const instanceId = this.#requiredInstanceId();
    return this.#request({
      type: 'pairing.open',
      deploymentId,
      instanceId,
      allowManualCode,
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    }, 'pairing.opened', 'pairing-open', (message) => (
      message.deploymentId === deploymentId && message.instanceId === instanceId
    ));
  }

  async renewPairing(pairingSessionId: string): Promise<void> {
    this.#requireAuthenticated();
    await this.#transport.send({
      type: 'pairing.renew',
      pairingSessionId,
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    });
  }

  async closePairing(pairingSessionId: string, reason: PairingCloseReason): Promise<void> {
    if (!this.#transport.connected) return;
    await this.#transport.send({
      type: 'pairing.close',
      pairingSessionId,
      reason,
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    });
  }

  async approvePairing(input: {
    pairingSessionId: string;
    pairingRequestId: string;
    bindingId: string;
    grantedCapabilities: readonly BridgeCommandCapability[];
  }): Promise<PairingApprovedMessage> {
    this.#requireAuthenticated();
    const capabilities = [...input.grantedCapabilities];
    return this.#request({
      type: 'pairing.approve',
      idempotencyKey: this.#id(),
      pairingSessionId: input.pairingSessionId,
      pairingRequestId: input.pairingRequestId,
      bindingId: input.bindingId,
      grantedCapabilities: capabilities,
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    }, 'pairing.approved', 'pairing-approve', (message) => (
      message.recipient === 'desktop'
      && message.pairingSessionId === input.pairingSessionId
      && message.pairingRequestId === input.pairingRequestId
      && message.bindingId === input.bindingId
      && this.#sameCapabilities(message.grantedCapabilities, capabilities)
    ));
  }

  async rejectPairing(input: {
    pairingSessionId: string;
    pairingRequestId: string;
    reason: PairingRejectReason;
  }): Promise<PairingRejectedMessage> {
    this.#requireAuthenticated();
    return this.#request({
      type: 'pairing.reject',
      idempotencyKey: this.#id(),
      pairingSessionId: input.pairingSessionId,
      pairingRequestId: input.pairingRequestId,
      reason: input.reason,
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    }, 'pairing.rejected', 'pairing-reject', (message) => (
      message.pairingRequestId === input.pairingRequestId
      && message.reason === input.reason
    ));
  }

  async revokeDesktop(): Promise<DesktopRevokedMessage> {
    this.#requireAuthenticated();
    const deploymentId = this.#requiredDeploymentId();
    const instanceId = this.#requiredInstanceId();
    return this.#request({
      type: 'desktop.revoke',
      deploymentId,
      instanceId,
      idempotencyKey: this.#id(),
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    }, 'desktop.revoked', 'desktop-revoke', (message) => (
      message.deploymentId === deploymentId && message.instanceId === instanceId
    ));
  }

  async revokeBinding(bindingId: string): Promise<BindingRevokedMessage> {
    this.#requireAuthenticated();
    const deploymentId = this.#requiredDeploymentId();
    const instanceId = this.#requiredInstanceId();
    return this.#request({
      type: 'binding.revoke',
      deploymentId,
      instanceId,
      bindingId,
      idempotencyKey: this.#id(),
      requestId: this.#id(),
      version: BRIDGE_PROTOCOL_VERSION,
    }, 'binding.revoked', 'binding-revoke', (message) => (
      message.deploymentId === deploymentId
      && message.instanceId === instanceId
      && message.bindingId === bindingId
    ));
  }

  /** Send one strict command result. No arbitrary message or RPC send is exposed. */
  sendCommandResult(result: CommandResultBody): Promise<void> {
    this.#requireAuthenticated();
    return this.#transport.send({
      ...result,
      type: 'command.result',
      version: BRIDGE_PROTOCOL_VERSION,
    });
  }

  /** Send one already-projected timeline event to its exact subscription. */
  sendTimelineEvent(input: {
    bindingId: string;
    subscriptionId: string;
    event: TimelineEvent;
  }): Promise<void> {
    this.#requireAuthenticated();
    return this.#transport.send({
      type: 'timeline.event',
      bindingId: input.bindingId,
      subscriptionId: input.subscriptionId,
      event: input.event,
      version: BRIDGE_PROTOCOL_VERSION,
    });
  }

  /** Notify Mobile that one exact subscription has been closed. */
  sendSubscriptionClosed(input: {
    bindingId: string;
    subscriptionId: string;
    sessionId: string;
    reason: SubscriptionCloseReason;
  }): Promise<void> {
    this.#requireAuthenticated();
    return this.#transport.send({
      type: 'session.subscription.closed',
      bindingId: input.bindingId,
      subscriptionId: input.subscriptionId,
      sessionId: input.sessionId,
      reason: input.reason,
      version: BRIDGE_PROTOCOL_VERSION,
    });
  }

  #handleOpen(): void {
    if (this.#stopping) return;
    const generation = ++this.#handshakeGeneration;
    void this.#negotiateAndAuthenticate(generation);
  }

  async #negotiateAndAuthenticate(generation: number): Promise<void> {
    this.#setAuthenticated(false);
    this.#setState('negotiating');
    try {
      const accepted = await this.#request({
        type: 'deployment.negotiate',
        endpoint: 'desktop',
        supportedVersions: [BRIDGE_PROTOCOL_VERSION],
        clientVersion: this.#clientVersion,
        requestId: this.#id(),
        version: BRIDGE_PROTOCOL_VERSION,
      }, 'deployment.accepted', 'negotiate', (message) => (
        message.endpoint === 'desktop' && message.protocolVersion === BRIDGE_PROTOCOL_VERSION
      ));
      if (generation !== this.#handshakeGeneration || this.#stopping) return;

      if (this.#profile.deploymentId && this.#profile.deploymentId !== accepted.deploymentId) {
        this.#terminal('deployment-mismatch');
        return;
      }
      if (!this.#profile.deploymentId) {
        this.#profile = { ...this.#profile, deploymentId: accepted.deploymentId };
      }

      const storedCredential = await this.#readBoundCredential();
      if (this.#state === 'terminal') return;
      const token = this.#authTokenOverride ?? storedCredential?.instanceToken ?? null;
      if (token && this.#profile.instanceId) {
        await this.#authenticate(token, generation);
      } else if (!token && !this.#profile.instanceId && this.#bootstrap) {
        await this.#enroll(generation);
      } else {
        this.#terminal('credential-missing');
      }
    } catch (error) {
      this.#handleLifecycleFailure(error, generation);
    }
  }

  async #enroll(generation: number): Promise<void> {
    const enrollmentToken = this.#bootstrap;
    const deploymentId = this.#profile.deploymentId;
    if (!enrollmentToken || !deploymentId) {
      this.#terminal('credential-missing');
      return;
    }

    // Irreversibly consume transient bootstrap state before the first send attempt.
    this.#bootstrap = null;
    this.#enrollmentSubmitted = true;
    this.#setState('enrolling');
    try {
      const enrolled = await this.#request({
        type: 'desktop.enroll',
        deploymentId,
        enrollmentToken,
        displayName: this.#profile.displayName,
        requestId: this.#id(),
        version: BRIDGE_PROTOCOL_VERSION,
      }, 'desktop.enrolled', 'enroll', (message) => message.deploymentId === deploymentId);
      if (generation !== this.#handshakeGeneration || this.#stopping) return;

      try {
        if (!this.#commitEnrollment) throw new Error('Crash-recoverable Bridge enrollment commit is unavailable');
        const next = { ...this.#profile, deploymentId: enrolled.deploymentId, instanceId: enrolled.instanceId };
        this.#profile = await this.#commitEnrollment(next, enrolled.instanceToken);
      } catch {
        this.#terminal('credential-store-failed');
        return;
      }
      await this.#authenticate(enrolled.instanceToken, generation);
    } catch (error) {
      if (error instanceof BridgeRequestError && (error.kind === 'transport' || error.kind === 'timeout')) {
        if (this.#stopping && this.#state !== 'enrollment-unknown') return;
        this.#enrollmentUnknown();
        return;
      }
      if (error instanceof BridgeRequestError && error.kind === 'bridge') {
        this.#terminal('enrollment-rejected');
        return;
      }
      throw error;
    }
  }

  async #authenticate(token: string, generation: number): Promise<void> {
    const deploymentId = this.#requiredDeploymentId();
    const instanceId = this.#requiredInstanceId();
    this.#setState('authenticating');
    try {
      await this.#request({
        type: 'desktop.auth',
        deploymentId,
        instanceId,
        instanceToken: token,
        requestId: this.#id(),
        version: BRIDGE_PROTOCOL_VERSION,
      }, 'desktop.authenticated', 'auth', (message) => (
        message.deploymentId === deploymentId && message.instanceId === instanceId
      ));
      if (generation !== this.#handshakeGeneration || this.#stopping) return;
      this.#authTokenOverride = null;
      this.#setAuthenticated(true);
      this.#setState(this.#rotationRecoveryRequired ? 'credential-delivery-unknown' : 'authenticated');
    } catch (error) {
      if (error instanceof BridgeRequestError && error.kind === 'bridge') {
        const terminal = isTerminalAuthCode(error.bridgeCode ?? '');
        if (terminal && this.#tryPreviousCredential(token)) return;
        if (terminal) {
          this.#terminal(terminal);
          return;
        }
      }
      throw error;
    }
  }

  #tryPreviousCredential(attemptedToken: string): boolean {
    const previous = this.#previousCredential;
    if (!previous || previous.attempted || attemptedToken === previous.token) return false;
    if (this.#timers.now() >= previous.graceEndsAtMs) return false;
    previous.attempted = true;
    this.#authTokenOverride = previous.token;
    this.#transport.retry();
    this.#setState('connecting');
    return true;
  }

  #handleMessage(message: DesktopServerMessage): void {
    if (message.type === 'pairing.request') {
      if (!this.#authenticated) {
        this.#protocolViolation();
        return;
      }
      for (const listener of this.#pairingListeners) listener(message);
      return;
    }
    if (message.type === 'pairing.rejected' && !this.#pending.has(message.requestId)) {
      if (!this.#authenticated || this.#settledRequestIds.includes(message.requestId)) {
        this.#protocolViolation();
        return;
      }
      for (const listener of this.#pairingRejectedListeners) listener(message);
      return;
    }
    if (message.type === 'presence.changed') {
      if (!this.#authenticated) {
        this.#protocolViolation();
        return;
      }
      this.#onPresenceChanged?.(message);
      return;
    }
    if (message.type === 'command.request') {
      if (!this.#authenticated) {
        this.#protocolViolation();
        return;
      }
      this.#onCommandRequest?.(message);
      return;
    }
    if (message.type === 'bridge.error') {
      this.#handleBridgeError(message);
      return;
    }

    if (!('requestId' in message)) {
      this.#protocolViolation();
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      this.#protocolViolation();
      return;
    }
    if (message.type !== pending.expectedType || !pending.validate(message)) {
      this.#protocolViolation();
      return;
    }
    this.#settlePending(message.requestId);
    pending.resolve(message);
  }

  #handleBridgeError(message: Extract<DesktopServerMessage, { type: 'bridge.error' }>): void {
    if (message.requestId === null) {
      const terminal = isTerminalAuthCode(message.code);
      if (terminal) this.#terminal(terminal);
      else if (!message.retryable) this.#protocolViolation();
      else this.#transport.retry();
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      this.#protocolViolation();
      return;
    }
    this.#settlePending(message.requestId);
    pending.reject(new BridgeRequestError('bridge', message.code, message.retryable));
  }

  #handleClose(_event: { code: number; retrying: boolean }): void {
    this.#handshakeGeneration += 1;
    this.#setAuthenticated(false);
    const hadEnrollment = [...this.#pending.values()].some((pending) => pending.operation === 'enroll');
    this.#rejectAllPending(new BridgeRequestError('transport'));
    if (hadEnrollment) {
      this.#enrollmentUnknown();
      return;
    }
    if (!this.#stopping && this.#state !== 'terminal') this.#setState('connecting');
  }

  #handleFault(fault: BridgeTransportFault): void {
    if (fault === 'protocol' || fault === 'payload-too-large') this.#protocolViolation();
  }

  #handleLifecycleFailure(error: unknown, generation: number): void {
    if (generation !== this.#handshakeGeneration || this.#stopping) return;
    if (error instanceof BridgeRequestError) {
      if (error.kind === 'bridge') {
        const terminal = isTerminalAuthCode(error.bridgeCode ?? '');
        if (terminal) {
          this.#terminal(terminal);
          return;
        }
        if (!error.retryable) {
          this.#protocolViolation();
          return;
        }
      }
      this.#transport.retry();
      this.#setState('connecting');
      return;
    }
    this.#terminal('credential-store-failed');
  }

  async #request<K extends DesktopServerMessageType>(
    outbound: DesktopClientMessage,
    expectedType: K,
    operation: string,
    validate: (message: DesktopServerMessageOf<K>) => boolean,
  ): Promise<DesktopServerMessageOf<K>> {
    if (!('requestId' in outbound)) throw new Error('Correlated Bridge request requires requestId');
    const requestId = outbound.requestId;
    if (this.#pending.has(requestId) || this.#settledRequestIds.includes(requestId)) {
      throw new Error('Duplicate Bridge request id');
    }

    return new Promise<DesktopServerMessageOf<K>>((resolve, reject) => {
      const timeout = this.#timers.setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#settlePending(requestId);
        pending.reject(new BridgeRequestError('timeout'));
      }, this.#requestTimeoutMs);
      const pending: PendingRequest = {
        requestId,
        expectedType,
        operation,
        validate: (message) => validate(message as DesktopServerMessageOf<K>),
        resolve: (message) => resolve(message as DesktopServerMessageOf<K>),
        reject,
        timeout,
      };
      this.#pending.set(requestId, pending);
      void this.#transport.send(outbound).catch(() => {
        const current = this.#pending.get(requestId);
        if (!current) return;
        this.#settlePending(requestId);
        current.reject(new BridgeRequestError('transport'));
      });
    });
  }

  #settlePending(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#timers.clearTimeout(pending.timeout);
    this.#pending.delete(requestId);
    this.#settledRequestIds.push(requestId);
    if (this.#settledRequestIds.length > 256) this.#settledRequestIds.shift();
  }

  #rejectAllPending(error: BridgeRequestError): void {
    for (const pending of this.#pending.values()) {
      this.#timers.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #readBoundCredential(): Promise<BridgeCredentialEnvelope | null> {
    let credential: BridgeCredentialEnvelope | null;
    try {
      credential = await this.#credentials.getBridgeInstanceCredential(this.#profile.profileId);
    } catch {
      this.#terminal('credential-binding-invalid');
      return null;
    }
    if (!credential) return null;
    if (!this.#profile.deploymentId || !this.#profile.instanceId || !tokenSchema.safeParse(credential.instanceToken).success
      || !bridgeCredentialMatches(credential, {
        origin: this.#profile.url,
        profileId: this.#profile.profileId,
        deploymentId: this.#profile.deploymentId,
        instanceId: this.#profile.instanceId,
      })) {
      this.#terminal('credential-binding-invalid');
      return null;
    }
    return credential;
  }

  #enrollmentUnknown(): void {
    this.#stopping = true;
    this.#setAuthenticated(false);
    this.#transport.stop();
    this.#setState('enrollment-unknown');
  }

  #protocolViolation(): void {
    this.#terminal('protocol-error');
  }

  #terminal(reason: BridgeTerminalReason): void {
    if (this.#state === 'terminal' && this.#terminalReason === reason) return;
    this.#stopping = true;
    this.#terminalReason = reason;
    this.#handshakeGeneration += 1;
    this.#setAuthenticated(false);
    this.#rejectAllPending(new BridgeRequestError('protocol'));
    this.#transport.stop();
    this.#setState('terminal');
  }

  #requireAuthenticated(): void {
    if (!this.#authenticated || this.#state !== 'authenticated') {
      throw new Error('Bridge Desktop is not authenticated');
    }
  }

  #requiredDeploymentId(): string {
    if (!this.#profile.deploymentId) throw new Error('Bridge deployment identity is unavailable');
    return this.#profile.deploymentId;
  }

  #requiredInstanceId(): string {
    if (!this.#profile.instanceId) throw new Error('Bridge instance identity is unavailable');
    return this.#profile.instanceId;
  }

  #sameCapabilities(a: readonly BridgeCommandCapability[], b: readonly BridgeCommandCapability[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((value, index) => value === right[index]);
  }

  #id(): string {
    const bytes = this.#randomBytes(BYTE_LENGTHS.opaqueId);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BYTE_LENGTHS.opaqueId) {
      throw new Error('Bridge random source returned invalid byte length');
    }
    return encodeBase64Url(bytes);
  }

  #setAuthenticated(authenticated: boolean): void {
    if (this.#authenticated === authenticated) return;
    this.#authenticated = authenticated;
    for (const listener of this.#authListeners) listener(authenticated);
  }

  #setState(state: BridgeConnectorState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#logger.log('info', 'connector.state-changed', { state });
    this.#onStateChange?.(state, this.#terminalReason);
  }
}

/** Canonical full capability set offered by Desktop pairing UIs. */
export const DESKTOP_BRIDGE_CAPABILITIES: readonly BridgeCommandCapability[] = COMMAND_CAPABILITIES;
