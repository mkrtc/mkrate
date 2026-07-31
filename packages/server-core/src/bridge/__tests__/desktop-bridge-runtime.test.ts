import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_PROTOCOL_VERSION,
  COMMAND_CAPABILITIES,
  encodeBase64Url,
  type DesktopClientMessage,
  type DesktopServerMessage,
} from '@mkrate/bridge-protocol'
import type { BridgeProfile } from '@craft-agent/shared/config'
import { createBridgeCredentialEnvelope, type BridgeCredentialEnvelope } from '@craft-agent/shared/credentials'
import { RPC_CHANNELS, type SessionEvent } from '@craft-agent/shared/protocol'
import {
  BridgeConnectorService,
  type BridgeCredentialAccess,
  type BridgeTransportPort,
} from '../bridge-connector-service.ts'
import { BridgeAuthorityStore } from '../bridge-authority-store.ts'
import { DesktopBridgeRuntime } from '../desktop-bridge-runtime.ts'
import { FakeBridgeSessionPort } from '../bridge-test-helpers.ts'

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000'
const DEPLOYMENT_ID = opaque(1)
const INSTANCE_ID = opaque(2)
const INSTANCE_TOKEN = token(3)
const BINDING_ID = opaque(4)
const DEVICE_ID = opaque(5)
const OWNER_ID = 'electron-web-contents:7'

function opaque(byte: number): string {
  return encodeBase64Url(new Uint8Array(16).fill(byte))
}
function token(byte: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(byte))
}
function profile(): BridgeProfile {
  return {
    profileId: PROFILE_ID,
    url: 'wss://bridge.example.test',
    displayName: 'Desktop',
    enabled: true,
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    createdAt: 1,
    updatedAt: 1,
  }
}

class FakeCredentials implements BridgeCredentialAccess {
  async getBridgeInstanceCredential(): Promise<BridgeCredentialEnvelope> {
    return createBridgeCredentialEnvelope({
      origin: profile().url, profileId: PROFILE_ID, deploymentId: DEPLOYMENT_ID,
      instanceId: INSTANCE_ID, instanceToken: INSTANCE_TOKEN,
    })
  }
  async setBridgeInstanceCredential(): Promise<void> {}
  async deleteBridgeInstanceToken(): Promise<boolean> { return true }
}

class FakeTransport implements BridgeTransportPort {
  connected = false
  sent: DesktopClientMessage[] = []
  starts = 0
  stops = 0
  failNextSend = false

  constructor(readonly callbacks: {
    onOpen(): void
    onMessage(message: DesktopServerMessage): void
    onClose(event: { code: number; retrying: boolean }): void
  }) {}

  start(): void {
    this.starts++
    this.connected = true
    this.callbacks.onOpen()
  }
  stop(): void {
    this.stops++
    this.connected = false
  }
  retry(): void {}
  async send(message: DesktopClientMessage): Promise<void> {
    this.sent.push(message)
    if (this.failNextSend) { this.failNextSend = false; throw new Error('injected send failure') }
  }
  emit(message: DesktopServerMessage): void { this.callbacks.onMessage(message) }
}

interface Harness {
  runtime: DesktopBridgeRuntime
  transport: FakeTransport
  sessions: FakeBridgeSessionPort
}

function createHarness(
  onStateChange?: (state: ReturnType<DesktopBridgeRuntime['getSafeState']>) => void,
  authorityStore?: BridgeAuthorityStore,
): Harness {
  let transport!: FakeTransport
  let random = 20
  const sessions = new FakeBridgeSessionPort()
  const runtime = new DesktopBridgeRuntime({
    profile: profile(),
    sessions,
    credentials: new FakeCredentials(),
    now: () => 10_000,
    authorityStore,
    pairingTimers: {
      now: () => 10_000,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: handle => clearTimeout(handle),
      setInterval: (callback, delayMs) => setInterval(callback, delayMs),
      clearInterval: handle => clearInterval(handle),
    },
    onStateChange,
    connectorFactory: options => new BridgeConnectorService({
      ...options,
      randomBytes: length => new Uint8Array(length).fill(random++),
      transportFactory: callbacks => {
        transport = new FakeTransport(callbacks)
        return transport
      },
    }),
  })
  return {
    runtime,
    sessions,
    get transport() {
      if (!transport) throw new Error('Bridge transport has not been constructed')
      return transport
    },
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForCount<T extends DesktopClientMessage['type']>(
  transport: FakeTransport,
  type: T,
  count: number,
): Promise<Extract<DesktopClientMessage, { type: T }>> {
  for (let i = 0; i < 50; i++) {
    const matches = transport.sent.filter(message => message.type === type)
    if (matches.length >= count) return matches[count - 1] as Extract<DesktopClientMessage, { type: T }>
    await flush()
  }
  throw new Error(`Missing ${type} #${count}`)
}

async function waitForPairing(h: Harness, pending: boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const pairing = h.runtime.getSafeState(OWNER_ID).pairing
    if (pairing && (!pending || pairing.pendingRequest)) return
    await flush()
  }
  throw new Error(`Missing pairing state (pending=${pending})`)
}

async function authenticate(h: Harness): Promise<void> {
  h.runtime.start()
  const negotiate = await waitForCount(h.transport, 'deployment.negotiate', 1)
  h.transport.emit({
    type: 'deployment.accepted',
    endpoint: 'desktop',
    deploymentId: DEPLOYMENT_ID,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    capabilities: [...COMMAND_CAPABILITIES],
    serverTimeMs: 1,
    requestId: negotiate.requestId,
    version: BRIDGE_PROTOCOL_VERSION,
  })
  const auth = await waitForCount(h.transport, 'desktop.auth', 1)
  h.transport.emit({
    type: 'desktop.authenticated',
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    connectionId: opaque(8),
    tokenExpiresAtMs: 99_999,
    requestId: auth.requestId,
    version: BRIDGE_PROTOCOL_VERSION,
  })
  await flush()
  expect(h.runtime.safeState.authenticated).toBe(true)
}

async function pair(h: Harness): Promise<void> {
  h.runtime.openPairing(OWNER_ID)
  const open = await waitForCount(h.transport, 'pairing.open', 1)
  h.transport.emit({
    type: 'pairing.opened',
    deploymentId: DEPLOYMENT_ID,
    instanceId: INSTANCE_ID,
    pairingSessionId: opaque(9),
    qrPayload: `mkrate://pair?secret=${token(9)}`,
    manualCodeEnabled: true,
    manualCode: '12345678',
    expiresAtMs: 50_000,
    renewEveryMs: 3_000,
    leaseLostAfterMs: 8_000,
    requestId: open.requestId,
    version: BRIDGE_PROTOCOL_VERSION,
  })
  await waitForPairing(h, false)
  h.transport.emit({
    type: 'pairing.request',
    pairingSessionId: opaque(9),
    pairingRequestId: opaque(10),
    deviceId: DEVICE_ID,
    deviceName: 'Phone',
    bindingId: BINDING_ID,
    requestedCapabilities: [...COMMAND_CAPABILITIES],
    requestedAtMs: 2,
    expiresAtMs: 40_000,
    requestId: opaque(11),
    version: BRIDGE_PROTOCOL_VERSION,
  })
  await waitForPairing(h, true)

  const approval = h.runtime.approvePairing(OWNER_ID, COMMAND_CAPABILITIES)
  const approve = await waitForCount(h.transport, 'pairing.approve', 1)
  h.transport.emit({
    type: 'pairing.approved',
    recipient: 'desktop',
    pairingSessionId: opaque(9),
    pairingRequestId: opaque(10),
    bindingId: BINDING_ID,
    grantedCapabilities: [...COMMAND_CAPABILITIES],
    committedAtMs: 3,
    requestId: approve.requestId,
    version: BRIDGE_PROTOCOL_VERSION,
  })
  await approval
  expect(h.runtime.listBindings()).toEqual([
    expect.objectContaining({ bindingId: BINDING_ID, deviceId: DEVICE_ID, presence: 'online' }),
  ])
}

function emitCommand(
  h: Harness,
  index: number,
  payload: Extract<DesktopServerMessage, { type: 'command.request' }>['payload'],
): void {
  h.transport.emit({
    type: 'command.request',
    bindingId: BINDING_ID,
    commandId: opaque(30 + index),
    idempotencyKey: opaque(60 + index),
    sentAtMs: 100 + index,
    payload,
    version: BRIDGE_PROTOCOL_VERSION,
  })
}

describe('DesktopBridgeRuntime headless data plane', () => {
  test('persists only the durable binding projection after remote approval commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-bridge-pairing-authority-'))
    const store = new BridgeAuthorityStore(root)
    const h = createHarness(undefined, store)
    try {
      await authenticate(h)
      await pair(h)
      expect(store.listBindings()).toEqual([{
        bindingId: BINDING_ID,
        deviceId: DEVICE_ID,
        deviceName: 'Phone',
        grantedCapabilities: [...COMMAND_CAPABILITIES],
        approvedAtMs: 3,
      }])
    } finally {
      await h.runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('notifies immediately when a visible-owner pairing request becomes pending without exposing it globally', async () => {
    const states: Array<ReturnType<DesktopBridgeRuntime['getSafeState']>> = []
    const h = createHarness(state => states.push(state))
    await authenticate(h)
    h.runtime.openPairing(OWNER_ID)
    const open = await waitForCount(h.transport, 'pairing.open', 1)
    h.transport.emit({
      type: 'pairing.opened', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      pairingSessionId: opaque(9), qrPayload: `mkrate://pair?secret=${token(9)}`,
      manualCodeEnabled: true, manualCode: '12345678', expiresAtMs: 50_000,
      renewEveryMs: 3_000, leaseLostAfterMs: 8_000,
      requestId: open.requestId, version: BRIDGE_PROTOCOL_VERSION,
    })
    await waitForPairing(h, false)
    const before = states.length
    h.transport.emit({
      type: 'pairing.request', pairingSessionId: opaque(9), pairingRequestId: opaque(10),
      deviceId: DEVICE_ID, deviceName: 'Phone', bindingId: BINDING_ID,
      requestedCapabilities: [...COMMAND_CAPABILITIES], requestedAtMs: 2, expiresAtMs: 40_000,
      requestId: opaque(11), version: BRIDGE_PROTOCOL_VERSION,
    })
    await waitForPairing(h, true)
    expect(states.length).toBeGreaterThan(before)
    expect(h.runtime.getSafeState(OWNER_ID).pairing?.pendingRequest).toMatchObject({ bindingId: BINDING_ID, deviceName: 'Phone' })
    expect(states.at(-1)?.pairing?.pendingRequest).toBeUndefined()
  })

  test('dispatches immutable binding scope, projects ordered events, replays, resyncs, and preserves base sink', async () => {
    const h = createHarness()
    await authenticate(h)
    await pair(h)

    emitCommand(h, 0, { command: 'session.send-message', sessionId: 'session-1', text: 'hello from phone' })
    const sendResult = await waitForCount(h.transport, 'command.result', 1)
    expect(sendResult).toMatchObject({
      outcome: 'success',
      result: {
        command: 'session.send-message',
        accepted: true,
        messageId: h.sessions.persistedMessageId,
      },
    })
    expect(h.sessions.sendCalls).toHaveLength(1)
    const firstCursor = sendResult.outcome === 'success' && sendResult.result.command === 'session.send-message'
      ? sendResult.result.cursor
      : ''

    emitCommand(h, 1, { command: 'session.snapshot', sessionId: 'session-1' })
    const snapshot = await waitForCount(h.transport, 'command.result', 2)
    expect(snapshot).toMatchObject({ outcome: 'success', result: { command: 'session.snapshot' } })

    emitCommand(h, 2, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: firstCursor })
    const firstSubscribe = await waitForCount(h.transport, 'command.result', 3)
    expect(firstSubscribe).toMatchObject({
      outcome: 'success',
      result: { command: 'session.subscribe', replay: [] },
    })

    const baseCalls: Array<{ channel: string; args: unknown[] }> = []
    const sink = h.runtime.composeSessionEventSink((channel, _target, ...args) => baseCalls.push({ channel, args }))
    const event: SessionEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'safe answer',
      messageId: 'assistant-1',
    }
    const delta: SessionEvent = { type: 'text_delta', sessionId: 'session-1', delta: 'next chunk' }
    sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'workspace-1' }, event)
    sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'workspace-1' }, delta)
    await waitForCount(h.transport, 'timeline.event', 2)
    const timelines = h.transport.sent.filter(message => message.type === 'timeline.event')
    expect(timelines.map(message => message.event.payload)).toEqual([
      { kind: 'assistant.message', text: 'safe answer', state: 'complete' },
      { kind: 'assistant.message', text: 'next chunk', state: 'streaming' },
    ])
    expect(baseCalls).toEqual([
      { channel: RPC_CHANNELS.sessions.EVENT, args: [event] },
      { channel: RPC_CHANNELS.sessions.EVENT, args: [delta] },
    ])

    // Re-subscribing from the send cursor replays the intervening assistant events
    // and explicitly closes the replaced live subscription.
    emitCommand(h, 3, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: firstCursor })
    const replay = await waitForCount(h.transport, 'command.result', 4)
    expect(replay).toMatchObject({
      outcome: 'success',
      result: {
        command: 'session.subscribe',
        replay: [
          expect.objectContaining({ payload: { kind: 'assistant.message', text: 'safe answer', state: 'complete' } }),
          expect.objectContaining({ payload: { kind: 'assistant.message', text: 'next chunk', state: 'streaming' } }),
        ],
      },
    })
    expect(await waitForCount(h.transport, 'session.subscription.closed', 1)).toMatchObject({ reason: 'replaced' })

    emitCommand(h, 4, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: '1' })
    const resync = await waitForCount(h.transport, 'command.result', 5)
    expect(resync).toMatchObject({
      outcome: 'error',
      command: 'session.subscribe',
      error: { code: 'RESYNC_REQUIRED', retryable: false },
    })

    // Non-session channels are preserved for the base sink and never projected.
    const sentBefore = h.transport.sent.length
    sink('sources:changed', { to: 'all' }, { secret: 'base-only' })
    await flush()
    expect(baseCalls.at(-1)).toEqual({ channel: 'sources:changed', args: [{ secret: 'base-only' }] })
    expect(h.transport.sent).toHaveLength(sentBefore)
  })

  test('revokes the remote Desktop instance before safe profile clear removes local bindings', async () => {
    const h = createHarness()
    await authenticate(h)
    await pair(h)
    const clearing = h.runtime.prepareProfileClear()
    const revoke = await waitForCount(h.transport, 'desktop.revoke', 1)
    expect(h.runtime.safeState.bindings).toHaveLength(1)
    h.transport.emit({
      type: 'desktop.revoked', deploymentId: DEPLOYMENT_ID, instanceId: INSTANCE_ID,
      revokedAtMs: 20, requestId: revoke.requestId, version: BRIDGE_PROTOCOL_VERSION,
    })
    await clearing
    expect(h.runtime.safeState.bindings).toEqual([])
  })

  test('failed remote profile clear preserves binding authorization but forces resync before admission resumes', async () => {
    const h = createHarness()
    await authenticate(h)
    await pair(h)
    h.transport.failNextSend = true
    await expect(h.runtime.prepareProfileClear()).rejects.toThrow()
    expect(h.runtime.safeState.bindings).toHaveLength(1)
    emitCommand(h, 0, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: null })
    expect(await waitForCount(h.transport, 'command.result', 1)).toMatchObject({
      outcome: 'error', error: { code: 'RESYNC_REQUIRED', retryable: false },
    })
  })

  test('drops live subscriptions but preserves replay on offline, then clears binding authorization on revoke', async () => {
    const h = createHarness()
    await authenticate(h)
    await pair(h)

    emitCommand(h, 0, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: null })
    const initialSubscribe = await waitForCount(h.transport, 'command.result', 1)
    const initialCursor = initialSubscribe.outcome === 'success' && initialSubscribe.result.command === 'session.subscribe'
      ? initialSubscribe.result.throughCursor
      : ''
    const sink = h.runtime.composeSessionEventSink(() => {})
    sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'workspace-1' }, {
      type: 'text_complete', sessionId: 'session-1', text: 'retained across short disconnect', messageId: 'assistant-retained',
    })
    await waitForCount(h.transport, 'timeline.event', 1)

    h.transport.emit({
      type: 'presence.changed', subject: 'mobile', instanceId: INSTANCE_ID,
      bindingId: BINDING_ID, state: 'offline', changedAtMs: 20, version: BRIDGE_PROTOCOL_VERSION,
    })
    expect(await waitForCount(h.transport, 'session.subscription.closed', 1)).toMatchObject({
      bindingId: BINDING_ID,
      reason: 'binding-offline',
    })
    await flush()
    expect(h.runtime.listBindings()[0]?.presence).toBe('offline')

    h.transport.emit({
      type: 'presence.changed', subject: 'mobile', instanceId: INSTANCE_ID,
      bindingId: BINDING_ID, state: 'online', changedAtMs: 21, version: BRIDGE_PROTOCOL_VERSION,
    })
    emitCommand(h, 1, { command: 'session.subscribe', sessionId: 'session-1', afterCursor: initialCursor })
    expect(await waitForCount(h.transport, 'command.result', 2)).toMatchObject({
      outcome: 'error',
      command: 'session.subscribe',
      error: { code: 'RESYNC_REQUIRED', retryable: false },
    })

    // A replacement snapshot is the only operation that clears the durable gap marker.
    emitCommand(h, 3, { command: 'session.snapshot', sessionId: 'session-1' })
    expect(await waitForCount(h.transport, 'command.result', 3)).toMatchObject({
      outcome: 'success', result: { command: 'session.snapshot' },
    })

    h.transport.emit({
      type: 'presence.changed', subject: 'mobile', instanceId: INSTANCE_ID,
      bindingId: BINDING_ID, state: 'revoked', changedAtMs: 22, version: BRIDGE_PROTOCOL_VERSION,
    })
    for (let i = 0; i < 50 && h.runtime.listBindings().length > 0; i++) await flush()
    expect(h.runtime.listBindings()).toEqual([])

    emitCommand(h, 4, { command: 'workspace.list-local' })
    expect(await waitForCount(h.transport, 'command.result', 4)).toMatchObject({
      outcome: 'error',
      error: { code: 'NOT_AUTHORIZED', retryable: false },
    })

    await h.runtime.stop()
    expect(h.transport.stops).toBeGreaterThan(0)
    expect(h.runtime.safeState).toMatchObject({ connectorState: 'stopped', authenticated: false, bindings: [] })
  })
})
