import { Buffer } from 'node:buffer'
import {
  SECURITY_LIMITS,
  type CommandResultBody,
  type TimelinePayload,
} from '@mkrate/bridge-protocol'
import type { Message } from '@craft-agent/core/types'
import type { Session } from '@craft-agent/shared/protocol'
import type { BridgeCaller, BridgeScopeAuthorizer } from './bridge-session-adapter.ts'
import { BridgeReplayWindow } from './bridge-replay-window.ts'

type SuccessResult = Extract<CommandResultBody, { outcome: 'success' }>['result']
export type BridgeSessionSummary = Extract<SuccessResult, { command: 'session.list' }>['sessions'][number]
export type BridgeSnapshotResult = Extract<SuccessResult, { command: 'session.snapshot' }>

export interface BridgeSnapshotSessionPort {
  getSession(sessionId: string): Promise<Session | null>
}

/** Per-session FIFO mutex shared by snapshots and live event projection. */
export class SessionSerializationBarrier {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.tails.set(sessionId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId)
    }
  }
}

export function projectSessionSummary(session: Session): BridgeSessionSummary {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId || null,
    title: redactPublicLabel(session.name || session.preview || 'Untitled session', 160),
    status: projectSessionStatus(session),
    updatedAtMs: finiteTimestamp(session.lastMessageAt, session.createdAt),
  }
}

export function projectSessionStatus(session: Pick<Session, 'isProcessing' | 'sessionStatus'>): BridgeSessionSummary['status'] {
  if (session.isProcessing) return 'running'
  switch ((session.sessionStatus ?? '').toLowerCase()) {
    case 'done':
    case 'completed': return 'completed'
    case 'failed':
    case 'error': return 'failed'
    case 'cancelled':
    case 'canceled': return 'cancelled'
    case 'in-progress':
    case 'in_progress':
    case 'running': return 'running'
    case 'needs-review':
    case 'waiting': return 'waiting'
    default: return 'idle'
  }
}

/**
 * Snapshot projection is an explicit role allowlist. Attachments, tool input and
 * result, paths, auth requests, plans, badges, annotations, source metadata,
 * credentials, and every other Message field are never copied.
 */
export function projectSafeMessagePayload(message: Message): TimelinePayload | null {
  if (message.hidden) return null
  switch (message.role) {
    case 'user':
      return { kind: 'user.message', text: boundedTimelineText(message.content) }
    case 'assistant':
      return {
        kind: 'assistant.message',
        text: boundedTimelineText(message.content),
        state: message.isStreaming || message.isPending ? 'streaming' : 'complete',
      }
    case 'tool': {
      if (message.taskId) {
        return {
          kind: 'subagent.status',
          subagentSessionId: boundedOpaqueId(message.taskId),
          name: 'Background task',
          state: projectToolTaskState(message.toolStatus),
        }
      }
      return {
        kind: 'tool.status',
        toolName: 'Desktop tool',
        state: message.isError || message.toolStatus === 'error'
          ? 'failed'
          : message.toolStatus === 'completed'
            ? 'completed'
            : 'started',
      }
    }
    case 'error':
      return projectVisibleError(message.errorCode ?? message.errorTitle ?? message.content, message.errorCanRetry ?? false)
    case 'status':
      return {
        kind: 'progress',
        label: message.statusType === 'compacting' ? 'Compacting session context' : 'Working',
        state: 'updated',
      }
    case 'info':
      return message.statusType === 'compaction_complete'
        ? { kind: 'progress', label: 'Session context compacted', state: 'completed' }
        : null
    case 'warning':
      return projectVisibleError('warning', false)
    case 'plan':
    case 'auth-request':
      return null
  }
}

export function projectVisibleError(raw: string, retryable: boolean): Extract<TimelinePayload, { kind: 'error' }> {
  const normalized = raw.toLowerCase()
  if (/rate|quota|too many|billing/.test(normalized)) {
    return { kind: 'error', source: 'provider', code: 'PROVIDER_LIMIT', retryable, displayText: 'The provider limit was reached.' }
  }
  if (/auth|credential|token|api.?key|oauth|permission/.test(normalized)) {
    return { kind: 'error', source: 'provider', code: 'PROVIDER_AUTH', retryable: false, displayText: 'Authentication requires attention on Desktop.' }
  }
  if (/tool|mcp|source/.test(normalized)) {
    return { kind: 'error', source: 'tool', code: 'TOOL_FAILED', retryable, displayText: 'A Desktop tool failed.' }
  }
  if (/backend|runtime|sdk|service|network|proxy/.test(normalized)) {
    return { kind: 'error', source: 'backend', code: 'BACKEND_FAILED', retryable, displayText: 'The Desktop backend failed.' }
  }
  if (/invalid|validation|required|malformed/.test(normalized)) {
    return { kind: 'error', source: 'session', code: 'VALIDATION_FAILED', retryable: false, displayText: 'The request was not valid.' }
  }
  return { kind: 'error', source: 'session', code: 'SESSION_FAILED', retryable, displayText: 'The session encountered an error.' }
}

export function boundedTimelineText(text: string): string {
  return truncateUtf8(text.replaceAll('\u0000', '\uFFFD').normalize('NFC'), SECURITY_LIMITS.timelineTextMaxBytes)
}

export function redactPublicLabel(
  text: string,
  maxCharacters: number = SECURITY_LIMITS.timelineDisplayTextMaxCharacters,
  fallback = 'Untitled session',
): string {
  const singleLine = text.normalize('NFC').replace(/[\r\n\t]+/g, ' ').trim()
  const redacted = singleLine
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{8,}){0,2}\b/gi, '[redacted]')
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:\\(?:[^\s<>:"|?*\\]+\\)*[^\s<>:"|?*\\]*|\/(?:[^\s<>:"|?*\/]+\/)*[^\s<>:"|?*\/]*)/g, '[path]')
  return redacted.slice(0, maxCharacters) || fallback
}

export class BridgeSnapshotService {
  constructor(
    private readonly sessions: BridgeSnapshotSessionPort,
    private readonly authorizer: BridgeScopeAuthorizer,
    private readonly replay: BridgeReplayWindow,
    readonly barrier: SessionSerializationBarrier,
  ) {}

  create(caller: BridgeCaller, sessionId: string): Promise<BridgeSnapshotResult> {
    const normalizedCaller = this.authorizer.normalizeCaller(caller)
    return this.barrier.runExclusive(sessionId, async () => {
      this.authorizer.assertAuthorizedSession(normalizedCaller, sessionId)
      const session = await this.sessions.getSession(sessionId)
      if (!session) throw new BridgeSnapshotError('NOT_FOUND')
      // Recheck after the async disk load: workspace ownership may have changed.
      this.authorizer.assertAuthorizedSession(normalizedCaller, sessionId)

      const projected = session.messages
        .map(message => ({ message, payload: projectSafeMessagePayload(message) }))
        .filter((entry): entry is { message: Message; payload: TimelinePayload } => entry.payload !== null)
      const truncatedBefore = projected.length > SECURITY_LIMITS.snapshotMaxEvents
      const selected = projected.slice(-SECURITY_LIMITS.snapshotMaxEvents)
      const allocated = this.replay.allocateSnapshot(normalizedCaller.bindingId, selected.map(({ message, payload }) => ({
        sessionId,
        occurredAtMs: finiteTimestamp(message.timestamp, session.lastMessageAt),
        payload,
      })))

      return {
        command: 'session.snapshot',
        session: projectSessionSummary(session),
        events: allocated.events,
        throughCursor: allocated.baseCursor,
        truncatedBefore,
      }
    })
  }
}

export class BridgeSnapshotError extends Error {
  constructor(readonly code: 'NOT_FOUND') {
    super(code)
    this.name = 'BridgeSnapshotError'
  }
}

function finiteTimestamp(primary?: number, fallback?: number): number {
  if (Number.isFinite(primary) && primary! >= 0) return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(primary!))
  if (Number.isFinite(fallback) && fallback! >= 0) return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(fallback!))
  return 0
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--
  return bytes.subarray(0, end).toString('utf8')
}

function boundedOpaqueId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : 'redacted-id'
}

function projectToolTaskState(status?: Message['toolStatus']): Extract<TimelinePayload, { kind: 'subagent.status' }>['state'] {
  switch (status) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'executing':
    case 'backgrounded': return 'running'
    default: return 'created'
  }
}
