import type { Session } from '@craft-agent/shared/protocol'
import type { BridgeCaller, BridgeSessionPort, BridgeWorkspaceRecord } from './bridge-session-adapter.ts'

export const TEST_CALLER: BridgeCaller = Object.freeze({
  profileId: 'profile-1',
  deploymentId: 'deployment-1',
  instanceId: 'instance-1',
  bindingId: 'AAAAAAAAAAAAAAAAAAAAAA',
  deviceId: 'device-1',
})

export function testSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Local',
    name: 'Safe session',
    lastMessageAt: 100,
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

export class FakeBridgeSessionPort implements BridgeSessionPort {
  workspaces: BridgeWorkspaceRecord[] = [
    { id: 'workspace-1', name: 'Local' },
    { id: 'remote-workspace', name: 'Remote', remoteServer: { token: 'never-project-me' } },
  ]
  sessions: Session[] = [testSession()]
  sendCalls: Array<{ sessionId: string; text: string; optimisticMessageId: string }> = []
  cancelCalls: string[] = []
  sendBehavior: 'ack' | 'conflicting-ack' | 'no-ack' | 'reject' = 'ack'
  persistedMessageId = 'persisted-user-1'

  getWorkspaces(): readonly BridgeWorkspaceRecord[] { return this.workspaces }
  getSessions(workspaceId?: string): readonly Session[] {
    return workspaceId ? this.sessions.filter(session => session.workspaceId === workspaceId) : this.sessions
  }
  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.find(session => session.id === sessionId) ?? null
  }
  getSessionWorkspaceId(sessionId: string): string | undefined {
    return this.sessions.find(session => session.id === sessionId)?.workspaceId
  }
  async sendMessage(
    sessionId: string,
    text: string,
    request: { readonly optimisticMessageId: string; readonly onAck: (persistedMessageId: string) => void },
  ): Promise<void> {
    this.sendCalls.push({ sessionId, text, optimisticMessageId: request.optimisticMessageId })
    if (this.sendBehavior === 'reject') throw new Error('send failed at /secret/path token=supersecret')
    if (this.sendBehavior === 'ack') request.onAck(this.persistedMessageId)
    if (this.sendBehavior === 'conflicting-ack') {
      request.onAck(this.persistedMessageId)
      request.onAck(`${this.persistedMessageId}-conflict`)
    }
  }
  async cancelProcessing(sessionId: string): Promise<void> { this.cancelCalls.push(sessionId) }
}
