import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkServerIdentity } from 'node:tls'
import WebSocket from 'ws'
import {
  BRIDGE_PROTOCOL_VERSION,
  SECURITY_LIMITS,
} from '@mkrate/bridge-protocol'
import {
  BridgeAuthorityStore,
  BridgeConnectorService,
  DesktopBridgeRuntime,
  type BridgeSessionPort,
  type BridgeWebSocketLike,
  type DesktopBridgeSafeState,
} from '@craft-agent/server-core/bridge'
import {
  BridgeCredentialSaga,
  getBridgeProfile,
  setBridgeProfile,
  type BridgeProfile,
} from '@craft-agent/shared/config'
import { CredentialManager } from '@craft-agent/shared/credentials'
import { RPC_CHANNELS, type Session, type SessionEvent } from '@craft-agent/shared/protocol'
import type { Message } from '@craft-agent/core/types'

const PROTOCOL_COORDINATES = Object.freeze({
  packageName: '@mkrate/bridge-protocol',
  packageVersion: '1.0.1',
  epoch: 'mkrate-bridge/v1',
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  artifactSha256: '9ec050cfe35d8fdc960e2e6a345e2268bb59be655a0ff031c1f999dc7b14d637',
  fixtureSetSha256: 'b0322b8ecdfe84d546f1262bd56b5bb674da1690de06694eebfcab25e1f715f2',
})

const OWNER_ID = 'bridge-e2e-desktop-driver'
export const DESKTOP_BRIDGE_E2E_CLIENT_VERSION = '1.0.0-wave-d-e2e'
const PAIRING_TIMEOUT_MS = 30_000
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024
const PATH_AREAS = ['secrets', 'state', 'control'] as const
const FAULT_KINDS = ['disconnect-after-next-mutating-command', 'drop-next-command-result'] as const
const OPS = [
  'driver.ready',
  'desktop.enroll',
  'desktop.auth',
  'desktop.fixture.load',
  'desktop.pairing.open',
  'desktop.pairing.await-request',
  'desktop.pairing.approve',
  'desktop.fixture.advance',
  'desktop.binding.revoke',
  'desktop.authority.counts',
  'transport.disconnect',
  'transport.reconnect',
  'driver.state',
  'fault.arm',
  'driver.stop',
] as const

type PathArea = typeof PATH_AREAS[number]
type FaultKind = typeof FAULT_KINDS[number]
type Operation = typeof OPS[number]

export interface PathRef {
  area: PathArea
  path: string
}

export interface ControlRequest {
  v: 1
  id: string
  op: Operation
  args: Record<string, unknown>
}

export interface ControlResponse {
  v: 1
  id: string
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: DriverErrorCode }
}

export type DriverErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_OPERATION'
  | 'INVALID_STATE'
  | 'INVALID_PATH_REF'
  | 'FILE_INVALID'
  | 'PROTOCOL_MISMATCH'
  | 'TIMEOUT'
  | 'OPERATION_FAILED'
  | 'DUPLICATE_REQUEST'

export class DriverError extends Error {
  constructor(readonly code: DriverErrorCode) {
    super(code)
    this.name = 'DriverError'
  }
}

interface FixtureMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  occurredAtMs: number
}

interface FixtureSession {
  id: string
  workspaceId: string
  title: string
  isProcessing: boolean
  messages: FixtureMessage[]
}

interface FixtureDocument {
  v: 1
  workspaces: Array<{ id: string; name: string }>
  sessions: FixtureSession[]
}

interface AdvancePayload {
  v: 1
  events: Array<{ sessionId: string; messageId: string; text: string; occurredAtMs: number }>
}

interface DurableAuthorityDocument extends FixtureDocument {
  fixtureDigest: string | null
  execution: {
    send: number
    cancel: number
    fixtureAdvance: number
  }
  protocolCounts: {
    commandResult: number
    mutatingResult: number
    idempotencyConflict: number
    resyncRequiredResult: number
    droppedResult: number
    disconnectFault: number
  }
  optimisticAcks: Record<string, string>
}

interface DriverCounts {
  sendExecutionCount: number
  cancelExecutionCount: number
  fixtureAdvanceCount: number
  commandResultCount: number
  mutatingResultCount: number
  idempotencyConflictCount: number
  resyncRequiredResultCount: number
  droppedResultCount: number
  disconnectFaultCount: number
}

/**
 * Deterministic, crash-atomic test session authority. It is intentionally a
 * BridgeSessionPort rather than a provider/model substitute: the production
 * MobileBridgeFacade remains the only command dispatcher and idempotency owner.
 */
export class DurableDesktopSessionAuthority implements BridgeSessionPort {
  readonly #path: string
  #doc: DurableAuthorityDocument

  constructor(stateDir: string) {
    this.#path = join(stateDir, 'desktop-session-authority.json')
    this.#doc = this.#load()
  }

  loadFixture(fixture: FixtureDocument): void {
    validateFixture(fixture)
    const digest = fixtureIdentity(fixture)
    const next = toDurableFixture(fixture, digest)
    if (this.#hasPersistedState()) {
      if (this.#doc.fixtureDigest !== digest) throw new DriverError('INVALID_STATE')
      return
    }
    this.#doc = next
    this.#save()
  }

  getWorkspaces(): ReadonlyArray<{ id: string; name: string }> {
    return this.#doc.workspaces.map(workspace => ({ ...workspace }))
  }

  getSessions(workspaceId?: string): readonly Session[] {
    return this.#doc.sessions
      .filter(session => workspaceId === undefined || session.workspaceId === workspaceId)
      .map(session => this.#projectSession(session))
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const session = this.#doc.sessions.find(candidate => candidate.id === sessionId)
    return session ? this.#projectSession(session) : null
  }

  getSessionWorkspaceId(sessionId: string): string | undefined {
    return this.#doc.sessions.find(candidate => candidate.id === sessionId)?.workspaceId
  }

  async sendMessage(
    sessionId: string,
    text: string,
    request: { readonly optimisticMessageId: string; readonly onAck: (persistedMessageId: string) => void },
  ): Promise<void> {
    const session = this.#requireSession(sessionId)
    let persistedMessageId = this.#doc.optimisticAcks[request.optimisticMessageId]
    if (!persistedMessageId) {
      persistedMessageId = `bridge-user-${createHash('sha256').update(request.optimisticMessageId).digest('hex').slice(0, 32)}`
      this.#doc.optimisticAcks[request.optimisticMessageId] = persistedMessageId
      if (!session.messages.some(message => message.id === persistedMessageId)) {
        session.messages.push({
          id: persistedMessageId,
          role: 'user',
          text,
          occurredAtMs: nextAuthorityTimestamp(this.#doc),
        })
      }
      session.isProcessing = true
      this.#doc.execution.send += 1
      this.#save()
    }
    request.onAck(persistedMessageId)
  }

  async cancelProcessing(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId)
    session.isProcessing = false
    this.#doc.execution.cancel += 1
    this.#save()
  }

  advance(payload: AdvancePayload, count: number): SessionEvent[] {
    validateAdvancePayload(payload)
    if (!Number.isSafeInteger(count) || count < 0 || count > payload.events.length) throw new DriverError('FILE_INVALID')
    const events: SessionEvent[] = []
    for (const event of payload.events.slice(0, count)) {
      const session = this.#requireSession(event.sessionId)
      if (!session.messages.some(message => message.id === event.messageId)) {
        session.messages.push({
          id: event.messageId,
          role: 'assistant',
          text: event.text,
          occurredAtMs: event.occurredAtMs,
        })
        session.isProcessing = false
        this.#doc.execution.fixtureAdvance += 1
      }
      events.push({
        type: 'text_complete',
        sessionId: event.sessionId,
        text: event.text,
        timestamp: event.occurredAtMs,
        messageId: event.messageId,
      })
    }
    this.#save()
    return events
  }

  recordCommandResult(input: {
    mutating: boolean
    idempotencyConflict: boolean
    resyncRequired: boolean
    fault: 'drop' | 'disconnect' | null
  }): void {
    this.#doc.protocolCounts.commandResult += 1
    if (input.mutating) this.#doc.protocolCounts.mutatingResult += 1
    if (input.idempotencyConflict) this.#doc.protocolCounts.idempotencyConflict += 1
    if (input.resyncRequired) this.#doc.protocolCounts.resyncRequiredResult += 1
    if (input.fault === 'drop') this.#doc.protocolCounts.droppedResult += 1
    if (input.fault === 'disconnect') this.#doc.protocolCounts.disconnectFault += 1
    this.#save()
  }

  counts(): DriverCounts {
    return {
      sendExecutionCount: this.#doc.execution.send,
      cancelExecutionCount: this.#doc.execution.cancel,
      fixtureAdvanceCount: this.#doc.execution.fixtureAdvance,
      commandResultCount: this.#doc.protocolCounts.commandResult,
      mutatingResultCount: this.#doc.protocolCounts.mutatingResult,
      idempotencyConflictCount: this.#doc.protocolCounts.idempotencyConflict,
      resyncRequiredResultCount: this.#doc.protocolCounts.resyncRequiredResult,
      droppedResultCount: this.#doc.protocolCounts.droppedResult,
      disconnectFaultCount: this.#doc.protocolCounts.disconnectFault,
    }
  }

  #projectSession(session: FixtureSession): Session {
    const workspace = this.#doc.workspaces.find(candidate => candidate.id === session.workspaceId)
    const messages: Message[] = session.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.text,
      timestamp: message.occurredAtMs,
    }))
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      workspaceName: workspace?.name ?? 'Workspace',
      name: session.title,
      createdAt: messages[0]?.timestamp ?? 0,
      lastMessageAt: messages.at(-1)?.timestamp ?? 0,
      messages,
      isProcessing: session.isProcessing,
    }
  }

  #requireSession(sessionId: string): FixtureSession {
    const session = this.#doc.sessions.find(candidate => candidate.id === sessionId)
    if (!session) throw new DriverError('FILE_INVALID')
    return session
  }

  #hasPersistedState(): boolean {
    return this.#doc.fixtureDigest !== null
      || this.#doc.workspaces.length > 0
      || this.#doc.sessions.length > 0
      || this.#doc.execution.send > 0
      || this.#doc.execution.cancel > 0
      || this.#doc.execution.fixtureAdvance > 0
  }

  #load(): DurableAuthorityDocument {
    if (!existsSync(this.#path)) return toDurableFixture({ v: 1, workspaces: [], sessions: [] }, null)
    const value = readSecureJsonFile(this.#path, MAX_CONTROL_FILE_BYTES)
    validateDurableAuthority(value)
    return structuredClone(value)
  }

  #save(): void {
    atomicWrite0600(this.#path, `${JSON.stringify(this.#doc, null, 2)}\n`)
  }
}

export class DesktopBridgeE2EDriver {
  readonly #root: string
  readonly #areas: Record<PathArea, string>
  readonly #credentials: CredentialManager
  readonly #saga: BridgeCredentialSaga
  readonly #sessions: DurableDesktopSessionAuthority
  readonly #seenRequestIds = new Set<string>()
  readonly #counts: DriverCounts

  #ready = false
  #stopped = false
  #bridgeUrl = ''
  #tlsServerName = ''
  #caCertificate: Buffer | null = null
  #profile: BridgeProfile | null = null
  #authorityStore: BridgeAuthorityStore | null = null
  #runtime: DesktopBridgeRuntime | null = null
  #sink: ReturnType<DesktopBridgeRuntime['composeSessionEventSink']> | null = null
  #enrollmentToken: string | undefined
  #fault: FaultKind | null = null
  #activeSockets = new Set<WebSocket>()
  #transportDisconnected = false

  constructor(root: string) {
    this.#root = validateRunRoot(root)
    this.#areas = {
      secrets: join(this.#root, 'secrets'),
      state: join(this.#root, 'state'),
      control: join(this.#root, 'control'),
    }
    for (const area of ['secrets', 'state', 'control', 'logs', 'evidence']) {
      validateSecureDirectory(join(this.#root, area))
    }
    this.#credentials = new CredentialManager({ credentialsConfigDir: this.#areas.state })
    this.#saga = new BridgeCredentialSaga(this.#credentials, {}, join(this.#areas.state, 'bridge'))
    this.#sessions = new DurableDesktopSessionAuthority(this.#areas.state)
    this.#counts = this.#sessions.counts()
  }

  get stopped(): boolean {
    return this.#stopped
  }

  async handle(raw: unknown): Promise<ControlResponse> {
    let request: ControlRequest
    try {
      request = parseControlRequest(raw)
      if (this.#seenRequestIds.has(request.id)) throw new DriverError('DUPLICATE_REQUEST')
      this.#seenRequestIds.add(request.id)
      const result = await this.#dispatch(request.op, request.args)
      return { v: 1, id: request.id, ok: true, result }
    } catch (error) {
      const id = safeRequestId(raw)
      return {
        v: 1,
        id,
        ok: false,
        error: { code: error instanceof DriverError ? error.code : 'OPERATION_FAILED' },
      }
    }
  }

  async close(): Promise<void> {
    await this.#runtime?.stop().catch(() => undefined)
    this.#runtime = null
    this.#sink = null
    for (const socket of this.#activeSockets) socket.terminate()
    this.#activeSockets.clear()
    this.#stopped = true
  }

  async #dispatch(op: Operation, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (op) {
      case 'driver.ready': return this.#readyDriver(args)
      case 'desktop.enroll': return this.#stageEnrollment(args)
      case 'desktop.auth': return this.#authenticate(args)
      case 'desktop.fixture.load': return this.#loadFixture(args)
      case 'desktop.pairing.open': return this.#openPairing(args)
      case 'desktop.pairing.await-request': return this.#awaitPairingRequest(args)
      case 'desktop.pairing.approve': return this.#approvePairing(args)
      case 'desktop.fixture.advance': return this.#advanceFixture(args)
      case 'desktop.binding.revoke': return this.#revokeBinding(args)
      case 'desktop.authority.counts': return this.#authorityCounts(args)
      case 'transport.disconnect': return this.#disconnect(args)
      case 'transport.reconnect': return this.#reconnect(args)
      case 'driver.state': return this.#driverState(args)
      case 'fault.arm': return this.#armFault(args)
      case 'driver.stop': return this.#stop(args)
    }
  }

  async #readyDriver(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, ['bridgeUrl', 'tlsServerName', 'caCertRef', 'protocol'])
    if (this.#ready) throw new DriverError('INVALID_STATE')
    if (typeof args.bridgeUrl !== 'string' || typeof args.tlsServerName !== 'string') throw new DriverError('INVALID_REQUEST')
    const url = parseBridgeUrl(args.bridgeUrl)
    if (url.hostname !== 'bridge.localhost' || args.tlsServerName !== 'bridge.localhost') throw new DriverError('INVALID_REQUEST')
    validateProtocolCoordinates(args.protocol)
    const caPath = this.resolvePathRef(args.caCertRef, ['control'])
    const caCertificate = readSecureFile(caPath, 1024 * 1024)
    if (!caCertificate.includes('BEGIN CERTIFICATE')) throw new DriverError('FILE_INVALID')

    await this.#saga.ensureRecovered()
    this.#bridgeUrl = url.toString().replace(/\/$/, '')
    this.#tlsServerName = args.tlsServerName
    this.#caCertificate = Buffer.from(caCertificate)
    this.#ready = true
    return { state: 'ready' }
  }

  #stageEnrollment(args: Record<string, unknown>): Record<string, unknown> {
    this.#requireReady()
    strictKeys(args, ['bootstrapTokenRef'])
    if (this.#runtime) throw new DriverError('INVALID_STATE')
    const tokenPath = this.resolvePathRef(args.bootstrapTokenRef, ['secrets'])
    const token = readSecureFile(tokenPath, 4096).trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DriverError('FILE_INVALID')
    this.#profile = setBridgeProfile({
      url: this.#bridgeUrl,
      displayName: 'Wave D Desktop',
      enabled: true,
    })
    this.#enrollmentToken = token
    return { state: 'enrollment-staged' }
  }

  async #authenticate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#requireReady()
    strictKeys(args, [])
    if (this.#runtime) throw new DriverError('INVALID_STATE')
    await this.#startRuntime()
    return { state: 'connecting' }
  }

  #loadFixture(args: Record<string, unknown>): Record<string, unknown> {
    this.#requireReady()
    strictKeys(args, ['fixtureRef'])
    const fixturePath = this.resolvePathRef(args.fixtureRef, ['state', 'control'])
    const fixture = readSecureJsonFile(fixturePath, MAX_CONTROL_FILE_BYTES)
    validateFixture(fixture)
    this.#sessions.loadFixture(fixture)
    this.#refreshAuthorityCounts()
    return {
      workspaceCount: fixture.workspaces.length,
      sessionCount: fixture.sessions.length,
    }
  }

  async #openPairing(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, ['manualCode'])
    if (args.manualCode !== false) throw new DriverError('INVALID_REQUEST')
    const runtime = this.#requireAuthenticatedRuntime()
    runtime.openPairing(OWNER_ID, { allowManualCode: false })
    const state = await waitFor(() => {
      const current = runtime.getSafeState(OWNER_ID)
      return current.pairing?.state === 'open' && current.pairing.display ? current : null
    }, PAIRING_TIMEOUT_MS)
    const qrPayload = state.pairing?.display?.qrPayload
    if (!qrPayload) throw new DriverError('OPERATION_FAILED')
    const qrRef: PathRef = { area: 'secrets', path: 'desktop-pairing.json' }
    atomicWrite0600(this.resolvePathRefForWrite(qrRef, ['secrets']), `${JSON.stringify({ v: 1, qrPayload })}\n`)
    return { qrRef }
  }

  async #awaitPairingRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    const runtime = this.#requireAuthenticatedRuntime()
    const state = await waitFor(() => {
      const current = runtime.getSafeState(OWNER_ID)
      return current.pairing?.pendingRequest ? current : null
    }, PAIRING_TIMEOUT_MS)
    return {
      state: 'pending',
      requestedCapabilityCount: state.pairing!.pendingRequest!.requestedCapabilities.length,
    }
  }

  async #approvePairing(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    const runtime = this.#requireAuthenticatedRuntime()
    const pending = runtime.getSafeState(OWNER_ID).pairing?.pendingRequest
    if (!pending) throw new DriverError('INVALID_STATE')
    await runtime.approvePairing(OWNER_ID, pending.requestedCapabilities)
    return { capabilityCount: pending.requestedCapabilities.length }
  }

  async #advanceFixture(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, ['kind', 'count', 'payloadRef'])
    if (args.kind !== 'live' && args.kind !== 'offline-gap') throw new DriverError('INVALID_REQUEST')
    if (!Number.isSafeInteger(args.count) || (args.count as number) < 0) throw new DriverError('INVALID_REQUEST')
    const payloadPath = this.resolvePathRef(args.payloadRef, ['state', 'control'])
    const payload = readSecureJsonFile(payloadPath, MAX_CONTROL_FILE_BYTES)
    validateAdvancePayload(payload)
    const events = this.#sessions.advance(payload, args.count as number)
    this.#refreshAuthorityCounts()
    if (args.kind === 'live') {
      const sink = this.#sink
      if (!sink || !this.#runtime?.safeState.authenticated) throw new DriverError('INVALID_STATE')
      for (const event of events) {
        const workspaceId = this.#sessions.getSessionWorkspaceId(event.sessionId)
        if (!workspaceId) throw new DriverError('FILE_INVALID')
        sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
      }
    }
    return { kind: args.kind, eventCount: events.length }
  }

  async #revokeBinding(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    const runtime = this.#requireAuthenticatedRuntime()
    const bindings = runtime.listBindings()
    if (bindings.length !== 1) throw new DriverError('INVALID_STATE')
    await runtime.revokeBinding(bindings[0]!.bindingId)
    return { revoked: true }
  }

  #authorityCounts(args: Record<string, unknown>): Record<string, unknown> {
    strictKeys(args, [])
    this.#requireReady()
    this.#refreshAuthorityCounts()
    return {
      sendExecutionCount: this.#counts.sendExecutionCount,
      cancelExecutionCount: this.#counts.cancelExecutionCount,
      idempotencyConflictCount: this.#counts.idempotencyConflictCount,
      droppedResultCount: this.#counts.droppedResultCount,
      resyncRequiredResultCount: this.#counts.resyncRequiredResultCount,
    }
  }

  async #disconnect(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    if (!this.#runtime) throw new DriverError('INVALID_STATE')
    this.#transportDisconnected = true
    await this.#runtime.stop()
    this.#runtime = null
    this.#sink = null
    for (const socket of this.#activeSockets) socket.terminate()
    this.#activeSockets.clear()
    return { state: 'disconnected' }
  }

  async #reconnect(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    if (!this.#transportDisconnected || this.#runtime) throw new DriverError('INVALID_STATE')
    this.#transportDisconnected = false
    await this.#startRuntime()
    return { state: 'connecting' }
  }

  #driverState(args: Record<string, unknown>): Record<string, unknown> {
    strictKeys(args, [])
    this.#refreshAuthorityCounts()
    const safe = this.#runtime?.safeState ?? null
    const durableBindings = this.#authorityStore?.listBindings() ?? []
    const replay = durableBindings.length === 1 ? this.#authorityStore?.loadReplay(durableBindings[0]!.bindingId) : null
    const state = this.#stopped
      ? 'stopped'
      : this.#transportDisconnected
        ? 'disconnected'
        : safe?.authenticated && replay?.resyncRequired
          ? 'authenticated-resync-required'
          : safe?.pairing?.pendingRequest
            ? 'pairing-pending'
            : safe?.pairing?.state === 'open'
              ? 'pairing-open'
              : safe?.authenticated
                ? 'authenticated'
                : this.#runtime
                  ? safe?.connectorState === 'terminal' ? 'terminal' : 'connecting'
                  : this.#enrollmentToken
                    ? 'enrollment-staged'
                    : this.#ready ? 'ready' : 'created'
    return {
      state,
      count: safe?.bindings.length ?? durableBindings.length,
      connectorState: safe?.connectorState ?? 'stopped',
      ...(safe?.terminalReason ? { terminalReason: safe.terminalReason } : {}),
    }
  }

  #armFault(args: Record<string, unknown>): Record<string, unknown> {
    strictKeys(args, ['kind'])
    if (!FAULT_KINDS.includes(args.kind as FaultKind) || this.#fault) throw new DriverError('INVALID_REQUEST')
    this.#fault = args.kind as FaultKind
    return { armed: true }
  }

  async #stop(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    strictKeys(args, [])
    await this.close()
    return { state: 'stopped' }
  }

  async #startRuntime(): Promise<void> {
    if (!this.#caCertificate) throw new DriverError('INVALID_STATE')
    await this.#saga.ensureRecovered()
    this.#profile = getBridgeProfile()
    if (!this.#profile) throw new DriverError('INVALID_STATE')
    this.#authorityStore = new BridgeAuthorityStore(join(this.#areas.state, 'bridge'))
    const runtime = new DesktopBridgeRuntime({
      profile: this.#profile,
      sessions: this.#sessions,
      credentials: this.#credentials,
      enrollmentToken: this.#enrollmentToken,
      authorityStore: this.#authorityStore,
      commitEnrollment: (profile, instanceToken) => this.#saga.commitEnrollment(profile, instanceToken),
      clientVersion: DESKTOP_BRIDGE_E2E_CLIENT_VERSION,
      connectorFactory: options => new BridgeConnectorService({
        ...options,
        webSocketFactory: (url, transportOptions) => this.#createTlsSocket(url, transportOptions),
      }),
      onStateChange: state => {
        if (state.authenticated) this.#profile = state.profile ? { ...state.profile } : this.#profile
      },
    })
    this.#runtime = runtime
    this.#sink = runtime.composeSessionEventSink(() => {})
    this.#enrollmentToken = undefined
    runtime.start()
  }

  #createTlsSocket(
    url: string,
    options: { rejectUnauthorized: true; perMessageDeflate: false; maxPayload: number },
  ): BridgeWebSocketLike {
    if (
      options.rejectUnauthorized !== true
      || options.perMessageDeflate !== false
      || options.maxPayload !== SECURITY_LIMITS.websocketMaxPayloadBytes
    ) throw new DriverError('INVALID_STATE')
    const parsed = new URL(url)
    if (parsed.protocol !== 'wss:' || parsed.hostname !== this.#tlsServerName) throw new DriverError('INVALID_STATE')
    const socket = new WebSocket(url, {
      rejectUnauthorized: true,
      perMessageDeflate: false,
      maxPayload: options.maxPayload,
      ca: this.#caCertificate!,
      servername: this.#tlsServerName,
      checkServerIdentity: ((hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) => {
        if (hostname !== this.#tlsServerName) return new Error('tls-hostname')
        return checkServerIdentity(this.#tlsServerName, certificate)
      }) as never,
    })
    this.#activeSockets.add(socket)
    socket.once('close', () => this.#activeSockets.delete(socket))
    const realSend = socket.send.bind(socket)
    socket.send = ((data: WebSocket.Data, sendOptionsOrCallback?: unknown, callbackMaybe?: unknown) => {
      const callback = typeof sendOptionsOrCallback === 'function'
        ? sendOptionsOrCallback as (error?: Error) => void
        : typeof callbackMaybe === 'function' ? callbackMaybe as (error?: Error) => void : undefined
      if (typeof data === 'string') {
        const action = this.#inspectOutbound(data)
        if (action === 'drop') {
          queueMicrotask(() => callback?.())
          return
        }
        if (action === 'disconnect') {
          socket.terminate()
          queueMicrotask(() => callback?.())
          return
        }
      }
      if (typeof sendOptionsOrCallback === 'function' || sendOptionsOrCallback === undefined) {
        return realSend(data, sendOptionsOrCallback as ((error?: Error) => void) | undefined)
      }
      return realSend(data, sendOptionsOrCallback as never, callback as ((error?: Error) => void) | undefined)
    }) as WebSocket['send']
    return socket as unknown as BridgeWebSocketLike
  }

  #inspectOutbound(serialized: string): 'send' | 'drop' | 'disconnect' {
    let raw: unknown
    try { raw = JSON.parse(serialized) } catch { return 'send' }
    if (!isRecord(raw) || raw.type !== 'command.result') return 'send'
    const command = raw.outcome === 'success' && isRecord(raw.result) ? raw.result.command : raw.command
    const mutating = command === 'session.send-message' || command === 'session.cancel'
    const idempotencyConflict = raw.outcome === 'error' && isRecord(raw.error) && raw.error.code === 'IDEMPOTENCY_CONFLICT'
    const resyncRequired = raw.outcome === 'error' && isRecord(raw.error) && raw.error.code === 'RESYNC_REQUIRED'
    let fault: 'drop' | 'disconnect' | null = null
    if (this.#fault === 'drop-next-command-result') {
      this.#fault = null
      fault = 'drop'
    } else if (this.#fault === 'disconnect-after-next-mutating-command' && mutating) {
      this.#fault = null
      fault = 'disconnect'
    }
    this.#sessions.recordCommandResult({ mutating, idempotencyConflict, resyncRequired, fault })
    this.#refreshAuthorityCounts()
    return fault ?? 'send'
  }

  resolvePathRef(value: unknown, allowedAreas: readonly PathArea[]): string {
    const ref = parsePathRef(value)
    if (!allowedAreas.includes(ref.area)) throw new DriverError('INVALID_PATH_REF')
    const area = realpathSync(this.#areas[ref.area])
    const candidate = resolve(area, ...ref.path.split('/'))
    assertContained(area, candidate)
    let actual: string
    try {
      const stat = lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
        throw new DriverError('FILE_INVALID')
      }
      actual = realpathSync(candidate)
    } catch (error) {
      if (error instanceof DriverError) throw error
      throw new DriverError('INVALID_PATH_REF')
    }
    assertContained(area, actual)
    return actual
  }

  resolvePathRefForWrite(value: unknown, allowedAreas: readonly PathArea[]): string {
    const ref = parsePathRef(value)
    if (!allowedAreas.includes(ref.area)) throw new DriverError('INVALID_PATH_REF')
    const area = realpathSync(this.#areas[ref.area])
    const candidate = resolve(area, ...ref.path.split('/'))
    assertContained(area, candidate)
    if (dirname(candidate) !== area) throw new DriverError('INVALID_PATH_REF')
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new DriverError('INVALID_PATH_REF')
    }
    return candidate
  }

  #requireReady(): void {
    if (!this.#ready || this.#stopped) throw new DriverError('INVALID_STATE')
  }

  #requireAuthenticatedRuntime(): DesktopBridgeRuntime {
    const runtime = this.#runtime
    if (!runtime?.safeState.authenticated) throw new DriverError('INVALID_STATE')
    return runtime
  }

  #refreshAuthorityCounts(): void {
    Object.assign(this.#counts, this.#sessions.counts())
    atomicWrite0600(join(this.#areas.state, 'desktop-driver-counts.json'), `${JSON.stringify({
      v: 1,
      ...this.#counts,
    }, null, 2)}\n`)
  }
}

export function parseControlRequest(value: unknown): ControlRequest {
  if (!isRecord(value)) throw new DriverError('INVALID_REQUEST')
  strictKeys(value, ['v', 'id', 'op', 'args'])
  if (value.v !== 1 || typeof value.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.id)) {
    throw new DriverError('INVALID_REQUEST')
  }
  if (typeof value.op !== 'string' || !OPS.includes(value.op as Operation)) throw new DriverError('UNKNOWN_OPERATION')
  if (!isRecord(value.args)) throw new DriverError('INVALID_REQUEST')
  return value as unknown as ControlRequest
}

export function parsePathRef(value: unknown): PathRef {
  if (!isRecord(value)) throw new DriverError('INVALID_PATH_REF')
  strictKeys(value, ['area', 'path'], 'INVALID_PATH_REF')
  if (!PATH_AREAS.includes(value.area as PathArea) || typeof value.path !== 'string') throw new DriverError('INVALID_PATH_REF')
  if (
    value.path.length === 0
    || isAbsolute(value.path)
    || value.path.includes('\\')
    || value.path.includes('\0')
    || value.path.startsWith('/')
    || value.path.endsWith('/')
  ) throw new DriverError('INVALID_PATH_REF')
  const segments = value.path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw new DriverError('INVALID_PATH_REF')
  return { area: value.area as PathArea, path: value.path }
}

export function validateRunRoot(root: string): string {
  if (!isAbsolute(root)) throw new DriverError('INVALID_PATH_REF')
  const actual = realpathSync(root)
  validateSecureDirectory(actual)
  return actual
}

function validateSecureDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) {
    throw new DriverError('INVALID_PATH_REF')
  }
}

function parseBridgeUrl(value: string): URL {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new DriverError('INVALID_REQUEST') }
  if (
    parsed.protocol !== 'wss:'
    || parsed.hostname !== 'bridge.localhost'
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new DriverError('INVALID_REQUEST')
  return parsed
}

function validateProtocolCoordinates(value: unknown): void {
  if (!isRecord(value)) throw new DriverError('PROTOCOL_MISMATCH')
  strictKeys(value, Object.keys(PROTOCOL_COORDINATES), 'PROTOCOL_MISMATCH')
  for (const [key, expected] of Object.entries(PROTOCOL_COORDINATES)) {
    if (value[key] !== expected) throw new DriverError('PROTOCOL_MISMATCH')
  }
}

function validateFixture(value: unknown): asserts value is FixtureDocument {
  if (!isRecord(value)) throw new DriverError('FILE_INVALID')
  strictKeys(value, ['v', 'workspaces', 'sessions'], 'FILE_INVALID')
  if (value.v !== 1 || !Array.isArray(value.workspaces) || !Array.isArray(value.sessions)) throw new DriverError('FILE_INVALID')
  const workspaceIds = new Set<string>()
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace)) throw new DriverError('FILE_INVALID')
    strictKeys(workspace, ['id', 'name'], 'FILE_INVALID')
    if (!validEntityId(workspace.id) || !validLabel(workspace.name) || workspaceIds.has(workspace.id)) throw new DriverError('FILE_INVALID')
    workspaceIds.add(workspace.id)
  }
  const sessionIds = new Set<string>()
  for (const session of value.sessions) {
    if (!isRecord(session)) throw new DriverError('FILE_INVALID')
    strictKeys(session, ['id', 'workspaceId', 'title', 'isProcessing', 'messages'], 'FILE_INVALID')
    if (
      !validEntityId(session.id)
      || !validEntityId(session.workspaceId)
      || !workspaceIds.has(session.workspaceId)
      || !validLabel(session.title)
      || typeof session.isProcessing !== 'boolean'
      || !Array.isArray(session.messages)
      || sessionIds.has(session.id)
    ) throw new DriverError('FILE_INVALID')
    sessionIds.add(session.id)
    const messageIds = new Set<string>()
    for (const message of session.messages) {
      validateFixtureMessage(message)
      if (messageIds.has(message.id)) throw new DriverError('FILE_INVALID')
      messageIds.add(message.id)
    }
  }
}

function validateFixtureMessage(value: unknown): asserts value is FixtureMessage {
  if (!isRecord(value)) throw new DriverError('FILE_INVALID')
  strictKeys(value, ['id', 'role', 'text', 'occurredAtMs'], 'FILE_INVALID')
  if (
    !validEntityId(value.id)
    || (value.role !== 'user' && value.role !== 'assistant')
    || typeof value.text !== 'string'
    || value.text.length === 0
    || Buffer.byteLength(value.text, 'utf8') > SECURITY_LIMITS.timelineTextMaxBytes
    || !validTimestamp(value.occurredAtMs)
  ) throw new DriverError('FILE_INVALID')
}

function validateAdvancePayload(value: unknown): asserts value is AdvancePayload {
  if (!isRecord(value)) throw new DriverError('FILE_INVALID')
  strictKeys(value, ['v', 'events'], 'FILE_INVALID')
  if (value.v !== 1 || !Array.isArray(value.events)) throw new DriverError('FILE_INVALID')
  const keys = new Set<string>()
  for (const event of value.events) {
    if (!isRecord(event)) throw new DriverError('FILE_INVALID')
    strictKeys(event, ['sessionId', 'messageId', 'text', 'occurredAtMs'], 'FILE_INVALID')
    if (
      !validEntityId(event.sessionId)
      || !validEntityId(event.messageId)
      || typeof event.text !== 'string'
      || event.text.length === 0
      || Buffer.byteLength(event.text, 'utf8') > SECURITY_LIMITS.timelineTextMaxBytes
      || !validTimestamp(event.occurredAtMs)
    ) throw new DriverError('FILE_INVALID')
    const key = `${event.sessionId}\0${event.messageId}`
    if (keys.has(key)) throw new DriverError('FILE_INVALID')
    keys.add(key)
  }
}

function validateDurableAuthority(value: unknown): asserts value is DurableAuthorityDocument {
  if (!isRecord(value)) throw new DriverError('FILE_INVALID')
  strictKeys(value, ['v', 'workspaces', 'sessions', 'fixtureDigest', 'execution', 'protocolCounts', 'optimisticAcks'], 'FILE_INVALID')
  validateFixture({ v: value.v, workspaces: value.workspaces, sessions: value.sessions })
  if (value.fixtureDigest !== null && (typeof value.fixtureDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.fixtureDigest))) {
    throw new DriverError('FILE_INVALID')
  }
  if (!isRecord(value.execution)) throw new DriverError('FILE_INVALID')
  strictKeys(value.execution, ['send', 'cancel', 'fixtureAdvance'], 'FILE_INVALID')
  if (![value.execution.send, value.execution.cancel, value.execution.fixtureAdvance].every(validCount)) throw new DriverError('FILE_INVALID')
  if (!isRecord(value.protocolCounts)) throw new DriverError('FILE_INVALID')
  strictKeys(value.protocolCounts, ['commandResult', 'mutatingResult', 'idempotencyConflict', 'resyncRequiredResult', 'droppedResult', 'disconnectFault'], 'FILE_INVALID')
  if (!Object.values(value.protocolCounts).every(validCount)) throw new DriverError('FILE_INVALID')
  if (!isRecord(value.optimisticAcks)) throw new DriverError('FILE_INVALID')
  for (const [key, messageId] of Object.entries(value.optimisticAcks)) {
    if (!validEntityId(key) || !validEntityId(messageId)) throw new DriverError('FILE_INVALID')
  }
}

function toDurableFixture(fixture: FixtureDocument, fixtureDigest: string | null): DurableAuthorityDocument {
  return {
    ...structuredClone(fixture),
    fixtureDigest,
    execution: { send: 0, cancel: 0, fixtureAdvance: 0 },
    protocolCounts: {
      commandResult: 0,
      mutatingResult: 0,
      idempotencyConflict: 0,
      resyncRequiredResult: 0,
      droppedResult: 0,
      disconnectFault: 0,
    },
    optimisticAcks: {},
  }
}

function fixtureIdentity(fixture: FixtureDocument): string {
  return createHash('sha256').update(JSON.stringify({ workspaces: fixture.workspaces, sessions: fixture.sessions })).digest('hex')
}

function nextAuthorityTimestamp(doc: DurableAuthorityDocument): number {
  let maximum = 0
  for (const session of doc.sessions) {
    for (const message of session.messages) maximum = Math.max(maximum, message.occurredAtMs)
  }
  return Math.min(Number.MAX_SAFE_INTEGER, maximum + 1)
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[], code: DriverErrorCode = 'INVALID_REQUEST'): void {
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new DriverError(code)
}

function readSecureJsonFile(path: string, maxBytes: number): unknown {
  const text = readSecureFile(path, maxBytes)
  try { return JSON.parse(text) as unknown } catch { throw new DriverError('FILE_INVALID') }
}

function readSecureFile(path: string, maxBytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (
      !stat.isFile()
      || stat.size > maxBytes
      || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())
    ) throw new DriverError('FILE_INVALID')
    return readFileSync(fd, 'utf8')
  } catch (error) {
    if (error instanceof DriverError) throw error
    throw new DriverError('FILE_INVALID')
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function atomicWrite0600(path: string, text: string): void {
  const dir = dirname(path)
  validateSecureDirectory(dir)
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`)
  let fd: number | null = null
  let dirFd: number | null = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
    dirFd = openSync(dir, 'r')
    fsyncSync(dirFd)
  } finally {
    if (fd !== null) closeSync(fd)
    if (dirFd !== null) closeSync(dirFd)
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DriverError('INVALID_PATH_REF')
}

function safeRequestId(value: unknown): string {
  if (isRecord(value) && typeof value.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.id)) return value.id
  return 'invalid'
}

function validEntityId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001F\u007F]/.test(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new DriverError('TIMEOUT')
}

export const DESKTOP_BRIDGE_E2E_PROTOCOL_COORDINATES = PROTOCOL_COORDINATES
