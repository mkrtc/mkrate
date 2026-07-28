import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson, type CommandResultBody, type TimelineEvent, type TimelinePayload } from '@mkrate/bridge-protocol'
import { RPC_CHANNELS, type SessionEvent } from '@craft-agent/shared/protocol'
import type { BridgeCaller, BridgeScopeAuthorizer } from './bridge-session-adapter.ts'
import { BridgeReplayWindow } from './bridge-replay-window.ts'
import {
  SessionSerializationBarrier,
  boundedTimelineText,
  projectSessionStatus,
  projectVisibleError,
} from './bridge-snapshot.ts'

type SuccessResult = Extract<CommandResultBody, { outcome: 'success' }>['result']
export type BridgeSubscribeResult = Extract<SuccessResult, { command: 'session.subscribe' }>

interface Subscription {
  readonly caller: BridgeCaller
  readonly subscriptionId: string
  readonly sessionId: string
}

export interface ProjectedTimelineDelivery {
  readonly bindingId: string
  readonly subscriptionId: string
  readonly event: TimelineEvent
}

export class BridgeEventProjectorError extends Error {
  constructor(
    readonly code: 'RESYNC_REQUIRED',
    readonly currentCursor: string,
  ) {
    super(code)
    this.name = 'BridgeEventProjectorError'
  }
}

/**
 * Projects only RPC_CHANNELS.sessions.EVENT and only to an already authorized,
 * local session subscription. Raw SessionEvent objects are never returned.
 */
export class BridgeEventProjector {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>()

  constructor(
    private readonly authorizer: BridgeScopeAuthorizer,
    private readonly replay: BridgeReplayWindow,
    private readonly barrier: SessionSerializationBarrier,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(caller: BridgeCaller, sessionId: string, afterCursor: string | null): Promise<BridgeSubscribeResult> {
    const normalizedCaller = this.authorizer.normalizeCaller(caller)
    return this.barrier.runExclusive(sessionId, async () => {
      this.authorizer.assertAuthorizedSession(normalizedCaller, sessionId)
      const replay = this.replay.replay(normalizedCaller.bindingId, afterCursor, sessionId)
      if (replay.kind === 'resync-required') {
        throw new BridgeEventProjectorError('RESYNC_REQUIRED', replay.currentCursor)
      }
      const subscriptionId = randomBytes(16).toString('base64url')
      let bindingSubscriptions = this.subscriptions.get(normalizedCaller.bindingId)
      if (!bindingSubscriptions) {
        bindingSubscriptions = new Map()
        this.subscriptions.set(normalizedCaller.bindingId, bindingSubscriptions)
      }
      // One live subscription per binding/session. Replacing it cannot affect a
      // different binding, even when both devices subscribe concurrently.
      bindingSubscriptions.set(sessionId, { caller: normalizedCaller, subscriptionId, sessionId })
      return {
        command: 'session.subscribe',
        sessionId,
        afterCursor,
        subscriptionId,
        replay: replay.events,
        throughCursor: replay.throughCursor,
      }
    })
  }

  unsubscribe(bindingId: string, subscriptionId: string): boolean {
    const bindingSubscriptions = this.subscriptions.get(bindingId)
    if (!bindingSubscriptions) return false
    for (const [sessionId, subscription] of bindingSubscriptions) {
      if (subscription.subscriptionId !== subscriptionId) continue
      bindingSubscriptions.delete(sessionId)
      if (bindingSubscriptions.size === 0) this.subscriptions.delete(bindingId)
      return true
    }
    return false
  }

  clearBinding(bindingId: string): void {
    this.subscriptions.delete(bindingId)
  }

  async project(channel: string, rawEvent: SessionEvent): Promise<ProjectedTimelineDelivery[]> {
    if (channel !== RPC_CHANNELS.sessions.EVENT) return []
    const payload = projectSessionEvent(rawEvent)
    if (!payload) return []

    const candidates: Subscription[] = []
    for (const bindingSubscriptions of this.subscriptions.values()) {
      const subscription = bindingSubscriptions.get(rawEvent.sessionId)
      if (subscription) candidates.push(subscription)
    }

    const deliveries: ProjectedTimelineDelivery[] = []
    for (const subscription of candidates) {
      try {
        this.authorizer.assertAuthorizedSession(subscription.caller, rawEvent.sessionId)
      } catch {
        // Ownership changed, workspace became remote, or the binding is no
        // longer valid for this facade. Fail closed and drop the subscription.
        this.unsubscribe(subscription.caller.bindingId, subscription.subscriptionId)
        continue
      }
      const event = await this.barrier.runExclusive(rawEvent.sessionId, async () => {
        // Revalidate inside the same serialization boundary used by snapshot.
        this.authorizer.assertAuthorizedSession(subscription.caller, rawEvent.sessionId)
        return this.replay.append(subscription.caller.bindingId, {
          sessionId: rawEvent.sessionId,
          occurredAtMs: eventTimestamp(rawEvent, this.now()),
          payload,
          dedupeKey: stableSourceEventKey(rawEvent),
        })
      })
      deliveries.push({
        bindingId: subscription.caller.bindingId,
        subscriptionId: subscription.subscriptionId,
        event,
      })
    }
    return deliveries
  }
}

/** Explicit deny-by-default projection. Unlisted SessionEvent variants are omitted. */
export function projectSessionEvent(event: SessionEvent): TimelinePayload | null {
  switch (event.type) {
    case 'text_delta':
      return { kind: 'assistant.message', text: boundedTimelineText(event.delta), state: 'streaming' }
    case 'text_complete':
      return { kind: 'assistant.message', text: boundedTimelineText(event.text), state: 'complete' }
    case 'user_message':
      return event.message.hidden || event.message.role !== 'user'
        ? null
        : { kind: 'user.message', text: boundedTimelineText(event.message.content) }
    case 'tool_start':
      return { kind: 'tool.status', toolName: 'Desktop tool', state: 'started' }
    case 'tool_result':
      return { kind: 'tool.status', toolName: 'Desktop tool', state: event.isError ? 'failed' : 'completed' }
    case 'status':
      return {
        kind: 'progress',
        label: event.statusType === 'compacting' ? 'Compacting session context' : 'Working',
        state: 'updated',
      }
    case 'info':
      return event.statusType === 'compaction_complete'
        ? { kind: 'progress', label: 'Session context compacted', state: 'completed' }
        : null
    case 'task_backgrounded':
      return {
        kind: 'subagent.status',
        subagentSessionId: safeOpaqueId(event.taskId),
        name: event.kind === 'workflow' ? 'Workflow' : 'Background task',
        state: 'running',
      }
    case 'task_progress':
      return {
        kind: 'progress',
        label: 'Background task running',
        state: 'updated',
      }
    case 'task_completed':
      return {
        kind: 'subagent.status',
        subagentSessionId: safeOpaqueId(event.taskId),
        name: 'Background task',
        state: event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'cancelled',
      }
    case 'workflow_agent_completed':
      return {
        kind: 'subagent.status',
        subagentSessionId: safeOpaqueId(event.agentId),
        name: 'Workflow agent',
        state: 'completed',
      }
    case 'shell_backgrounded':
      return { kind: 'tool.status', toolName: 'Desktop shell', state: 'started' }
    case 'shell_killed':
      return { kind: 'tool.status', toolName: 'Desktop shell', state: 'failed' }
    case 'error':
      return projectVisibleError(event.error, false)
    case 'typed_error':
      return projectTypedError(event.error.code, event.error.canRetry)
    case 'interrupted':
      return event.message && event.message.role === 'assistant' && !event.message.hidden && event.message.content
        ? { kind: 'assistant.message', text: boundedTimelineText(event.message.content), state: 'interrupted' }
        : { kind: 'error', source: 'session', code: 'TURN_INTERRUPTED', retryable: true, displayText: 'The turn was interrupted.' }
    case 'complete':
      return { kind: 'session.status', state: 'idle' }
    case 'session_status_changed':
      return { kind: 'session.status', state: projectSessionStatus({ isProcessing: false, sessionStatus: event.sessionStatus }) }

    // Protocol v1 has no desktop_action_required timeline payload. Permission,
    // credential, and auth waits are therefore omitted rather than projecting
    // commands, credential metadata, source data, URLs, or descriptions.
    case 'permission_request':
    case 'credential_request':
    case 'auth_request':
    case 'auth_completed':
    case 'working_directory_changed':
    case 'working_directory_error':
    case 'sources_changed':
    case 'source_activated':
    case 'plan_submitted':
    case 'connection_changed':
    case 'permission_mode_changed':
    case 'message_annotations_updated':
    case 'session_shared':
    case 'session_unshared':
    case 'usage_update':
    case 'labels_changed':
    case 'project_id_changed':
    case 'session_metadata_changed':
    case 'session_model_changed':
    case 'async_operation':
    case 'title_generated':
    case 'title_regenerating':
    case 'session_flagged':
    case 'session_unflagged':
    case 'session_archived':
    case 'session_unarchived':
    case 'name_changed':
    case 'session_deleted':
    case 'session_created':
      return null
  }
}

function projectTypedError(code: string, retryable: boolean): Extract<TimelinePayload, { kind: 'error' }> {
  if (code === 'rate_limited' || code === 'billing_error' || code === 'response_too_large') {
    return { kind: 'error', source: 'provider', code: 'PROVIDER_LIMIT', retryable, displayText: 'The provider limit was reached.' }
  }
  if (code === 'invalid_api_key' || code === 'invalid_credentials' || code === 'expired_oauth_token' || code === 'token_expired' || code === 'mcp_auth_required') {
    return { kind: 'error', source: 'provider', code: 'PROVIDER_AUTH', retryable: false, displayText: 'Authentication requires attention on Desktop.' }
  }
  if (code.startsWith('mcp_')) {
    return { kind: 'error', source: 'tool', code: 'TOOL_FAILED', retryable, displayText: 'A Desktop tool failed.' }
  }
  if (code.startsWith('runtime_') || code.startsWith('sdk_') || code === 'network_error' || code === 'proxy_error' || code === 'service_error' || code === 'service_unavailable') {
    return { kind: 'error', source: 'backend', code: 'BACKEND_FAILED', retryable, displayText: 'The Desktop backend failed.' }
  }
  if (code === 'invalid_request' || code === 'invalid_model' || code === 'model_no_tool_support' || code === 'image_too_large') {
    return { kind: 'error', source: 'session', code: 'VALIDATION_FAILED', retryable: false, displayText: 'The request was not valid.' }
  }
  return { kind: 'error', source: 'session', code: 'SESSION_FAILED', retryable, displayText: 'The session encountered an error.' }
}

function stableSourceEventKey(event: SessionEvent): string | undefined {
  const session = `${event.sessionId}:`
  switch (event.type) {
    case 'user_message': return `${session}user:${event.message.id}`
    case 'text_complete': return event.messageId ? `${session}assistant:${event.messageId}` : undefined
    case 'tool_start': return `${session}tool-start:${event.toolUseId}`
    case 'tool_result': return `${session}tool-result:${event.toolUseId}`
    case 'task_backgrounded': return `${session}task-start:${event.taskId}`
    case 'task_completed': return `${session}task-end:${event.taskId}:${event.status}`
    case 'workflow_agent_completed': return `${session}workflow-agent:${event.workflowId}:${event.agentId}`
    case 'shell_backgrounded': return `${session}shell-start:${event.shellId}`
    case 'shell_killed': return `${session}shell-end:${event.shellId}`
    case 'complete':
    case 'interrupted':
    case 'error':
    case 'typed_error':
      // These may lack a canonical ID. Hashing their canonical source shape only
      // deduplicates exact duplicate delivery; the hash never crosses/logs/persists.
      return `${session}source:${createHash('sha256').update(canonicalJson(event)).digest('hex')}`
    default: return undefined
  }
}

function eventTimestamp(event: SessionEvent, fallback: number): number {
  if ('timestamp' in event && Number.isFinite(event.timestamp) && event.timestamp! >= 0) return safeTimestamp(event.timestamp!)
  if (event.type === 'user_message' && Number.isFinite(event.message.timestamp) && event.message.timestamp >= 0) return safeTimestamp(event.message.timestamp)
  return safeTimestamp(fallback)
}

function safeOpaqueId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : 'redacted-id'
}

function safeTimestamp(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
}
