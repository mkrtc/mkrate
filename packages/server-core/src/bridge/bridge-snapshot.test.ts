import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import { BridgeScopeAuthorizer } from './bridge-session-adapter.ts'
import { BridgeReplayWindow } from './bridge-replay-window.ts'
import { BridgeSnapshotService, SessionSerializationBarrier } from './bridge-snapshot.ts'
import { FakeBridgeSessionPort, TEST_CALLER, testSession } from './bridge-test-helpers.ts'

describe('BridgeSnapshotService', () => {
  it('projects only safe ordered fields and omits attachments, paths, tools, sources, and credentials', async () => {
    const port = new FakeBridgeSessionPort()
    port.sessions = [testSession({
      name: 'Session /home/alice/private/token.txt',
      workingDirectory: '/home/alice/private',
      enabledSourceSlugs: ['secret-source'],
      llmConnection: 'private-connection',
      messages: [
        { id: 'u', role: 'user', content: 'hello', timestamp: 1, attachments: [{ type: 'text', name: 'secret.txt', mimeType: 'text/plain', size: 1, storedPath: '/secret' }] } as Message,
        { id: 't', role: 'tool', content: 'ignored', timestamp: 2, toolName: 'bash', toolInput: { command: 'cat /secret' }, toolResult: 'token=abc', toolStatus: 'completed' },
        { id: 'a', role: 'assistant', content: 'answer', timestamp: 3 },
        { id: 'auth', role: 'auth-request', content: 'password=secret', timestamp: 4, authSourceUrl: 'https://secret' },
        { id: 'e', role: 'error', content: 'token=secret at /home/alice/private', timestamp: 5, errorCode: 'invalid_credentials' },
      ],
    })]
    const replay = new BridgeReplayWindow({ epoch: 'epochA' })
    const snapshot = new BridgeSnapshotService(port, new BridgeScopeAuthorizer({
      profileId: TEST_CALLER.profileId,
      deploymentId: TEST_CALLER.deploymentId,
      instanceId: TEST_CALLER.instanceId,
    }, port), replay, new SessionSerializationBarrier())
    const result = await snapshot.create(TEST_CALLER, 'session-1')
    expect(result.events.map(event => event.payload.kind)).toEqual(['user.message', 'tool.status', 'assistant.message', 'error'])
    const serialized = JSON.stringify(result)
    for (const secret of ['/home/alice', 'secret.txt', 'secret-source', 'private-connection', 'cat /secret', 'token=abc', 'password=secret', 'https://secret']) {
      expect(serialized).not.toContain(secret)
    }
    expect(result.session.title).toContain('[path]')
  })

  it('holds the barrier across async load so a racing live event gets seq > baseCursor', async () => {
    const port = new FakeBridgeSessionPort()
    port.sessions = [testSession({ messages: [{ id: 'u', role: 'user', content: 'one', timestamp: 1 }] })]
    let releaseLoad!: () => void
    const loadGate = new Promise<void>(resolve => { releaseLoad = resolve })
    const originalGet = port.getSession.bind(port)
    port.getSession = async sessionId => { await loadGate; return originalGet(sessionId) }
    const replay = new BridgeReplayWindow({ epoch: 'epochA' })
    const barrier = new SessionSerializationBarrier()
    const service = new BridgeSnapshotService(port, new BridgeScopeAuthorizer({
      profileId: TEST_CALLER.profileId,
      deploymentId: TEST_CALLER.deploymentId,
      instanceId: TEST_CALLER.instanceId,
    }, port), replay, barrier)

    const pendingSnapshot = service.create(TEST_CALLER, 'session-1')
    await Promise.resolve()
    const pendingLive = barrier.runExclusive('session-1', () => replay.append(TEST_CALLER.bindingId, {
      sessionId: 'session-1', occurredAtMs: 2, payload: { kind: 'progress', label: 'Working', state: 'updated' },
    }))
    releaseLoad()
    const snapshot = await pendingSnapshot
    const live = await pendingLive
    expect(Number(BigInt(snapshot.throughCursor) & 0xffff_ffffn)).toBe(1)
    expect(Number(BigInt(live.cursor) & 0xffff_ffffn)).toBe(2)
  })
})
