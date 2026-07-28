import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  COMMAND_CAPABILITIES,
  SECURITY_LIMITS,
  commandRequestBodySchema,
  messageIdSchema,
  type CommandCapability,
  type CommandRequestBody,
  type CommandResultBody,
} from '@mkrate/bridge-protocol'
import type { Session, SendMessageOptions } from '@craft-agent/shared/protocol'
import { BridgeEventProjector, BridgeEventProjectorError } from './bridge-event-projector.ts'
import { BridgeReplayWindow } from './bridge-replay-window.ts'
import { BridgeResultCache, BridgeResultCacheError } from './bridge-result-cache.ts'
import {
  BridgeSnapshotError,
  BridgeSnapshotService,
  SessionSerializationBarrier,
  projectSessionSummary,
  redactPublicLabel,
} from './bridge-snapshot.ts'

export interface BridgeCaller {
  readonly profileId: string
  readonly deploymentId: string
  readonly instanceId: string
  readonly bindingId: string
  readonly deviceId: string
}

export interface BridgeLocalIdentity {
  readonly profileId: string
  readonly deploymentId: string
  readonly instanceId: string
}

export interface BridgeWorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly remoteServer?: unknown
}

/** The only Desktop session authority available to MobileBridgeFacade. */
export interface BridgeSessionPort {
  getWorkspaces(): readonly BridgeWorkspaceRecord[]
  getSessions(workspaceId?: string): readonly Session[]
  getSession(sessionId: string): Promise<Session | null>
  getSessionWorkspaceId(sessionId: string): string | undefined
  sendMessage(
    sessionId: string,
    text: string,
    request: { readonly optimisticMessageId: string; readonly onAck: (persistedMessageId: string) => void },
  ): Promise<void>
  cancelProcessing(sessionId: string): Promise<void>
}

/**
 * Minimal shape needed to wrap the existing SessionManager. The facade itself
 * receives only BridgeSessionPort, so attachments, arbitrary SendMessageOptions,
 * RPC context, channels, webContents, paths, and SessionCommand are structurally
 * unavailable to remote command dispatch.
 */
export interface ExistingSessionManagerBridgeSource {
  getWorkspaces(): readonly BridgeWorkspaceRecord[]
  getSessions(workspaceId?: string): readonly Session[]
  getSession(sessionId: string): Promise<Session | null>
  getSessionWorkspaceId(sessionId: string): string | undefined
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: never[],
    storedAttachments?: never[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
}

export function createBridgeSessionPort(source: ExistingSessionManagerBridgeSource): BridgeSessionPort {
  return Object.freeze({
    getWorkspaces: () => source.getWorkspaces(),
    getSessions: (workspaceId?: string) => source.getSessions(workspaceId),
    getSession: (sessionId: string) => source.getSession(sessionId),
    getSessionWorkspaceId: (sessionId: string) => source.getSessionWorkspaceId(sessionId),
    sendMessage: (sessionId: string, text: string, request: { optimisticMessageId: string; onAck: (messageId: string) => void }) =>
      source.sendMessage(
        sessionId,
        text,
        undefined,
        undefined,
        { optimisticMessageId: request.optimisticMessageId },
        undefined,
        undefined,
        request.onAck,
      ),
    cancelProcessing: (sessionId: string) => source.cancelProcessing(sessionId),
  })
}

export class BridgeAuthorizationError extends Error {
  constructor(readonly code: 'NOT_AUTHORIZED' | 'NOT_FOUND') {
    super(code)
    this.name = 'BridgeAuthorizationError'
  }
}

export class BridgeScopeAuthorizer {
  private readonly localIdentity: Readonly<BridgeLocalIdentity>

  constructor(identity: BridgeLocalIdentity, private readonly sessions: BridgeSessionPort) {
    this.localIdentity = Object.freeze({ ...identity })
  }

  normalizeCaller(caller: BridgeCaller): Readonly<BridgeCaller> {
    const keys = Object.keys(caller).sort()
    const expected = ['bindingId', 'deploymentId', 'deviceId', 'instanceId', 'profileId']
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new BridgeAuthorizationError('NOT_AUTHORIZED')
    }
    const normalized = Object.freeze({
      profileId: boundedId(caller.profileId),
      deploymentId: boundedId(caller.deploymentId),
      instanceId: boundedId(caller.instanceId),
      bindingId: boundedId(caller.bindingId),
      deviceId: boundedId(caller.deviceId),
    })
    if (
      normalized.profileId !== this.localIdentity.profileId
      || normalized.deploymentId !== this.localIdentity.deploymentId
      || normalized.instanceId !== this.localIdentity.instanceId
    ) {
      throw new BridgeAuthorizationError('NOT_AUTHORIZED')
    }
    return normalized
  }

  assertLocalWorkspace(workspaceId: string): BridgeWorkspaceRecord {
    const workspace = this.sessions.getWorkspaces().find(candidate => candidate.id === workspaceId)
    if (!workspace) throw new BridgeAuthorizationError('NOT_FOUND')
    if (workspace.remoteServer) throw new BridgeAuthorizationError('NOT_AUTHORIZED')
    return workspace
  }

  assertAuthorizedSession(caller: BridgeCaller, sessionId: string): { workspaceId: string } {
    this.normalizeCaller(caller)
    const workspaceId = this.sessions.getSessionWorkspaceId(sessionId)
    if (!workspaceId) throw new BridgeAuthorizationError('NOT_FOUND')
    this.assertLocalWorkspace(workspaceId)
    return { workspaceId }
  }
}

type SuccessResult = Extract<CommandResultBody, { outcome: 'success' }>['result']
type CommandError = Extract<CommandResultBody, { outcome: 'error' }>['error']
type CachedOutcome =
  | { outcome: 'success'; result: SuccessResult }
  | { outcome: 'error'; error: CommandError }

export interface MobileBridgeFacadeOptions {
  readonly identity: BridgeLocalIdentity
  readonly sessions: BridgeSessionPort
  readonly now?: () => number
  readonly replay?: BridgeReplayWindow
  readonly resultCache?: BridgeResultCache<CachedOutcome>
}

/** Closed six-command Desktop boundary. There is intentionally no generic RPC escape hatch. */
export class MobileBridgeFacade {
  readonly authorizer: BridgeScopeAuthorizer
  readonly replay: BridgeReplayWindow
  readonly barrier: SessionSerializationBarrier
  readonly snapshots: BridgeSnapshotService
  readonly events: BridgeEventProjector

  private readonly sessions: BridgeSessionPort
  private readonly resultCache: BridgeResultCache<CachedOutcome>
  private readonly now: () => number
  private readonly rates = new Map<string, { windowStartedAtMs: number; count: number; inFlight: number }>()

  constructor(options: MobileBridgeFacadeOptions) {
    this.sessions = options.sessions
    this.now = options.now ?? Date.now
    this.replay = options.replay ?? new BridgeReplayWindow()
    this.resultCache = options.resultCache ?? new BridgeResultCache<CachedOutcome>()
    this.authorizer = new BridgeScopeAuthorizer(options.identity, options.sessions)
    this.barrier = new SessionSerializationBarrier()
    this.snapshots = new BridgeSnapshotService(options.sessions, this.authorizer, this.replay, this.barrier)
    this.events = new BridgeEventProjector(this.authorizer, this.replay, this.barrier, this.now)
  }

  /** Drop only live delivery registrations for a transient Mobile disconnect. */
  clearBindingSubscriptions(bindingId: string): void {
    this.events.clearBinding(bindingId)
  }

  /** Terminal binding removal: discard subscriptions, replay, idempotency, and rate state. */
  clearBinding(bindingId: string): void {
    this.clearBindingSubscriptions(bindingId)
    this.replay.clearBinding(bindingId)
    this.resultCache.clearBinding(bindingId)
    this.rates.delete(bindingId)
  }

  async execute(
    callerInput: BridgeCaller,
    grantedCapabilitiesInput: readonly CommandCapability[],
    requestInput: CommandRequestBody,
  ): Promise<CommandResultBody> {
    const completedAtMs = () => safeTimestamp(this.now())
    let caller: Readonly<BridgeCaller>
    let request: CommandRequestBody
    try {
      caller = this.authorizer.normalizeCaller(callerInput)
      request = commandRequestBodySchema.parse(requestInput)
      validateRequestBounds(request)
      if (request.bindingId !== caller.bindingId) throw new BridgeAuthorizationError('NOT_AUTHORIZED')
      validateCapabilities(grantedCapabilitiesInput)
      if (!grantedCapabilitiesInput.includes(request.payload.command)) {
        return errorResult(request, completedAtMs(), commandError('CAPABILITY_DENIED', false))
      }
    } catch (error) {
      const fallback = safeFallbackRequest(requestInput)
      const command = fallback.payload.command
      const mapped = error instanceof BridgeAuthorizationError
        ? commandError(error.code, false)
        : commandError('INVALID_REQUEST', false)
      return {
        bindingId: fallback.bindingId,
        commandId: fallback.commandId,
        outcome: 'error',
        completedAtMs: completedAtMs(),
        command,
        error: mapped,
      }
    }

    let execution: Promise<CachedOutcome>
    try {
      execution = this.resultCache.run(caller.bindingId, request.idempotencyKey, request.payload, () =>
        this.executeRateLimited(caller, request.idempotencyKey, request.payload),
      )
    } catch (error) {
      const mapped = error instanceof BridgeResultCacheError && error.code === 'REQUEST_ID_REUSE'
        ? commandError('IDEMPOTENCY_CONFLICT', false)
        : commandError('BUSY', true, 1000)
      return errorResult(request, completedAtMs(), mapped)
    }

    const outcome = await execution
    if (outcome.outcome === 'success') {
      return {
        bindingId: caller.bindingId,
        commandId: request.commandId,
        outcome: 'success',
        completedAtMs: completedAtMs(),
        result: outcome.result,
      }
    }
    return errorResult(request, completedAtMs(), outcome.error)
  }

  private async executeRateLimited(
    caller: Readonly<BridgeCaller>,
    requestId: string,
    payload: CommandRequestBody['payload'],
  ): Promise<CachedOutcome> {
    const rate = this.rateFor(caller.bindingId)
    if (rate.count >= SECURITY_LIMITS.commandRequestsPerMinutePerBinding) {
      return { outcome: 'error', error: commandError('BUSY', true, 60_000 - (this.now() - rate.windowStartedAtMs)) }
    }
    if (rate.inFlight >= SECURITY_LIMITS.commandMaxInFlightPerBinding) {
      return { outcome: 'error', error: commandError('BUSY', true, 250) }
    }
    rate.count++
    rate.inFlight++
    try {
      return await this.executeCommand(caller, requestId, payload)
    } finally {
      rate.inFlight--
    }
  }

  private async executeCommand(
    caller: Readonly<BridgeCaller>,
    requestId: string,
    payload: CommandRequestBody['payload'],
  ): Promise<CachedOutcome> {
    try {
      switch (payload.command) {
        case 'workspace.list-local': {
          const workspaces = this.sessions.getWorkspaces()
            .filter(workspace => !workspace.remoteServer)
            .filter(workspace => isProtocolEntityId(workspace.id))
            .slice(0, SECURITY_LIMITS.workspaceListMaxItems)
            .map(workspace => ({
              workspaceId: workspace.id,
              name: redactPublicLabel(workspace.name, SECURITY_LIMITS.displayNameMaxCharacters, 'Workspace'),
            }))
          return { outcome: 'success', result: { command: payload.command, workspaces } }
        }
        case 'session.list': {
          if (payload.workspaceId) this.authorizer.assertLocalWorkspace(payload.workspaceId)
          const localWorkspaceIds = new Set(this.sessions.getWorkspaces().filter(workspace => !workspace.remoteServer).map(workspace => workspace.id))
          const sessions = this.sessions.getSessions(payload.workspaceId ?? undefined)
            .filter(session => !session.hidden)
            .filter(session => isProtocolEntityId(session.id) && isProtocolEntityId(session.workspaceId))
            .filter(session => localWorkspaceIds.has(session.workspaceId))
            .filter(session => this.sessions.getSessionWorkspaceId(session.id) === session.workspaceId)
            .filter(session => payload.workspaceId === null || session.workspaceId === payload.workspaceId)
            .slice(0, SECURITY_LIMITS.sessionListMaxItems)
            .map(projectSessionSummary)
          return { outcome: 'success', result: { command: payload.command, sessions } }
        }
        case 'session.snapshot':
          return { outcome: 'success', result: await this.snapshots.create(caller, payload.sessionId) }
        case 'session.subscribe':
          return { outcome: 'success', result: await this.events.subscribe(caller, payload.sessionId, payload.afterCursor) }
        case 'session.send-message': {
          this.authorizer.assertAuthorizedSession(caller, payload.sessionId)
          const optimisticMessageId = optimisticId(caller.bindingId, requestId)
          let acknowledgedId: string | undefined
          let conflictingAck = false
          let settleAck!: () => void
          let rejectAck!: (error: unknown) => void
          const ack = new Promise<void>((resolve, reject) => { settleAck = resolve; rejectAck = reject })
          const send = this.sessions.sendMessage(payload.sessionId, payload.text, {
            optimisticMessageId,
            onAck: persistedMessageId => {
              if (acknowledgedId && acknowledgedId !== persistedMessageId) conflictingAck = true
              acknowledgedId ??= persistedMessageId
              settleAck()
            },
          })
          void send.then(
            () => {
              if (!acknowledgedId) rejectAck(new BridgeSendAmbiguousError())
            },
            error => rejectAck(error),
          )
          await ack
          await Promise.resolve()
          if (!acknowledgedId || conflictingAck || !messageIdSchema.safeParse(acknowledgedId).success) {
            throw new BridgeSendAmbiguousError()
          }

          const event = await this.barrier.runExclusive(payload.sessionId, async () => {
            this.authorizer.assertAuthorizedSession(caller, payload.sessionId)
            return this.replay.append(caller.bindingId, {
              sessionId: payload.sessionId,
              occurredAtMs: safeTimestamp(this.now()),
              payload: { kind: 'user.message', text: payload.text },
              dedupeKey: `${payload.sessionId}:user:${acknowledgedId}`,
            })
          })
          // Post-ack processing may fail later; normal SessionEvents surface that.
          // Observe the promise solely to prevent an unhandled rejection.
          void send.catch(() => undefined)
          return {
            outcome: 'success',
            result: {
              command: payload.command,
              accepted: true,
              messageId: acknowledgedId,
              userMessageEventId: event.eventId,
              cursor: event.cursor,
            },
          }
        }
        case 'session.cancel': {
          this.authorizer.assertAuthorizedSession(caller, payload.sessionId)
          const session = await this.sessions.getSession(payload.sessionId)
          if (!session) throw new BridgeAuthorizationError('NOT_FOUND')
          const cancelled = session.isProcessing
          await this.sessions.cancelProcessing(payload.sessionId)
          return { outcome: 'success', result: { command: payload.command, cancelled } }
        }
      }
    } catch (error) {
      if (error instanceof BridgeEventProjectorError) {
        return {
          outcome: 'error',
          error: { code: 'RESYNC_REQUIRED', retryable: false, retryAfterMs: null, currentCursor: error.currentCursor },
        }
      }
      if (error instanceof BridgeSendAmbiguousError) {
        return {
          outcome: 'error',
          error: { code: 'RESYNC_REQUIRED', retryable: false, retryAfterMs: null, currentCursor: this.replay.currentCursor(caller.bindingId) },
        }
      }
      if (error instanceof BridgeAuthorizationError || error instanceof BridgeSnapshotError) {
        return { outcome: 'error', error: commandError(error.code, false) }
      }
      return { outcome: 'error', error: commandError('INTERNAL_FAILURE', false) }
    }
  }

  private rateFor(bindingId: string): { windowStartedAtMs: number; count: number; inFlight: number } {
    const now = this.now()
    let rate = this.rates.get(bindingId)
    if (!rate || now - rate.windowStartedAtMs >= 60_000) {
      rate = { windowStartedAtMs: now, count: 0, inFlight: 0 }
      this.rates.set(bindingId, rate)
    }
    return rate
  }
}

class BridgeSendAmbiguousError extends Error {}

function validateCapabilities(capabilities: readonly CommandCapability[]): void {
  if (capabilities.length > COMMAND_CAPABILITIES.length) throw new Error('invalid capabilities')
  const allowlist = new Set<string>(COMMAND_CAPABILITIES)
  const seen = new Set<string>()
  for (const capability of capabilities) {
    if (!allowlist.has(capability) || seen.has(capability)) throw new Error('invalid capabilities')
    seen.add(capability)
  }
}

function validateRequestBounds(request: CommandRequestBody): void {
  boundedId(request.bindingId)
  boundedId(request.commandId)
  boundedId(request.idempotencyKey)
  if (!Number.isFinite(request.sentAtMs) || request.sentAtMs < 0) throw new Error('invalid timestamp')
  if ('workspaceId' in request.payload && request.payload.workspaceId !== null) boundedId(request.payload.workspaceId)
  if ('sessionId' in request.payload) boundedId(request.payload.sessionId)
  if ('afterCursor' in request.payload && request.payload.afterCursor !== null && request.payload.afterCursor.length > 256) {
    throw new Error('cursor too long')
  }
  if (request.payload.command === 'session.send-message') {
    if (request.payload.text.length === 0 || Buffer.byteLength(request.payload.text, 'utf8') > SECURITY_LIMITS.userTextMaxBytes) {
      throw new Error('invalid text')
    }
  }
}

function boundedId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new BridgeAuthorizationError('NOT_AUTHORIZED')
  }
  return value
}

function commandError(
  code: Exclude<CommandError['code'], 'RESYNC_REQUIRED'>,
  retryable: boolean,
  retryAfterMs: number | null = null,
): CommandError {
  return { code, retryable, retryAfterMs: retryAfterMs === null ? null : safeTimestamp(retryAfterMs) }
}

function errorResult(request: CommandRequestBody, completedAtMs: number, error: CommandError): CommandResultBody {
  return {
    bindingId: request.bindingId,
    commandId: request.commandId,
    outcome: 'error',
    completedAtMs,
    command: request.payload.command,
    error,
  }
}

function safeFallbackRequest(input: CommandRequestBody): CommandRequestBody {
  const payload = input && typeof input === 'object' && input.payload && typeof input.payload === 'object'
    && COMMAND_CAPABILITIES.includes((input.payload as { command?: CommandCapability }).command as CommandCapability)
    ? input.payload
    : { command: 'workspace.list-local' as const }
  return {
    bindingId: canonicalOpaqueIdOrFallback(input?.bindingId),
    commandId: canonicalOpaqueIdOrFallback(input?.commandId),
    idempotencyKey: 'AAAAAAAAAAAAAAAAAAAAAA',
    sentAtMs: 0,
    payload: payload as CommandRequestBody['payload'],
  }
}

function optimisticId(bindingId: string, requestId: string): string {
  const digest = createHash('sha256').update(bindingId).update('\0').update(requestId).digest('hex')
  return `bridge-${digest.slice(0, 32)}`
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0
}

function isProtocolEntityId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function canonicalOpaqueIdOrFallback(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) return 'AAAAAAAAAAAAAAAAAAAAAA'
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === 16 && bytes.toString('base64url') === value ? value : 'AAAAAAAAAAAAAAAAAAAAAA'
}
