import {
  BRIDGE_PROTOCOL_VERSION,
  COMMAND_CAPABILITIES,
  type CommandCapability,
  type CommandRequestBody,
  type CommandResultBody,
  type DesktopServerMessage,
} from '@mkrate/bridge-protocol'
import type { BridgeProfile } from '@craft-agent/shared/config'
import { RPC_CHANNELS, type SessionEvent } from '@craft-agent/shared/protocol'
import type { EventSink } from '../transport/types.ts'
import {
  BridgeConnectorService,
  type BridgeConnectorServiceOptions,
  type BridgeConnectorState,
  type BridgeCredentialAccess,
  type BridgeTerminalReason,
  type PairingRejectReason,
  type PresenceChangedMessage,
  type SubscriptionCloseReason,
} from './bridge-connector-service.ts'
import { NULL_BRIDGE_LOGGER, type BridgeLogger } from './bridge-logging.ts'
import {
  BridgePairingLease,
  type BridgePairingLeaseTimers,
} from './bridge-pairing-lease.ts'
import type {
  BridgePairingDisplayMetadata,
  BridgePairingRequestMetadata,
  BridgePairingSessionState,
} from './bridge-pairing-session.ts'
import {
  MobileBridgeFacade,
  type BridgeCaller,
  type BridgeSessionPort,
} from './bridge-session-adapter.ts'

export type DesktopBridgeCommandCapability = CommandCapability

export interface DesktopBridgeBindingMetadata {
  readonly bindingId: string
  readonly deviceId: string
  readonly deviceName: string
  readonly grantedCapabilities: readonly CommandCapability[]
  readonly approvedAtMs: number
  readonly presence: 'online' | 'offline' | 'replaced'
}

export interface DesktopBridgePairingState {
  readonly state: BridgePairingSessionState
  readonly display?: Readonly<BridgePairingDisplayMetadata>
  readonly pendingRequest?: Readonly<BridgePairingRequestMetadata>
}

export interface DesktopBridgeSafeState {
  readonly profile: Readonly<BridgeProfile> | null
  readonly connectorState: BridgeConnectorState
  readonly terminalReason: BridgeTerminalReason | null
  readonly authenticated: boolean
  readonly pairing: DesktopBridgePairingState | null
  readonly bindings: readonly DesktopBridgeBindingMetadata[]
}

export interface DesktopBridgeRuntimeOptions {
  profile: BridgeProfile | null
  sessions: BridgeSessionPort
  credentials: BridgeCredentialAccess
  enrollmentToken?: string
  clientVersion?: string
  allowInsecureLoopback?: boolean
  logger?: BridgeLogger
  now?: () => number
  pairingTimers?: BridgePairingLeaseTimers
  connectorFactory?: (options: BridgeConnectorServiceOptions) => BridgeConnectorService
  onStateChange?: (state: DesktopBridgeSafeState) => void
}

interface LiveSubscription {
  readonly bindingId: string
  readonly subscriptionId: string
  readonly sessionId: string
}

type CommandRequestMessage = Extract<DesktopServerMessage, { type: 'command.request' }>

/**
 * Authoritative Desktop Bridge data plane.
 *
 * The runtime owns the only mapping from a Bridge binding to the immutable
 * device/capability scope committed by Desktop pairing. Remote command input is
 * dispatched only through MobileBridgeFacade; no generic RPC/send surface exists.
 */
export class DesktopBridgeRuntime {
  readonly #sessions: BridgeSessionPort
  readonly #credentials: BridgeCredentialAccess
  readonly #clientVersion: string
  readonly #allowInsecureLoopback: boolean
  readonly #logger: BridgeLogger
  readonly #now: () => number
  readonly #pairingTimers?: BridgePairingLeaseTimers
  readonly #connectorFactory: NonNullable<DesktopBridgeRuntimeOptions['connectorFactory']>
  readonly #onStateChange?: DesktopBridgeRuntimeOptions['onStateChange']

  #profile: BridgeProfile | null
  #enrollmentToken: string | undefined
  #connector: BridgeConnectorService | null = null
  #pairingLease: BridgePairingLease | null = null
  #facade: MobileBridgeFacade | null = null
  #started = false
  #admitting = false
  #generation = 0
  #pairingOwnerId: string | null = null
  #unsubscribeAuth: (() => void) | null = null
  #bindings = new Map<string, DesktopBridgeBindingMetadata>()
  #subscriptions = new Map<string, Map<string, LiveSubscription>>()

  constructor(options: DesktopBridgeRuntimeOptions) {
    this.#profile = options.profile ? { ...options.profile } : null
    this.#sessions = options.sessions
    this.#credentials = options.credentials
    this.#enrollmentToken = options.enrollmentToken
    this.#clientVersion = options.clientVersion ?? '0.11.23'
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true
    this.#logger = options.logger ?? NULL_BRIDGE_LOGGER
    this.#now = options.now ?? Date.now
    this.#pairingTimers = options.pairingTimers
    this.#connectorFactory = options.connectorFactory ?? (connectorOptions => new BridgeConnectorService(connectorOptions))
    this.#onStateChange = options.onStateChange
  }

  get safeState(): DesktopBridgeSafeState {
    return this.getSafeState()
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#admitting = true
    this.#ensureConnector()
    if (this.#profile?.enabled) this.#connector?.start()
    this.#emitState()
  }

  /** Fence command/event admission, close pairing/subscriptions, then stop the socket. */
  async stop(): Promise<void> {
    if (!this.#started && !this.#connector) return
    this.#started = false
    this.#admitting = false
    this.#pairingOwnerId = null
    this.#pairingLease?.dispose()
    this.#pairingLease = null
    await this.#closeAllSubscriptions('desktop-offline')
    this.#unsubscribeAuth?.()
    this.#unsubscribeAuth = null
    this.#connector?.stop()
    this.#connector = null
    this.#facade = null
    this.#bindings.clear()
    this.#generation += 1
    this.#emitState()
  }

  /** Replace the one active profile. Enrollment bootstrap remains transient. */
  async updateProfile(profile: BridgeProfile | null, enrollmentToken?: string): Promise<void> {
    this.#admitting = false
    this.#pairingOwnerId = null
    this.#pairingLease?.dispose()
    this.#pairingLease = null
    await this.#closeAllSubscriptions('replaced')
    this.#unsubscribeAuth?.()
    this.#unsubscribeAuth = null
    this.#connector?.stop()
    this.#connector = null
    this.#facade = null
    this.#bindings.clear()
    this.#generation += 1
    this.#profile = profile ? { ...profile } : null
    this.#enrollmentToken = enrollmentToken
    this.#admitting = this.#started
    this.#ensureConnector()
    if (this.#started && this.#profile?.enabled) {
      const connector = this.#connector as BridgeConnectorService | null
      connector?.start()
    }
    this.#emitState()
  }

  openPairing(ownerId: string, options: { allowManualCode?: boolean } = {}): void {
    this.#requireAdmission()
    this.#assertOwner(ownerId)
    if (!this.#pairingLease) throw new Error('Bridge profile is unavailable')
    this.#pairingOwnerId = ownerId
    this.#pairingLease.show(ownerId, options)
    this.#emitState()
  }

  closePairing(ownerId: string): void {
    if (this.#pairingOwnerId !== ownerId) return
    this.#pairingLease?.closeOwner(ownerId)
    this.#pairingOwnerId = null
    this.#emitState()
  }

  async approvePairing(ownerId: string, grantedCapabilities: readonly CommandCapability[]): Promise<DesktopBridgeBindingMetadata> {
    this.#requirePairingOwner(ownerId)
    validateGrantedCapabilities(grantedCapabilities)
    const session = this.#pairingLease?.session
    const pending = session?.pendingRequest
    if (!session || !pending) throw new Error('No pending pairing request')
    const immutablePending = { ...pending, requestedCapabilities: [...pending.requestedCapabilities] }
    const ack = await session.approve(grantedCapabilities)
    if (!this.#admitting || this.#pairingOwnerId !== ownerId) {
      await session.revokeApprovedBinding().catch(() => undefined)
      throw new Error('Pairing owner is no longer active')
    }

    if (this.#bindings.has(ack.bindingId)) await this.#clearBinding(ack.bindingId, 'replaced')
    const binding = freezeBinding({
      bindingId: ack.bindingId,
      deviceId: immutablePending.deviceId,
      deviceName: immutablePending.deviceName,
      grantedCapabilities: ack.grantedCapabilities,
      approvedAtMs: ack.committedAtMs,
      presence: 'online',
    })
    this.#bindings.set(binding.bindingId, binding)
    this.closePairing(ownerId)
    this.#emitState()
    return cloneBinding(binding)
  }

  async rejectPairing(ownerId: string, reason: PairingRejectReason): Promise<void> {
    this.#requirePairingOwner(ownerId)
    if (!PAIRING_REJECT_REASONS.has(reason)) throw new Error('Invalid pairing rejection reason')
    const session = this.#pairingLease?.session
    if (!session?.pendingRequest) throw new Error('No pending pairing request')
    await session.reject(reason)
    this.closePairing(ownerId)
  }

  listBindings(): readonly DesktopBridgeBindingMetadata[] {
    return Object.freeze([...this.#bindings.values()].map(cloneBinding))
  }

  async revokeBinding(bindingId: string): Promise<void> {
    this.#requireAdmission()
    if (!this.#bindings.has(bindingId)) throw new Error('Bridge binding not found')
    const connector = this.#requireConnector()
    await connector.revokeBinding(bindingId)
    await this.#clearBinding(bindingId, 'revoked')
    this.#emitState()
  }

  getSafeState(pairingOwnerId?: string): DesktopBridgeSafeState {
    const connector = this.#connector
    const session = this.#pairingLease?.session ?? null
    const ownsVisibleLease = pairingOwnerId !== undefined && pairingOwnerId === this.#pairingOwnerId
    let pairing: DesktopBridgePairingState | null = null
    if (session) {
      pairing = { state: session.state }
      if (ownsVisibleLease) {
        pairing = {
          state: session.state,
          display: Object.freeze({ ...session.displayMetadata }),
          ...(session.pendingRequest
            ? { pendingRequest: Object.freeze({
                ...session.pendingRequest,
                requestedCapabilities: Object.freeze([...session.pendingRequest.requestedCapabilities]),
              }) }
            : {}),
        }
      }
    }
    return Object.freeze({
      profile: this.#profile ? Object.freeze({ ...this.#profile }) : null,
      connectorState: connector?.state ?? 'stopped',
      terminalReason: connector?.terminalReason ?? null,
      authenticated: connector?.isAuthenticated ?? false,
      pairing,
      bindings: this.listBindings(),
    })
  }

  /** Preserve the base RPC/messaging sink, then asynchronously project one safe session event. */
  composeSessionEventSink(baseSink: EventSink): EventSink {
    return (channel, target, ...args) => {
      baseSink(channel, target, ...args)
      if (channel !== RPC_CHANNELS.sessions.EVENT || args.length !== 1) return
      const rawEvent = args[0]
      if (!rawEvent || typeof rawEvent !== 'object') return
      void this.#projectAndSend(channel, rawEvent as SessionEvent).catch(() => {
        this.#logger.log('warn', 'transport.send-failed', { operation: 'timeline-event' })
      })
    }
  }

  #ensureConnector(): void {
    if (this.#connector || !this.#profile) return
    const generation = ++this.#generation
    const connector = this.#connectorFactory({
      profile: this.#profile,
      credentials: this.#credentials,
      enrollmentToken: this.#enrollmentToken,
      clientVersion: this.#clientVersion,
      allowInsecureLoopback: this.#allowInsecureLoopback,
      logger: this.#logger,
      onStateChange: () => {
        if (generation === this.#generation) this.#emitState()
      },
      onCommandRequest: message => {
        if (generation !== this.#generation) return
        void this.#handleCommandRequest(message).catch(() => undefined)
      },
      onPresenceChanged: message => {
        if (generation !== this.#generation) return
        void this.#handlePresenceChanged(message).catch(() => undefined)
      },
    })
    this.#connector = connector
    this.#pairingLease = new BridgePairingLease({
      channel: connector,
      timers: this.#pairingTimers,
      logger: this.#logger,
      onSessionChange: () => this.#emitState(),
    })
    this.#unsubscribeAuth = connector.onAuthenticatedChange(authenticated => {
      if (generation !== this.#generation) return
      if (authenticated) {
        const current = connector.profile
        if (current.deploymentId && current.instanceId) {
          this.#profile = { ...current }
          this.#facade = new MobileBridgeFacade({
            identity: {
              profileId: current.profileId,
              deploymentId: current.deploymentId,
              instanceId: current.instanceId,
            },
            sessions: this.#sessions,
            now: this.#now,
          })
        }
      } else {
        this.#facade = null
        void this.#closeAllSubscriptions('desktop-offline')
      }
      this.#emitState()
    })
  }

  async #handleCommandRequest(message: CommandRequestMessage): Promise<void> {
    const connector = this.#connector
    if (!connector || !this.#admitting || !connector.isAuthenticated) return
    const request = commandRequestBody(message)
    let result: CommandResultBody
    try {
      const binding = this.#bindings.get(message.bindingId)
      const facade = this.#facade
      if (!binding) {
        result = commandFailure(request, 'NOT_AUTHORIZED', this.#now())
      } else if (!facade) {
        result = commandFailure(request, 'UNAVAILABLE', this.#now())
      } else {
        const caller: BridgeCaller = {
          profileId: connector.profile.profileId,
          deploymentId: connector.profile.deploymentId ?? '',
          instanceId: connector.profile.instanceId ?? '',
          bindingId: binding.bindingId,
          deviceId: binding.deviceId,
        }
        result = await facade.execute(caller, binding.grantedCapabilities, request)
      }

      if (result.outcome === 'success' && result.result.command === 'session.subscribe') {
        await this.#rememberSubscription({
          bindingId: result.bindingId,
          subscriptionId: result.result.subscriptionId,
          sessionId: result.result.sessionId,
        })
      }
    } catch {
      result = commandFailure(request, 'INTERNAL_FAILURE', this.#now())
    }

    if (this.#admitting && connector === this.#connector && connector.isAuthenticated) {
      await connector.sendCommandResult(result).catch(() => {
        this.#logger.log('warn', 'transport.send-failed', { operation: 'command-result' })
      })
    }
  }

  async #projectAndSend(channel: string, event: SessionEvent): Promise<void> {
    const connector = this.#connector
    const facade = this.#facade
    if (!this.#admitting || !connector?.isAuthenticated || !facade) return
    if (event.type === 'session_deleted') {
      await this.#closeSessionSubscriptions(event.sessionId, 'session-ended')
      return
    }
    const deliveries = await facade.events.project(channel, event)
    for (const delivery of deliveries) {
      if (!this.#isTrackedSubscription(delivery.bindingId, delivery.subscriptionId, delivery.event.sessionId)) continue
      if (!this.#admitting || connector !== this.#connector || !connector.isAuthenticated) return
      await connector.sendTimelineEvent(delivery).catch(() => {
        this.#logger.log('warn', 'transport.send-failed', { operation: 'timeline-event' })
      })
    }
  }

  async #handlePresenceChanged(message: PresenceChangedMessage): Promise<void> {
    const connector = this.#connector
    if (!connector) return
    if (message.instanceId !== connector.profile.instanceId) return
    if (message.subject === 'desktop') {
      if (message.state === 'offline') await this.#closeAllSubscriptions('desktop-offline')
      if (message.state === 'replaced' || message.state === 'revoked') {
        await this.#closeAllSubscriptions(message.state === 'replaced' ? 'replaced' : 'revoked')
        this.#bindings.clear()
      }
      this.#emitState()
      return
    }

    const binding = this.#bindings.get(message.bindingId)
    if (!binding) return
    if (message.state === 'revoked') {
      await this.#clearBinding(message.bindingId, 'revoked')
    } else if (message.state === 'offline' || message.state === 'replaced') {
      await this.#closeBindingSubscriptions(
        message.bindingId,
        message.state === 'offline' ? 'binding-offline' : 'replaced',
      )
      this.#bindings.set(message.bindingId, freezeBinding({ ...binding, presence: message.state }))
    } else {
      this.#bindings.set(message.bindingId, freezeBinding({ ...binding, presence: 'online' }))
    }
    this.#emitState()
  }

  async #rememberSubscription(subscription: LiveSubscription): Promise<void> {
    let bySession = this.#subscriptions.get(subscription.bindingId)
    if (!bySession) {
      bySession = new Map()
      this.#subscriptions.set(subscription.bindingId, bySession)
    }
    const replaced = bySession.get(subscription.sessionId)
    if (replaced && replaced.subscriptionId !== subscription.subscriptionId) {
      await this.#sendSubscriptionClosed(replaced, 'replaced')
    }
    bySession.set(subscription.sessionId, Object.freeze({ ...subscription }))
  }

  #isTrackedSubscription(bindingId: string, subscriptionId: string, sessionId: string): boolean {
    const subscription = this.#subscriptions.get(bindingId)?.get(sessionId)
    return subscription?.subscriptionId === subscriptionId
  }

  async #clearBinding(bindingId: string, reason: SubscriptionCloseReason): Promise<void> {
    await this.#closeBindingSubscriptions(bindingId, reason)
    this.#bindings.delete(bindingId)
    this.#facade?.clearBinding(bindingId)
  }

  async #closeBindingSubscriptions(bindingId: string, reason: SubscriptionCloseReason): Promise<void> {
    const subscriptions = [...(this.#subscriptions.get(bindingId)?.values() ?? [])]
    this.#subscriptions.delete(bindingId)
    this.#facade?.clearBindingSubscriptions(bindingId)
    for (const subscription of subscriptions) await this.#sendSubscriptionClosed(subscription, reason)
  }

  async #closeSessionSubscriptions(sessionId: string, reason: SubscriptionCloseReason): Promise<void> {
    for (const [bindingId, bySession] of this.#subscriptions) {
      const subscription = bySession.get(sessionId)
      if (!subscription) continue
      bySession.delete(sessionId)
      if (bySession.size === 0) this.#subscriptions.delete(bindingId)
      this.#facade?.events.unsubscribe(bindingId, subscription.subscriptionId)
      await this.#sendSubscriptionClosed(subscription, reason)
    }
  }

  async #closeAllSubscriptions(reason: SubscriptionCloseReason): Promise<void> {
    const bindingIds = [...this.#subscriptions.keys()]
    for (const bindingId of bindingIds) await this.#closeBindingSubscriptions(bindingId, reason)
  }

  async #sendSubscriptionClosed(subscription: LiveSubscription, reason: SubscriptionCloseReason): Promise<void> {
    const connector = this.#connector
    if (!connector?.isAuthenticated) return
    await connector.sendSubscriptionClosed({ ...subscription, reason }).catch(() => {
      this.#logger.log('warn', 'transport.send-failed', { operation: 'subscription-close' })
    })
  }

  #requireAdmission(): void {
    if (!this.#started || !this.#admitting) throw new Error('Bridge runtime is stopped')
  }

  #requireConnector(): BridgeConnectorService {
    const connector = this.#connector
    if (!connector) throw new Error('Bridge profile is unavailable')
    return connector
  }

  #requirePairingOwner(ownerId: string): void {
    this.#requireAdmission()
    this.#assertOwner(ownerId)
    if (this.#pairingOwnerId !== ownerId) throw new Error('Pairing lease is not owned by this caller')
  }

  #assertOwner(ownerId: string): void {
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0 || ownerId.length > 128) {
      throw new Error('Invalid pairing owner')
    }
  }

  #emitState(): void {
    this.#onStateChange?.(this.getSafeState())
  }
}

function commandRequestBody(message: CommandRequestMessage): CommandRequestBody {
  return {
    bindingId: message.bindingId,
    commandId: message.commandId,
    idempotencyKey: message.idempotencyKey,
    sentAtMs: message.sentAtMs,
    payload: message.payload,
  }
}

function commandFailure(
  request: CommandRequestBody,
  code: 'NOT_AUTHORIZED' | 'UNAVAILABLE' | 'INTERNAL_FAILURE',
  now: number,
): CommandResultBody {
  return {
    bindingId: request.bindingId,
    commandId: request.commandId,
    outcome: 'error',
    completedAtMs: safeTimestamp(now),
    command: request.payload.command,
    error: { code, retryable: code === 'UNAVAILABLE', retryAfterMs: code === 'UNAVAILABLE' ? 1000 : null },
  }
}

function freezeBinding(binding: DesktopBridgeBindingMetadata): DesktopBridgeBindingMetadata {
  return Object.freeze({
    ...binding,
    grantedCapabilities: Object.freeze([...binding.grantedCapabilities]),
  })
}

function cloneBinding(binding: DesktopBridgeBindingMetadata): DesktopBridgeBindingMetadata {
  return freezeBinding({ ...binding, grantedCapabilities: [...binding.grantedCapabilities] })
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0
}

const PAIRING_REJECT_REASONS = new Set<PairingRejectReason>([
  'cancelled',
  'user-rejected',
  'device-unrecognized',
  'capability-refused',
])

function validateGrantedCapabilities(capabilities: readonly CommandCapability[]): void {
  const allowed = new Set<CommandCapability>(COMMAND_CAPABILITIES)
  if (capabilities.length === 0 || capabilities.length > allowed.size) {
    throw new Error('Invalid granted capabilities')
  }
  const unique = new Set(capabilities)
  if (unique.size !== capabilities.length || capabilities.some(capability => !allowed.has(capability))) {
    throw new Error('Invalid granted capabilities')
  }
}

export const DESKTOP_BRIDGE_PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION
