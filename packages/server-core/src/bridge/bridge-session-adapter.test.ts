import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import {
  COMMAND_CAPABILITIES,
  SECURITY_LIMITS,
  commandResultBodySchema,
  type CommandCapability,
  type CommandPayload,
  type CommandRequestBody,
} from '@mkrate/bridge-protocol'
import type { SessionManager } from '../sessions/SessionManager.ts'
import { MobileBridgeFacade, type ExistingSessionManagerBridgeSource } from './bridge-session-adapter.ts'
import { FakeBridgeSessionPort, TEST_CALLER, testSession } from './bridge-test-helpers.ts'

// Structural gate: arbitrary SessionCommand/RPC operations cannot enter the facade.
// @ts-expect-error delete is not one of the exact six protocol capabilities
const NON_ALLOWLISTED_COMMAND: CommandPayload = { command: 'session.delete', sessionId: 'session-1' }
void NON_ALLOWLISTED_COMMAND

type ExistingManagerFitsNarrowWrapper = SessionManager extends ExistingSessionManagerBridgeSource ? true : false
const EXISTING_MANAGER_FITS_NARROW_WRAPPER: ExistingManagerFitsNarrowWrapper = true
void EXISTING_MANAGER_FITS_NARROW_WRAPPER

const ALL = [...COMMAND_CAPABILITIES] as readonly CommandCapability[]

function setupFacade(port = new FakeBridgeSessionPort()) {
  return { port, facade: new MobileBridgeFacade({
    identity: {
      profileId: TEST_CALLER.profileId,
      deploymentId: TEST_CALLER.deploymentId,
      instanceId: TEST_CALLER.instanceId,
    },
    sessions: port,
    now: () => 1_000,
  }) }
}

function opaqueId(label: string): string {
  return createHash('sha256').update(label).digest().subarray(0, 16).toString('base64url')
}

function request(payload: CommandPayload, overrides: Partial<CommandRequestBody> = {}): CommandRequestBody {
  return {
    bindingId: overrides.bindingId ?? TEST_CALLER.bindingId,
    commandId: opaqueId(overrides.commandId ?? 'command-1'),
    idempotencyKey: opaqueId(overrides.idempotencyKey ?? 'request-1'),
    sentAtMs: overrides.sentAtMs ?? 1,
    payload: overrides.payload ?? payload,
  }
}

describe('MobileBridgeFacade', () => {
  it('denies unknown commands, missing capability, cross-instance, and cross-binding callers', async () => {
    const { facade } = setupFacade()
    const unknown = await facade.execute(TEST_CALLER, ALL, request({ command: 'session.delete' } as never))
    expect(unknown.outcome).toBe('error')
    if (unknown.outcome === 'error') expect(unknown.error.code).toBe('INVALID_REQUEST')

    const denied = await facade.execute(TEST_CALLER, [], request({ command: 'workspace.list-local' }))
    expect(denied.outcome).toBe('error')
    if (denied.outcome === 'error') expect(denied.error.code).toBe('CAPABILITY_DENIED')

    const otherInstance = await facade.execute({ ...TEST_CALLER, instanceId: 'other' }, ALL, request({ command: 'workspace.list-local' }))
    expect(otherInstance.outcome).toBe('error')
    if (otherInstance.outcome === 'error') expect(otherInstance.error.code).toBe('NOT_AUTHORIZED')

    const otherBinding = await facade.execute({ ...TEST_CALLER, bindingId: opaqueId('binding-2') }, ALL, request({ command: 'workspace.list-local' }))
    expect(otherBinding.outcome).toBe('error')
    if (otherBinding.outcome === 'error') expect(otherBinding.error.code).toBe('NOT_AUTHORIZED')
  })

  it('lists only safe local workspace/session DTOs and denies remote-owned sessions', async () => {
    const { port, facade } = setupFacade()
    port.workspaces[0] = { id: 'workspace-1', name: 'Local /secret token=topsecret' }
    port.workspaces.push({ id: 'workspace-2', name: 'Other local' })
    port.sessions.push(
      testSession({ id: 'session-2', workspaceId: 'workspace-2', workspaceName: 'Other local' }),
      testSession({
        id: 'remote-session', workspaceId: 'remote-workspace', workspaceName: 'Remote',
        workingDirectory: '/secret/path', enabledSourceSlugs: ['secret-source'], llmConnection: 'secret-connection',
      }),
    )
    const workspaces = await facade.execute(TEST_CALLER, ALL, request({ command: 'workspace.list-local' }))
    const sessions = await facade.execute(TEST_CALLER, ALL, request(
      { command: 'session.list', workspaceId: null },
      { commandId: 'command-2', idempotencyKey: 'request-2' },
    ))
    expect(commandResultBodySchema.safeParse(workspaces).success).toBe(true)
    expect(commandResultBodySchema.safeParse(sessions).success).toBe(true)
    const serialized = JSON.stringify({ workspaces, sessions })
    expect(serialized).toContain('workspace-1')
    expect(serialized).not.toContain('remote-workspace')
    for (const secret of ['never-project-me', '/secret', 'topsecret', 'secret-source', 'secret-connection', 'workingDirectory', 'remoteServer']) {
      expect(serialized).not.toContain(secret)
    }

    // Defend against a buggy/over-broad port implementation returning sessions
    // from another local workspace even when a workspace filter is supplied.
    port.getSessions = () => port.sessions
    const workspaceOne = await facade.execute(TEST_CALLER, ALL, request(
      { command: 'session.list', workspaceId: 'workspace-1' },
      { commandId: 'workspace-scope', idempotencyKey: 'workspace-scope' },
    ))
    expect(JSON.stringify(workspaceOne)).not.toContain('session-2')

    const remoteSnapshot = await facade.execute(TEST_CALLER, ALL, request(
      { command: 'session.snapshot', sessionId: 'remote-session' },
      { commandId: 'command-3', idempotencyKey: 'request-3' },
    ))
    expect(remoteSnapshot.outcome).toBe('error')
    if (remoteSnapshot.outcome === 'error') expect(remoteSnapshot.error.code).toBe('NOT_AUTHORIZED')
  })

  it('serves snapshot and subscribe with a no-gap cursor and caches duplicate snapshot identity', async () => {
    const { port, facade } = setupFacade()
    port.sessions[0]!.messages = [{ id: 'u', role: 'user', content: 'hello', timestamp: 1 }]
    const snapshotRequest = request({ command: 'session.snapshot', sessionId: 'session-1' })
    const first = await facade.execute(TEST_CALLER, ALL, snapshotRequest)
    const duplicate = await facade.execute(TEST_CALLER, ALL, { ...snapshotRequest, commandId: opaqueId('command-duplicate') })
    expect(commandResultBodySchema.safeParse(first).success).toBe(true)
    expect(commandResultBodySchema.safeParse(duplicate).success).toBe(true)
    expect(first.outcome).toBe('success')
    expect(duplicate.outcome).toBe('success')
    if (first.outcome !== 'success' || first.result.command !== 'session.snapshot') return
    if (duplicate.outcome !== 'success' || duplicate.result.command !== 'session.snapshot') return
    expect(duplicate.result.throughCursor).toBe(first.result.throughCursor)

    const subscribe = await facade.execute(TEST_CALLER, ALL, request(
      { command: 'session.subscribe', sessionId: 'session-1', afterCursor: first.result.throughCursor },
      { commandId: 'subscribe', idempotencyKey: 'subscribe' },
    ))
    expect(commandResultBodySchema.safeParse(subscribe).success).toBe(true)
    expect(subscribe.outcome).toBe('success')
    if (subscribe.outcome === 'success' && subscribe.result.command === 'session.subscribe') {
      expect(subscribe.result.replay).toEqual([])
      expect(subscribe.result.throughCursor).toBe(first.result.throughCursor)
    }
  })

  it('accepts text only after canonical onAck and reuses in-flight/completed send results', async () => {
    const { port, facade } = setupFacade()
    const sendRequest = request({ command: 'session.send-message', sessionId: 'session-1', text: 'hello' })
    const [first, duplicate] = await Promise.all([
      facade.execute(TEST_CALLER, ALL, sendRequest),
      facade.execute(TEST_CALLER, ALL, { ...sendRequest, commandId: opaqueId('command-duplicate') }),
    ])
    expect(commandResultBodySchema.safeParse(first).success).toBe(true)
    expect(commandResultBodySchema.safeParse(duplicate).success).toBe(true)
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.optimisticMessageId).toMatch(/^bridge-[a-f0-9]{32}$/)
    expect(first.outcome).toBe('success')
    expect(duplicate.outcome).toBe('success')
    if (first.outcome === 'success' && first.result.command === 'session.send-message'
      && duplicate.outcome === 'success' && duplicate.result.command === 'session.send-message') {
      expect(duplicate.result.userMessageEventId).toBe(first.result.userMessageEventId)
      expect(duplicate.result.cursor).toBe(first.result.cursor)
    }

    const completed = await facade.execute(TEST_CALLER, ALL, { ...sendRequest, commandId: opaqueId('command-later') })
    expect(completed.outcome).toBe('success')
    expect(port.sendCalls).toHaveLength(1)

    const conflict = await facade.execute(TEST_CALLER, ALL, {
      ...sendRequest,
      commandId: opaqueId('command-conflict'),
      payload: { command: 'session.send-message', sessionId: 'session-1', text: 'different' },
    })
    expect(conflict.outcome).toBe('error')
    if (conflict.outcome === 'error') expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('turns a resolved-without-ack send into cached resync-required ambiguity', async () => {
    const { port, facade } = setupFacade()
    port.sendBehavior = 'no-ack'
    const sendRequest = request({ command: 'session.send-message', sessionId: 'session-1', text: 'hello' })
    const first = await facade.execute(TEST_CALLER, ALL, sendRequest)
    const retry = await facade.execute(TEST_CALLER, ALL, { ...sendRequest, commandId: opaqueId('retry') })
    for (const result of [first, retry]) {
      expect(result.outcome).toBe('error')
      if (result.outcome === 'error') expect(result.error.code).toBe('RESYNC_REQUIRED')
    }
    expect(port.sendCalls).toHaveLength(1)
  })

  it('caps list counts and enforces the per-binding command rate', async () => {
    const countPort = new FakeBridgeSessionPort()
    countPort.workspaces = Array.from({ length: SECURITY_LIMITS.workspaceListMaxItems + 20 }, (_, index) => ({
      id: `workspace-${index + 1}`,
      name: `Workspace ${index + 1}`,
    }))
    countPort.sessions = Array.from({ length: SECURITY_LIMITS.sessionListMaxItems + 20 }, (_, index) => testSession({
      id: `session-${index + 1}`,
      workspaceId: 'workspace-1',
    }))
    const countFacade = setupFacade(countPort).facade
    const workspaceResult = await countFacade.execute(TEST_CALLER, ALL, request({ command: 'workspace.list-local' }))
    const sessionResult = await countFacade.execute(TEST_CALLER, ALL, request(
      { command: 'session.list', workspaceId: null },
      { commandId: 'count-sessions', idempotencyKey: 'count-sessions' },
    ))
    if (workspaceResult.outcome === 'success' && workspaceResult.result.command === 'workspace.list-local') {
      expect(workspaceResult.result.workspaces).toHaveLength(SECURITY_LIMITS.workspaceListMaxItems)
    }
    if (sessionResult.outcome === 'success' && sessionResult.result.command === 'session.list') {
      expect(sessionResult.result.sessions).toHaveLength(SECURITY_LIMITS.sessionListMaxItems)
    }

    const rateFacade = setupFacade().facade
    for (let index = 0; index < SECURITY_LIMITS.commandRequestsPerMinutePerBinding; index++) {
      const result = await rateFacade.execute(TEST_CALLER, ALL, request(
        { command: 'workspace.list-local' },
        { commandId: `rate-command-${index}`, idempotencyKey: `rate-request-${index}` },
      ))
      expect(result.outcome).toBe('success')
    }
    const limited = await rateFacade.execute(TEST_CALLER, ALL, request(
      { command: 'workspace.list-local' },
      { commandId: 'rate-command-over', idempotencyKey: 'rate-request-over' },
    ))
    expect(limited.outcome).toBe('error')
    if (limited.outcome === 'error') expect(limited.error.code).toBe('BUSY')
  })

  it('enforces text bounds and authorizes cancel server-side', async () => {
    const { port, facade } = setupFacade()
    const tooLarge = await facade.execute(TEST_CALLER, ALL, request({
      command: 'session.send-message', sessionId: 'session-1', text: 'x'.repeat(SECURITY_LIMITS.userTextMaxBytes + 1),
    }))
    expect(tooLarge.outcome).toBe('error')
    if (tooLarge.outcome === 'error') expect(tooLarge.error.code).toBe('INVALID_REQUEST')

    port.sessions[0]!.isProcessing = true
    const cancelled = await facade.execute(TEST_CALLER, ALL, request(
      { command: 'session.cancel', sessionId: 'session-1' },
      { commandId: 'cancel', idempotencyKey: 'cancel' },
    ))
    expect(cancelled.outcome).toBe('success')
    if (cancelled.outcome === 'success' && cancelled.result.command === 'session.cancel') expect(cancelled.result.cancelled).toBe(true)
    expect(port.cancelCalls).toEqual(['session-1'])
  })
})
