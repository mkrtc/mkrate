import { describe, expect, it } from 'bun:test'
import { timelineEventSchema } from '@mkrate/bridge-protocol'
import { RPC_CHANNELS, type SessionEvent } from '@craft-agent/shared/protocol'
import { BridgeScopeAuthorizer } from './bridge-session-adapter.ts'
import { BridgeEventProjector } from './bridge-event-projector.ts'
import { BridgeReplayWindow } from './bridge-replay-window.ts'
import { SessionSerializationBarrier } from './bridge-snapshot.ts'
import { FakeBridgeSessionPort, TEST_CALLER, testSession } from './bridge-test-helpers.ts'

function setup() {
  const port = new FakeBridgeSessionPort()
  const replay = new BridgeReplayWindow({ epoch: 'epochA' })
  const authorizer = new BridgeScopeAuthorizer({
    profileId: TEST_CALLER.profileId,
    deploymentId: TEST_CALLER.deploymentId,
    instanceId: TEST_CALLER.instanceId,
  }, port)
  return { port, replay, projector: new BridgeEventProjector(authorizer, replay, new SessionSerializationBarrier(), () => 100) }
}

describe('BridgeEventProjector', () => {
  it('preserves visible ordering while replacing sensitive data with explicit safe payloads', async () => {
    const { projector } = setup()
    await projector.subscribe(TEST_CALLER, 'session-1', null)
    const events: SessionEvent[] = [
      { type: 'user_message', sessionId: 'session-1', status: 'accepted', message: { id: 'u1', role: 'user', content: 'hello', timestamp: 1, attachments: [{ storedPath: '/secret/path' } as never] } },
      { type: 'text_delta', sessionId: 'session-1', delta: 'partial' },
      { type: 'task_backgrounded', sessionId: 'session-1', toolUseId: 'tool-1', taskId: 'task-1', intent: 'read /secret/path', kind: 'workflow', workflowId: 'workflow-1' },
      { type: 'task_progress', sessionId: 'session-1', toolUseId: 'tool-1', elapsedSeconds: 3 },
      { type: 'tool_start', sessionId: 'session-1', toolName: 'bash', toolUseId: 'tool-secret', toolInput: { command: 'cat /secret/path', token: 'abc' } },
      { type: 'tool_result', sessionId: 'session-1', toolName: 'bash', toolUseId: 'tool-secret', result: 'password=secret', isError: true },
      { type: 'typed_error', sessionId: 'session-1', error: { code: 'invalid_credentials', title: 'Bad key', message: 'api_key=secret at /secret/path', actions: [], canRetry: false } },
      { type: 'interrupted', sessionId: 'session-1', message: { id: 'a1', role: 'assistant', content: 'safe partial answer', timestamp: 7 }, queuedMessages: ['password=secret'] },
      { type: 'task_completed', sessionId: 'session-1', taskId: 'task-1', status: 'failed', outputFile: '/secret/output', summary: 'token=secret' },
      { type: 'complete', sessionId: 'session-1' },
    ]
    const projected = []
    for (const event of events) projected.push(...await projector.project(RPC_CHANNELS.sessions.EVENT, event))
    expect(projected.every(item => timelineEventSchema.safeParse(item.event).success)).toBe(true)
    expect(projected.map(item => item.event.payload.kind)).toEqual([
      'user.message', 'assistant.message', 'subagent.status', 'progress', 'tool.status', 'tool.status',
      'error', 'assistant.message', 'subagent.status', 'session.status',
    ])
    const serialized = JSON.stringify(projected)
    for (const secret of ['/secret/path', 'cat /secret', 'password=secret', 'api_key=secret', '/secret/output', 'token=secret', 'queuedMessages', 'toolInput', 'result']) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain('task-1')
    expect(serialized).toContain('PROVIDER_AUTH')
    expect(serialized).toContain('interrupted')
  })

  it('omits non-session channels and desktop-only permission/credential/auth waits', async () => {
    const { projector } = setup()
    await projector.subscribe(TEST_CALLER, 'session-1', null)
    const permission: SessionEvent = {
      type: 'permission_request', sessionId: 'session-1',
      request: { requestId: 'p', sessionId: 'session-1', toolName: 'Bash', command: 'rm -rf /secret', description: 'token=secret' },
    }
    expect(await projector.project('sessions:get', permission)).toEqual([])
    expect(await projector.project(RPC_CHANNELS.sessions.EVENT, permission)).toEqual([])
  })

  it('isolates concurrent subscriptions by binding and rechecks local ownership', async () => {
    const { port, projector } = setup()
    const other = Object.freeze({ ...TEST_CALLER, bindingId: 'binding-2', deviceId: 'device-2' })
    const mutableCaller = { ...TEST_CALLER }
    const first = await projector.subscribe(mutableCaller, 'session-1', null)
    mutableCaller.bindingId = 'mutated-after-subscribe'
    mutableCaller.deviceId = 'mutated-device'
    const second = await projector.subscribe(other, 'session-1', null)
    const deliveries = await projector.project(RPC_CHANNELS.sessions.EVENT, {
      type: 'text_complete', sessionId: 'session-1', text: 'answer', messageId: 'answer-1',
    })
    expect(deliveries.map(item => item.bindingId).sort()).toEqual([TEST_CALLER.bindingId, 'binding-2'].sort())
    expect(new Set(deliveries.map(item => item.subscriptionId))).toEqual(new Set([first.subscriptionId, second.subscriptionId]))

    // Same task/tool IDs in two sessions under one binding must never dedupe to
    // an event owned by the other session.
    port.sessions.push(testSession({ id: 'session-2' }))
    const third = await projector.subscribe(TEST_CALLER, 'session-2', null)
    const firstTask = await projector.project(RPC_CHANNELS.sessions.EVENT, {
      type: 'task_backgrounded', sessionId: 'session-1', toolUseId: 'same-tool', taskId: 'same-task',
    })
    const secondTask = await projector.project(RPC_CHANNELS.sessions.EVENT, {
      type: 'task_backgrounded', sessionId: 'session-2', toolUseId: 'same-tool', taskId: 'same-task',
    })
    expect(firstTask.find(item => item.bindingId === TEST_CALLER.bindingId)?.event.sessionId).toBe('session-1')
    expect(secondTask).toEqual([expect.objectContaining({
      bindingId: TEST_CALLER.bindingId,
      subscriptionId: third.subscriptionId,
      event: expect.objectContaining({ sessionId: 'session-2' }),
    })])

    port.sessions[0]!.workspaceId = 'remote-workspace'
    expect(await projector.project(RPC_CHANNELS.sessions.EVENT, {
      type: 'text_complete', sessionId: 'session-1', text: 'must not leak', messageId: 'answer-2',
    })).toEqual([])
  })
})
