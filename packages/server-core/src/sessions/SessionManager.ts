import type { EventSink, RpcServer } from '@craft-agent/server-core/transport'
import { CLIENT_BROWSER_INVOKE } from '@craft-agent/server-core/transport'
import type { ISessionManager, IBrowserPaneManager, ExecutePromptAutomationInput, WorkspaceRemovalHooks, ShutdownCancellationResult } from '@craft-agent/server-core/handlers'
import { RemoteBrowserPaneManager } from './RemoteBrowserPaneManager'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@craft-agent/server-core/runtime'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { type AgentEvent, setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics, type PermissionMode, unregisterSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, AbortReason, type AuthRequest, type AuthResult, type CredentialAuthRequest, type BrowserPaneFns, type SessionScopedToolCallbacks, generateConversationSummary, resolveKeepBackgroundTasksAlive } from '@craft-agent/shared/agent'
import {
  resolveSessionConnection,
  createBackendFromConnection,
  resolveBackendContext,
  createBackendFromResolvedContext,
  cleanupSourceRuntimeArtifacts,
  providerTypeToAgentProvider,
  disposeBackendRuntime,
  type AgentBackend,
  type BackendHostRuntimeContext,
  type PostInitResult,
  type LabelSkillBootstrapChatEntry,
  type LabelSkillBootstrapRegisteredEvent,
} from '@craft-agent/shared/agent/backend'
import { getLlmConnection, getLlmConnections, getDefaultLlmConnection, getDefaultThinkingLevel, resetManagedAnthropicAuthEnvVars, resolveMidStreamBehavior, getPersistedUiLanguage, resolveTitleLanguageName, resolveRuntimeLifecycleConfig, type RuntimeLifecycleConfig } from '@craft-agent/shared/config'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { InitGate } from '@craft-agent/server-core/domain'
import { i18n } from '@craft-agent/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,
  loadPreferences,
  migrateLegacyCredentials,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type { ActiveSessionInfo, SessionProcessingStatus, RuntimeDisposeReason, RuntimeDisposeResult } from '@craft-agent/core/types'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { getProjectMemoryStore } from '@craft-agent/shared/project-memory'
import {
  formatSessionMemorySelectionDeniedReason,
  resolveSessionManagedMemorySelectionFromRepository,
} from './session-memory-runtime'
import { runContinuationTransaction } from './session-continuation'
import {
  // Session persistence functions
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  canUpdateSdkCwd,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionAttachmentsPath,
  getSessionPath as getSessionStoragePath,
  ensureSessionDir,
  getSessionFilePath,
  readSessionHeader,
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  writeSessionJsonl,
  preflightSessionJsonl,
  normalizeSessionHeaderMemorySelection,
  serializeSession,
  validateBundle,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionMetadata,
  type SessionStatus,
  type SessionHeader,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources, loadAllSources, getSourcesBySlugs, isSourceUsable, type LoadedSource, type McpServerConfig, getSourcesNeedingAuth, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, hasRenewEndpoint, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter } from '@craft-agent/shared/sources'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@craft-agent/shared/config'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import { resolveAuthEnvVars } from '@craft-agent/shared/config'
import { toolMetadataStore, getLastApiError } from '@craft-agent/shared/interceptor'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftMcpClient, McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp'
import { type Session, type SessionEvent, type FileAttachment, type SendMessageOptions, type UnreadSummary, type ContinueSessionInput, type ContinueSessionResult, type RemoteSessionTransferPayload, type ImportRemoteSessionTransferResult, type WorkspaceRemovalResult, type WorkspaceRemovalCode, RPC_CHANNELS, generateMessageId } from '@craft-agent/shared/protocol'
import { messageToStored, storedToMessage, type Message, type StoredAttachment, type ToolDisplayMeta, type TokenUsage } from '@craft-agent/core/types'
import { formatPathsToRelative, formatToolInputPaths, perf, encodeIconToDataUrlAsync, getEmojiIcon, resetSummarizationClient, resolveToolIcon, readFileAttachment, selectSpreadMessages, normalizePath } from '@craft-agent/shared/utils'
import { loadAllSkills, loadSkillBySlug, invalidateSkillsCache, listSkillSummaries, resolveSkillFilePathBySlug, type LoadedSkill, type SkillSummary } from '@craft-agent/shared/skills'
import { getDefaultLabelSkillBindingsConfig, loadAndValidateLabelSkillBindingsConfig, normalizeLabelSkillContextEpoch, resolveActiveLabelSkillAnchors, selectLabelSkillBootstrapCandidates, type LabelSkillAnchorResolution, type LabelSkillAnchorState, type LabelSkillBootstrapCandidateSelection, type LabelSkillBootstrapStateEntry } from '@craft-agent/shared/label-skill-bindings'
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system'
import { getToolIconsDir, getMiniModel } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import { listLabels, listLabelsFlat, loadLabelConfig } from '@craft-agent/shared/labels/storage'
import { extractLabelId, resolveSessionLabels, findTaskItemLabelId } from '@craft-agent/shared/labels'
import { ensureLabelsExist, ensureTaskItemLabel } from '@craft-agent/shared/labels/crud'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import {
  parseTaskYaml,
  saveTaskSpec,
  loadTaskSpec,
  listTaskSlugs,
  listRunIds,
  readRunLog,
  readNodeOutput,
  readRunSpecSnapshot,
  nodeTitle,
  assertTaskRunId,
  assertTaskSlug,
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
} from '@craft-agent/shared/tasks'
import { getOrCreateTaskConductorService, type TaskConductorService } from '../tasks'
import { AutomationSystem, createPromptHistoryEntry, appendAutomationHistoryEntry, type AutomationSystemMetadataSnapshot } from '@craft-agent/shared/automations'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput } from './runtime-config'

// Import from server-core domain utilities
import { sanitizeForTitle, shouldActivateBrowserOverlay, normalizeBrowserToolName, rollbackFailedBranchCreation, releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'
import { resizeImageForAPI, resizeIconBuffer } from '@craft-agent/server-core/services'
export { sanitizeForTitle }

// Module-level platform ref — set once during init via setSessionPlatform()
let _platform: PlatformServices | null = null

// Scoped logger — upgraded from console fallback when setSessionPlatform() is called.
// Named `sessionLog` so all ~30 existing call sites remain unchanged.
let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}

function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform) throw new Error('setSessionPlatform() must be called before session creation')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

const MAX_ADMIN_REMEMBER_MINUTES = 60
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// Window during which fs.watch metadata-revert events from our own atomic write
// are ignored, so the watcher does not roll back the in-memory mutation we
// just persisted. See onSessionMetadataChange.
const METADATA_WRITE_GUARD_MS = 5000

/**
 * Text sent to the session when a plan is approved from outside the desktop
 * UI (e.g. Telegram button). Mirrors the English `plan.approved` i18n key
 * used by the desktop flow at `plan-approval-message.ts`. Not localized —
 * the agent reads this, not the end user.
 */
const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath removed — use shared validateFilePath from @craft-agent/server-core/handlers

const PI_TURN_ANCHORS_VERSION = 1
const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

interface PiTurnAnchorsIndex {
  version: number
  anchors: Record<string, string>
}

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  const filePath = getPiTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PiTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(anchors)) {
      if (typeof messageId === 'string' && typeof anchor === 'string' && messageId && anchor) {
        normalized[messageId] = anchor
      }
    }
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getPiTurnAnchor(sessionPath: string, messageId: string): Promise<string | undefined> {
  if (!messageId) return undefined
  const index = await loadPiTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

export async function savePiTurnAnchor(sessionPath: string, messageId: string, anchorId: string): Promise<void> {
  if (!messageId || !anchorId) return

  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return

  index.anchors[messageId] = anchorId

  const filePath = getPiTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Copy Pi turn anchors from the source session into the branch session,
 * filtered to the messages actually carried into the branch.
 *
 * Without this, branching a branch is silently lossy: the source branch's
 * sidecar contains no anchors for messages copied from its own parent, so a
 * downstream branch falls back to "full-history fork" — discarding the
 * branch cutoff and producing a session whose visible history doesn't match
 * what the LLM sees. See craft-agents-oss#782.
 */
export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const index = await loadPiTurnAnchors(sourceSessionPath)
  if (Object.keys(index.anchors).length === 0) return
  const idSet = new Set(branchedMessageIds)
  const filtered: Record<string, string> = {}
  for (const [messageId, anchor] of Object.entries(index.anchors)) {
    if (idSet.has(messageId)) {
      filtered[messageId] = anchor
    }
  }
  if (Object.keys(filtered).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(
    getPiTurnAnchorsPath(branchSessionPath),
    JSON.stringify({ version: PI_TURN_ANCHORS_VERSION, anchors: filtered }),
    'utf-8',
  )
}

const CLAUDE_TURN_ANCHORS_VERSION = 1
const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(sessionPath: string): Promise<ClaudeTurnAnchorsIndex> {
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      const sdkSessionId = (value as { sdkSessionId?: unknown }).sdkSessionId
      const sdkMessageUuid = (value as { sdkMessageUuid?: unknown }).sdkMessageUuid
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getClaudeTurnAnchor(sessionPath: string, messageId: string): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // Load credentials for all sources
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  // Build token getter for refreshable sources (OAuth + renew-endpoint)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // Provider-specific OAuth (Google, Slack, Microsoft) or generic OAuth (authType: 'oauth')
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    // API renew endpoint — non-OAuth token refresh
    if (hasRenewEndpoint(source)) {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // Per-request credential getter for non-OAuth / non-renew API sources
  // (bearer / header / query / basic auth).
  //
  // Without this, the in-process API tool captures the credential as a static
  // string at build time and keeps using it forever — meaning a fresh JWT
  // entered via source_credential_prompt is ignored until session restart.
  //
  // With this getter, every API call reads the latest credential from the
  // vault, so credential updates take effect on the next call. OAuth and
  // renew-endpoint sources have their own refresh logic via TokenRefreshManager
  // and are skipped here.
  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    return async () => credManager.getApiCredential(source)
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
    getCredentialForSource,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state.
  // Re-classify AUTH_REQUIRED → TOKEN_EXPIRED when the credential is merely
  // expired-but-refreshable; in that case the refresh cycle handles recovery
  // and we must NOT prematurely mark the source as needing re-auth (#710).
  for (const error of result.errors) {
    if (error.error !== SERVER_BUILD_ERRORS.AUTH_REQUIRED) continue
    const source = sources.find(s => s.config.slug === error.sourceSlug)
    if (!source) continue

    const cred = await credManager.load(source)
    const isExpiredRefreshable =
      cred &&
      (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
      (cred.refreshToken || hasRenewEndpoint(source))

    if (isExpiredRefreshable) {
      error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
      sessionLog.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
      continue
    }

    credManager.markSourceNeedsReauth(source, 'Token missing or expired')
    sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
  }

  span.end()
  return result
}

/**
 * Result of expired-credential refresh.
 */
interface RefreshExpiredCredentialsResult {
  /** Number of sources whose tokens were successfully refreshed */
  refreshedCount: number
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth / renew-endpoint tokens for the given sources.
 *
 * Side effects (carried by `TokenRefreshManager.ensureFreshToken`):
 * - Success: source.config.isAuthenticated = true (in-memory + on disk).
 * - Failure: source.config.isAuthenticated = false + connectionStatus = 'needs_auth'
 *   (in-memory + on disk), so isSourceUsable() returns false and the source is
 *   excluded from intendedSlugs by callers.
 *
 * The caller is responsible for building servers AFTER this returns — that way
 * a single fresh build sees the correct credentials and the correct usable set.
 * Issue #710.
 */
async function refreshExpiredCredentials(
  sources: LoadedSource[],
  tokenRefreshManager: TokenRefreshManager
): Promise<RefreshExpiredCredentialsResult> {
  sessionLog.debug('[OAuth] Checking if any tokens need refresh')

  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)
  if (needRefresh.length === 0) {
    return { refreshedCount: 0, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Refreshing ${needRefresh.length} source(s): ${needRefresh.map(s => s.config.slug).join(', ')}`)

  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  return { refreshedCount: refreshed.length, failedSources }
}

/**
 * Apply bridge-mcp-server updates for backends that use it.
 * Delegates to the backend's own applyBridgeUpdates() method.
 * Each backend handles its own strategy via applyBridgeUpdates().
 */
async function applyBridgeUpdates(
  agent: AgentInstance,
  sessionPath: string,
  enabledSources: LoadedSource[],
  mcpServers: Record<string, import('@craft-agent/shared/agent/backend').SdkMcpServerConfig>,
  sessionId: string,
  workspaceRootPath: string,
  context: string,
  poolServerUrl?: string
): Promise<void> {
  await agent.applyBridgeUpdates({
    sessionPath,
    enabledSources,
    mcpServers,
    sessionId,
    workspaceRootPath,
    context,
    poolServerUrl,
  })
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'
let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // Cache miss sentinel: undefined means "not computed yet"
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // Dev fallback (before sync to ~/.craft-agent/tool-icons)
      join(process.cwd(), 'apps', 'electron', 'resources', 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
      // Packaged fallback (app resources)
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, { resize: resizeIconBuffer })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): Promise<ToolDisplayMeta | undefined> {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session, docs)
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'SubmitPlan': 'Submit Plan',
          'call_llm': 'LLM Query',
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
          'transform_data': 'Transform Data',
          'render_template': 'Render Template',
          'update_user_preferences': 'Update Preferences',
          'send_developer_feedback': 'Send Feedback',
          'browser_tool': 'Browser',
        },
        'craft-agents-docs': {
          'SearchCraftAgents': 'Search Docs',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return {
            displayName,
            iconDataUrl: normalizedBrowserTool ? await getBrowserToolIconDataUrl() : undefined,
            category: 'native' as const,
          }
        }
      }

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, { resize: resizeIconBuffer })
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        }
      }
    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, { resize: resizeIconBuffer })
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
  if (toolName === 'Bash' && toolInput?.command) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // Icon resolution is best-effort — never crash the session for it
    }
  }

  // Native browser tool names (with Chrome icon)
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return {
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    }
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'Agent': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}

/** Agent type - unified backend interface for all providers */
type AgentInstance = AgentBackend

type ManagedRuntimeState = 'creating' | 'ready' | 'draining' | 'disposed'

/** Exact immutable resource identity for one session runtime generation. */
interface ManagedRuntimeGeneration {
  epoch: number
  token: string
  state: ManagedRuntimeState
  agent?: AgentInstance
  mcpPool?: McpClientPool
  poolServer?: McpPoolServer
  envOverrides?: Record<string, string>
  readyPromise?: Promise<AgentInstance>
  disposePromise?: Promise<RuntimeDisposeResult | undefined>
  createdAt: number
}

type TurnWatchdogPhase = 'startup' | 'streaming' | 'tool' | 'compaction' | 'permission' | 'background'

/** Minimum generation/identity fence required by the production hotfix. */
interface ManagedTurnContext {
  generation: number
  token: string
  runtimeEpoch: number
  agent?: AgentInstance
  phase: TurnWatchdogPhase
  lastActivityAt: number
  protectedUntil?: number
  activeToolIds: Set<string>
  terminalClaimed: boolean
  terminalPromise?: Promise<void>
  watchdogTimer?: ReturnType<typeof setTimeout>
  retireRuntimeAfterTurn?: RuntimeDisposeReason
}

/**
 * Status of a background task in the main-process registry.
 * - `running`   — backgrounded and no terminal notification seen yet.
 * - `completed`/`failed`/`stopped` — a real SDK task_notification arrived.
 * - `orphaned`  — the turn that owned the task ended before a terminal
 *   notification arrived. With the (default) per-turn subprocess model the task
 *   almost certainly died with the subprocess, so reporting it as still
 *   "running" would be a lie. Once WS2 keep-alive is enabled these are no longer
 *   produced because the query outlives the turn.
 */
type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

/** A background task tracked from launch, for cross-subprocess status queries. */
interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  /** ms timestamp when the task was backgrounded */
  startTime: number
  /** ms timestamp of the last task_progress notification, if any */
  lastProgressAt?: number
  /** elapsed seconds from the most recent progress notification, if any */
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** turn that launched the task (used to orphan on that turn's completion) */
  turnId?: string
  /** Workflow run id (wf_...) — set when this task is a Workflow launch. */
  workflowId?: string
  /** Count of workflow sub-agents completed so far (Workflow tasks only). */
  agentsCompleted?: number
}

interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  /** Exact currently-owned runtime generation (partial resources stay private here while creating). */
  runtimeGeneration?: ManagedRuntimeGeneration
  nextRuntimeEpoch: number
  /** Queue-empty timestamp used by the global retained-runtime reaper. */
  runtimeIdleSince?: number
  /** Current turn identity; stale events/timers must match this object before mutation. */
  activeTurn?: ManagedTurnContext
  /** Watchdog/crash pauses FIFO replay until an explicit later send/retry. */
  runtimeQueuePaused?: boolean
  /** Tombstone closes per-session runtime admission before delete teardown awaits. */
  deleting?: boolean
  /** Generation-owned stop fallback timer. */
  stopTimer?: ReturnType<typeof setTimeout>
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  isFlagged: boolean
  /** Whether this session is pinned to the top of session lists */
  isPinned?: boolean
  /** Timestamp when this session was pinned (used for pinned ordering) */
  pinnedAt?: number
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  /** Previous permission mode (preserved across restarts for session_state modeTransition context) */
  previousPermissionMode?: PermissionMode
  /** Centralized MCP client pool for this session's source connections */
  mcpPool?: McpClientPool
  /** HTTP MCP server exposing pool tools to external SDK subprocesses */
  poolServer?: McpPoolServer
  // SDK session ID for conversation continuity
  sdkSessionId?: string
  // Token usage for display
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  // Session status (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  sessionStatus?: string
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[]
  // Structurally canonical Memory selection; availability is resolved separately.
  enabledMemorySpaceRefs?: SessionHeader['enabledMemorySpaceRefs']
  memoryWriteTargetRef?: SessionHeader['memoryWriteTargetRef']
  memorySelectionMode?: SessionHeader['memorySelectionMode']
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[]
  // Workspace-scoped project binding (undefined = unbound)
  projectId?: string
  // Workspace-scoped custom chat group binding (undefined = ungrouped)
  customGroupId?: string
  // Manual order within the workspace-scoped custom chat group (undefined = recency fallback)
  customGroupOrder?: number
  // Parent session id — when set, this session is a subtask of the parent (undefined = top-level task)
  parentSessionId?: string
  // Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus
  kanbanColumn?: string
  // Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes)
  taskSlug?: string
  // Tasks Conductor: id of the run that spawned this child session (child nodes only)
  taskRunId?: string
  // Tasks Conductor: id of the DAG node this child session executes (child nodes only)
  taskNodeId?: string
  // Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator
  taskNodeCount?: number
  // Tasks Conductor: hidden generate-time orchestrator awaiting validated adoption (off the board)
  taskDraft?: boolean
  // Working directory for this session (used by agent for bash commands)
  workingDirectory?: string
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // LLM connection slug for this session (locked after first message)
  llmConnection?: string
  // Whether the connection is locked (cannot be changed after first agent creation)
  connectionLocked?: boolean
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader
  // Guard: suppress external metadata revert after programmatic writes (setSessionStatus/setSessionLabels).
  // fs.watch fires during atomic write (unlink+rename) and can read stale data, reverting in-memory state.
  _metadataWriteGuardUntil?: number
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean
  // Preview of first user message (for sidebar display fallback)
  preview?: string
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number
  // Message queue for handling new messages while processing
  // When a message arrives during processing, we interrupt and queue
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string  // Pre-generated ID for matching with UI
    optimisticMessageId?: string  // Frontend's ID for reliable event matching
  }>
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // Registry of background tasks (running + recently-terminal) for this session.
  // Unlike backgroundTaskOutputs (which only stores COMPLETED tasks for output
  // retrieval), this tracks tasks from the moment they are backgrounded, so a
  // cross-subprocess "status?" query can enumerate what is actually live. The
  // SDK's in-subprocess task tools cannot answer this: their state dies with the
  // subprocess at turn end, so this main-process registry is the real source of
  // truth for background-task status. See RunningBackgroundTask.
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
  branchFromMessageId?: string
  // Branch context strategy:
  // - sdk-fork: provider-level fork from parent SDK session
  // - seeded-fresh-session: fresh backend session seeded with transcript up to branch cutoff
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  // Parent session's SDK session ID (used only when branchContextStrategy === 'sdk-fork')
  branchFromSdkSessionId?: string
  // Parent session's storage path (used only when branchContextStrategy === 'sdk-fork')
  branchFromSessionPath?: string
  // Parent session's sdkCwd — needed so the fork subprocess uses the correct
  // ~/.claude/projects/{cwd-hash}/ directory to find the parent's session file.
  branchFromSdkCwd?: string
  // SDK assistant message UUID at the branch point — used as resumeSessionAt
  // to trim the forked conversation at the branch point.
  branchFromSdkTurnId?: string
  // One-shot flag for seeded branch mode - set true after first turn seed injection.
  branchSeedApplied?: boolean
  // One-shot hidden summary injected on the first turn after a remote transfer.
  transferredSessionSummary?: string
  // Whether the transferred-session summary has already been injected.
  transferredSessionSummaryApplied?: boolean
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
  // Metadata for sessions created by automations
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number }
  // Persistent runtime state for hidden label-skill anchor revocation/supersession.
  labelSkillAnchorState?: LabelSkillAnchorState
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
  // Per-session env overrides for SDK subprocess (e.g., ANTHROPIC_BASE_URL).
  // Stored on managed session so it persists across agent recreations (auth-retry, etc.)
  envOverrides?: Record<string, string>
  // Runtime-affecting backend config signature captured when the live agent was created/refreshed.
  backendRuntimeSignature?: string
  /**
   * Signature over fields that cannot be propagated via `update_runtime_config`
   * (see `runtime-config.ts:buildRestartRequiredSignature`). When this drifts,
   * the agent must be disposed + recreated rather than refreshed in place.
   */
  backendRestartSignature?: string
  // Whether the previous turn was interrupted (for context injection on next message).
  // Ephemeral — not persisted to disk. Cleared after one-shot injection.
  wasInterrupted?: boolean
  /**
   * Runtime-only: Pi SDK message id → Craft assistant message id.
   * Populated when a `text_complete` arrives carrying `sdkMessageId`, and read
   * when the follow-up `pi_turn_anchor` event arrives (deferred by one microtask
   * so the SDK's session-manager has updated its leaf — see craft-agents-oss#782).
   * Capped at PI_SDK_MESSAGE_ID_CACHE_LIMIT to bound memory in long sessions.
   */
  piSdkMessageToCraftMessage?: Map<string, string>
  // Source-activation auto-retry (craft-agents-oss#804). When a source activates
  // mid-turn, we re-send the original message with a "[<slug> activated]" suffix
  // after a short delay. The pending slot lets `sendMessage` dedup a duplicate
  // RPC from a legacy renderer that still ships the client-side auto_retry.
  autoRetryTimer?: ReturnType<typeof setTimeout>
  autoRetryPending?: {
    content: string
    deadlineMs: number
    /** True after the first matching sendMessage consumes the slot; later matches drop. */
    committed: boolean
  }
}

const PI_SDK_MESSAGE_ID_CACHE_LIMIT = 256

export interface AutoRetryPendingHost {
  autoRetryPending?: {
    content: string
    deadlineMs: number
    committed: boolean
  }
}

export function claimAutoRetryPending(
  host: AutoRetryPendingHost,
  message: string,
  nowMs = Date.now(),
): 'send' | 'drop' {
  const pending = host.autoRetryPending
  if (pending && message === pending.content) {
    if (nowMs < pending.deadlineMs) {
      if (pending.committed) return 'drop'
      pending.committed = true
      return 'send'
    }
    host.autoRetryPending = undefined
    return 'send'
  }

  if (pending && nowMs >= pending.deadlineMs) {
    host.autoRetryPending = undefined
  }

  return 'send'
}

/**
 * Create a ManagedSession from any session-like source (SessionMetadata, SessionConfig, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { id: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: Remove legacy 'think' normalization after old persisted session
    // headers have realistically aged out across upgrades.
    const normalizedThinkingLevel = normalizeThinkingLevel(sourceFields.thinkingLevel)
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  const managed = {
    // Spread all session-like fields from source (id, name, permissionMode, labels, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    nextRuntimeEpoch: 0,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    backgroundTaskRegistry: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // Caller overrides (permissionMode defaults, thinkingLevel, messagesLoaded, etc.)
    ...overrides,
  } as ManagedSession

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  return managed
}

/**
 * Resolve supportsBranching for a managed session.
 * Prefers the live agent instance; falls back to true for all backends.
 */
function resolveSupportsBranching(managed: ManagedSession): boolean {
  // If agent is live, use its instance property (authoritative)
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // default: branching enabled for all backends
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

/**
 * Convert a ManagedSession to a renderer-side Session object.
 * Uses pickSessionFields() for persistent fields so new fields propagate automatically.
 */
function managedToSession(m: ManagedSession, overrides?: Partial<Session>): Session {
  return {
    ...pickSessionFields(m),
    // Pre-computed fields from header (not in SESSION_PERSISTENT_FIELDS)
    preview: m.preview,
    lastMessageRole: m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: m.messageCount,
    lastFinalMessageId: m.lastFinalMessageId,
    // Runtime-only fields
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    isProcessing: m.isProcessing,
    sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}

// Performance: Batch IPC delta events to reduce renderer load
const DELTA_BATCH_INTERVAL_MS = 50  // Flush batched deltas every 50ms

interface PendingDelta {
  delta: string
  turnId?: string
}

function extractExplicitSkillSlugsForLabelBootstrap(message: string, options?: SendMessageOptions): string[] {
  const slugs: string[] = []
  for (const slug of options?.skillSlugs ?? []) {
    if (slug && !slugs.includes(slug)) slugs.push(slug)
  }
  const pattern = /\[skill:(?:[\w .-]+:)?([\w-]+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(message)) !== null) {
    const slug = match[1]
    if (slug && !slugs.includes(slug)) slugs.push(slug)
  }
  return slugs
}

/**
 * In-process session-completion signal for the Tasks Conductor.
 *
 * Emitted once per turn from `onProcessingStopped` when the session's message
 * queue is empty (i.e. true completion, not a hand-off between queued turns),
 * carrying the stop `reason`. This is an internal, side-effect-free seam — it is
 * NOT a renderer event and NOT exposed to agents. The Conductor maps the reason
 * onto a node run-state: complete→done, error/timeout→failed, interrupted→cancelled.
 */
export interface SessionCompletionEvent {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  /** The final (non-intermediate) assistant message id for this turn, if any. */
  finalMessageId?: string
  /** Convenience copy of the final assistant message text (same as getSessionFinalText). */
  finalText?: string
  /** The session's cumulative token usage, so the Conductor can meter token_budget without re-fetching. */
  tokenUsage?: TokenUsage
}

type SessionTaskTools = NonNullable<SessionScopedToolCallbacks['taskTools']>
type SessionTaskInvocation = Parameters<NonNullable<SessionTaskTools['validate']>>[1]

/** Map shared task validation issues onto the session-tool callback DTO shape. */
function toTaskToolValidationDto(result: ReturnType<typeof parseTaskYaml>) {
  const issue = (i: { path: string; message: string; severity: 'error' | 'warning'; suggestion?: string }) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
    ...(i.suggestion ? { suggestion: i.suggestion } : {}),
  })
  const sessionNodeCount = result.spec?.nodes.filter((n) => n.kind === 'session').length ?? 0
  return {
    valid: result.valid,
    errors: result.errors.map(issue),
    warnings: result.warnings.map(issue),
    estimate: result.spec ? { nodeCount: result.spec.nodes.length, sessionNodeCount } : undefined,
  }
}

/** Storage-backed task run results, shared by agent callbacks with the renderer RPC shape. */
function readTaskToolResults(workspaceRoot: string, slug: string, runId?: string) {
  const safeSlug = assertTaskSlug(slug)
  const requestedRunId = runId === undefined ? undefined : assertTaskRunId(runId)
  const runIds = listRunIds(workspaceRoot, safeSlug)
  const chosen = requestedRunId ?? runIds.at(-1) ?? null
  if (!chosen) return { slug: safeSlug, runId: null, runIds, nodes: [] }

  const log = readRunLog(workspaceRoot, safeSlug, chosen)
  const snapshot = readRunSpecSnapshot(workspaceRoot, safeSlug, chosen)
  const titleById = new Map<string, string>()
  if (snapshot) for (const n of snapshot.nodes) titleById.set(n.id, nodeTitle(n))

  const byId = new Map<string, { id: string; state: string; sessionId?: string }>()
  const ensure = (id: string) => {
    let e = byId.get(id)
    if (!e) { e = { id, state: 'pending' }; byId.set(id, e) }
    return e
  }

  const verdicts: Array<{ result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }> = []
  let runStatus: string | undefined
  for (const entry of log) {
    if (entry.kind === 'node-scheduled' || entry.kind === 'node-spawned') {
      const e = ensure(entry.nodeId)
      if (entry.kind === 'node-spawned') e.sessionId = entry.sessionId
    } else if (entry.kind === 'node-finished') {
      const e = ensure(entry.nodeId)
      e.state = entry.state
      if (entry.sessionId) e.sessionId = entry.sessionId
    } else if (entry.kind === 'verdict') {
      verdicts.push({
        result: entry.result,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.nodes?.length ? { nodes: entry.nodes } : {}),
      })
    } else if (entry.kind === 'run-completed') {
      runStatus = 'completed'
    } else if (entry.kind === 'run-failed') {
      runStatus = 'failed'
    } else if (entry.kind === 'run-stopped') {
      runStatus = 'stopped'
    } else if (entry.kind === 'run-verifying') {
      runStatus = 'verifying'
    }
  }

  const nodes = [...byId.values()].map((e) => {
    const out = readNodeOutput(workspaceRoot, safeSlug, chosen, e.id)
    return {
      id: e.id,
      title: titleById.get(e.id) ?? e.id,
      state: e.state,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(out?.text ? { output: out.text } : {}),
    }
  })

  const repairUsed = verdicts.filter((v) => v.result === 'fail').length
  const repairMax = Math.min(snapshot?.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP)

  return {
    slug: safeSlug,
    runId: chosen,
    runIds,
    verdict: verdicts.at(-1),
    verdicts,
    repair: { used: repairUsed, max: repairMax },
    ...(runStatus ? { runStatus } : {}),
    ...(snapshot?.acceptance_criteria ? { acceptanceCriteria: snapshot.acceptance_criteria } : {}),
    nodes,
  }
}

type WorkspaceLifecycleState = 'active' | 'removing' | 'removed'
type WorkspaceAdmissionKind = 'session' | 'task' | 'automation' | 'background'

interface WorkspaceLifecycle {
  state: WorkspaceLifecycleState
  inFlight: Record<WorkspaceAdmissionKind, number>
  removalPromise?: Promise<WorkspaceRemovalResult>
  teardownStarted: boolean
}

export class WorkspaceAdmissionError extends Error {
  readonly code = 'workspace-admission-closed'

  constructor(readonly workspaceId: string, readonly kind: WorkspaceAdmissionKind) {
    super(`Workspace ${workspaceId} is not accepting ${kind} work`)
    this.name = 'WorkspaceAdmissionError'
  }
}

function newWorkspaceLifecycle(state: WorkspaceLifecycleState = 'active'): WorkspaceLifecycle {
  return {
    state,
    inFlight: { session: 0, task: 0, automation: 0, background: 0 },
    teardownStarted: false,
  }
}

function runtimeDisposalFailed(result: RuntimeDisposeResult | undefined): boolean {
  return result?.outcome === 'timed_out'
    || result?.errorCode === 'runtime_dispose_failed'
    || result?.errorCode === 'runtime_dispose_timed_out'
}

export class SessionManager implements ISessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  private pendingDeltas: Map<string, PendingDelta> = new Map()
  private deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // Config watchers for live updates (sources, etc.) - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // Idle write-guard expirations for deferred external session headers.
  private externalMetadataGuardTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  // Automation systems for workspace event automations - one per workspace (includes scheduler, diffing, and handlers)
  private automationSystems: Map<string, AutomationSystem> = new Map()
  // Pending credential request resolvers (keyed by requestId)
  private pendingCredentialResolvers: Map<string, (response: import('@craft-agent/shared/protocol').CredentialResponse) => void> = new Map()
  // Permission request metadata tracking (keyed by requestId)
  private pendingPermissionRequests: Map<string, {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }> = new Map()
  // Privileged approval binding + audit logger
  private privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // Session-local admin remember windows (exact command hash binding)
  private adminRememberApprovals: Map<string, {
    createdAt: number
    expiresAt: number
    sourceRequestId: string
  }> = new Map()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId. Used to determine if a session should be
   * marked as unread when assistant completes - if user is viewing it, don't mark unread.
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** Canonical per-workspace admission/removal ownership. */
  private workspaceLifecycles: Map<string, WorkspaceLifecycle> = new Map()
  /** Coordinates startup initialization waiters from IPC handlers. */
  private initGate = new InitGate()
  // O(1) index: taskId → sessionId for background task output lookup (avoids O(n) session scan)
  private taskOutputIndex: Map<string, string> = new Map()
  /**
   * WS2 keep-alive flag (default ON, opt-out via `CRAFT_KEEP_BG_AGENTS_ALIVE=0`).
   * When true, a persistent streaming query keeps the subprocess alive across
   * turns so background sub-agents survive, and orphaning is suppressed. When
   * false (kill-switch), sub-agents are bound to a single turn's subprocess and
   * die at turn end, so markOrphanedBackgroundTasks() flips still-running registry
   * entries to `orphaned` on turn completion. Resolved via the shared
   * `resolveKeepBackgroundTasksAlive` so the main process and the Claude backend
   * can never disagree about whether keep-alive is on.
   */
  private readonly keepBackgroundTasksAlive: boolean = resolveKeepBackgroundTasksAlive()
  /**
   * Per-session in-flight runtime-refresh promise. Ensures `updateRuntimeConfig`
   * (or a dispose) cannot overlap with another refresh OR with a send-path
   * `getOrCreateAgent` on the same session. Without this serialization, a
   * `SAVE`-triggered refresh and a `sendMessage`-triggered refresh can both
   * see `agent.isProcessing()=false`, both fire `updateRuntimeConfig`, and the
   * subprocess can race the resulting `chat` against the still-pending update.
   */
  private agentRefreshLocks: Map<string, Promise<void>> = new Map()
  /** Audited environment-driven hotfix bounds (resolved per manager instance). */
  private readonly runtimeLifecycleConfig: RuntimeLifecycleConfig = resolveRuntimeLifecycleConfig()
  /** Exact generations remain tracked until their own awaited disposal finishes. */
  private runtimeRegistry = new Map<string, { managed: ManagedSession; generation: ManagedRuntimeGeneration }>()
  private idleReaperTimer?: ReturnType<typeof setInterval>
  private closing = false
  private cleanupPromise?: Promise<void>
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0

  /**
   * Optional binder installed by the messaging-gateway bootstrap. When set,
   * `executePromptAutomation` calls it after creating a session whose matcher
   * declared `telegramTopic`, so the new session is bound to a Telegram forum
   * topic in the workspace's paired supergroup. Best-effort — failures must
   * not block the session.
   */
  private automationBinder?: (input: {
    workspaceId: string
    sessionId: string
    topicName: string
  }) => Promise<void>
  private workspaceReattachedHandler?: (workspaceId: string) => Promise<void>

  /**
   * Centralized setter for session processing state.
   * Automatically notifies the power manager on transitions (true→false, false→true)
   * so callers don't need to remember to call onSessionStarted/onSessionStopped.
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      sessionRuntimeHooks.onSessionStopped()
    }
  }

  private beginTurn(managed: ManagedSession): ManagedTurnContext {
    const turn: ManagedTurnContext = {
      generation: managed.processingGeneration,
      token: randomUUID(),
      runtimeEpoch: managed.runtimeGeneration?.epoch ?? 0,
      agent: managed.agent ?? undefined,
      phase: managed.agent ? 'streaming' : 'startup',
      lastActivityAt: Date.now(),
      activeToolIds: new Set(),
      terminalClaimed: false,
    }
    if (managed.activeTurn?.watchdogTimer) clearTimeout(managed.activeTurn.watchdogTimer)
    managed.activeTurn = turn
    managed.runtimeIdleSince = undefined
    this.scheduleTurnWatchdog(managed, turn)
    return turn
  }

  private isCurrentTurn(managed: ManagedSession, turn: ManagedTurnContext, agent?: AgentInstance): boolean {
    const generationMatches = !turn.agent || (
      managed.runtimeGeneration?.epoch === turn.runtimeEpoch
      && managed.runtimeGeneration.agent === turn.agent
    )
    return managed.activeTurn === turn
      && managed.processingGeneration === turn.generation
      && !turn.terminalClaimed
      && generationMatches
      && (!agent || turn.agent === agent)
      && !managed.deleting
      && !this.closing
  }

  private scheduleTurnWatchdog(managed: ManagedSession, turn: ManagedTurnContext): void {
    if (turn.watchdogTimer) clearTimeout(turn.watchdogTimer)
    turn.watchdogTimer = undefined
    if (!this.runtimeLifecycleConfig.watchdogEnabled || turn.terminalClaimed || !this.isCurrentTurn(managed, turn)) return

    const now = Date.now()
    let deadline: number
    switch (turn.phase) {
      case 'startup':
        deadline = turn.lastActivityAt + this.runtimeLifecycleConfig.startupTimeoutMs
        break
      case 'tool':
        deadline = turn.protectedUntil ?? (turn.lastActivityAt + this.runtimeLifecycleConfig.toolTimeoutMs)
        break
      case 'compaction':
      case 'permission':
      case 'background':
        deadline = turn.protectedUntil ?? (now + this.runtimeLifecycleConfig.protectedLeaseMs)
        break
      default:
        deadline = turn.lastActivityAt + this.runtimeLifecycleConfig.silenceTimeoutMs
    }

    turn.watchdogTimer = setTimeout(() => {
      if (!this.isCurrentTurn(managed, turn) || turn.terminalClaimed) return
      void this.handleRuntimeFailure(
        managed,
        managed.runtimeGeneration,
        turn.agent,
        'watchdog',
        turn,
      )
    }, Math.max(1, deadline - now))
    turn.watchdogTimer.unref?.()
  }

  private protectTurn(managed: ManagedSession, phase: Extract<TurnWatchdogPhase, 'permission' | 'compaction' | 'background'>): void {
    const turn = managed.activeTurn
    if (!turn || !this.isCurrentTurn(managed, turn)) return
    turn.phase = phase
    turn.protectedUntil = Date.now() + this.runtimeLifecycleConfig.protectedLeaseMs
    turn.lastActivityAt = Date.now()
    this.scheduleTurnWatchdog(managed, turn)
  }

  private resolvePermissionProtection(managed: ManagedSession): void {
    if (this.hasPendingPermissionForSession(managed.id)) return
    const turn = managed.activeTurn
    if (!turn || !this.isCurrentTurn(managed, turn) || turn.phase !== 'permission') return
    turn.phase = turn.activeToolIds.size > 0 ? 'tool' : 'streaming'
    turn.protectedUntil = turn.activeToolIds.size > 0
      ? Date.now() + this.runtimeLifecycleConfig.toolTimeoutMs
      : undefined
    turn.lastActivityAt = Date.now()
    this.scheduleTurnWatchdog(managed, turn)
  }

  private noteTurnActivity(managed: ManagedSession, turn: ManagedTurnContext, event: AgentEvent): void {
    if (!this.isCurrentTurn(managed, turn)) return
    const now = Date.now()
    turn.lastActivityAt = now

    if ((event.type === 'status' || event.type === 'info') && event.runtimeActivity === 'compaction_start') {
      turn.phase = 'compaction'
      turn.protectedUntil = now + this.runtimeLifecycleConfig.protectedLeaseMs
    } else if ((event.type === 'status' || event.type === 'info') && event.runtimeActivity && event.runtimeActivity !== 'compaction_start') {
      turn.phase = turn.activeToolIds.size > 0 ? 'tool' : 'streaming'
      turn.protectedUntil = turn.activeToolIds.size > 0 ? turn.protectedUntil : undefined
    } else if (event.type === 'tool_start') {
      turn.activeToolIds.add(event.toolUseId)
      turn.phase = 'tool'
      // Foreground tool ceiling is absolute, not renewed by ordinary progress.
      if (turn.activeToolIds.size === 1) turn.protectedUntil = now + this.runtimeLifecycleConfig.toolTimeoutMs
    } else if (event.type === 'tool_result') {
      turn.activeToolIds.delete(event.toolUseId)
      if (turn.activeToolIds.size === 0) {
        turn.phase = 'streaming'
        turn.protectedUntil = undefined
      }
    } else if (event.type === 'task_backgrounded' || event.type === 'shell_backgrounded') {
      turn.phase = 'background'
      turn.protectedUntil = now + this.runtimeLifecycleConfig.protectedLeaseMs
    } else if (turn.phase === 'startup') {
      turn.phase = 'streaming'
    }

    this.scheduleTurnWatchdog(managed, turn)
  }

  private appendRuntimeTerminalError(managed: ManagedSession, kind: 'crash' | 'watchdog'): void {
    const code = kind === 'crash' ? 'runtime_backend_crashed' : 'runtime_watchdog_timeout'
    const title = kind === 'crash' ? 'Agent runtime stopped' : 'Agent became unresponsive'
    const content = kind === 'crash'
      ? 'The agent backend exited unexpectedly. Retry to continue with a fresh runtime.'
      : 'The agent did not make progress before the safety deadline. Retry to continue with a fresh runtime.'
    const timestamp = this.monotonic()
    const errorMessage: Message = {
      id: generateMessageId(),
      role: 'error',
      content,
      timestamp,
      errorCode: code,
      errorTitle: title,
      errorCanRetry: true,
    }
    managed.messages.push(errorMessage)
    this.sendEvent({
      type: 'typed_error',
      sessionId: managed.id,
      error: {
        code,
        title,
        message: content,
        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
        canRetry: true,
      },
    }, managed.workspace.id)
  }

  private async handleRuntimeFailure(
    managed: ManagedSession,
    generation: ManagedRuntimeGeneration | undefined,
    agent: AgentInstance | undefined,
    kind: 'crash' | 'watchdog',
    expectedTurn?: ManagedTurnContext,
  ): Promise<void> {
    if (!generation || managed.runtimeGeneration !== generation) return
    const turn = expectedTurn ?? managed.activeTurn

    if (!turn || !this.isCurrentTurn(managed, turn, agent)) {
      // Idle unexpected exit: retire the dead exact bundle without fabricating a turn error.
      await this.disposeManagedAgentRuntime(managed, kind === 'crash' ? 'backend_crash' : 'watchdog', generation)
      return
    }
    if (turn.terminalClaimed) return

    this.clearPendingPermissionRequestsForSession(managed.id)
    this.appendRuntimeTerminalError(managed, kind)
    managed.runtimeQueuePaused = true
    turn.retireRuntimeAfterTurn = kind === 'crash' ? 'backend_crash' : 'watchdog'
    try {
      agent?.forceAbort(AbortReason.UserStop)
    } catch {
      // Exact disposal below is the hard backstop.
    }

    const terminal = this.onProcessingStopped(managed.id, 'timeout', turn)
    await this.disposeManagedAgentRuntime(managed, turn.retireRuntimeAfterTurn, generation)
    await terminal
  }

  /** Wait until initialize() has completed (sessions loaded from disk).
   *  Resolves immediately if already initialized. */
  waitForInit(): Promise<void> {
    return this.initGate.wait()
  }

  /**
   * Install the automation→topic binder. Wired by the messaging-gateway
   * bootstrap so SessionManager doesn't need to import the messaging
   * package (avoids a package-level circular dependency).
   */
  setAutomationBinder(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void {
    this.automationBinder = fn
  }

  setWorkspaceReattachedHandler(fn: (workspaceId: string) => Promise<void>): void {
    this.workspaceReattachedHandler = fn
  }

  private taskConductor?: TaskConductorService

  /** Inject the shared task conductor selected by a composition root/RPC handler. */
  setTaskConductorService(service: TaskConductorService): void {
    if (this.taskConductor && this.taskConductor !== service) {
      sessionLog.warn('Replacing SessionManager TaskConductorService; active task runs may be split')
    }
    this.taskConductor = service
  }

  /** Shared task conductor used by both renderer RPC handlers and agent-facing task callbacks. */
  getTaskConductorService(): TaskConductorService {
    if (!this.taskConductor) {
      this.taskConductor = getOrCreateTaskConductorService({ host: this })
    }
    return this.taskConductor
  }

  private assertSessionTaskCaller(managed: ManagedSession, context: SessionTaskInvocation): void {
    if (context.callerSessionId !== managed.id) {
      throw new Error(`Task tool caller mismatch: expected ${managed.id}, got ${context.callerSessionId}`)
    }
    if (context.workspacePath !== managed.workspace.rootPath) {
      throw new Error('Task tool workspace mismatch: caller context does not match the managed session workspace')
    }
  }

  private createSessionTaskToolCallbacks(managed: ManagedSession): SessionTaskTools {
    const reconcileFromSpec = (spec: NonNullable<ReturnType<typeof parseTaskYaml>['spec']>) => ({
      name: spec.title,
      projectId: spec.project,
      ...(spec.cwd ? { workingDirectory: spec.cwd } : {}),
      ...(spec.defaults?.model ? { model: spec.defaults.model } : {}),
      ...(spec.defaults?.llmConnection ? { llmConnection: spec.defaults.llmConnection } : {}),
      ...(spec.defaults?.permissionMode ? { permissionMode: spec.defaults.permissionMode } : {}),
    })

    const finishCreate = async (
      callerSessionId: string,
      spec: NonNullable<ReturnType<typeof parseTaskYaml>['spec']>,
      validation: ReturnType<typeof toTaskToolValidationDto>,
    ) => {
      const applied = await this.applyTaskLabel(callerSessionId).catch((err: unknown) => {
        sessionLog.warn('task_create callback: applyTaskLabel failed for caller orchestrator', {
          sessionId: callerSessionId,
          err,
        })
        return undefined
      })

      if (spec.sources?.length) {
        await Promise.resolve(this.setSessionSources(callerSessionId, spec.sources)).catch((err: unknown) => {
          sessionLog.warn('task_create callback: setSessionSources failed for caller orchestrator', {
            sessionId: callerSessionId,
            err,
          })
        })
      }

      return {
        slug: spec.id,
        orchestratorSessionId: callerSessionId,
        validation,
        ...(applied?.labelId ? { taskLabelId: applied.labelId } : {}),
      }
    }

    return {
      validate: (input, context) => {
        this.assertSessionTaskCaller(managed, context)
        return toTaskToolValidationDto(parseTaskYaml(input.yaml))
      },
      create: async (input, context) => {
        this.assertSessionTaskCaller(managed, context)
        const parsed = parseTaskYaml(input.yaml)
        const validation = toTaskToolValidationDto(parsed)
        if (!parsed.valid || !parsed.spec) {
          return { slug: '', orchestratorSessionId: context.callerSessionId, validation }
        }

        const spec = parsed.spec

        // The agent-facing MVP deliberately binds/adopts the current caller only. It does not
        // expose raw orchestratorSessionId / attachToExistingSession passthroughs.
        const reconcile = reconcileFromSpec(spec)
        const adopted = await this.adoptGeneratedTaskOrchestrator(context.callerSessionId, spec.id, reconcile)
        if (!adopted) {
          const bound = await this.bindExistingSessionToTask(context.callerSessionId, spec.id, reconcile)
          if (!bound) {
            throw new Error(
              `Cannot bind task "${spec.id}" to current session ${context.callerSessionId}: ` +
              'session is missing or already bound to a different task.',
            )
          }
        }

        saveTaskSpec(managed.workspace.rootPath, spec)
        return finishCreate(context.callerSessionId, spec, validation)
      },
      run: (input, context) => {
        this.assertSessionTaskCaller(managed, context)
        const slug = assertTaskSlug(input.slug)
        const runId = input.runId === undefined ? undefined : assertTaskRunId(input.runId)
        return this.getTaskConductorService().run(managed.workspace.id, slug, {
          ...(runId !== undefined ? { runId } : {}),
          orchestratorSessionId: context.callerSessionId,
          ...(input.params ? { params: input.params } : {}),
        })
      },
      get: (input, context) => {
        this.assertSessionTaskCaller(managed, context)
        const slug = assertTaskSlug(input.slug)
        const runId = input.runId === undefined ? undefined : assertTaskRunId(input.runId)
        const loaded = loadTaskSpec(managed.workspace.rootPath, slug)
        if (!loaded) {
          return {
            slug,
            validation: {
              valid: false,
              errors: [{ path: 'root', message: `Task "${slug}" not found`, severity: 'error' }],
              warnings: [],
            },
            run: null,
          }
        }
        const run = runId ? this.getTaskConductorService().getRunState(managed.workspace.id, slug, runId) : null
        return { slug, validation: toTaskToolValidationDto(loaded), spec: loaded.spec, run }
      },
      list: (_input, context) => {
        this.assertSessionTaskCaller(managed, context)
        return listTaskSlugs(managed.workspace.rootPath)
      },
      getResults: (input, context) => {
        this.assertSessionTaskCaller(managed, context)
        return readTaskToolResults(managed.workspace.rootPath, input.slug, input.runId)
      },
    }
  }

  private browserPaneManager: IBrowserPaneManager | null = null
  private rpcServer: RpcServer | null = null
  private remoteBpms = new Map<string, RemoteBrowserPaneManager>()
  /** Pinned desktop client per session for `client:browser:invoke` routing. */
  private browserHostByCanvas = new Map<string, string>()
  private eventSink: EventSink | null = null

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  setBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.browserPaneManager = bpm
    bpm.setSessionPathResolver((sessionId) => this.getSessionPath(sessionId))
  }

  /**
   * Provide the WS RPC server so remote clients can host browser tools.
   *
   * When called, the SM activates the remote-bridge code path: per-session
   * `RemoteBrowserPaneManager` instances are created lazily by
   * {@link getBrowserPaneManagerForSession}, and the browser-host client is
   * resolved via {@link getBrowserHostClient} with capability-aware fallback.
   *
   * Local Electron callers do not need to call this — they already
   * call `setBrowserPaneManager(bpm)` with the in-process BPM, which takes
   * precedence over the remote bridge in {@link getBrowserPaneManagerForSession}.
   */
  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
    sessionLog.info('[browser-pane] setRpcServer called — remote browser bridge is now available')
  }

  /**
   * Resolve the {@link IBrowserPaneManager} that owns the user's local browser
   * for a given session. Returns:
   *
   * 1. The locally-injected `browserPaneManager` when present (Electron client co-located
   *    with the agent), regardless of session.
   * 2. A session-bound {@link RemoteBrowserPaneManager} when `rpcServer` is set.
   *    Cached in `remoteBpms` so repeat lookups don't allocate.
   * 3. `null` when there's neither a local BPM nor an RPC server.
   */
  getBrowserPaneManagerForSession(sid: string): IBrowserPaneManager | null {
    if (this.browserPaneManager) return this.browserPaneManager
    if (!this.rpcServer) return null

    const cached = this.remoteBpms.get(sid)
    if (cached) return cached

    const session = this.sessions.get(sid)
    if (!session) return null

    const bridge = new RemoteBrowserPaneManager({
      sessionId: sid,
      workspaceId: session.workspace.id,
      rpcServer: this.rpcServer,
      getHostClient: () => this.getBrowserHostClient(sid),
    })
    this.remoteBpms.set(sid, bridge)
    return bridge
  }

  /**
   * Record which desktop client should host this session's browser. Called
   * with `ctx.clientId` from the `sessions.sendMessage` RPC handler so the
   * agent's browser_* tools route back to the client that posted the message.
   *
   * No-op when `callerClientId` is undefined — preserves the existing pin
   * (lets reconnected clients continue holding the host role).
   */
  private setLastMessageClientId(sid: string, callerClientId: string | undefined): void {
    if (!callerClientId) return
    this.browserHostByCanvas.set(sid, callerClientId)
  }

  /**
   * Called by the transport bootstrap on `onClientDisconnected`. Drops any
   * pins held by `clientId` so the next browser tool call re-resolves via
   * {@link findClientsWithCapability} instead of trying to ship to a dead client.
   */
  onClientDisconnected(clientId: string): void {
    for (const [sid, pinned] of this.browserHostByCanvas) {
      if (pinned === clientId) this.browserHostByCanvas.delete(sid)
    }
  }

  /**
   * Pinned client first, with fallback to any connected client for the workspace
   * that advertises `client:browser:invoke`. The fallback handles reconnect-with-
   * new-clientId so the agent isn't stuck waiting for another user message.
   */
  private getBrowserHostClient(sid: string): string | null {
    if (!this.rpcServer) return null
    const pinned = this.browserHostByCanvas.get(sid)
    if (pinned && this.rpcServer.hasClientCapability(pinned, CLIENT_BROWSER_INVOKE)) {
      return pinned
    }
    const session = this.sessions.get(sid)
    if (!session) return null
    const candidates = this.rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId: session.workspace.id },
    )
    const fallback = candidates[0]
    if (!fallback) return null
    this.browserHostByCanvas.set(sid, fallback)
    return fallback
  }

  /** Returns a strictly increasing timestamp (ms). When Date.now() collides with
   *  the previous value, increments by 1 to preserve event ordering. */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  private hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
        sessionId,
        commandHash,
        sourceRequestId: entry.sourceRequestId,
        expiresAt: entry.expiresAt,
      })
      return false
    }

    return true
  }

  private storeAdminRememberApproval(sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES)
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(this.getAdminRememberKey(sessionId, commandHash), {
      createdAt: now,
      expiresAt,
      sourceRequestId,
    })

    this.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
      sessionId,
      commandHash,
      sourceRequestId,
      rememberForMinutes: boundedMinutes,
      createdAt: now,
      expiresAt,
    })
  }

  private clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  private clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, metadata] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        if (metadata.type === 'admin_approval') {
          this.privilegedExecutionBroker.resolveApproval(requestId, false, {
            expectedCommandHash: metadata.commandHash,
          })
        }
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  /**
   * Apply external session header metadata to in-memory state and emit UI events.
   * Returns true if any in-memory metadata field changed.
   */
  private applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): boolean {
    const sessionId = managed.id
    // Defense in depth: the watcher currently reads normalized headers, but
    // reconciliation must remain atomic if another caller supplies one.
    header = normalizeSessionHeaderMemorySelection(header)
    let changed = false

    // Labels
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(header.labels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = header.labels
      this.sendEvent({ type: 'labels_changed', sessionId, labels: header.labels ?? [] }, managed.workspace.id)
      changed = true
    }

    // Flagged
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent(
        { type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId },
        managed.workspace.id
      )
      changed = true
    }

    // Pinned
    if ((managed.isPinned ?? false) !== (header.isPinned ?? false) || managed.pinnedAt !== header.pinnedAt) {
      managed.isPinned = header.isPinned ?? false
      managed.pinnedAt = header.pinnedAt
      this.sendEvent(
        { type: 'session_metadata_changed', sessionId, changes: { isPinned: managed.isPinned, pinnedAt: managed.pinnedAt } },
        managed.workspace.id
      )
      changed = true
    }

    // Session status
    if (managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' }, managed.workspace.id)
      changed = true
    }

    // Name
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id)
      changed = true
    }

    // Project binding (no dedicated event today — handled via metaChanged broadcast)
    if (managed.projectId !== header.projectId) {
      managed.projectId = header.projectId
      changed = true
    }

    // Custom chat group binding and manual order
    if (managed.customGroupId !== header.customGroupId || managed.customGroupOrder !== header.customGroupOrder) {
      managed.customGroupId = header.customGroupId
      managed.customGroupOrder = header.customGroupOrder
      this.sendEvent(
        { type: 'session_metadata_changed', sessionId, changes: { customGroupId: managed.customGroupId, customGroupOrder: managed.customGroupOrder } },
        managed.workspace.id,
      )
      changed = true
    }

    // Memory selection is one atomic persisted unit. Deletion/absence clears
    // all fields; cloned refs avoid aliasing watcher-owned header objects.
    const oldMemory = JSON.stringify({
      enabledMemorySpaceRefs: managed.enabledMemorySpaceRefs,
      memoryWriteTargetRef: managed.memoryWriteTargetRef,
      memorySelectionMode: managed.memorySelectionMode,
    })
    const nextMemory = {
      enabledMemorySpaceRefs: header.enabledMemorySpaceRefs?.map(ref => ({ ...ref })),
      memoryWriteTargetRef: header.memoryWriteTargetRef ? { ...header.memoryWriteTargetRef } : undefined,
      memorySelectionMode: header.memorySelectionMode,
    }
    if (oldMemory !== JSON.stringify(nextMemory)) {
      managed.enabledMemorySpaceRefs = nextMemory.enabledMemorySpaceRefs
      managed.memoryWriteTargetRef = nextMemory.memoryWriteTargetRef
      managed.memorySelectionMode = nextMemory.memorySelectionMode
      changed = true
    }

    // Kanban column (mutable via drag; reconcile external/multi-window changes)
    if (managed.kanbanColumn !== header.kanbanColumn) {
      managed.kanbanColumn = header.kanbanColumn
      changed = true
    }

    if (changed) {
      sessionLog.info(`External metadata change detected for session ${sessionId}`)

      // Prevent stale pending writes from reverting externally-updated metadata.
      sessionPersistenceQueue.cancel(sessionId)
      this.persistSession(managed)
    }

    return changed
  }

  /**
   * Set up ConfigWatcher for a workspace to broadcast live updates
   * (sources added/removed, guide.md changes, etc.)
   * Called eagerly at boot for all workspaces (automations/scheduler) and
   * on client connect (GET_WORKSPACE / SWITCH_WORKSPACE).
   * Idempotent — returns immediately if already watching.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    const existingLifecycle = this.workspaceLifecycles.get(workspaceId)
    if (existingLifecycle?.state === 'removing') {
      throw new WorkspaceAdmissionError(workspaceId, 'background')
    }
    const reattached = this.activateWorkspaceLifecycle(workspaceId)

    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange event via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(`[Automations] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onLabelSkillBindingsConfigChange: () => {
        sessionLog.info(`Label-skill bindings config changed in ${workspaceId}`)
        this.broadcastLabelSkillBindingsChanged(workspaceId)
      },
      onAutomationsConfigChange: () => {
        sessionLog.info(`Automations config changed in ${workspaceId}`)
        // Reload automations config via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`)
          } else {
            sessionLog.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors)
          }
        }
        // Notify renderer to re-read automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onLlmConnectionsChange: () => {
        sessionLog.info(`LLM connections changed in ${workspaceId}`)
        this.broadcastLlmConnectionsChanged()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onWatchStateChange: (state) => {
        const details = {
          event: state.status === 'degraded' ? 'config_watch_degraded' : 'config_watch_active',
          workspaceId,
          status: state.status,
          pathClass: state.pathClass,
          priority: state.priority,
          reason: state.reason,
          errorCode: state.errorCode,
        }
        if (state.status === 'degraded') sessionLog.warn('[config-watch] degraded', details)
        else sessionLog.info('[config-watch] active', details)
      },
      onWatchDiagnostic: (diagnostic) => {
        if (diagnostic.type !== 'degraded') return
        sessionLog.warn('[config-watch] diagnostic', {
          event: 'config_watch_diagnostic',
          workspaceId,
          type: diagnostic.type,
          pathClass: diagnostic.pathClass,
          priority: diagnostic.priority,
          reason: diagnostic.reason,
          errorCode: diagnostic.errorCode,
          activeDirectoryCount: diagnostic.activeDirectoryCount,
          capacity: diagnostic.capacity,
        })
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadAllSkills } = await import('@craft-agent/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to session.jsonl headers).
      // Detects changes from both internal writes (self) and external sources
      // (other instances, scripts, manual edits).
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // Check if this is our own write echoing back via fs.watch().
        // Self-writes don't need in-memory sync (already up to date), but
        // still need to notify the automation system for event matching.
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature = sessionPersistenceQueue.getLastWrittenSignature(sessionId)
        const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature)

        // For external writes: sync in-memory state + emit UI events.
        // Skip for self-writes to avoid feedback loops (especially on Windows
        // where fs.watch fires aggressively: unlink + rename = 2+ events).
        if (!isSelfWrite) {
          // Defer external metadata application when:
          // 1. Session is actively processing (agent running), OR
          // 2. Session was just written programmatically (set_session_status/labels tool)
          //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
          const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            // Always retain the latest header. Idle guard deferrals receive a
            // one-shot expiry timer; processing deferrals remain owned by
            // onProcessingStopped (the timer also checks processing state).
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              this.scheduleGuardedExternalMetadata(managed)
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`)
            } else {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (processing active)`)
            }
          } else {
            this.applyExternalSessionMetadata(managed, header)
          }
        }

        // Always notify automation system — it does its own diffing and needs
        // to see both self-writes and external changes for event matching.
        const automationSystem = this.automationSystems.get(managed.workspace.rootPath)
        if (automationSystem) {
          automationSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: header.labels,
            isFlagged: header.isFlagged,
            sessionStatus: header.sessionStatus,
            sessionName: header.name,
          }).catch((error) => {
            sessionLog.error(`[Automations] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    try {
      watcher.start()
    } catch (error) {
      if (error instanceof Error && error.name === 'WatchCapacityError') {
        ;(error as Error & { code: string }).code = 'required-watch-budget'
      }
      throw error
    }
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: async (prompts) => {
          const releaseAutomationAdmission = this.acquireWorkspaceAdmission(workspaceId, 'automation')
          try {
          // Execute prompt automations by creating new sessions
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptAutomation({
                workspaceId,
                workspaceRootPath,
                prompt: pending.prompt,
                labels: pending.labels,
                permissionMode: pending.permissionMode,
                mentions: pending.mentions,
                llmConnection: pending.llmConnection,
                model: pending.model,
                thinkingLevel: pending.thinkingLevel,
                automationName: pending.automationName,
                telegramTopic: pending.telegramTopic,
              })
            )
          )

          // Write enriched history entries (with session IDs and prompt summaries)
          for (const [idx, result] of settled.entries()) {
            const pending = prompts[idx]
            if (!pending.matcherId) continue

            const entry = createPromptHistoryEntry({
              matcherId: pending.matcherId,
              ok: result.status === 'fulfilled',
              sessionId: result.status === 'fulfilled' ? result.value.sessionId : undefined,
              prompt: pending.prompt,
              error: result.status === 'rejected' ? String(result.reason) : undefined,
            })

            await appendAutomationHistoryEntry(workspaceRootPath, entry).catch(e => sessionLog.warn('[Automations] Failed to write history:', e))

            if (result.status === 'rejected') {
              sessionLog.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, result.reason)
            } else {
              sessionLog.info(`[Automations] Created session ${result.value.sessionId} from prompt action`)
            }
          }
          } finally {
            releaseAutomationAdmission()
          }
        },
        onError: (event, error) => {
          sessionLog.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      sessionLog.info(`Initialized AutomationSystem for workspace ${workspaceId}`)
    }

    if (reattached) {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (workspace) {
        const loaded = this.loadWorkspaceSessionsFromDisk(workspace)
        sessionLog.info(`[workspace-detach] reattached clean workspace ownership`, { workspaceId, loadedSessions: loaded })
        void this.workspaceReattachedHandler?.(workspaceId).catch((error) => {
          sessionLog.error('[workspace-detach] external workspace reattach failed', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
    }
  }

  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  private resolveLabelSkillAnchorsForSession(managed: ManagedSession): LabelSkillAnchorResolution | null {
    try {
      const skills = listSkillSummaries(
        managed.workspace.rootPath,
        managed.workingDirectory,
      ) as SkillSummary[]
      const labels = listLabelsFlat(managed.workspace.rootPath)
      const validation = loadAndValidateLabelSkillBindingsConfig(managed.workspace.rootPath, {
        labels,
        skills,
        workspaceSlug: managed.workspace.id,
      })
      if (!validation.valid) {
        sessionLog.warn(`Label-skill bindings invalid for workspace ${managed.workspace.id}: ${validation.errors.map(e => e.message).join('; ')}`)
        // Invalid or unreadable binding config must supersede any previously
        // injected compact instructions. Resolve against an empty canonical config
        // so sessions with prior active bindings emit a revocation block instead
        // of leaving stale label-skill anchors authoritative.
        const fallback = resolveActiveLabelSkillAnchors(getDefaultLabelSkillBindingsConfig(), {
          sessionLabels: managed.labels ?? [],
          labels,
          skills,
          workspaceSlug: managed.workspace.id,
          previousState: managed.labelSkillAnchorState,
        })
        return fallback
      }
      const resolution = resolveActiveLabelSkillAnchors(validation.config, {
        sessionLabels: managed.labels ?? [],
        labels,
        skills,
        workspaceSlug: managed.workspace.id,
        previousState: managed.labelSkillAnchorState,
      })
      for (const warning of [...validation.warnings, ...resolution.warnings]) {
        sessionLog.warn(`Label-skill binding warning${warning.bindingId ? ` (${warning.bindingId})` : ''}: ${warning.message}`)
      }
      return resolution
    } catch (error) {
      sessionLog.warn(`Failed to resolve label-skill bindings for session ${managed.id}:`, error)
      try {
        return resolveActiveLabelSkillAnchors(getDefaultLabelSkillBindingsConfig(), {
          sessionLabels: managed.labels ?? [],
          labels: listLabelsFlat(managed.workspace.rootPath),
          skills: [],
          workspaceSlug: managed.workspace.id,
          previousState: managed.labelSkillAnchorState,
        })
      } catch {
        return null
      }
    }
  }

  private persistLabelSkillAnchorState(managed: ManagedSession, resolution: LabelSkillAnchorResolution | null): void {
    if (!resolution) return
    const prev = JSON.stringify(managed.labelSkillAnchorState ?? null)
    const next = JSON.stringify(resolution.nextState ?? null)
    if (prev === next) return
    managed.labelSkillAnchorState = resolution.nextState
    this.persistSession(managed)
  }

  private advanceLabelSkillContextEpochAfterCompaction(managed: ManagedSession): void {
    const previousState = managed.labelSkillAnchorState ?? {}
    const currentEpoch = normalizeLabelSkillContextEpoch(previousState.contextEpoch)
    const nextState: LabelSkillAnchorState = {
      ...previousState,
      contextEpoch: currentEpoch + 1,
    }
    const prev = JSON.stringify(managed.labelSkillAnchorState ?? null)
    const next = JSON.stringify(nextState)
    if (prev === next) return
    managed.labelSkillAnchorState = nextState
    this.persistSession(managed)
  }

  private getUnpreparedLabelSkillSourceSlugs(managed: ManagedSession, resolution: LabelSkillAnchorResolution | null): string[] {
    const required = resolution?.requiredSourceSlugs ?? []
    if (required.length === 0) return []

    const enabledSlugs = new Set(managed.enabledSourceSlugs ?? [])
    const liveSlugs = new Set(managed.agent?.getActiveSourceSlugs() ?? [])
    return required.filter(slug => !enabledSlugs.has(slug) || !liveSlugs.has(slug))
  }

  private buildLabelSkillBootstrapEntriesForSession(
    managed: ManagedSession,
    resolution: LabelSkillAnchorResolution | null,
    args: {
      messagesBeforeModelCall: Message[]
      isQueuedReplay: boolean
      explicitSkillSlugs: string[]
    },
  ): { entries: LabelSkillBootstrapChatEntry[]; overflowBindingIds: string[]; selection: LabelSkillBootstrapCandidateSelection } | null {
    if (!resolution || resolution.blockKind !== 'active') return null
    const selection = selectLabelSkillBootstrapCandidates({
      activeAnchors: resolution.activeAnchors,
      configHash: resolution.configHash,
      previousState: managed.labelSkillAnchorState,
      contextEpoch: normalizeLabelSkillContextEpoch(managed.labelSkillAnchorState?.contextEpoch),
      messagesBeforeModelCall: args.messagesBeforeModelCall,
      explicitSkillSlugs: args.explicitSkillSlugs,
      isQueuedReplay: args.isQueuedReplay,
    })
    if (!selection.eligible || selection.anchors.length === 0) return { entries: [], overflowBindingIds: [], selection }

    const entries: LabelSkillBootstrapChatEntry[] = []
    const missingPaths: string[] = []
    for (const anchor of selection.anchors) {
      const skillPath = resolveSkillFilePathBySlug(managed.workspace.rootPath, anchor.skillSlug, managed.workingDirectory)
      if (!skillPath) {
        missingPaths.push(anchor.skillSlug)
        continue
      }
      entries.push({
        bindingId: anchor.bindingId,
        labelId: anchor.labelId,
        skillSlug: anchor.skillSlug,
        skillPath,
      })
    }

    if (missingPaths.length > 0) {
      const reason = `Unable to resolve SKILL.md path for label-bound bootstrap skill(s): ${missingPaths.join(', ')}`
      sessionLog.warn(reason)
      this.markLabelSkillBootstrapFailure(managed, selection.anchors.map(anchor => ({
        bindingId: anchor.bindingId,
        labelId: anchor.labelId,
        skillSlug: anchor.skillSlug,
      })), resolution.configHash, reason)
    }

    return {
      entries,
      overflowBindingIds: selection.overflowAnchors.map(anchor => anchor.bindingId),
      selection,
    }
  }

  private markLabelSkillBootstrapAttempted(
    managed: ManagedSession,
    entries: LabelSkillBootstrapChatEntry[],
    configHash: string,
  ): void {
    if (entries.length === 0) return
    const now = new Date().toISOString()
    this.updateLabelSkillBootstrapState(managed, configHash, now, draft => {
      for (const entry of entries) {
        const existing = draft.entries.get(entry.bindingId)
        draft.entries.set(entry.bindingId, {
          bindingId: entry.bindingId,
          labelId: entry.labelId,
          skillSlug: entry.skillSlug,
          status: existing?.status === 'completed' ? 'completed' : 'attempted',
          attemptedAt: now,
          completedAt: existing?.completedAt,
        })
      }
      draft.lastFailureReason = undefined
    })
  }

  private markLabelSkillBootstrapCompleted(
    managed: ManagedSession,
    event: LabelSkillBootstrapRegisteredEvent,
  ): void {
    if (event.bindingIds.length === 0) return
    this.updateLabelSkillBootstrapState(managed, event.configHash, event.registeredAt, draft => {
      for (const bindingId of event.bindingIds) {
        const existing = draft.entries.get(bindingId)
        if (!existing) continue
        draft.entries.set(bindingId, {
          ...existing,
          status: 'completed',
          completedAt: event.registeredAt,
          lastFailureReason: undefined,
        })
      }
      for (const slug of event.skillSlugs) draft.bootstrappedSkillSlugs.add(slug)
      draft.lastFailureReason = undefined
    })
  }

  private markLabelSkillBootstrapFailure(
    managed: ManagedSession,
    entries: Array<{ bindingId: string; labelId?: string; skillSlug: string }>,
    configHash: string,
    reason: string,
  ): void {
    if (entries.length === 0) return
    const now = new Date().toISOString()
    this.updateLabelSkillBootstrapState(managed, configHash, now, draft => {
      let updated = false
      for (const entry of entries) {
        const existing = draft.entries.get(entry.bindingId)
        if (existing?.status === 'completed') continue
        draft.entries.set(entry.bindingId, {
          bindingId: entry.bindingId,
          labelId: entry.labelId ?? existing?.labelId,
          skillSlug: entry.skillSlug,
          status: existing?.status ?? 'attempted',
          attemptedAt: existing?.attemptedAt ?? now,
          completedAt: existing?.completedAt,
          lastFailureReason: reason,
        })
        updated = true
      }
      if (updated) draft.lastFailureReason = reason
    })
  }

  private updateLabelSkillBootstrapState(
    managed: ManagedSession,
    configHash: string,
    updatedAt: string,
    mutate: (draft: {
      entries: Map<string, LabelSkillBootstrapStateEntry>
      bootstrappedSkillSlugs: Set<string>
      lastFailureReason?: string
    }) => void,
  ): void {
    const previousState = managed.labelSkillAnchorState ?? {}
    const contextEpoch = normalizeLabelSkillContextEpoch(previousState.contextEpoch)
    const previousBootstrap = previousState.bootstrap?.configHash === configHash && normalizeLabelSkillContextEpoch(previousState.bootstrap.contextEpoch) === contextEpoch
      ? previousState.bootstrap
      : undefined
    const draft = {
      entries: new Map((previousBootstrap?.entries ?? []).map(entry => [entry.bindingId, entry] as const)),
      bootstrappedSkillSlugs: new Set(previousBootstrap?.bootstrappedSkillSlugs ?? []),
      lastFailureReason: previousBootstrap?.lastFailureReason,
    }
    mutate(draft)
    const nextState: LabelSkillAnchorState = {
      ...previousState,
      contextEpoch,
      lastConfigHash: previousState.lastConfigHash ?? configHash,
      bootstrap: {
        configHash,
        contextEpoch,
        entries: Array.from(draft.entries.values()).sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
        bootstrappedSkillSlugs: Array.from(draft.bootstrappedSkillSlugs).sort(),
        updatedAt,
        lastFailureReason: draft.lastFailureReason,
      },
    }
    const prev = JSON.stringify(managed.labelSkillAnchorState ?? null)
    const next = JSON.stringify(nextState)
    if (prev === next) return
    managed.labelSkillAnchorState = nextState
    this.persistSession(managed)
  }

  /**
   * Reload sources for all sessions in a workspace, skipping those currently processing.
   */
  private async reloadSourcesForWorkspace(workspaceRootPath: string): Promise<void> {
    for (const [_, managed] of this.sessions) {
      if (managed.workspace.rootPath === workspaceRootPath) {
        if (managed.isProcessing) {
          sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
          continue
        }
        await this.reloadSessionSources(managed)
      }
    }
  }

  private broadcastSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    if (!this.eventSink) return
    this.eventSink(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
  }

  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastLabelSkillBindingsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting label-skill bindings changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.labelSkillBindings.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAutomationsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAppThemeChanged(theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastLlmConnectionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting LLM connections changed')
    this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
  }

  private broadcastSkillsChanged(workspaceId: string, skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  private broadcastDefaultPermissionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting default permissions changed')
    this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return  // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    // Update bridge-mcp-server config/credentials for backends that need it
    await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source reload', managed.poolServer?.url)

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: These env vars are propagated to the SDK subprocess via options.ts.
   * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
   * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
   * OAuth auth — Claude Code prioritizes API key over OAuth token when both are set.
   * See: https://github.com/lukilabs/craft-agents-oss/issues/39
   */
  /**
   * Reinitialize authentication environment variables.
   *
   * Uses the default LLM connection to determine which credentials to set.
   *
   * @param connectionSlug - Optional connection slug to use (overrides default)
   */
  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    try {
      const manager = getCredentialManager()

      // Get the connection to use (explicit parameter or default)
      const slug = connectionSlug || getDefaultLlmConnection()
      if (!slug) {
        sessionLog.warn('No LLM connection slug available for reinitializeAuth')
      }
      const connection = slug ? getLlmConnection(slug) : null

      // Restore managed auth env vars to their baseline before applying this connection.
      resetManagedAnthropicAuthEnvVars()

      if (!connection) {
        sessionLog.error(`No LLM connection found for slug: ${slug}`)
        resetSummarizationClient()
        return
      }

      sessionLog.info(`Reinitializing auth for connection: ${slug} (${connection.authType})`)

      // Resolve auth env vars via shared utility (provider-agnostic)
      const result = await resolveAuthEnvVars(connection, slug!, manager, getValidClaudeOAuthToken)

      if (!result.success) {
        sessionLog.error(`Auth resolution failed for ${slug}: ${result.warning}`)
      } else {
        // Apply resolved env vars to process.env
        for (const [key, value] of Object.entries(result.envVars)) {
          process.env[key] = value
        }
        sessionLog.info(`Auth env vars set for connection: ${slug}`)
      }

      // Reset cached summarization client so it picks up new credentials/base URL
      resetSummarizationClient()
    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async initialize(): Promise<void> {
    try {
      // Backfill missing `models` arrays on existing LLM connections
      migrateLegacyLlmConnectionsConfig()

      // Fix defaultLlmConnection if it points to a non-existent connection
      migrateOrphanedDefaultConnections()

      // Migrate legacy credentials to LLM connection format (one-time migration)
      // This ensures credentials saved before LLM connections are available via the new system
      await migrateLegacyCredentials()

      // Set up authentication environment variables (critical for SDK to work)
      await this.reinitializeAuth()

      // Eagerly activate ConfigWatcher + AutomationSystem for every workspace so
      // the scheduler and event handlers start at boot — not lazily on first
      // client connect. This is critical for headless servers where no UI may
      // ever connect, yet scheduled/event-driven automations must still fire.
      const workspaces = getWorkspaces()
      for (const workspace of workspaces) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
      }

      // Load existing sessions from disk
      this.loadSessionsFromDisk()
      this.startIdleReaper()

      // Signal that initialization is complete — IPC handlers waiting on initGate will proceed
      this.initGate.markReady()
    } catch (error) {
      this.initGate.markFailed(error)
      throw error
    }
  }

  private loadWorkspaceSessionsFromDisk(workspace: Workspace): number {
    const workspaceRootPath = workspace.rootPath
    const sessionMetadata = listStoredSessions(workspaceRootPath)
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory
    let loaded = 0

    for (const meta of sessionMetadata) {
      if (this.sessions.has(meta.id)) continue
      const managed = createManagedSession(meta, workspace, {
        enabledSourceSlugs: meta.enabledSourceSlugs,
        workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
      })

      if (managed.llmConnection) {
        const conn = resolveSessionConnection(managed.llmConnection, undefined)
        if (!conn) {
          sessionLog.warn(`Session ${meta.id} has orphaned llmConnection "${managed.llmConnection}", clearing`)
          managed.llmConnection = undefined
          managed.connectionLocked = false
        }
      }

      setPermissionMode(meta.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(meta.id, managed.previousPermissionMode)
      }

      this.sessions.set(meta.id, managed)
      const header = readSessionHeader(getSessionFilePath(workspaceRootPath, meta.id))
      if (header) sessionPersistenceQueue.initializeBaseline(meta.id, header)

      const automationSystem = this.automationSystems.get(workspaceRootPath)
      if (automationSystem) {
        automationSystem.setInitialSessionMetadata(meta.id, {
          permissionMode: meta.permissionMode,
          labels: meta.labels,
          isFlagged: meta.isFlagged,
          sessionStatus: meta.sessionStatus,
          sessionName: managed.name,
        })
      }
      loaded += 1
    }
    return loaded
  }

  // Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
  private loadSessionsFromDisk(): void {
    try {
      let totalSessions = 0
      for (const workspace of getWorkspaces()) {
        totalSessions += this.loadWorkspaceSessionsFromDisk(workspace)
      }
      sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`)
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  // Suppress fs.watch metadata-revert events for the window in which our own
  // atomic write completes. See onSessionMetadataChange.
  private setMetadataWriteGuard(managed: ManagedSession): void {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS
    if (managed.pendingExternalMetadata && !managed.isProcessing) {
      this.scheduleGuardedExternalMetadata(managed)
    }
  }

  private clearExternalMetadataGuardTimer(sessionId: string): void {
    const timer = this.externalMetadataGuardTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.externalMetadataGuardTimers.delete(sessionId)
  }

  private scheduleGuardedExternalMetadata(managed: ManagedSession): void {
    const sessionId = managed.id
    this.clearExternalMetadataGuardTimer(sessionId)
    const guardUntil = managed._metadataWriteGuardUntil ?? Date.now()
    const delay = Math.max(0, guardUntil - Date.now()) + 1
    const timer = setTimeout(() => {
      this.externalMetadataGuardTimers.delete(sessionId)
      const current = this.sessions.get(sessionId)
      if (current !== managed) return
      // Processing-stop owns application in this case; keep the latest header.
      if (current.isProcessing) return
      const pendingHeader = current.pendingExternalMetadata
      current.pendingExternalMetadata = undefined
      current._metadataWriteGuardUntil = undefined
      if (!pendingHeader) return
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after write guard expiry`)
      this.applyExternalSessionMetadata(current, pendingHeader)
    }, delay)
    this.externalMetadataGuardTimers.set(sessionId, timer)
  }

  /**
   * Persist a session to disk (async, with debouncing in the persistence queue).
   *
   * Cold-session path: if messages haven't been lazy-loaded yet, hydrate them
   * synchronously from the JSONL first — otherwise the snapshot we enqueue
   * would write `messages: []` over the real messages on disk. Hydration
   * deliberately does NOT touch persistent metadata fields (name, labels,
   * sessionStatus, llmConnection, ...) because the caller may have just
   * mutated them; the in-memory mutation must win over what's on disk.
   * `loadStoredSession` is synchronous (sync fs reads), so the entire path
   * stays sync — no microtask race window between the load and the enqueue.
   */
  private persistSession(managed: ManagedSession): void {
    if (!managed.messagesLoaded) {
      this.hydrateMessagesForColdPersist(managed)
    }
    this.enqueuePersist(managed)
  }

  // Cold-persist hydration. Mirrors the messages/queue-recovery half of
  // loadMessagesFromDisk but skips the metadata field syncs. Sets
  // messagesLoaded=true so subsequent persistSession calls take the fast path.
  // Subsequent ensureMessagesLoaded calls also short-circuit, which is fine —
  // queue recovery has already run here.
  private hydrateMessagesForColdPersist(managed: ManagedSession): void {
    sessionLog.debug(`Cold-load triggered for persistSession on ${managed.id}`)
    const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (stored) {
      managed.messages = (stored.messages || []).map(storedToMessage)
      managed.tokenUsage = stored.tokenUsage
      // Deferred-load fields (intentionally undefined after startup, see
      // loadSessionsFromDisk). Populate from disk only if not already set in
      // memory — a caller may have mutated them via setSessionSources etc.
      if (managed.enabledSourceSlugs === undefined) managed.enabledSourceSlugs = stored.enabledSourceSlugs
      if (managed.lastReadMessageId === undefined) managed.lastReadMessageId = stored.lastReadMessageId
      if (managed.hasUnread === undefined) managed.hasUnread = stored.hasUnread
      if (managed.sharedUrl === undefined) managed.sharedUrl = stored.sharedUrl
      if (managed.sharedId === undefined) managed.sharedId = stored.sharedId
      if (managed.transferredSessionSummary === undefined) managed.transferredSessionSummary = stored.transferredSessionSummary
      if (managed.transferredSessionSummaryApplied === undefined) managed.transferredSessionSummaryApplied = stored.transferredSessionSummaryApplied

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them.
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,
            storedAttachments: msg.attachments,
            options: undefined,
          })
        }
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
      sessionLog.debug(`Cold-hydrated ${managed.messages.length} messages for session ${managed.id}`)
    }
    managed.messagesLoaded = true
  }

  // Build the StoredSession snapshot and hand it to the persistence queue.
  // Caller must ensure `managed.messagesLoaded` is true.
  private enqueuePersist(managed: ManagedSession): void {
    try {
      // Filter out transient status messages (progress indicators like "Compacting...")
      // Error messages are now persisted with rich fields for diagnostics
      const persistableMessages = managed.messages.filter(m =>
        m.role !== 'status'
      )

      const storedSession: StoredSession = {
        ...pickSessionFields(managed),
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession

      // Queue for async persistence with debouncing
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
  }

  // Flush a specific session immediately (call on session close/switch).
  // Cold-persist hydration is synchronous, so by the time we reach here the
  // queue already has an entry whenever persistSession was just called.
  async flushSession(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  // Flush all pending sessions (call on app quit).
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  beginTerminalShutdown(): void {
    this.closing = true
  }

  async cancelAllProcessingForShutdown(
    options?: { deadline?: number; graceMs?: number },
  ): Promise<ShutdownCancellationResult> {
    // Fence every new session/turn synchronously before the first await. Deferred
    // automation and queued replay paths also observe `closing`.
    this.beginTerminalShutdown()

    const deadline = options?.deadline ?? (Date.now() + this.runtimeLifecycleConfig.shutdownTimeoutMs)
    const graceMs = Math.max(0, options?.graceMs ?? 5_000)
    const targets = [...this.sessions.values()]
      .filter(managed => managed.isProcessing)
      .map(managed => ({
        managed,
        turn: managed.activeTurn,
        generation: managed.runtimeGeneration,
      }))

    const result: ShutdownCancellationResult = {
      targeted: targets.length,
      cancelled: 0,
      forced: 0,
      failures: [],
    }

    const waitUntil = async (promise: Promise<unknown>, until: number): Promise<boolean> => {
      const remaining = Math.max(0, until - Date.now())
      if (remaining === 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise.then(() => true, () => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), remaining)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    await Promise.all(targets.map(async ({ managed, turn, generation }) => {
      let cancellationError: unknown
      try {
        await this.cancelProcessing(managed.id)
      } catch (error) {
        cancellationError = error
        sessionLog.warn(`UserStop signal failed during shutdown for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }

      // The ordinary stop path has a detached five-second backstop. Terminal
      // shutdown owns an awaited exact-generation fallback instead.
      if (managed.stopTimer) {
        clearTimeout(managed.stopTimer)
        managed.stopTimer = undefined
      }

      const gracefulDeadline = Math.min(deadline, Date.now() + graceMs)
      while (managed.isProcessing && Date.now() < gracefulDeadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(25, gracefulDeadline - Date.now())))
      }

      let forced = false
      if (managed.isProcessing) {
        forced = true
        result.forced++
        sessionLog.warn(`Shutdown cancellation grace expired for ${managed.id}; forcing exact runtime cleanup`)
      }

      const terminal = managed.isProcessing
        ? this.onProcessingStopped(managed.id, 'timeout', turn)
        : (turn?.terminalPromise ?? Promise.resolve())
      const retirement = generation
        ? this.disposeManagedAgentRuntime(managed, 'manual', generation, deadline)
        : Promise.resolve()
      const lifecycle = Promise.allSettled([terminal, retirement])
      const retired = await waitUntil(lifecycle, deadline)
      const rejected = retired
        ? (await lifecycle).find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
        : undefined

      if (!retired) {
        result.failures.push({ sessionId: managed.id, error: 'Runtime retirement timed out' })
      } else if (rejected) {
        result.failures.push({
          sessionId: managed.id,
          error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        })
      } else if (managed.isProcessing) {
        result.failures.push({ sessionId: managed.id, error: 'Session remained processing after forced cancellation' })
      } else {
        result.cancelled++
      }

      if (cancellationError && !forced && !result.failures.some(entry => entry.sessionId === managed.id)) {
        result.failures.push({
          sessionId: managed.id,
          error: cancellationError instanceof Error ? cancellationError.message : String(cancellationError),
        })
      }
    }))

    sessionLog.info('Shutdown active-turn cancellation complete', result)
    return result
  }

  // ============================================
  // Unified Auth Request Helpers
  // ============================================

  /**
   * Get human-readable description for auth request
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }


  /**
   * Complete an auth request and send result back to agent
   * This updates the auth message status and sends a faked user message
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(m =>
      m.role === 'auth-request' &&
      m.authRequestId === result.requestId &&
      m.authStatus === 'pending'
    )

    if (authMessage) {
      authMessage.authStatus = result.success ? 'completed' :
                               result.cancelled ? 'cancelled' : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // Emit auth_completed event to update UI
    this.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    }, managed.workspace.id)

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        sessionLog.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`)
      }

      // Clear any refresh cooldown so the source is immediately usable
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // Persist session with updated auth message and enabled sources
    this.persistSession(managed)

    // Update bridge-mcp-server config/credentials for backends that need it
    if (result.success && result.sourceSlug && managed.agent) {
      const workspaceRootPath = managed.workspace.rootPath
      const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(workspaceRootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )
      const { mcpServers } = await buildServersFromSources(
        enabledSources, sessionPath, managed.tokenRefreshManager
      )
      await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source auth', managed.poolServer?.url)
    }

    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    await this.sendMessage(sessionId, resultContent, [], [], {})

    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth)
   * Called when user submits credentials via the inline form
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const credManager = getCredentialManager()
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify(response.headers) }
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath, createdAt, ...info }) => info)
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem) return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // SchedulerService is running if the system was created with enableScheduler
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  /**
   * Reload all sessions from disk.
   * Used after importing sessions to refresh the in-memory session list.
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(this.sessions.values())

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => managedToSession(m))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  /**
   * Aggregate unread state across all workspaces.
   * Excludes hidden and archived sessions from counts/indicators.
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
    }
  }

  /**
   * Refresh badge count from current unread state.
   * Called by renderer on mount — ensures badge is set even if the initial
   * emitUnreadSummaryChanged() fired before the renderer was ready.
   */
  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)
  }

  /**
   * Broadcast global unread summary to all workspace windows.
   */
  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()

    // Update badge via runtime hook — host decides whether/how to render badges
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)

    if (!this.eventSink) return

    // Broadcast to renderers for UI updates (session list dots, etc.)
    this.eventSink(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED, { to: 'all' }, summary)
  }

  /**
   * Get a single session by ID with all messages loaded.
   * Used for lazy loading session messages when session is selected.
   * Messages are loaded from disk on first access to reduce memory usage.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // Lazy-load messages from disk if not yet loaded
    await this.ensureMessagesLoaded(m)

    return managedToSession(m, { messages: m.messages })
  }

  /**
   * Ensure messages are loaded for a managed session.
   * Uses promise deduplication to prevent race conditions when multiple
   * concurrent calls (e.g., rapid session switches + message send) try
   * to load messages simultaneously.
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * Internal: Load messages from disk storage into the managed session.
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // Explicit unread flag for NEW badge state machine
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      // Sync name from disk - ensures title persistence across lazy loading
      managed.name = storedSession.name
      // Restore LLM connection state - ensures correct provider on resume
      if (storedSession.llmConnection) {
        managed.llmConnection = storedSession.llmConnection
      }
      if (storedSession.connectionLocked) {
        managed.connectionLocked = storedSession.connectionLocked
      }
      // Sync transferred session summary state from disk
      managed.transferredSessionSummary = storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied
      sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,  // Attachments already stored on disk
            storedAttachments: msg.attachments,
            options: undefined,
          })
        }
        // Process queue when session becomes active (will be triggered by first message or interaction)
        // Use setImmediate to avoid blocking the load and allow session state to settle
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
    }
    managed.messagesLoaded = true
  }

  /**
   * Get the filesystem path to a session's folder
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  getSessionWorkspaceId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workspace.id
  }

  async createSession(
    workspaceId: string,
    options?: import('@craft-agent/shared/protocol').CreateSessionOptions,
    // Transport concern, deliberately NOT on the wire DTO: by default every created session is
    // announced to the renderer (see notifySessionCreated). Callers that register the session
    // themselves — the `sessions:create` RPC adds it from the return value — pass
    // `{ emitCreatedEvent: false }` to avoid a redundant hydrate.
    internal?: {
      emitCreatedEvent?: boolean
      initialTransferredSessionSummary?: string
    },
  ): Promise<Session> {
    const releaseAdmission = this.acquireWorkspaceAdmission(workspaceId, 'session')
    try {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // Get new session defaults from workspace config (with global fallback)
    // Options.permissionMode overrides the workspace default (used by EditPopover for auto-execute)
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const globalDefaults = loadConfigDefaults()

    // Read permission mode from workspace config, fallback to global defaults
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel)
      ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
      ?? getDefaultThinkingLevel()
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // Resolve model tier hints ('fast' / 'default') to actual model IDs.
    // EditPopover uses tier hints instead of hardcoded Anthropic model names
    // so the right model is selected regardless of the active LLM provider.
    const workspaceResolvedConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(
      workspaceRootPath,
      options?.llmConnection,
      wsConfig?.defaults?.defaultLlmConnection,
    )

    let resolvedModelOption = options?.model || defaultModel
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierConnection = resolveSessionConnection(
        workspaceResolvedConnectionSlug,
        undefined,
      )
      if (tierConnection) {
        resolvedModelOption = resolvedModelOption === 'fast'
          ? (getMiniModel(tierConnection) ?? tierConnection.defaultModel ?? defaultModel)
          : (tierConnection.defaultModel ?? defaultModel)
      } else {
        resolvedModelOption = defaultModel
      }
    }

    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
      sessionConnectionSlug: workspaceResolvedConnectionSlug,
      workspaceDefaultConnectionSlug: undefined,
      managedModel: resolvedModelOption,
    })
    const targetProviderType = targetBackendContext.connection?.providerType
      ?? (targetBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
    const targetPiAuthProvider = targetBackendContext.connection?.piAuthProvider

    // Resolve working directory from options:
    // - 'user_default' or undefined: Use workspace's configured default
    // - 'none': No working directory (empty string means session folder only)
    // - Absolute path: Use as-is
    let resolvedWorkingDir: string | undefined
    if (options?.workingDirectory === 'none') {
      resolvedWorkingDir = undefined  // No working directory
    } else if (options?.workingDirectory === 'user_default' || options?.workingDirectory === undefined) {
      resolvedWorkingDir = userDefaultWorkingDir
    } else {
      resolvedWorkingDir = options.workingDirectory
    }

    // Resolve project binding. When a projectId is provided and the project has a
    // workingDirectory configured, inherit it (only when the caller didn't pass an
    // explicit override). This lets "+ New session in {project}" reuse the project's
    // bound directory without duplicating logic on the renderer side.
    // Subtasks inherit the parent's project when the caller didn't bind one explicitly —
    // a child of a project-bound task belongs to that project (board quick-add passes none),
    // so project-scoped filtering sees the whole task family.
    const inheritedProjectId = options?.parentSessionId
      ? this.sessions.get(options.parentSessionId)?.projectId
      : undefined
    const requestedProjectId = options?.projectId ?? inheritedProjectId
    let resolvedProjectId: string | undefined
    if (requestedProjectId) {
      const { loadProjectById } = await import('@craft-agent/shared/projects')
      const project = loadProjectById(workspaceRootPath, requestedProjectId)
      if (!project) {
        // An EXPLICIT binding to a missing project is a caller bug; an inherited one
        // (parent's project deleted since) just no-ops rather than failing the child.
        if (options?.projectId) {
          throw new Error(`Project ${options.projectId} not found in workspace ${workspaceId}`)
        }
      } else {
        resolvedProjectId = project.config.id
        if (
          (options?.workingDirectory === undefined || options?.workingDirectory === 'user_default') &&
          project.config.workingDirectory
        ) {
          resolvedWorkingDir = project.config.workingDirectory
        }
      }
    }

    // Validate branch request up-front so branch metadata is only set for valid branches.
    // This prevents creating sessions that claim to be branched but don't have copied history.
    let validatedBranch: {
      sourceSessionId: string
      sourceMessageId: string
      sourceSession: StoredSession
      branchIdx: number
      branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session'
      branchFromSdkSessionId?: string
      branchFromSessionPath?: string
      branchFromSdkCwd?: string
      branchFromSdkTurnId?: string
      sourceProvider?: 'anthropic' | 'pi'
    } | undefined

    if (options?.branchFromSessionId || options?.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        sessionLog.warn('Branch validation failed: missing branchFromSessionId or branchFromMessageId', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged) {
        if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
          sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
            workspaceId,
            targetWorkspaceRootPath: workspaceRootPath,
            sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
            branchFromSessionId: options.branchFromSessionId,
          })
          throw new Error('Invalid branch request: source session belongs to a different workspace')
        }

        // Flush source session to disk to ensure latest message list is available for branch copy.
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(workspaceRootPath, options.branchFromSessionId)
      if (!sourceSession) {
        sessionLog.warn('Branch validation failed: source session not found on disk', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
        })
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }

      const sourceResolvedConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(
        workspaceRootPath,
        sourceManaged?.llmConnection || sourceSession.llmConnection,
        wsConfig?.defaults?.defaultLlmConnection,
      )
      const sourceBackendContext = resolveBackendContext({
        sessionConnectionSlug: sourceResolvedConnectionSlug,
        workspaceDefaultConnectionSlug: undefined,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType = sourceBackendContext.connection?.providerType
        ?? (sourceBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
      const sourcePiAuthProvider = sourceBackendContext.connection?.piAuthProvider

      const providerMismatch = sourceBackendContext.provider !== targetBackendContext.provider
      const providerTypeMismatch = sourceProviderType !== targetProviderType
      const piAuthProviderMismatch =
        sourceBackendContext.provider === 'pi' && sourcePiAuthProvider !== targetPiAuthProvider

      if (providerMismatch || providerTypeMismatch || piAuthProviderMismatch) {
        sessionLog.warn('Branch validation failed: source and target providers are incompatible', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          sourceProviderType,
          sourcePiAuthProvider,
          targetProvider: targetBackendContext.provider,
          targetProviderType,
          targetPiAuthProvider,
        })
        throw new Error('Branching is only supported within the same provider/backend. Switch this panel connection and try again.')
      }

      const branchIdx = sourceSession.messages.findIndex(m => m.id === options.branchFromMessageId)
      if (branchIdx === -1) {
        sessionLog.warn('Branch validation failed: message not found in source session', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }

      // New branches always use strict provider-level SDK fork semantics.
      // Seeded mode remains only for legacy sessions created before strict fork was enforced.
      const branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session' = 'sdk-fork'

      const branchFromSdkSessionId = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkSessionId || sourceSession.sdkSessionId)
        : undefined
      const branchFromSessionPath = branchContextStrategy === 'sdk-fork'
        ? getSessionStoragePath(workspaceRootPath, options.branchFromSessionId)
        : undefined
      // Capture parent's sdkCwd so the child SDK subprocess can find the parent's
      // session file (stored under ~/.claude/projects/{cwd-hash}/).
      const branchFromSdkCwd = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkCwd || sourceSession.sdkCwd)
        : undefined

      // Provider-native branch anchor at branch point.
      // - Claude: assistant message UUID (resumeSessionAt), but only when anchor lineage
      //   matches the parent SDK session being resumed.
      // - Pi: session entry ID loaded from sidecar (pi-turn-anchors.json)
      const branchMessage = sourceSession.messages[branchIdx]
      let branchFromSdkTurnId: string | undefined
      if (branchContextStrategy === 'sdk-fork') {
        if (sourceBackendContext.provider === 'pi') {
          if (branchFromSessionPath) {
            branchFromSdkTurnId = await getPiTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!branchFromSdkTurnId) {
              sessionLog.warn('Pi branch anchor missing: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            }
          }
        } else if (sourceBackendContext.provider === 'anthropic') {
          if (branchFromSessionPath && branchFromSdkSessionId) {
            const anchor = await getClaudeTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!anchor) {
              sessionLog.warn('Claude branch anchor missing: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            } else if (!anchor.sdkMessageUuid || !isClaudeMessageUuid(anchor.sdkMessageUuid)) {
              sessionLog.warn('Claude branch anchor malformed: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
              })
            } else if (anchor.sdkSessionId !== branchFromSdkSessionId) {
              sessionLog.warn('Claude branch anchor lineage mismatch: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
                parentSdkSessionId: branchFromSdkSessionId,
              })
            } else {
              branchFromSdkTurnId = anchor.sdkMessageUuid
            }
          }
        } else {
          branchFromSdkTurnId = branchMessage?.turnId
        }
      }

      if (branchContextStrategy === 'sdk-fork' && !branchFromSdkSessionId) {
        sessionLog.warn('Branch validation failed: sdk-fork requires parent SDK session ID', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          targetProvider: targetBackendContext.provider,
        })
        throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.')
      }

      validatedBranch = {
        sourceSessionId: options.branchFromSessionId,
        sourceMessageId: options.branchFromMessageId,
        sourceSession,
        branchIdx,
        branchContextStrategy,
        branchFromSdkSessionId,
        branchFromSessionPath,
        branchFromSdkCwd,
        branchFromSdkTurnId,
        sourceProvider: sourceBackendContext.provider,
      }

      sessionLog.info('Branch validation succeeded', {
        workspaceId,
        branchFromSessionId: validatedBranch.sourceSessionId,
        branchFromMessageId: validatedBranch.sourceMessageId,
        branchContextStrategy: validatedBranch.branchContextStrategy,
        branchFromSdkSessionId: !!validatedBranch.branchFromSdkSessionId,
        copiedMessageCount: validatedBranch.branchIdx + 1,
      })
    }

    // Use storage layer to create and persist the session
    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      hidden: options?.hidden,
      sessionStatus: options?.sessionStatus,
      labels: options?.labels,
      isFlagged: options?.isFlagged,
      isPinned: options?.isPinned,
      pinnedAt: options?.pinnedAt,
      projectId: resolvedProjectId,
      customGroupId: options?.customGroupId,
      customGroupOrder: options?.customGroupId
        ? (typeof options.customGroupOrder === 'number' && Number.isFinite(options.customGroupOrder)
            ? options.customGroupOrder
            : this.resolveNextCustomGroupOrder(workspaceRootPath, options.customGroupId))
        : undefined,
      parentSessionId: options?.parentSessionId,
      taskSlug: options?.taskSlug,
      taskRunId: options?.taskRunId,
      taskNodeId: options?.taskNodeId,
      taskDraft: options?.taskDraft,
      // Persist only an EXPLICIT selection (e.g. a task's spec.sources on its subtasks).
      // The workspace-default fallback stays dynamic — freezing it into the header would
      // pin every ordinary session to the defaults as of its creation time.
      enabledSourceSlugs: options?.enabledSourceSlugs,
      // Persist only explicit routing overrides. Ordinary sessions must retain
      // dynamic workspace/global fallbacks rather than freezing creation-time defaults.
      model: options?.model ? targetBackendContext.resolvedModel : undefined,
      thinkingLevel: options?.thinkingLevel ? defaultThinkingLevel : undefined,
      llmConnection: options?.llmConnection,
      enabledMemorySpaceRefs: options?.enabledMemorySpaceRefs,
      memoryWriteTargetRef: options?.memoryWriteTargetRef,
      memorySelectionMode: options?.memorySelectionMode,
      transferredSessionSummary: internal?.initialTransferredSessionSummary,
      transferredSessionSummaryApplied: internal?.initialTransferredSessionSummary ? false : undefined,
    })

    // Branch: copy messages from source session up to and including the branch point
    if (validatedBranch) {
      const branchedStored = loadStoredSession(workspaceRootPath, storedSession.id)
      if (!branchedStored) {
        throw new Error(`Failed to load newly created session ${storedSession.id} for branch copy`)
      }

      const sourceMessages = validatedBranch.sourceSession.messages.slice(0, validatedBranch.branchIdx + 1)

      // Re-map embedded paths: source messages were loaded with expandSessionPath(sourceDir),
      // so they contain absolute paths to the *source* session directory. When saved to the
      // branch session, makeSessionPathPortable uses the *branch* dir — which won't match.
      // Fix: replace source dir paths with branch dir paths so tokenization works on save.
      const sourceDir = normalizePath(getSessionStoragePath(workspaceRootPath, validatedBranch.sourceSessionId))
      const branchDir = normalizePath(getSessionStoragePath(workspaceRootPath, storedSession.id))
      if (sourceDir !== branchDir) {
        branchedStored.messages = sourceMessages.map(m => {
          const json = JSON.stringify(m)
          if (!json.includes(sourceDir)) return m
          return JSON.parse(json.replaceAll(sourceDir, branchDir)) as StoredMessage
        })
      } else {
        branchedStored.messages = sourceMessages
      }

      branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
      if (validatedBranch.branchContextStrategy === 'sdk-fork') {
        branchedStored.branchFromSdkSessionId = validatedBranch.branchFromSdkSessionId
        branchedStored.branchFromSessionPath = validatedBranch.branchFromSessionPath
        branchedStored.branchFromSdkCwd = validatedBranch.branchFromSdkCwd
        branchedStored.branchFromSdkTurnId = validatedBranch.branchFromSdkTurnId
      } else {
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
      }
      await saveStoredSession(branchedStored)

      // Propagate the Pi turn-anchor sidecar into the branch so a downstream
      // branch can still resolve anchors for messages copied here from the
      // source. Without this step, branch-of-branch silently falls back to
      // full-history fork — see craft-agents-oss#782.
      if (
        validatedBranch.branchContextStrategy === 'sdk-fork' &&
        validatedBranch.sourceProvider === 'pi'
      ) {
        try {
          await copyPiTurnAnchorsForBranch(
            sourceDir,
            branchDir,
            branchedStored.messages.map((m) => m.id),
          )
        } catch (err) {
          sessionLog.warn('Failed to copy Pi turn-anchors sidecar to branch', {
            err,
            sourceSessionId: validatedBranch.sourceSessionId,
            branchSessionId: storedSession.id,
          })
        }
      }
    }

    // Resolve connection/provider/auth/model using the provider-agnostic backend resolver.
    // Reuse precomputed target context so branch validation and session construction share the same target identity.
    const resolvedContext = targetBackendContext
    const resolvedModel = resolvedContext.resolvedModel

    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`)
    }

    const isBranch = !!validatedBranch

    const managed = createManagedSession(storedSession, workspace, {
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      model: resolvedModel,
      llmConnection: options?.llmConnection,
      thinkingLevel: defaultThinkingLevel,
      systemPromptPreset: options?.systemPromptPreset,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchFromSdkSessionId: validatedBranch?.branchFromSdkSessionId,
      branchFromSessionPath: validatedBranch?.branchFromSessionPath,
      branchFromSdkCwd: validatedBranch?.branchFromSdkCwd,
      branchFromSdkTurnId: validatedBranch?.branchFromSdkTurnId,
      branchSeedApplied: validatedBranch ? validatedBranch.branchContextStrategy === 'sdk-fork' : undefined,
      messagesLoaded: !isBranch,  // Branched sessions: lazy-load messages from JSONL
    })

    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) {
      await this.ensureMessagesLoaded(managed)

      const requiresBranchPreflight = managed.branchContextStrategy === 'sdk-fork'
      if (requiresBranchPreflight) {
        // Enforce branch correctness at creation time.
        // A branch is only valid if backend context can be established now,
        // not deferred to the first user message.
        try {
          await this.getOrCreateAgent(managed)
          await managed.agent!.ensureBranchReady()
        } catch (error) {
          sessionLog.warn('Branch creation failed during backend preflight handshake', {
            workspaceId,
            sessionId: storedSession.id,
            branchFromSessionId: validatedBranch?.sourceSessionId,
            branchFromMessageId: validatedBranch?.sourceMessageId,
            branchContextStrategy: managed.branchContextStrategy,
            error: error instanceof Error ? error.message : String(error),
          })

          await rollbackFailedBranchCreation({
            managed,
            workspaceRootPath,
            sessionId: storedSession.id,
            deleteFromRuntimeSessions: (id) => {
              const m = this.sessions.get(id)
              if (m?.autoRetryTimer) {
                clearTimeout(m.autoRetryTimer)
                m.autoRetryTimer = undefined
              }
              if (m) m.autoRetryPending = undefined
              this.clearExternalMetadataGuardTimer(id)
              this.sessions.delete(id)
            },
            deleteStoredSession,
            disposeRuntime: async () => {
              await this.disposeManagedAgentRuntime(managed, 'construction_failed')
            },
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    // Initialize mode-manager state immediately to avoid UI/enforcement races
    // before the agent instance is lazily created.
    setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(storedSession.id, managed.previousPermissionMode)
    }

    this.sessions.set(storedSession.id, managed)

    // Initialize session metadata in AutomationSystem for diffing
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(storedSession.id, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Reserved "Task" label: task flows opt in so the tile (and its subtasks, which inherit the
    // parent's number) are filterable as tasks from the moment they exist. Applied before the
    // created-event so the renderer hydrates the label with the rest of the metadata. Fail-soft:
    // a label problem must never abort session creation.
    if (options?.applyTaskLabel) {
      try {
        await this.applyTaskLabel(storedSession.id, { parentSessionId: options?.parentSessionId })
      } catch (error) {
        sessionLog.warn('Failed to apply Task label to new session', {
          sessionId: storedSession.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Announce by default so the renderer hydrates full metadata (name, parentSessionId, …)
    // instead of fabricating a titleless "New Chat" from the first streamed event. Emitted at
    // the very end so a thrown branch-preflight failure above never announces an orphan.
    if (internal?.emitCreatedEvent !== false) {
      this.notifySessionCreated(workspaceId, storedSession.id)
    }

    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined)
    } finally {
      releaseAdmission()
    }
  }

  /**
   * Announce a session to the renderer so it hydrates full metadata (name, parentSessionId, …)
   * instead of fabricating a "New Chat" placeholder from the first streamed event.
   *
   * `createSession` calls this by default, so server-side creators get it for free. Use it
   * directly only for sessions built outside `createSession` (e.g. the SessionBundle import
   * path, which assembles a ManagedSession by hand). The renderer handler is idempotent.
   */
  notifySessionCreated(workspaceId: string, sessionId: string): void {
    this.sendEvent({ type: 'session_created', sessionId }, workspaceId)
  }

  /** Resolved working directory of a live session (used by the Tasks Conductor so child
   *  sessions inherit the orchestrator's cwd). Undefined if the session has none or is unknown. */
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workingDirectory
  }

  private assertRuntimeAdmission(): void {
    if (this.closing) {
      throw new Error('Session runtime manager is shutting down')
    }
  }

  private lifecycleFor(workspaceId: string): WorkspaceLifecycle {
    let lifecycle = this.workspaceLifecycles.get(workspaceId)
    if (!lifecycle) {
      lifecycle = newWorkspaceLifecycle()
      this.workspaceLifecycles.set(workspaceId, lifecycle)
    }
    return lifecycle
  }

  private activateWorkspaceLifecycle(workspaceId: string): boolean {
    const lifecycle = this.workspaceLifecycles.get(workspaceId)
    if (!lifecycle) {
      this.workspaceLifecycles.set(workspaceId, newWorkspaceLifecycle())
      return false
    }
    if (lifecycle.state !== 'removed') return false
    this.workspaceLifecycles.set(workspaceId, newWorkspaceLifecycle())
    return true
  }

  assertWorkspaceAdmission(workspaceId: string, kind: 'task' | 'background'): void {
    this.assertRuntimeAdmission()
    const lifecycle = this.lifecycleFor(workspaceId)
    if (lifecycle.state !== 'active') throw new WorkspaceAdmissionError(workspaceId, kind)
  }

  private acquireWorkspaceAdmission(workspaceId: string, kind: WorkspaceAdmissionKind): () => void {
    this.assertRuntimeAdmission()
    const lifecycle = this.lifecycleFor(workspaceId)
    if (lifecycle.state !== 'active') throw new WorkspaceAdmissionError(workspaceId, kind)
    lifecycle.inFlight[kind] += 1
    let released = false
    return () => {
      if (released) return
      released = true
      lifecycle.inFlight[kind] = Math.max(0, lifecycle.inFlight[kind] - 1)
    }
  }

  private workspaceActivityCode(workspaceId: string): Extract<WorkspaceRemovalCode, 'active-session' | 'active-task' | 'active-background'> | null {
    const lifecycle = this.lifecycleFor(workspaceId)
    const workspaceSessions = [...this.sessions.values()].filter((managed) => managed.workspace.id === workspaceId)
    const sessionIds = new Set(workspaceSessions.map((managed) => managed.id))

    if (
      lifecycle.inFlight.task > 0
      || this.getTaskConductorService().hasNonTerminalRuns(workspaceId)
    ) {
      return 'active-task'
    }

    if (
      lifecycle.inFlight.automation > 0
      || lifecycle.inFlight.background > 0
      || workspaceSessions.some((managed) =>
        this.hasRunningBackgroundWork(managed)
        || managed.backgroundShellCommands.size > 0
        || managed.authRetryInProgress
      )
      || [...this.agentRefreshLocks.keys()].some((sessionId) => sessionIds.has(sessionId))
    ) {
      return 'active-background'
    }

    if (
      lifecycle.inFlight.session > 0
      || workspaceSessions.some((managed) => managed.isProcessing || managed.messageQueue.length > 0)
      || [...this.messageLoadingPromises.keys()].some((sessionId) => sessionIds.has(sessionId))
    ) {
      return 'active-session'
    }

    return null
  }

  private classifyWorkspaceRemovalFailure(
    error: unknown,
    hooks: WorkspaceRemovalHooks,
  ): Extract<WorkspaceRemovalCode, 'teardown-failed' | 'required-watch-budget'> {
    const classified = hooks.classifyFailure?.(error)
    if (classified) return classified
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === 'required-watch-budget'
    ) {
      return 'required-watch-budget'
    }
    return 'teardown-failed'
  }

  private async releaseWorkspaceResources(workspace: Workspace): Promise<void> {
    const lifecycle = this.lifecycleFor(workspace.id)
    lifecycle.teardownStarted = true

    const watcher = this.configWatchers.get(workspace.rootPath)
    if (watcher) {
      watcher.stop()
      this.configWatchers.delete(workspace.rootPath)
    }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (automationSystem) {
      automationSystem.dispose()
      this.automationSystems.delete(workspace.rootPath)
    }

    this.getTaskConductorService().releaseWorkspace(workspace.id)

    const managedSessions = [...this.sessions.values()].filter((managed) => managed.workspace.id === workspace.id)
    for (const managed of managedSessions) {
      managed.deleting = true
      this.persistSession(managed)
      await this.flushSession(managed.id)

      const deltaTimer = this.deltaFlushTimers.get(managed.id)
      if (deltaTimer) clearTimeout(deltaTimer)
      this.deltaFlushTimers.delete(managed.id)
      this.pendingDeltas.delete(managed.id)
      this.clearAdminRememberApprovalsForSession(managed.id)
      this.clearPendingPermissionRequestsForSession(managed.id)
      this.clearExternalMetadataGuardTimer(managed.id)
      this.messageLoadingPromises.delete(managed.id)
      this.agentRefreshLocks.delete(managed.id)

      if (managed.stopTimer) clearTimeout(managed.stopTimer)
      managed.stopTimer = undefined
      if (managed.activeTurn?.watchdogTimer) clearTimeout(managed.activeTurn.watchdogTimer)
      managed.activeTurn = undefined
      if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
      managed.autoRetryPending = undefined
      managed.pendingExternalMetadata = undefined

      const sessionBpm = this.getBrowserPaneManagerForSession(managed.id)
      sessionBpm?.destroyForSession(managed.id)
      this.remoteBpms.delete(managed.id)
      this.browserHostByCanvas.delete(managed.id)

      const hadRuntime = Boolean(managed.agent || managed.poolServer || managed.mcpPool || managed.runtimeGeneration)
      const disposal = await this.disposeManagedAgentRuntime(managed, 'workspace_detach')
      if ((hadRuntime && !disposal) || runtimeDisposalFailed(disposal)) {
        const error = new Error(`Workspace runtime teardown failed for session ${managed.id}`)
        ;(error as Error & { code: string }).code = disposal?.errorCode ?? 'runtime-dispose-failed'
        throw error
      }

      sessionPersistenceQueue.cancel(managed.id)
      unregisterSessionScopedToolCallbacks(managed.id)
      managed.messageQueue.length = 0
      managed.backgroundShellCommands.clear()
      managed.backgroundTaskRegistry.clear()
      managed.backgroundTaskOutputs.clear()
      for (const [taskId, ownerSessionId] of this.taskOutputIndex) {
        if (ownerSessionId === managed.id) this.taskOutputIndex.delete(taskId)
      }
      this.sessions.delete(managed.id)
    }

    this.activeViewingSession.delete(workspace.id)
  }

  removeWorkspace(workspaceId: string, hooks: WorkspaceRemovalHooks): Promise<WorkspaceRemovalResult> {
    const lifecycle = this.lifecycleFor(workspaceId)
    if (lifecycle.removalPromise) return lifecycle.removalPromise

    const removal = (async (): Promise<WorkspaceRemovalResult> => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace || lifecycle.state === 'removed') {
        lifecycle.state = 'removed'
        let credentialCleanupPending = false
        try {
          await hooks.cleanupCredentials?.()
        } catch (error) {
          credentialCleanupPending = true
          sessionLog.warn('[workspace-detach] retryable credential cleanup failed', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return {
          ok: true,
          code: 'already-removed',
          ...(credentialCleanupPending ? { credentialCleanupPending: true } : {}),
        }
      }

      lifecycle.state = 'removing'
      lifecycle.teardownStarted = false

      try {
        hooks.freezeExternalAdmission?.()
        const activity = this.workspaceActivityCode(workspaceId)
          ?? (hooks.hasExternalActivity?.() ? 'active-background' : null)
        if (activity) {
          try {
            hooks.resumeExternalAdmission?.()
            lifecycle.state = 'active'
          } catch (error) {
            sessionLog.error('[workspace-detach] failed to resume external admission after refusal', {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            })
            lifecycle.state = 'removing'
            return { ok: false, code: 'teardown-failed', retryable: true }
          }
          return { ok: false, code: activity, retryable: true }
        }

        await this.releaseWorkspaceResources(workspace)
        await hooks.releaseExternalResources?.()

        // Config detach is intentionally the final teardown mutation.
        const detached = await hooks.detachConfig()
        lifecycle.state = 'removed'

        let credentialCleanupPending = false
        try {
          await hooks.cleanupCredentials?.()
        } catch (error) {
          credentialCleanupPending = true
          sessionLog.warn('[workspace-detach] retryable credential cleanup failed after detach', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          })
        }

        return {
          ok: true,
          code: detached ? 'success' : 'already-removed',
          ...(credentialCleanupPending ? { credentialCleanupPending: true } : {}),
        }
      } catch (error) {
        const code = this.classifyWorkspaceRemovalFailure(error, hooks)
        sessionLog.error('[workspace-detach] teardown failed', {
          workspaceId,
          code,
          teardownStarted: lifecycle.teardownStarted,
          error: error instanceof Error ? error.message : String(error),
        })

        if (!lifecycle.teardownStarted) {
          try {
            hooks.resumeExternalAdmission?.()
            lifecycle.state = 'active'
          } catch {
            lifecycle.state = 'removing'
          }
        } else {
          // Resource ownership may already be partially released. Keep admission
          // closed and retry idempotently; do not fake a rollback.
          lifecycle.state = 'removing'
        }
        return { ok: false, code, retryable: true }
      }
    })()

    lifecycle.removalPromise = removal
    void removal.finally(() => {
      if (lifecycle.removalPromise === removal) lifecycle.removalPromise = undefined
    })
    return removal
  }

  /** Adopt legacy/test-injected fields into one exact bundle before disposal. */
  private ensureRuntimeGeneration(managed: ManagedSession): ManagedRuntimeGeneration | undefined {
    if (managed.runtimeGeneration) return managed.runtimeGeneration
    if (!managed.agent && !managed.poolServer && !managed.mcpPool) return undefined

    const generation: ManagedRuntimeGeneration = {
      epoch: ++managed.nextRuntimeEpoch,
      token: randomUUID(),
      state: 'ready',
      ...(managed.agent ? { agent: managed.agent } : {}),
      ...(managed.poolServer ? { poolServer: managed.poolServer } : {}),
      ...(managed.mcpPool ? { mcpPool: managed.mcpPool } : {}),
      ...(managed.envOverrides ? { envOverrides: managed.envOverrides } : {}),
      createdAt: Date.now(),
    }
    managed.runtimeGeneration = generation
    this.runtimeRegistry.set(generation.token, { managed, generation })
    return generation
  }

  private isCurrentRuntime(managed: ManagedSession, generation: ManagedRuntimeGeneration, agent?: AgentInstance): boolean {
    return managed.runtimeGeneration === generation
      && generation.state === 'ready'
      && (!agent || generation.agent === agent)
      && this.sessions.get(managed.id) === managed
      && !this.closing
  }

  private async disposeRuntimeGeneration(
    managed: ManagedSession,
    generation: ManagedRuntimeGeneration,
    reason: RuntimeDisposeReason,
    deadline = Date.now() + this.runtimeLifecycleConfig.shutdownTimeoutMs,
  ): Promise<RuntimeDisposeResult | undefined> {
    if (generation.disposePromise) return generation.disposePromise

    generation.state = 'draining'
    generation.agent?.setBackgroundEventSink?.(null)
    if (generation.agent) generation.agent.onRuntimeExit = null

    const work = (async (): Promise<RuntimeDisposeResult | undefined> => {
      const startedAt = Date.now()
      let resourceFailure = false
      const [agentResult] = await Promise.all([
        generation.agent
          ? disposeBackendRuntime(generation.agent, { reason, deadline }).catch((error) => {
              resourceFailure = true
              sessionLog.warn(`Failed to dispose agent for ${managed.id} during ${reason}: ${error instanceof Error ? error.message : error}`)
              return undefined
            })
          : Promise.resolve(undefined),
        generation.poolServer?.stop().catch((error) => {
          resourceFailure = true
          sessionLog.warn(`Failed to stop pool server for ${managed.id} during ${reason}: ${error instanceof Error ? error.message : error}`)
        }),
        generation.mcpPool?.disconnectAll().catch((error) => {
          resourceFailure = true
          sessionLog.warn(`Failed to disconnect MCP pool for ${managed.id} during ${reason}: ${error instanceof Error ? error.message : error}`)
        }),
      ])
      const fallbackResult: RuntimeDisposeResult = {
        outcome: 'limited_observability',
        observedExit: false,
        attemptedGraceful: false,
        forced: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
      const result: RuntimeDisposeResult | undefined = resourceFailure
        ? {
            ...(agentResult ?? fallbackResult),
            errorCode: 'runtime_dispose_failed',
          }
        : (agentResult ?? (generation.poolServer || generation.mcpPool ? fallbackResult : undefined))

      if (reason === 'workspace_detach' && runtimeDisposalFailed(result)) {
        // Preserve exact ownership so a fail-forward detach retry can make a
        // real second disposal attempt instead of forgetting a leaked runtime.
        generation.state = 'ready'
        return result
      }

      generation.state = 'disposed'
      generation.agent = undefined
      generation.poolServer = undefined
      generation.mcpPool = undefined
      generation.envOverrides = undefined
      this.runtimeRegistry.delete(generation.token)
      return result
    })()

    generation.disposePromise = work
    const result = await work
    if (reason === 'workspace_detach' && runtimeDisposalFailed(result)) {
      generation.disposePromise = undefined
    }
    return result
  }

  /**
   * Single idempotent awaited ownership path for agent + model child + pool server
   * + MCP transports. Fields are fenced synchronously before any external await.
   */
  private async disposeManagedAgentRuntime(
    managed: ManagedSession,
    reason: RuntimeDisposeReason,
    expectedGeneration?: ManagedRuntimeGeneration,
    deadline?: number,
  ): Promise<RuntimeDisposeResult | undefined> {
    const generation = expectedGeneration ?? this.ensureRuntimeGeneration(managed)
    if (!generation) return undefined

    if (expectedGeneration && managed.runtimeGeneration !== expectedGeneration) {
      return this.disposeRuntimeGeneration(managed, expectedGeneration, reason, deadline)
    }

    if (managed.runtimeGeneration === generation) {
      managed.runtimeGeneration = undefined
      managed.agent = null
      managed.poolServer = undefined
      managed.mcpPool = undefined
      managed.envOverrides = undefined
      managed.runtimeIdleSince = undefined
      managed.agentReadyResolve?.()
      managed.agentReady = undefined
      managed.agentReadyResolve = undefined
      managed.backendRuntimeSignature = undefined
      managed.backendRestartSignature = undefined
      unregisterSessionScopedToolCallbacks(managed.id)
    }

    const result = await this.disposeRuntimeGeneration(managed, generation, reason, deadline)
    if (reason === 'workspace_detach' && runtimeDisposalFailed(result)) {
      managed.runtimeGeneration = generation
      managed.agent = generation.agent ?? null
      managed.poolServer = generation.poolServer
      managed.mcpPool = generation.mcpPool
      managed.envOverrides = generation.envOverrides
    }
    return result
  }

  private hasPendingPermissionForSession(sessionId: string): boolean {
    for (const request of this.pendingPermissionRequests.values()) {
      if (request.sessionId === sessionId) return true
    }
    return false
  }

  private hasRunningBackgroundWork(managed: ManagedSession): boolean {
    for (const task of managed.backgroundTaskRegistry.values()) {
      if (task.status === 'running') return true
    }
    return false
  }

  private canEvictRuntime(managed: ManagedSession, generation: ManagedRuntimeGeneration): boolean {
    return managed.runtimeGeneration === generation
      && generation.state === 'ready'
      && !managed.isProcessing
      && !managed.activeTurn
      && managed.messageQueue.length === 0
      && !managed.authRetryInProgress
      && !this.hasPendingPermissionForSession(managed.id)
      && !this.hasRunningBackgroundWork(managed)
  }

  /** Global (cross-workspace) TTL/cap reaper plus exact-registry reconciliation. */
  async reapIdleRuntimes(now = Date.now()): Promise<void> {
    if (this.closing || !this.runtimeLifecycleConfig.idleEvictionEnabled) return

    const orphanDisposals: Promise<unknown>[] = []
    for (const { managed, generation } of this.runtimeRegistry.values()) {
      if (this.sessions.get(managed.id) !== managed || managed.runtimeGeneration !== generation) {
        orphanDisposals.push(this.disposeRuntimeGeneration(managed, generation, 'eviction'))
      }
    }

    const candidates = [...this.sessions.values()]
      .map((managed) => ({ managed, generation: this.ensureRuntimeGeneration(managed) }))
      .filter((entry): entry is { managed: ManagedSession; generation: ManagedRuntimeGeneration } =>
        !!entry.generation && entry.managed.runtimeIdleSince !== undefined && this.canEvictRuntime(entry.managed, entry.generation))
      .sort((a, b) => (a.managed.runtimeIdleSince ?? 0) - (b.managed.runtimeIdleSince ?? 0))

    const overCap = Math.max(0, candidates.length - this.runtimeLifecycleConfig.retainedCap)
    const disposals = candidates
      .filter((entry, index) =>
        index < overCap || now - (entry.managed.runtimeIdleSince ?? now) >= this.runtimeLifecycleConfig.idleTtlMs)
      .map(({ managed, generation }) => {
        // Revalidate immediately before fencing the exact bundle.
        if (!this.canEvictRuntime(managed, generation)) return Promise.resolve(undefined)
        return this.disposeManagedAgentRuntime(managed, 'eviction', generation)
      })

    await Promise.allSettled([...orphanDisposals, ...disposals])
  }

  private startIdleReaper(): void {
    if (this.idleReaperTimer || !this.runtimeLifecycleConfig.idleEvictionEnabled || this.closing) return
    const intervalMs = Math.max(1_000, Math.min(60_000, Math.floor(this.runtimeLifecycleConfig.idleTtlMs / 2)))
    this.idleReaperTimer = setInterval(() => {
      void this.reapIdleRuntimes()
    }, intervalMs)
    this.idleReaperTimer.unref?.()
  }

  /**
   * Refresh an existing agent's runtime config in place when the session's
   * resolved connection signature has drifted from what the agent was created
   * with. No-ops when the agent doesn't exist, when the signature still
   * matches, or when the agent is mid-stream (the gate is `agent.isProcessing()`
   * — `managed.isProcessing` is not used because `sendMessage` flips it before
   * calling `getOrCreateAgent`, which would make every send-path refresh dead
   * code).
   *
   * Concurrency: per-session serialization via `agentRefreshLocks`. A second
   * caller (e.g. `sendMessage` arriving mid-`SAVE`-refresh) awaits the
   * in-flight refresh, then re-evaluates from the post-refresh state — so the
   * subsequent `agent.chat()` is sent only after the subprocess has applied
   * the runtime update (or the agent has been disposed for recreation).
   *
   * The helper distinguishes two kinds of drift:
   *   - Restart-required (provider/auth/slug/piAuthProvider): goes straight
   *     to dispose + recreate because `update_runtime_config` cannot fully
   *     re-route credential/provider state in a live subprocess.
   *   - In-place safe (model/baseUrl/customEndpoint/customModels): attempts
   *     `agent.updateRuntimeConfig` and falls back to dispose if the backend
   *     can't apply the update.
   */
  private async tryRefreshAgentRuntime(
    managed: ManagedSession,
    reason: string,
    allowCurrentSendStartup = false,
  ): Promise<void> {
    // Serialize against any in-flight refresh on this session. The waiter
    // doesn't propagate the prior call's errors — those are logged at the
    // origin call site.
    const inflight = this.agentRefreshLocks.get(managed.id)
    if (inflight) {
      await inflight.catch(() => undefined)
    }

    if (!managed.agent) return

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const resolvedConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(
      managed.workspace.rootPath,
      managed.llmConnection,
      workspaceConfig?.defaults?.defaultLlmConnection,
    )
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: resolvedConnectionSlug,
      workspaceDefaultConnectionSlug: undefined,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      return
    }

    const restartRequired = managed.backendRestartSignature !== restartSignature
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature

    if (!restartRequired && !runtimeChanged) return

    if (
      managed.agent.isProcessing()
      || (!allowCurrentSendStartup && managed.activeTurn?.agent === managed.agent)
    ) {
      sessionLog.info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`)
      return
    }

    const work = this.runAgentRuntimeRefresh(
      managed,
      backendContext,
      runtimeSignature,
      restartSignature,
      restartRequired,
      reason,
    )
    // Track the work so concurrent callers serialize. Swallow errors on the
    // tracked promise — the awaiter shouldn't get someone else's exception;
    // errors are logged inside `runAgentRuntimeRefresh`.
    const tracked = work.then(() => undefined, () => undefined)
    this.agentRefreshLocks.set(managed.id, tracked)
    try {
      await work
    } finally {
      // Concurrent callers awaited `tracked` before reaching this point and
      // each registered their own work serially, so the slot is always ours
      // to clear when our own work resolves.
      if (this.agentRefreshLocks.get(managed.id) === tracked) {
        this.agentRefreshLocks.delete(managed.id)
      }
    }
  }

  private async runAgentRuntimeRefresh(
    managed: ManagedSession,
    backendContext: ReturnType<typeof resolveBackendContext>,
    runtimeSignature: string,
    restartSignature: string,
    restartRequired: boolean,
    reason: string,
  ): Promise<void> {
    if (restartRequired) {
      sessionLog.info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'replacement')
      return
    }

    const connection = backendContext.connection
    let refreshed = false
    if (managed.agent?.updateRuntimeConfig) {
      try {
        refreshed = await managed.agent.updateRuntimeConfig({
          model: backendContext.resolvedModel,
          providerType: connection?.providerType,
          authType: backendContext.authType,
          runtime: connection ? {
            baseUrl: connection.baseUrl,
            piAuthProvider: connection.piAuthProvider,
            customEndpoint: connection.customEndpoint,
            customModels: connection.models?.map(model => {
              if (typeof model === 'string') return model
              const supportsImages = typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined
              if (model.contextWindow || supportsImages !== undefined) {
                return {
                  id: model.id,
                  ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                  ...(supportsImages !== undefined ? { supportsImages } : {}),
                }
              }
              return model.id
            }),
          } : undefined,
        })
      } catch (error) {
        sessionLog.warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (refreshed) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      sessionLog.info(`Refreshed runtime config for session ${managed.id} (${reason})`)
    } else {
      sessionLog.info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'replacement')
    }
  }

  /**
   * Push a connection's runtime updates (e.g. `supportsImages` toggle) to every
   * active session that uses it. Called from the `llmConnections.SAVE` handler
   * so capability changes reach live Pi subprocesses immediately instead of
   * waiting for the next send to lazily notice the signature drift.
   */
  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    for (const managed of this.sessions.values()) {
      if (managed.llmConnection !== connectionSlug) continue
      try {
        await this.tryRefreshAgentRuntime(managed, 'connection update')
      } catch (error) {
        sessionLog.warn(`refreshConnectionRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates the appropriate backend agent based on LLM connection.
   *
   * Provider resolution order:
   * 1. session.llmConnection (locked after first message)
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
   * 4. fallback: no connection configured
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    this.assertRuntimeAdmission()
    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await this.tryRefreshAgentRuntime(managed, 'send-path refresh', true)

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const resolvedConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(
      managed.workspace.rootPath,
      managed.llmConnection,
      workspaceConfig?.defaults?.defaultLlmConnection,
    )
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: resolvedConnectionSlug,
      workspaceDefaultConnectionSlug: undefined,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    const existingGeneration = this.ensureRuntimeGeneration(managed)
    if (managed.agent && existingGeneration?.state === 'ready') {
      managed.runtimeIdleSince = undefined
      return managed.agent
    }
    if (existingGeneration?.state === 'creating' && existingGeneration.readyPromise) {
      return existingGeneration.readyPromise
    }

    const generation: ManagedRuntimeGeneration = {
      epoch: ++managed.nextRuntimeEpoch,
      token: randomUUID(),
      state: 'creating',
      createdAt: Date.now(),
    }
    managed.runtimeGeneration = generation
    managed.runtimeIdleSince = undefined
    this.runtimeRegistry.set(generation.token, { managed, generation })

    const construction = (async (): Promise<AgentInstance> => {
      const end = perf.start('agent.create', { sessionId: managed.id })
      let agent: AgentInstance | undefined
      let mcpPool: McpClientPool | undefined
      let poolServer: McpPoolServer | undefined
      try {

      // Lock the connection after first resolution
      // This ensures the session always uses the same provider
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        sessionLog.info(`Locked session ${managed.id} to connection "${connection.slug}"`)
        this.persistSession(managed)

        // Keep renderer session capabilities in sync when auto-locking the connection.
        this.sendEvent({
          type: 'connection_changed',
          sessionId: managed.id,
          connectionSlug: connection.slug,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }

      const provider = backendContext.provider
      if (connection) {
        sessionLog.info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`)
      } else {
        sessionLog.warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`)
      }

      // Set session directory for tool metadata cross-process sharing.
      // The SDK subprocess reads CRAFT_SESSION_DIR to write tool-metadata.json;
      // the main process reads it via toolMetadataStore.setSessionDir().
      const sessionDirForMetadata = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      process.env.CRAFT_SESSION_DIR = sessionDirForMetadata
      toolMetadataStore.setSessionDir(sessionDirForMetadata)

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // Common setup: sources, MCP pool, session config
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(managed.workspace.rootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )

      // Build server configs for enabled sources
      const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)
      if (generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
        throw new Error('Runtime construction cancelled')
      }

      // Create centralized MCP client pool (all backends use it)
      mcpPool = new McpClientPool({ debug: (msg) => sessionLog.debug(msg), workspaceRootPath: managed.workspace.rootPath, sessionPath })
      generation.mcpPool = mcpPool

      // Backends that run as external subprocesses need an HTTP pool server
      let poolServerUrl: string | undefined
      if (backendContext.capabilities.needsHttpPoolServer) {
        poolServer = new McpPoolServer(mcpPool, { debug: (msg) => sessionLog.debug(msg) })
        generation.poolServer = poolServer
        mcpPool.onToolsChanged = () => poolServer?.notifyToolsChanged()
        poolServerUrl = await poolServer.start()
        if (generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
          await poolServer.stop().catch(() => undefined)
          await mcpPool.disconnectAll().catch(() => undefined)
          throw new Error('Runtime construction cancelled')
        }
        await mcpPool.sync(mcpServers) // Ensure pool has tools before SDK connects
        if (generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
          // A dispose may have raced start/sync. Sweep again after the awaited
          // construction step so no late HTTP/MCP child can resurrect.
          await poolServer.stop().catch(() => undefined)
          await mcpPool.disconnectAll().catch(() => undefined)
          throw new Error('Runtime construction cancelled')
        }
      }

      // Per-session env overrides
      const miniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
        // Pass mini model to SDK subprocess so built-in tools like WebFetch
        // use the correct model for summarization (instead of hardcoded Haiku)
        ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchFromMessageId,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmConnection: managed.llmConnection,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
        projectId: managed.projectId,
      }

      const ownsGeneration = () => managed.runtimeGeneration === generation
        && (generation.state === 'creating' || generation.state === 'ready')
        && !this.closing

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        if (!ownsGeneration()) return
        managed.sdkSessionId = sdkSessionId
        // Retire branch-only fork metadata now that child session is established
        if (managed.branchFromSdkSessionId) {
          sessionLog.info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`)
          managed.branchFromSdkSessionId = undefined
          managed.branchFromSdkCwd = undefined
          managed.branchFromSdkTurnId = undefined
        } else {
          sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
        }
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onSdkSessionIdCleared = () => {
        if (!ownsGeneration()) return
        managed.sdkSessionId = undefined
        sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onBranchForkInvalidated = () => {
        if (!ownsGeneration()) return
        managed.sdkSessionId = undefined
        managed.branchFromSdkSessionId = undefined
        managed.branchFromSdkCwd = undefined
        managed.branchFromSdkTurnId = undefined
        sessionLog.info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const getRecoveryMessages = () => {
        const relevantMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .slice(-6)
        return relevantMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
          }))
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        const seedMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)

        return seedMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const markBranchSeedApplied = () => {
        if (!ownsGeneration()) return
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        sessionLog.info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null)
        sessionLog.info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`)
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (!ownsGeneration()) return
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary) return
        managed.transferredSessionSummaryApplied = true
        this.persistSession(managed)
        sessionLog.info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      // ============================================================
      // Construct backend via factory
      // ============================================================

      const { getEnable1MContext } = await import('@craft-agent/shared/config/storage')
      const enable1MContext = getEnable1MContext()
      if (generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
        await poolServer?.stop().catch(() => undefined)
        await mcpPool.disconnectAll().catch(() => undefined)
        throw new Error('Runtime construction cancelled')
      }

      agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
        workspace: managed.workspace,
        miniModel,
        thinkingLevel: managed.thinkingLevel,
        session: sessionConfig,
        onSdkSessionIdUpdate,
        onSdkSessionIdCleared,
        onBranchForkInvalidated,
        getRecoveryMessages,
        getBranchFallbackMessages,
        getBranchSeedMessages,
        markBranchSeedApplied,
        getTransferredSessionSummary,
        markTransferredSessionSummaryApplied,
        mcpPool: mcpPool,
        poolServerUrl,
        envOverrides,
        // Claude-specific
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
        automationSystem: this.automationSystems.get(managed.workspace.rootPath),
        systemPromptPreset: managed.systemPromptPreset,
        debugMode: _platform?.isDebugMode ? { enabled: true, logFilePath: _platform.getLogFilePath?.() } : undefined,
        enable1MContext,
        // Image resize callback — prevents oversized images from entering conversation history
        onImageResize: async (filePath: string, maxSizeBytes: number): Promise<string | null> => {
          try {
            const buffer = await readFile(filePath)
            const result = await resizeImageForAPI(buffer, { maxSizeBytes })
            if (!result) return null

            // Write to session tmp directory (cleaned up with session)
            const sessionTmpDir = join(sessionPath, 'tmp')
            await mkdir(sessionTmpDir, { recursive: true })
            const ext = result.format === 'jpeg' ? 'jpg' : 'png'
            const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`)
            await writeFile(outPath, result.buffer)

            sessionLog.info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`)
            return outPath
          } catch (err) {
            sessionLog.error('Image resize failed:', err)
            return null
          }
        },
        // Source configs for postInit() — backends set up their own bridge/config
        initialSources: {
          enabledSources,
          mcpServers,
          apiServers,
          enabledSlugs,
        },
        },
      }) as AgentInstance
      generation.agent = agent

      sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            sessionLog.info('Tool blocked by permission mode', payload)
            return
          } catch {
            // fall through to plain logging when payload parsing fails
          }
        }

        sessionLog.info(msg)
      }

      // Unified auth callback — replaces per-backend onChatGptAuthRequired/onGithubAuthRequired
      agent.onBackendAuthRequired = (reason: string) => {
        if (!ownsGeneration()) return
        sessionLog.warn(`Backend auth required for session ${managed.id}: ${reason}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: `Authentication required: ${reason}`,
          level: 'error',
        }, managed.workspace.id)
      }

      // Run post-init (auth injection) — each backend handles its own
      const postInitResult = await agent.postInit()
      if (generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
        // Awaited postInit may have raced disposal. Re-sweep the exact agent
        // after it unwinds so it cannot publish a late child.
        await disposeBackendRuntime(agent, { reason: 'construction_failed' }).catch(() => undefined)
        await poolServer?.stop().catch(() => undefined)
        await mcpPool.disconnectAll().catch(() => undefined)
        throw new Error('Runtime construction cancelled')
      }
      if (postInitResult.authWarning) {
        sessionLog.warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: postInitResult.authWarning,
          level: postInitResult.authWarningLevel || 'error',
        }, managed.workspace.id)
      }

      // Wire up large response handling in the MCP pool (all backends)
      if (mcpPool && agent) {
        mcpPool.setSummarizeCallback(agent.getSummarizeCallback())
      }

      // Wire up browser pane tools — merge BrowserPaneFns into session callbacks
      // so browser_* tools can delegate to BrowserPaneManager.
      //
      // Always register when EITHER a local BPM is set OR an RPC server is
      // available (which lets `getBrowserPaneManagerForSession` lazily build a
      // RemoteBrowserPaneManager). Calls fail per-method with
      // BROWSER_NO_CAPABLE_CLIENT if no desktop client is connected, instead
      // of "tool unavailable".
      sessionLog.info('[browser-pane] BPF gate check', {
        sessionId: managed.id,
        hasLocalBpm: !!this.browserPaneManager,
        hasRpcServer: !!this.rpcServer,
      })
      if (this.browserPaneManager || this.rpcServer) {
        const sid = managed.id
        const bpm = this.getBrowserPaneManagerForSession(sid)
        if (!bpm) {
          throw new Error('Browser pane manager unavailable despite passing the gate — this is a bug.')
        }
        sessionLog.info('[browser-pane] BPF block resolved BPM', {
          sessionId: sid,
          bpmKind: this.browserPaneManager === bpm ? 'local' : 'remote',
        })

        const workspaceId = managed.workspace.id
        const resolveSessionBrowserInstance = async (toolName: string, options?: { show?: boolean }): Promise<string> => {
          const instanceId = await bpm.createForSessionAsync(sid, {
            show: options?.show ?? false,
            workspaceId,
          })
          const info = await bpm.getInstanceAsync(instanceId)
          sessionLog.info(`[browser-pane] tool target resolved: ${toolName} session=${sid} instance=${instanceId} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
          return instanceId
        }

        const resolveLifecycleWindowTarget = async (command: 'release' | 'close' | 'hide', requestedInstanceId?: string) => {
          const windows = await bpm.listInstancesAsync()

          if (windows.length === 0) {
            return { windows, reason: 'No browser windows are available. Use "open" first.' }
          }

          const validateTarget = (target: (typeof windows)[number] | undefined) => {
            if (!target) {
              return { ok: false as const, reason: `Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.` }
            }

            if (target.boundSessionId && target.boundSessionId !== sid) {
              return { ok: false as const, reason: `Browser window "${target.id}" is locked to session ${target.boundSessionId}.` }
            }

            if (!target.boundSessionId && target.ownerSessionId && target.ownerSessionId !== sid) {
              return { ok: false as const, reason: `Browser window "${target.id}" is currently owned by session ${target.ownerSessionId}.` }
            }

            return { ok: true as const, target }
          }

          if (requestedInstanceId) {
            const validated = validateTarget(windows.find((w) => w.id === requestedInstanceId))
            if (!validated.ok) {
              return { windows, reason: validated.reason }
            }
            return { windows, target: validated.target }
          }

          const fallbackTarget = windows.find((w) => w.boundSessionId === sid)
            ?? windows.find((w) => w.ownerSessionId === sid)

          if (!fallbackTarget) {
            return { windows, reason: `No ${command} target is currently associated with this session. Use "windows", then "${command} <id>".` }
          }

          const validated = validateTarget(fallbackTarget)
          if (!validated.ok) {
            return { windows, reason: validated.reason }
          }

          return { windows, target: validated.target }
        }

        sessionLog.info('[browser-pane] BPF registering browserPaneFns', { sessionId: sid })
        mergeSessionScopedToolCallbacks(sid, {
          browserPaneFns: {
            openPanel: async (options) => {
              const instanceId = options?.background
                ? await bpm.createForSessionAsync(sid, { show: false, workspaceId })
                : await bpm.focusBoundForSessionAsync(sid, { workspaceId })
              const info = await bpm.getInstanceAsync(instanceId)
              sessionLog.info(`[browser-pane] route decision: browser_open session=${sid} instance=${instanceId} background=${options?.background ?? false} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
              return { instanceId }
            },
            navigate: async (url) => {
              const instanceId = await resolveSessionBrowserInstance('browser_navigate')
              return bpm.navigate(instanceId, url)
            },
            snapshot: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_snapshot')
              return bpm.getAccessibilitySnapshot(instanceId)
            },
            click: async (ref, options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click')
              return bpm.clickElement(instanceId, ref, options)
            },
            clickAt: async (x, y) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click_at')
              return bpm.clickAtCoordinates(instanceId, x, y)
            },
            drag: async (x1, y1, x2, y2) => {
              const instanceId = await resolveSessionBrowserInstance('browser_drag')
              return bpm.drag(instanceId, x1, y1, x2, y2)
            },
            fill: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_fill')
              return bpm.fillElement(instanceId, ref, value)
            },
            type: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_type')
              return bpm.typeText(instanceId, text)
            },
            select: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_select')
              return bpm.selectOption(instanceId, ref, value)
            },
            setClipboard: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_set_clipboard')
              return bpm.setClipboard(instanceId, text)
            },
            getClipboard: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_get_clipboard')
              return bpm.getClipboard(instanceId)
            },
            screenshot: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot')
              return bpm.screenshot(instanceId, options)
            },
            screenshotRegion: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot_region')
              return bpm.screenshotRegion(instanceId, options)
            },
            getConsoleLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_console')
              return bpm.getConsoleLogs(instanceId, options)
            },
            windowResize: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_window_resize')
              return bpm.windowResize(instanceId, options.width, options.height)
            },
            getNetworkLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_network')
              return bpm.getNetworkLogs(instanceId, options)
            },
            waitFor: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_wait')
              return bpm.waitFor(instanceId, options)
            },
            sendKey: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_key')
              return bpm.sendKey(instanceId, options)
            },
            getDownloads: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_downloads')
              return bpm.getDownloads(instanceId, options)
            },
            upload: async (ref, filePaths) => {
              const instanceId = await resolveSessionBrowserInstance('browser_upload')
              return bpm.uploadFile(instanceId, ref, filePaths).then(() => {})
            },
            scroll: async (direction, amount) => {
              const instanceId = await resolveSessionBrowserInstance('browser_scroll')
              return bpm.scroll(instanceId, direction, amount)
            },
            goBack: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_back')
              return bpm.goBack(instanceId)
            },
            goForward: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_forward')
              return bpm.goForward(instanceId)
            },
            evaluate: async (expression) => {
              const instanceId = await resolveSessionBrowserInstance('browser_evaluate')
              return bpm.evaluate(instanceId, expression)
            },
            focusWindow: async (targetInstanceId) => {
              const windows = await bpm.listInstancesAsync()
              if (windows.length === 0) {
                throw new Error('No browser windows available to focus. Use "open" first.')
              }

              const target = targetInstanceId
                ? windows.find(w => w.id === targetInstanceId)
                : windows.find(w => w.boundSessionId === sid || w.ownerSessionId === sid)

              if (!target) {
                if (targetInstanceId) {
                  throw new Error(`Browser window "${targetInstanceId}" not found. Use "windows" to list available windows.`)
                }
                throw new Error('No browser window is currently bound to this session. Use "open --foreground" to create or reuse one.')
              }

              const availableToSession = !target.boundSessionId || target.boundSessionId === sid
              if (!availableToSession) {
                throw new Error(`Browser window "${target.id}" is locked to session ${target.boundSessionId}.`)
              }

              if (!target.boundSessionId) {
                bpm.bindSession(target.id, sid, { workspaceId })
              }

              bpm.focus(target.id)
              const focused = await bpm.getInstanceAsync(target.id)
              return {
                instanceId: target.id,
                title: focused?.title ?? target.title,
                url: focused?.currentUrl ?? target.url,
              }
            },
            releaseControl: async (requestedInstanceId) => {
              if (requestedInstanceId === 'all') {
                const before = await bpm.listInstancesAsync()
                const beforeActive = before.filter((w) => !!w.agentControlActive).length
                bpm.clearAgentControl(sid)
                const after = await bpm.listInstancesAsync()
                const afterActive = after.filter((w) => !!w.agentControlActive).length
                const released = afterActive < beforeActive

                sessionLog.info(`[browser-pane] lifecycle release-all session=${sid} overlays=${beforeActive}->${afterActive}`)

                return {
                  action: released ? 'released' : 'noop',
                  requestedInstanceId,
                  affectedIds: released ? before.filter((w) => !!w.agentControlActive).map((w) => w.id) : [],
                  reason: released ? undefined : 'No active overlay was found for this session.',
                }
              }

              const resolution = await resolveLifecycleWindowTarget('release', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              const result = bpm.clearAgentControlForInstance(resolution.target.id, sid)
              const action = result.released ? 'released' : 'noop'
              sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=${action} reason=${result.reason ?? 'none'}`)

              return {
                action,
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: result.released ? [resolution.target.id] : [],
                reason: result.reason,
              }
            },
            closeWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('close', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.destroyInstance(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=closed`)

              return {
                action: 'closed',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            hideWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('hide', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.hide(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=hidden`)

              return {
                action: 'hidden',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            listWindows: async () => {
              return bpm.listInstancesAsync()
            },
            detectChallenge: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_detect_challenge')
              return bpm.detectSecurityChallenge(instanceId)
            },
          } satisfies BrowserPaneFns,
        })
      }

      // Set up permission handler to forward requests to renderer
      agent.onPermissionRequest = (request: {
        requestId: string;
        toolName: string;
        command?: string;
        description: string;
        type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
        appName?: string;
        reason?: string;
        impact?: string;
        requiresSystemPrompt?: boolean;
        rememberForMinutes?: number;
        commandHash?: string;
        approvalTtlSeconds?: number;
      }) => {
        if (!ownsGeneration()) return
        this.protectTurn(managed, 'permission')
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command)
        let brokerMetadata: {
          commandHash?: string
          approvalTtlSeconds?: number
        } = {}

        if (request.type === 'admin_approval' && request.command) {
          const brokerRequest = this.privilegedExecutionBroker.createRequest({
            requestId: request.requestId,
            sessionId: managed.id,
            command: request.command,
            reason: request.reason,
            impact: request.impact,
            approvalTtlSeconds: request.approvalTtlSeconds,
          })

          brokerMetadata = {
            commandHash: brokerRequest.commandHash,
            approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
          }
        }

        const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash

        this.pendingPermissionRequests.set(request.requestId, {
          sessionId: managed.id,
          type: request.type,
          commandHash: effectiveCommandHash,
        })

        if (request.type === 'admin_approval' && effectiveCommandHash && this.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)) {
          const brokerResult = this.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
            expectedCommandHash: effectiveCommandHash,
          })

          this.pendingPermissionRequests.delete(request.requestId)

          if (brokerResult.ok) {
            this.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
              sessionId: managed.id,
              requestId: request.requestId,
              commandHash: effectiveCommandHash,
            })
            const liveAgent = agent
            if (liveAgent) {
              liveAgent.respondToPermission(request.requestId, true, false)
              return
            }
          }

          sessionLog.warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`)
        }

        this.sendEvent({
          type: 'permission_request',
          sessionId: managed.id,
          request: {
            ...request,
            ...brokerMetadata,
            sessionId: managed.id,
          }
        }, managed.workspace.id)
      }

      // Note: Credential requests now flow through onAuthRequest (unified auth flow)
      // The legacy onCredentialRequest callback has been removed from CraftAgent
      // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
      // which destroys/recreates the agent to get fresh credentials

      // Set up mode change handlers
      agent.onPermissionModeChange = (mode) => {
        if (managed.permissionMode === mode) {
          return
        }

        managed.permissionMode = mode
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        managed.previousPermissionMode = diagnostics.previousPermissionMode
        sessionLog.info('Permission mode changed (agent callback)', {
          sessionId: managed.id,
          permissionMode: mode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
        this.sendEvent({
          type: 'permission_mode_changed',
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          previousPermissionMode: diagnostics.previousPermissionMode,
          transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id)
      }

      // Wire up onPlanSubmitted to add plan message to conversation
      agent.onPlanSubmitted = async (planPath) => {
        if (!ownsGeneration()) return
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        try {
          // Read the plan file content
          const planContent = await readFile(planPath, 'utf-8')
          if (!ownsGeneration()) return

          // Mark the SubmitPlan tool message as completed (it won't get a tool_result due to forceAbort)
          const submitPlanMsg = managed.messages.find(
            m => m.toolName?.includes('SubmitPlan') && m.toolStatus === 'executing'
          )
          if (submitPlanMsg) {
            submitPlanMsg.toolStatus = 'completed'
            submitPlanMsg.content = 'Plan submitted for review'
            submitPlanMsg.toolResult = 'Plan submitted for review'
          }

          // Create a plan message
          const planMessage = {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'plan' as const,
            content: planContent,
            timestamp: this.monotonic(),
            planPath,
          }

          // Add to session messages
          managed.messages.push(planMessage)

          // Update lastMessageRole for badge display
          managed.lastMessageRole = 'plan'

          // Send event to renderer
          this.sendEvent({
            type: 'plan_submitted',
            sessionId: managed.id,
            message: planMessage,
          }, managed.workspace.id)

          // Interrupt execution - plan presentation is a stopping point
          // The user needs to review and respond before continuing
          if (managed.isProcessing && agent) {
            sessionLog.info(`Interrupting for plan submission in session ${managed.id}`)
            if (managed.activeTurn?.agent === agent) managed.activeTurn.retireRuntimeAfterTurn = 'manual'
            agent.interruptForHandoff(AbortReason.PlanSubmitted)
            this.setProcessing(managed, false)

            // Release browser overlay + session binding because the agent is no longer running.
            // Plan submission pauses execution until user review, so browser ownership should not remain locked.
            await releaseBrowserOwnershipOnForcedStop(
              (sid) => this.getBrowserPaneManagerForSession(sid),
              managed.id,
            )

            // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
            this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)

            // Persist session state
            this.persistSession(managed)
          }
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }
      }

      // Wire up onAuthRequest to add auth message to conversation and pause execution
      agent.onAuthRequest = (request) => {
        if (!ownsGeneration()) return
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

        // Create auth-request message
        const authMessage: Message = {
          id: generateMessageId(),
          role: 'auth-request',
          content: this.getAuthRequestDescription(request),
          timestamp: this.monotonic(),
          authRequestId: request.requestId,
          authRequestType: request.type,
          authSourceSlug: request.sourceSlug,
          authSourceName: request.sourceName,
          authStatus: 'pending',
          // Copy type-specific fields for credentials
          ...(request.type === 'credential' && {
            authCredentialMode: request.mode,
            authLabels: request.labels,
            authDescription: request.description,
            authHint: request.hint,
            authHeaderName: request.headerName,
            authHeaderNames: request.headerNames,
            authSourceUrl: request.sourceUrl,
            authPasswordRequired: request.passwordRequired,
          }),
        }

        // Add to session messages
        managed.messages.push(authMessage)

        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request

        // Interrupt execution (like SubmitPlan)
        if (managed.isProcessing && agent) {
          sessionLog.info(`Interrupting for auth request in session ${managed.id}`)
          if (managed.activeTurn?.agent === agent) managed.activeTurn.retireRuntimeAfterTurn = 'manual'
          agent.interruptForHandoff(AbortReason.AuthRequest)
          this.setProcessing(managed, false)

          // Release browser overlay + session binding because the agent is paused awaiting user auth.
          void releaseBrowserOwnershipOnForcedStop(
            (sid) => this.getBrowserPaneManagerForSession(sid),
            managed.id,
          )

          // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)
        }

        // Emit auth_request event to renderer
        this.sendEvent({
          type: 'auth_request',
          sessionId: managed.id,
          message: authMessage,
          request: request,
        }, managed.workspace.id)

        // Persist session state
        this.persistSession(managed)

        // OAuth flow is client-driven via performOAuth() (preload).
        // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
      }

      // Wire up onSpawnSession to create independent sessions from agent tool calls
      agent.onSpawnSession = async (request) => {
        sessionLog.info(`Spawn session request from session ${managed.id}:`, request.name || '(unnamed)')

        const session = await this.createSession(managed.workspace.id, {
          name: request.name,
          llmConnection: request.llmConnection ?? managed.llmConnection,
          model: request.model ?? managed.model,
          enabledSourceSlugs: request.enabledSourceSlugs ?? managed.enabledSourceSlugs,
          permissionMode: request.permissionMode ?? managed.permissionMode,
          thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
          labels: request.labels ?? managed.labels,
          workingDirectory: request.workingDirectory,
          projectId: request.projectId ?? managed.projectId,
          // Spawned sessions become subtasks of the spawning session.
          parentSessionId: managed.id,
        })

        // Build FileAttachment[] from paths (if any)
        let fileAttachments: FileAttachment[] | undefined
        if (request.attachments?.length) {
          const attachments: FileAttachment[] = []
          for (const a of request.attachments) {
            try {
              const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
              if (request.workingDirectory) extraDirs.push(request.workingDirectory)
              const safePath = await validateFilePath(a.path, extraDirs)
              const attachment = readFileAttachment(safePath)
              if (attachment) {
                if (a.name) attachment.name = a.name
                attachments.push(attachment)
              } else {
                sessionLog.warn(`Spawn session: attachment not found: ${a.path}`)
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              sessionLog.warn(`Spawn session: blocked attachment path ${a.path}: ${message}`)
            }
          }
          if (attachments.length > 0) fileAttachments = attachments
        }

        // (session_created is emitted by createSession above.)

        // Fire and forget — send the message but don't await completion
        this.sendMessage(session.id, request.prompt, fileAttachments).catch(err => {
          sessionLog.error(`Failed to send message to spawned session ${session.id}:`, err)
        })

        return {
          sessionId: session.id,
          name: session.name || request.name || session.id,
          status: 'started' as const,
          connection: session.llmConnection,
          model: session.model,
        }
      }

      // Wire up session self-management and task tools. These are merged (not replaced) so
      // agent-owned callbacks and browser-pane callbacks stay registered across turns/restarts.
      mergeSessionScopedToolCallbacks(managed.id, {
        taskTools: this.createSessionTaskToolCallbacks(managed),
        setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
          await this.setSessionLabels(sessionId ?? managed.id, labels)
        },
        setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
          await this.setSessionStatus(sessionId ?? managed.id, status as SessionStatus)
        },
        getSessionInfoFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const session = this.sessions.get(targetId)
          if (!session) return null
          return {
            id: session.id,
            name: session.name ?? session.id,
            labels: session.labels ?? [],
            status: session.sessionStatus ?? 'todo',
            permissionMode: session.permissionMode ?? 'ask',
            createdAt: session.createdAt ?? 0,
            workingDirectory: session.workingDirectory,
            projectId: session.projectId,
            llmConnection: session.llmConnection,
            model: session.model,
            isActive: session.agent != null,
          }
        },
        listSessionsFn: (options) => {
          const DEFAULT_LIMIT = 20
          const MAX_LIMIT = 100
          const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const offset = options?.offset ?? 0

          let sessions = this.getSessions(managed.workspace.id)

          // Filter
          if (options?.status) {
            sessions = sessions.filter(s => s.sessionStatus === options.status)
          }
          if (options?.label) {
            sessions = sessions.filter(s => s.labels?.includes(options.label!))
          }
          if (options?.search) {
            const needle = options.search.toLowerCase()
            sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle))
          }

          // Sort
          const sortBy = options?.sortBy ?? 'recent'
          if (sortBy === 'recent') {
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          } else if (sortBy === 'name') {
            sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          } else if (sortBy === 'status') {
            sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''))
          }

          const total = sessions.length

          // Paginate
          const page = sessions.slice(offset, offset + limit)

          return {
            total,
            returned: page.length,
            sessions: page.map(s => ({
              id: s.id,
              name: s.name ?? s.id,
              labels: s.labels ?? [],
              status: s.sessionStatus ?? 'todo',
              createdAt: s.createdAt ?? 0,
              projectId: s.projectId,
            })),
          }
        },
        listBackgroundTasksFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const now = Date.now()
          return this.listBackgroundTasks(targetId).map((t) => {
            // Prefer wall-clock elapsed; running tasks tick off startTime, terminal
            // tasks freeze at completion. Fall back to the last progress value.
            const anchorEnd = t.status === 'running' ? now : (t.completedAt ?? now)
            const wallElapsed = Math.max(0, Math.round((anchorEnd - t.startTime) / 1000))
            return {
              taskId: t.taskId,
              intent: t.intent,
              status: t.status,
              startTime: t.startTime,
              elapsedSeconds: t.elapsedSeconds ?? wallElapsed,
              completedAt: t.completedAt,
            }
          })
        },
        resolveLabelsFn: (labels: string[]) => {
          const labelConfig = loadLabelConfig(managed.workspace.rootPath)
          return resolveSessionLabels(labels, labelConfig.labels)
        },
        resolveStatusFn: (status: string) => {
          const statusConfig = loadStatusConfig(managed.workspace.rootPath)
          const allStatuses = statusConfig.statuses
          const available = allStatuses.map(s => s.id)

          // Exact ID match
          const byId = allStatuses.find(s => s.id === status)
          if (byId) return { resolved: byId.id, available, category: byId.category }
          // Case-insensitive label → ID
          const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase())
          if (byLabel) return { resolved: byLabel.id, available, category: byLabel.category }

          return { resolved: null, available }
        },
        projectMemoryAddFn: async (input) => {
          const selection = resolveSessionManagedMemorySelectionFromRepository({
            workspaceId: managed.workspace.id,
            projectId: managed.projectId,
            enabledMemorySpaceRefs: managed.enabledMemorySpaceRefs,
            memoryWriteTargetRef: managed.memoryWriteTargetRef,
          }, {
            loadCredential: (connectionId) => {
              const manager = getCredentialManager()
              try {
                void manager.getMemoryApiKey(connectionId).catch(() => {})
              } catch {
                // Intentionally swallow to keep callback-only behavior.
              }
            },
          })
          if (selection.deniedRefs.length > 0) {
            const denied = selection.deniedRefs.map(formatSessionMemorySelectionDeniedReason).join('; ')
            throw new Error(`Invalid memory write selection: ${denied}`)
          }
          return getProjectMemoryStore().add(input)
        },
        projectMemorySearchFn: async (input) => {
          const selection = resolveSessionManagedMemorySelectionFromRepository({
            workspaceId: managed.workspace.id,
            projectId: managed.projectId,
            enabledMemorySpaceRefs: managed.enabledMemorySpaceRefs,
            memoryWriteTargetRef: managed.memoryWriteTargetRef,
          }, {
            loadCredential: (connectionId) => {
              const manager = getCredentialManager()
              try {
                void manager.getMemoryApiKey(connectionId).catch(() => {})
              } catch {
                // Intentionally swallow to keep callback-only behavior.
              }
            },
          })
          if (selection.deniedRefs.length > 0) {
            const denied = selection.deniedRefs.map(formatSessionMemorySelectionDeniedReason).join('; ')
            throw new Error(`Invalid memory search selection: ${denied}`)
          }
          return getProjectMemoryStore().search(input)
        },
        projectMemoryStatusFn: async () => getProjectMemoryStore().status(),
        sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => {
          // Build FileAttachment[] from paths (same pattern as spawn_session)
          let fileAttachments: FileAttachment[] | undefined
          if (attachments?.length) {
            const builtAttachments: FileAttachment[] = []
            for (const a of attachments) {
              try {
                const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
                const safePath = await validateFilePath(a.path, extraDirs)
                const attachment = readFileAttachment(safePath)
                if (attachment) {
                  if (a.name) attachment.name = a.name
                  builtAttachments.push(attachment)
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                sessionLog.warn(`send_agent_message: blocked attachment path ${a.path}: ${msg}`)
              }
            }
            if (builtAttachments.length > 0) fileAttachments = builtAttachments
          }

          // Capture the target's busy state BEFORE delivery so the sender gets a
          // truthful ack. A busy (mid-turn) target queues the message and replays
          // it after the current turn (anthropic defaults to 'queue'); an idle
          // target starts processing immediately. sendMessage throws for an
          // unknown session — that rejection propagates to the handler's catch.
          const targetBusy = this.sessions.get(sessionId)?.isProcessing === true
          await this.sendMessage(sessionId, message, fileAttachments)
          return {
            delivery: targetBusy ? ('queued' as const) : ('delivered' as const),
            targetBusy,
          }
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
          const cb = agent?.onSourceActivationRequest
          if (!cb) {
            return { ok: false, reason: 'Agent has no activation callback wired' }
          }
          const ok = await cb(sourceSlug)
          if (!ok) {
            return {
              ok: false,
              reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
            }
          }
          // Both backends need the current turn to end before new tools are visible:
          // Claude SDK freezes mcpServers at query() start; Pi only picks up new proxy
          // tool defs on the next handlePrompt (`toolsChanged` flag in pi-agent-server).
          // Mark a pending restart on the agent — ClaudeAgent/PiAgent consume it after
          // the next tool_result, yield source_activated, and forceAbort. The
          // `source_activated` handler in this class then schedules a server-side
          // resend of the original user message with a "[{slug} activated]" suffix —
          // landing in a fresh turn with tools live (craft-agents-oss#804).
          const userMessage = agent?.getCurrentTurnUserMessage?.() ?? ''
          if (userMessage) {
            agent?.setPendingSourceActivationRestart({ sourceSlug, userMessage })
          }
          return { ok: true, availability: 'next-turn' as const }
        },
      })

      // WS2 keep-alive: forward background task events that arrive BETWEEN turns
      // (idle — no chat() generator consuming) into the normal event pipeline, so
      // the running-task registry + renderer chips reflect a completion even when
      // it lands while the session is idle. During a turn these events flow through
      // the chat() generator as usual; this only covers the idle gap. No-op unless
      // the backend supports a persistent cross-turn query (Claude keep-alive).
      agent.setBackgroundEventSink?.((event: AgentEvent) => {
        if (!this.isCurrentRuntime(managed, generation, agent)) return
        void this.processEvent(managed, event, undefined, generation)
      })
      agent.onRuntimeExit = (event) => {
        if (!event.unexpected || !this.isCurrentRuntime(managed, generation, agent)) return
        void this.handleRuntimeFailure(managed, generation, agent, 'crash')
      }

      // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
      agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
        if (!ownsGeneration()) return false
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug)

        const workspaceRootPath = managed.workspace.rootPath

        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
          // Source is in the list but server might not be active (e.g., build failed previously)
        }

        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
          sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
          return false
        }

        // Track whether we added this slug (for rollback on failure)
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // Add to enabled sources if not already there
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(`Added source ${sourceSlug} to session enabled sources`)
        }

        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs || [])
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, agent?.getSummarizeCallback())

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // Check if our target source was built successfully
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // Only remove if WE added it (not if it was already there)
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        if (!ownsGeneration()) return false

        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map(s => s.config.slug)

        // Update bridge-mcp-server config/credentials for backends that need it
        await applyBridgeUpdates(agent!, sessionPath, allEnabledSources, mcpServers, managed.id, workspaceRootPath, 'source enable', poolServer?.url)

        await agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

        // Persist session with updated enabled sources
        this.persistSession(managed)

        // Notify renderer of source change
        this.sendEvent({
          type: 'sources_changed',
          sessionId: managed.id,
          enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id)

        return true
      }

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply session-scoped permission mode to the newly created agent
      // This ensures the UI toggle state is reflected in the agent before first message
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode)
        }
        agent!.setPermissionMode(managed.permissionMode)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        sessionLog.info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      if (!agent || generation.state !== 'creating' || managed.runtimeGeneration !== generation || this.closing) {
        throw new Error('Runtime construction cancelled')
      }

      // Publish the exact bundle atomically only after all construction succeeds.
      generation.state = 'ready'
      generation.agent = agent
      generation.mcpPool = mcpPool
      generation.poolServer = poolServer
      generation.envOverrides = envOverrides
      managed.agent = agent
      managed.mcpPool = mcpPool
      managed.poolServer = poolServer
      managed.envOverrides = envOverrides
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      managed.agentReadyResolve?.()
      managed.agentReadyResolve = undefined
      if (!managed.isProcessing) {
        managed.runtimeIdleSince = Date.now()
        void this.reapIdleRuntimes()
      }
      end()
      return agent
      } catch (error) {
        managed.agentReadyResolve?.()
        end()
        await this.disposeManagedAgentRuntime(managed, 'construction_failed', generation)
        throw error
      }
    })()

    generation.readyPromise = construction
    return construction
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async pinSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const pinnedAt = Date.now()
      managed.isPinned = true
      managed.pinnedAt = pinnedAt
      this.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace via generic metadata update
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { isPinned: true, pinnedAt } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unpinSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isPinned = false
      managed.pinnedAt = undefined
      this.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace via generic metadata update
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { isPinned: false, pinnedAt: undefined } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      this.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Set the LLM connection for a session.
   * Can only be changed before the first message is sent (connection is locked after).
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Only allow changing connection before first message (session hasn't started)
    if (managed.messages && managed.messages.length > 0) {
      sessionLog.warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    // Validate connection exists and is enabled for this workspace
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      sessionLog.warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }
    this.assertLlmConnectionEnabledForWorkspace(managed.workspace.rootPath, connectionSlug)

    managed.llmConnection = connectionSlug
    // Persist in-memory state directly to avoid race with pending queue writes
    this.persistSession(managed)
    await this.flushSession(managed.id)
    sessionLog.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    // Notify UI that connection changed (triggers capabilities refresh)
    this.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
  }

  // ============================================
  // Pending Plan Execution (Accept & Compact)
  // ============================================

  /**
   * Set pending plan execution state.
   * Called when user clicks "Accept & Compact" to persist the plan path
   * so execution can resume after compaction (even if page reloads).
   */
  async setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, planPath, draftInputSnapshot)
      sessionLog.info(`Session ${sessionId}: set pending plan execution for ${planPath}`)
    }
  }

  /**
   * Mark compaction as complete for pending plan execution.
   * Called when compaction_complete event fires - allows reload recovery
   * to know that compaction finished and plan can be executed.
   */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  /**
   * Mark pending plan execution as already dispatched from the UI.
   * This prevents reload recovery from double-submitting the same plan if
   * sending succeeded but cleanup failed due a reconnect/disconnect.
   */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: marked pending plan execution as dispatched`)
    }
  }

  /**
   * Clear pending plan execution state.
   * Called after plan execution is triggered, on new user message,
   * or when the pending execution is no longer relevant.
   */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /**
   * Get pending plan execution state for a session.
   * Used on reload/init to check if we need to resume plan execution.
   */
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  /**
   * Dispatch a plan approval for a session, equivalent to the desktop
   * "Accept plan" button. Switches the session out of Explore mode (safe)
   * into allow-all if needed so the plan can execute without per-tool
   * prompts, then sends the approval message through the normal sendMessage
   * path.
   */
  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`acceptPlan: session ${sessionId} not found`)
      return
    }

    if (managed.permissionMode === 'safe') {
      this.setSessionPermissionMode(sessionId, 'allow-all')
    }

    await this.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE)
  }

  // ============================================
  // Session Sharing
  // ============================================

  /**
   * Share session to the web viewer
   * Uploads session data and returns shareable URL
   */
  async shareToViewer(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = await response.json() as { id: string; url: string }

      // Store shared info in session
      managed.sharedUrl = data.url
      managed.sharedId = data.id
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      sessionLog.info(`Session ${sessionId} shared at ${data.url}`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_shared', sessionId, sharedUrl: data.url }, managed.workspace.id)
      return { success: true, url: data.url }
    } catch (error) {
      sessionLog.error('Share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update an existing shared session
   * Re-uploads session data to the same URL
   */
  async updateShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      sessionLog.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`)
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      sessionLog.error('Update share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Revoke a shared session
   * Deletes from viewer and clears local shared state
   */
  async revokeShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(
        `${VIEWER_URL}/s/api/${managed.sharedId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        sessionLog.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      // Clear shared info
      delete managed.sharedUrl
      delete managed.sharedId
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      sessionLog.info(`Session ${sessionId} share revoked`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unshared', sessionId }, managed.workspace.id)
      return { success: true }
    } catch (error) {
      sessionLog.error('Revoke error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  // ============================================
  // Session Sources
  // ============================================

  /**
   * Update session's enabled sources
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug))
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs)
      } catch (err) {
        sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      // Update bridge-mcp-server config/credentials for backends that need it
      const usableSources = sources.filter(isSourceUsable)
      await applyBridgeUpdates(managed.agent, sessionPath, usableSources, mcpServers, managed.id, workspaceRootPath, 'source config change', managed.poolServer?.url)

      await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // Persist the session with updated sources
    this.persistSession(managed)

    // Notify renderer of the source change
    this.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * Get the enabled source slugs for a session
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * Get the last final assistant message ID from a list of messages
   * A "final" message is one where:
   * - role === 'assistant' AND
   * - isIntermediate !== true (not commentary between tool calls)
   * Returns undefined if no final assistant message exists
   */
  private getLastFinalAssistantMessageId(messages: Message[]): string | undefined {
    // Iterate backwards to find the most recent final assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }

  /**
   * Read a session's final assistant message TEXT (in-process output reader for
   * the Tasks Conductor). `getLastFinalAssistantMessageId` is private and returns
   * an id; this wraps it to return the message content. Never exposed to agents —
   * child node output is read here, not via any tool/RPC.
   */
  getSessionFinalText(sessionId: string): string | undefined {
    const managed = this.sessions.get(sessionId)
    if (!managed) return undefined
    const id = this.getLastFinalAssistantMessageId(managed.messages)
    if (!id) return undefined
    return managed.messages.find(m => m.id === id)?.content
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  private isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Update lastReadMessageId for legacy/manual unread functionality
    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // Persist to disk
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden, non-archived sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.rootPath, managed.id, { hasUnread: false })
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.name = name
      this.persistSession(managed)
      // Notify renderer of the name change
      this.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Regenerate the session title based on recent messages.
   * Uses the last few user messages to capture what the session has evolved into.
   * Automatically uses the same provider as the session (Claude or OpenAI).
   */
  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    if (this.closing) return { success: false, error: 'Session runtime manager is shutting down' }
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    // Ensure messages are loaded from disk (lazy loading support)
    await this.ensureMessagesLoaded(managed)

    // Select a spread of user messages (first, middle, last) to capture the session's purpose
    const allUserContents = managed.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    const userMessages = selectSpreadMessages(allUserContents)

    sessionLog.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`)

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    // Get the most recent assistant response
    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    // Resolve title language from the explicitly persisted UI language (disk-backed,
    // race-free vs. main-process i18n async hydration); undefined => auto-detect (#885).
    const titleLanguage = resolveTitleLanguageName()
    const titleOptions = { language: titleLanguage }
    sessionLog.info(`[refreshTitle] language at call time`, {
      sessionId,
      persistedUiLanguage: getPersistedUiLanguage() ?? null,
      resolvedLanguage: i18n.resolvedLanguage ?? null,
      titleLanguage: titleLanguage ?? null,
    })

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        const resolvedMiniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: resolvedMiniModel,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        isTemporary = true
        await agent.postInit()
        sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`)
      } catch (error) {
        if (isTemporary && agent) await disposeBackendRuntime(agent, { reason: 'construction_failed' })
        sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error)
        return { success: false, error: 'Failed to create agent for title generation' }
      }
    }

    if (!agent) {
      sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)


    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)
    // Keep legacy event for backward compatibility
    this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: true }, managed.workspace.id)

    try {
      const title = await agent.regenerateTitle(userMessages, assistantResponse, titleOptions)
      sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // title_generated will also clear isRegeneratingTitle via the event handler
        this.sendEvent({ type: 'title_generated', sessionId, title }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      // Failed to generate - clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      // Error occurred - clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error)
      return { success: false, error: message }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        await disposeBackendRuntime(agent, { reason: 'manual' })
      }
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update the working directory for a session.
   *
   * If no messages have been sent yet (no SDK interaction), also updates sdkCwd
   * so the SDK will use the new path for transcript storage. This prevents the
   * confusing "bash shell runs from a different directory" warning when the user
   * changes the working directory before their first message.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const validation = isValidWorkingDirectory(path)
      if (!validation.valid) {
        sessionLog.warn(`Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`)
        this.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: validation.reason!,
        }, managed.workspace.id)
        return
      }

      managed.workingDirectory = path

      // Invalidate filesystem caches that depend on working directory
      invalidateContextFileCache(path)
      invalidateSkillsCache()

      // Check if we can also update sdkCwd (safe if no SDK interaction yet)
      // Conditions: no messages sent AND no agent created yet (no SDK session)
      const shouldUpdateSdkCwd =
        managed.messages.length === 0 &&
        !managed.sdkSessionId &&
        !managed.agent

      if (shouldUpdateSdkCwd) {
        managed.sdkCwd = path
        sessionLog.info(`Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`)
      }

      // Also update the agent's session config if agent exists
      if (managed.agent) {
        managed.agent.updateWorkingDirectory(path)
        // If agent exists but conditions still allow sdkCwd update (edge case),
        // update the agent's sdkCwd as well
        if (shouldUpdateSdkCwd) {
          managed.agent.updateSdkCwd(path)
        }
      }

      this.persistSession(managed)
      // Notify renderer of the working directory change
      this.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory: path }, managed.workspace.id)
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param connection - Optional LLM connection slug (only applied if not already locked)
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    sessionLog.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`)
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.model = model ?? undefined
      // Also update connection if provided and not already locked
      if (connection && !managed.connectionLocked) {
        this.assertLlmConnectionEnabledForWorkspace(managed.workspace.rootPath, connection)
        managed.llmConnection = connection
      }
      // Persist to disk (include connection if it was updated)
      const updates: { model?: string; llmConnection?: string } = { model: model ?? undefined }
      if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      // Update agent model if it already exists (takes effect on next query)
      if (managed.agent) {
        // Fallback chain: session model > workspace default > connection default
        const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const resolvedConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(managed.workspace.rootPath, managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
        const sessionConn = resolveSessionConnection(resolvedConnectionSlug, undefined)
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!
        sessionLog.info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`)
        managed.agent.setModel(effectiveModel)
      } else {
        sessionLog.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`)
      }
      // Notify renderer of the model change
      this.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * Update the content of a specific message in a session
   * Used by preview window to save edited content back to the original message
   */
  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update message: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update message: message ${messageId} not found in session ${sessionId}`)
      return
    }

    // Update the message content
    message.content = content
    // Persist the updated session
    this.persistSession(managed)
    sessionLog.info(`Updated message ${messageId} content in session ${sessionId}`)
  }

  /**
   * Add an annotation to a message and persist the session.
   */
  addMessageAnnotation(sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      sessionLog.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(a => a.id === safeAnnotation.id)) {
      sessionLog.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      sessionLog.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Patch an existing annotation on a message.
   */
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex(a => a.id === annotationId)
    if (idx === -1) {
      sessionLog.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      sessionLog.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Remove an annotation from a message and persist the session.
   */
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(a => a.id === annotationId)) {
      sessionLog.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(a => a.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Tombstone first so concurrent sends cannot recreate children during teardown.
    managed.deleting = true

    // Get workspace slug before deleting
    const workspaceRootPath = managed.workspace.rootPath

    // If processing is in progress, force-abort via Query.close() and wait for cleanup
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // Brief wait for the query to finish tearing down before we delete session files.
      // Prevents file corruption from overlapping writes during rapid delete operations.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Revoke share if session was shared (prevent orphaned viewer copies)
    if (managed.sharedId) {
      try {
        const { VIEWER_URL } = await import('@craft-agent/shared/branding')
        const response = await fetch(
          `${VIEWER_URL}/s/api/${managed.sharedId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(5000) }
        )
        if (!response.ok) {
          sessionLog.warn(`Failed to revoke share for ${sessionId}: HTTP ${response.status}`)
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }

    // Clean up delta flush timers to prevent orphaned timers
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }
    this.pendingDeltas.delete(sessionId)
    this.clearAdminRememberApprovalsForSession(sessionId)
    this.clearPendingPermissionRequestsForSession(sessionId)

    // Cancel any pending persistence write (session is being deleted, no need to save)
    sessionPersistenceQueue.cancel(sessionId)

    // Clean up session-scoped tool callbacks to prevent memory accumulation
    unregisterSessionScopedToolCallbacks(sessionId)

    // Destroy browser instances bound to this session
    const sessionBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (sessionBpm) {
      sessionBpm.destroyForSession(sessionId)
    }
    // Drop the per-session remote bridge + host-client pin on destroy.
    this.remoteBpms.delete(sessionId)
    this.browserHostByCanvas.delete(sessionId)

    if (managed.stopTimer) {
      clearTimeout(managed.stopTimer)
      managed.stopTimer = undefined
    }
    if (managed.activeTurn?.watchdogTimer) {
      clearTimeout(managed.activeTurn.watchdogTimer)
    }
    managed.activeTurn = undefined

    // Exact awaited bundle teardown includes agent/model child, pool server, and MCP transports.
    await this.disposeManagedAgentRuntime(managed, 'delete')

    // Cancel any pending source-activation auto-retry timer (craft-agents-oss#804).
    if (managed.autoRetryTimer) {
      clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
    }
    managed.autoRetryPending = undefined
    this.clearExternalMetadataGuardTimer(sessionId)
    managed.pendingExternalMetadata = undefined

    this.sessions.delete(sessionId)

    // Clean up session metadata in AutomationSystem (prevents memory leak)
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.removeSessionMetadata(sessionId)
    }

    // Delete from disk too
    deleteStoredSession(workspaceRootPath, sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)
    this.emitUnreadSummaryChanged()

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    /**
     * Internal hook fired after the user message has been pushed to
     * `managed.messages` and persisted to disk, but before the model-streaming
     * work begins. The RPC handler uses this to send a synchronous "accepted"
     * ack to the client so a crash mid-stream doesn't lose the user message
     * (#616). Pre-persist errors still reject the outer promise as before.
     */
    onAck?: (messageId: string) => void,
    /**
     * Optional transport context. The `sessions.sendMessage` RPC handler passes
     * `{ callerClientId: ctx.clientId }` so the SM can pin the desktop client
     * that should host this session's browser tools. Pass undefined when calling
     * directly (tests, intra-server flows) to leave the existing pin in place.
     */
    rpcContext?: { callerClientId?: string },
  ): Promise<void> {
    this.assertRuntimeAdmission()
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }
    if (managed.deleting) {
      throw new Error(`Session ${sessionId} is being deleted`)
    }
    const releaseAdmission = this.acquireWorkspaceAdmission(managed.workspace.id, 'session')
    try {
    // An explicit send/retry resumes FIFO after crash/watchdog/auth pause. Existing
    // queued message identities remain intact and are never silently discarded.
    if (!existingMessageId && managed.runtimeQueuePaused) managed.runtimeQueuePaused = false
    this.setLastMessageClientId(sessionId, rpcContext?.callerClientId)

    // Source-activation auto-retry dedup (craft-agents-oss#804). When the server
    // has just scheduled or committed a "[<slug> activated]" retry, drop a matching
    // duplicate that arrives from a legacy renderer still running the client-side
    // auto_retry. The first matching caller wins (server timer or legacy RPC,
    // whichever arrives first), subsequent matching calls within the deadline drop.
    if (claimAutoRetryPending(managed, message) === 'drop') {
      sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`)
      return
    }

    // Clear any pending plan execution state when a new user message is sent.
    // This acts as a safety valve - if the user moves on, we don't want to
    // auto-execute an old plan later.
    await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)

    // Ensure messages are loaded before we try to add new ones
    await this.ensureMessagesLoaded(managed)

    // If currently processing, behavior depends on the connection's
    // `midStreamBehavior` (resolved via {@link resolveMidStreamBehavior},
    // defaults to provider-appropriate value):
    //
    // - 'steer': try to deliver into the in-flight turn. Pi steers natively;
    //   Claude emulates via PreToolUse hook. If `redirect()` returns false
    //   (Claude with no live query, or backend can't steer), the backend has
    //   already called forceAbort(Redirect) and we queue for replay.
    // - 'queue': hold the message untouched; the current turn keeps running
    //   to natural completion; replay as a new turn afterwards. NO call to
    //   `agent.redirect()`, NO forceAbort, NO interruption.
    if (managed.isProcessing) {
      const connection = resolveSessionConnection(managed.llmConnection, undefined)
      // Fallback to 'steer' when no connection is resolvable — preserves
      // today's exact behavior (call redirect, take whatever it returns).
      const behavior = connection ? resolveMidStreamBehavior(connection) : 'steer'

      const agent = managed.agent
      let steered = false
      let steeredAnchorResolution: LabelSkillAnchorResolution | null = null
      if (behavior === 'steer') {
        // Auto-label and label-skill anchors must apply to steered messages too,
        // but the persisted visible user message remains the raw user text.
        try {
          const labelTree = listLabels(managed.workspace.rootPath)
          const autoMatches = evaluateAutoLabels(message, labelTree)
          if (autoMatches.length > 0) {
            const existingLabels = managed.labels ?? []
            const newEntries = autoMatches
              .map(m => `${m.labelId}::${m.value}`)
              .filter(entry => !existingLabels.includes(entry))
            if (newEntries.length > 0) {
              managed.labels = [...existingLabels, ...newEntries]
              this.persistSession(managed)
              this.sendEvent({ type: 'labels_changed', sessionId, labels: managed.labels }, managed.workspace.id)
            }
          }
        } catch (e) {
          sessionLog.warn(`Auto-label evaluation failed for steered session ${sessionId}:`, e)
        }

        steeredAnchorResolution = this.resolveLabelSkillAnchorsForSession(managed)
        const unpreparedSourceSlugs = this.getUnpreparedLabelSkillSourceSlugs(managed, steeredAnchorResolution)
        if (unpreparedSourceSlugs.length > 0) {
          // Do not inject source-dependent label-skill anchors into an in-flight
          // backend that has not seen those source servers. Queue instead; the
          // replay path below runs the normal pre-enable/source setup flow before
          // sending the hidden anchor block.
          sessionLog.info(`Queueing steered label-skill message until required sources are prepared: ${unpreparedSourceSlugs.join(', ')}`)
        } else {
          const steerMessage = steeredAnchorResolution?.block
            ? (message.startsWith('/compact')
                ? `${message}\n\n${steeredAnchorResolution.block}`
                : `${steeredAnchorResolution.block}\n\n${message}`)
            : message
          steered = agent?.redirect(steerMessage) ?? false
          if (steered) {
            this.persistLabelSkillAnchorState(managed, steeredAnchorResolution)
          }
        }
      }
      // For 'queue': skip redirect entirely. The current turn is undisturbed.

      sessionLog.info('mid-stream send', {
        sessionId,
        behavior,
        steered,
        queueLengthBefore: managed.messageQueue.length,
        backend: agent ? agent.constructor.name : 'none',
        connectionSlug: connection?.slug,
      })

      // Create user message for UI
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments,
        badges: options?.badges,
        // Hidden system-generated messages reach the model but never render as a
        // transcript bubble (e.g. background-task-completion nudge).
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)

      // Emit to UI — 'accepted' iff a steer succeeded; 'queued' otherwise
      // (covers both queue-direct and queue-after-abort paths).
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: steered ? 'accepted' : 'queued',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      if (!steered) {
        // Push for FIFO replay on next onProcessingStopped tick. Same shape
        // for both queue-direct (current turn still running) and
        // queue-after-abort (backend already aborted) — the replay path in
        // processNextQueuedMessage is identical.
        managed.messageQueue.push({ message, attachments, storedAttachments, options, messageId: userMessage.id, optimisticMessageId: options?.optimisticMessageId })
        managed.wasInterrupted = true
      }

      this.persistSession(managed)
      // Force a synchronous flush so the user message is genuinely on disk
      // before we tell the renderer "accepted" — `persistSession` only
      // enqueues with a 500ms debounce. (#616 reliability fix.)
      await this.flushSession(managed.id)
      onAck?.(userMessage.id)
      return
    }

    // Capture the pre-model-call conversation state before a fresh user message is
    // appended. Label-bound skill bootstrap eligibility is based on whether any
    // prior final assistant/model response exists, not on user-message counts after
    // this send is persisted.
    const labelSkillMessagesBeforeModelCall = [...managed.messages]
    const isQueuedReplayForLabelSkillBootstrap = Boolean(existingMessageId)

    // Add user message with stored attachments for persistence
    // Skip if existingMessageId is provided (message was already created when queued)
    let userMessage: Message
    if (existingMessageId) {
      // Find existing message (already added when queued)
      userMessage = managed.messages.find(m => m.id === existingMessageId)!
      if (!userMessage) {
        throw new Error(`Existing message ${existingMessageId} not found`)
      }
    } else {
      // Create new message
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments, // Include for persistence (has thumbnailBase64)
        badges: options?.badges,  // Include content badges (sources, skills with embedded icons)
        // Hidden system-generated messages reach the model but never render as a
        // transcript bubble (e.g. background-task-completion nudge).
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)

      // Update lastMessageRole for badge display. Skip for hidden messages so the
      // session-list preview isn't briefly driven by an invisible system nudge.
      if (!options?.hidden) {
        managed.lastMessageRole = 'user'
      }

      // Persist + flush before announcing — the user message must be
      // genuinely on disk before we tell the renderer "accepted", and
      // `persistSession` is debounced (500ms). #616.
      this.persistSession(managed)
      await this.flushSession(managed.id)
      onAck?.(userMessage.id)

      // Emit user_message event so UI can confirm the optimistic message
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      // If this is the first user message and no title exists, set one immediately
      // AI generation will enhance it later, but we always have a title from the start
      // Automation sessions (triggeredBy set) already have a title and skip AI generation entirely
      const isFirstUserMessage = managed.messages.filter(m => m.role === 'user').length === 1
      if (isFirstUserMessage && !managed.name && !managed.triggeredBy) {
        // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
        // so titles show human-readable names instead of raw IDs
        let titleSource = message
        if (options?.badges) {
          for (const badge of options.badges) {
            if (badge.rawText && badge.label) {
              titleSource = titleSource.replace(badge.rawText, badge.label)
            }
          }
        }
        // Sanitize: strip any remaining bracket mentions, XML blocks, tags
        const sanitized = sanitizeForTitle(titleSource)
        const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '')
        managed.name = initialTitle
        this.persistSession(managed)
        // Flush immediately so disk is authoritative before notifying renderer
        await this.flushSession(managed.id)
        this.sendEvent({
          type: 'title_generated',
          sessionId,
          title: initialTitle,
        }, managed.workspace.id)

        // Generate AI title asynchronously using agent's SDK
        // (waits briefly for agent creation if needed)
        this.generateTitle(managed, message)
      }
    }

    // Evaluate auto-label rules against the user message (common path for both
    // fresh and queued messages). Scans regex patterns configured on labels,
    // then merges any new matches into the session's label array.
    try {
      const labelTree = listLabels(managed.workspace.rootPath)
      const autoMatches = evaluateAutoLabels(message, labelTree)

      if (autoMatches.length > 0) {
        const existingLabels = managed.labels ?? []
        const newEntries = autoMatches
          .map(m => `${m.labelId}::${m.value}`)
          .filter(entry => !existingLabels.includes(entry))

        if (newEntries.length > 0) {
          managed.labels = [...existingLabels, ...newEntries]
          this.persistSession(managed)
          this.sendEvent({
            type: 'labels_changed',
            sessionId,
            labels: managed.labels,
          }, managed.workspace.id)
        }
      }
    } catch (e) {
      sessionLog.warn(`Auto-label evaluation failed for session ${sessionId}:`, e)
    }

    managed.lastMessageAt = Date.now()
    this.setProcessing(managed, true)
    managed.streamingText = ''
    managed.processingGeneration++
    const turnContext = this.beginTurn(managed)
    managed.turnStartFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)

    // Reset auth retry flag for this new message (allows one retry per message)
    // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
    // and resetting it would allow infinite retry loops
    // Note: authRetryInProgress is NOT reset here - it's managed by the retry logic
    if (!_isAuthRetry) {
      managed.authRetryAttempted = false
    }

    // Store message/attachments for potential retry after auth refresh
    // (SDK subprocess caches token at startup, so if it expires mid-session,
    // we need to recreate the agent and retry the message)
    managed.lastSentMessage = message
    managed.lastSentAttachments = attachments
    managed.lastSentStoredAttachments = storedAttachments
    managed.lastSentOptions = options

    // Capture the generation to detect if a new request supersedes this one.
    // This prevents the finally block from clobbering state when a follow-up message arrives.
    const myGeneration = turnContext.generation

    // Pre-enable sources required by invoked skills (Issue #249)
    // This eliminates the two-turn penalty where the agent discovers missing sources at runtime.
    // Uses targeted loadSkillBySlug() instead of loadAllSkills() to avoid O(N) filesystem scans.
    if (options?.skillSlugs?.length) {
      try {
        const workspaceRoot = managed.workspace.rootPath

        const requiredSources = new Set<string>()
        for (const slug of options.skillSlugs) {
          const skill = loadSkillBySlug(workspaceRoot, slug, managed.workingDirectory)
          if (skill?.metadata.requiredSources) {
            for (const src of skill.metadata.requiredSources) {
              requiredSources.add(src)
            }
          }
        }

        if (requiredSources.size > 0) {
          const currentSlugs = new Set(managed.enabledSourceSlugs || [])
          const toEnable: string[] = []
          const skipped: string[] = []
          const candidateSlugs = Array.from(requiredSources)
          const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs)
          const usableSources = new Set(
            loadedSources
              .filter(isSourceUsable)
              .map(source => source.config.slug)
          )

          for (const srcSlug of candidateSlugs) {
            if (currentSlugs.has(srcSlug)) continue
            if (usableSources.has(srcSlug)) {
              toEnable.push(srcSlug)
            } else {
              skipped.push(srcSlug)
            }
          }

          if (skipped.length > 0) {
            sessionLog.warn(`Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`)
          }

          if (toEnable.length > 0) {
            managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable]
            sessionLog.info(`Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`)
            this.persistSession(managed)
            this.sendEvent({
              type: 'sources_changed',
              sessionId,
              enabledSourceSlugs: managed.enabledSourceSlugs,
            }, managed.workspace.id)
          }
        }
      } catch (e) {
        sessionLog.warn(`Failed to pre-enable skill sources for session ${sessionId}:`, e)
      }
    }

    // Resolve compact label → skill bindings after auto-label evaluation and before
    // source/server setup. This does not read full SKILL.md bodies; it uses
    // metadata-only skill summaries and persists only anchor state for revocation.
    const labelSkillAnchorResolution = this.resolveLabelSkillAnchorsForSession(managed)
    this.persistLabelSkillAnchorState(managed, labelSkillAnchorResolution)
    const explicitSkillSlugsForBootstrap = extractExplicitSkillSlugsForLabelBootstrap(message, options)
    const labelSkillBootstrapForChat = this.buildLabelSkillBootstrapEntriesForSession(managed, labelSkillAnchorResolution, {
      messagesBeforeModelCall: labelSkillMessagesBeforeModelCall,
      isQueuedReplay: isQueuedReplayForLabelSkillBootstrap,
      explicitSkillSlugs: explicitSkillSlugsForBootstrap,
    })
    if (labelSkillBootstrapForChat?.entries.length) {
      this.markLabelSkillBootstrapAttempted(managed, labelSkillBootstrapForChat.entries, labelSkillAnchorResolution!.configHash)
      if (labelSkillBootstrapForChat.overflowBindingIds.length > 0) {
        sessionLog.info(`Label-skill bootstrap capped; overflow bindings remain compact-only: ${labelSkillBootstrapForChat.overflowBindingIds.join(', ')}`)
      }
    }

    if (labelSkillAnchorResolution?.requiredSourceSlugs.length) {
      try {
        const workspaceRoot = managed.workspace.rootPath
        const currentSlugs = new Set(managed.enabledSourceSlugs || [])
        const candidateSlugs = labelSkillAnchorResolution.requiredSourceSlugs
        const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs)
        const usableSources = new Set(
          loadedSources
            .filter(isSourceUsable)
            .map(source => source.config.slug)
        )
        const toEnable: string[] = []
        const skipped: string[] = []
        for (const srcSlug of candidateSlugs) {
          if (currentSlugs.has(srcSlug)) continue
          if (usableSources.has(srcSlug)) toEnable.push(srcSlug)
          else skipped.push(srcSlug)
        }
        if (skipped.length > 0) {
          sessionLog.warn(`Label-skill bindings require sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`)
        }
        if (toEnable.length > 0) {
          managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable]
          sessionLog.info(`Pre-enabled sources for label-skill bindings: ${toEnable.join(', ')}`)
          this.persistSession(managed)
          this.sendEvent({
            type: 'sources_changed',
            sessionId,
            enabledSourceSlugs: managed.enabledSourceSlugs,
          }, managed.workspace.id)
        }
      } catch (e) {
        sessionLog.warn(`Failed to pre-enable label-skill binding sources for session ${sessionId}:`, e)
      }
    }

    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    const workspaceRootPath = managed.workspace.rootPath
    const enabledSlugs = managed.enabledSourceSlugs ?? []
    const hasSources = enabledSlugs.length > 0

    // Load enabled sources up-front so we can refresh tokens BEFORE getOrCreateAgent
    // runs its internal cold-session build. Otherwise that build sees stale tokens
    // and emits AUTH_REQUIRED, causing a brief "needs_auth" UI flicker before the
    // post-build refresh restores state (#710).
    const sources: LoadedSource[] = hasSources
      ? getSourcesBySlugs(workspaceRootPath, enabledSlugs)
      : []

    if (hasSources && managed.tokenRefreshManager) {
      const refreshResult = await refreshExpiredCredentials(sources, managed.tokenRefreshManager)
      if (refreshResult.failedSources.length > 0) {
        sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug))
      }
      if (refreshResult.refreshedCount > 0) {
        sendSpan.mark('oauth.refreshed')
      }
    }

    // Get or create the exact runtime bundle. Setup failures must clear thinking
    // immediately instead of escaping before the streaming try/finally begins.
    let agent: AgentInstance
    try {
      agent = await this.getOrCreateAgent(managed)
      const generation = this.ensureRuntimeGeneration(managed)
      if (
        !generation
        || generation.state !== 'ready'
        || generation.agent !== agent
        || managed.activeTurn !== turnContext
        || managed.processingGeneration !== turnContext.generation
        || turnContext.terminalClaimed
      ) {
        throw new Error('Runtime generation changed during turn startup')
      }
      turnContext.runtimeEpoch = generation.epoch
      turnContext.agent = agent
      turnContext.phase = 'streaming'
      turnContext.lastActivityAt = Date.now()
      this.scheduleTurnWatchdog(managed, turnContext)
      sendSpan.mark('agent.ready')

    // Always set all sources for context (even if none are enabled), including built-ins
    const allSources = loadAllSources(workspaceRootPath)
    agent.setAllSources(allSources)
    sendSpan.mark('sources.loaded')

    // Apply source servers if any are enabled
    if (hasSources) {
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      // Single fresh build — tokens already refreshed above.
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      const mcpCount = Object.keys(mcpServers).length
      const apiCount = Object.keys(apiServers).length
      if (mcpCount > 0 || apiCount > 0 || enabledSlugs.length > 0) {
        const usableSources = sources.filter(isSourceUsable)
        const intendedSlugs = usableSources.map(s => s.config.slug)
        await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
        await applyBridgeUpdates(agent, sessionPath, usableSources, mcpServers, sessionId, workspaceRootPath, 'send message', managed.poolServer?.url)
        sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`)
      }
      sendSpan.mark('servers.applied')
    }
    } catch (error) {
      if (this.isCurrentTurn(managed, turnContext)) {
        this.appendRuntimeTerminalError(managed, 'crash')
        managed.runtimeQueuePaused = true
        turnContext.retireRuntimeAfterTurn = 'construction_failed'
        await this.onProcessingStopped(sessionId, 'error', turnContext)
        const failedGeneration = managed.runtimeGeneration
        if (failedGeneration) {
          await this.disposeManagedAgentRuntime(managed, 'construction_failed', failedGeneration)
        }
      }
      sendSpan.mark('runtime.setup.error')
      sendSpan.end()
      throw error
    }

    try {
      sessionLog.info('Starting chat for session:', sessionId)
      sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
      sessionLog.info('Message:', message)
      sessionLog.info('Agent model:', agent.getModel())
      sessionLog.info('process.cwd():', process.cwd())

      // Process the message through the agent
      sessionLog.info('Calling agent.chat()...')
      if (attachments?.length) {
        sessionLog.info('Attachments:', attachments.length)
      }

      // Skills mentioned via @mentions are handled by the SDK's Skill tool.
      // The UI layer (extractBadges in mentions.ts) injects fully-qualified names
      // in the rawText, and canUseTool in craft-agent.ts provides a fallback
      // to qualify short names. No transformation needed here.

      // Ensure main process reads tool metadata from the correct session directory.
      // This must be set before each chat() call since multiple sessions share the process.
      const chatSessionDir = getSessionStoragePath(workspaceRootPath, sessionId)
      toolMetadataStore.setSessionDir(chatSessionDir)

      // Inject interruption context so the LLM knows the previous turn was cut short.
      // Uses <system-reminder> tags so the LLM treats it as transient system guidance
      // rather than part of the user's message content. The original message is stored
      // in session JSONL (line ~3952); this only affects the SDK's in-process context.
      let effectiveMessage = message
      if (managed.wasInterrupted) {
        effectiveMessage = `${message}\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>`
        managed.wasInterrupted = false
      }

      const messageWorkspaceConfig = loadWorkspaceConfig(workspaceRootPath)
      const messageConnectionSlug = this.resolveWorkspaceLlmConnectionSlug(
        workspaceRootPath,
        managed.llmConnection,
        messageWorkspaceConfig?.defaults?.defaultLlmConnection,
      )
      const messageBackendContext = resolveBackendContext({
        sessionConnectionSlug: messageConnectionSlug,
        workspaceDefaultConnectionSlug: undefined,
        managedModel: managed.model,
      })
      const modelInputAttachments = filterAttachmentsForModelInput(
        attachments,
        messageBackendContext.connection,
        messageBackendContext.resolvedModel,
      )
      if (modelInputAttachments.omittedImages.length > 0) {
        const omittedNames = modelInputAttachments.omittedImages.map(a => a.name).join(', ')
        sessionLog.info(`Omitting ${modelInputAttachments.omittedImages.length} image attachment(s) from model input for ${messageBackendContext.resolvedModel}: ${omittedNames}`)
        this.sendEvent({
          type: 'info',
          sessionId,
          message: `Image attachment${modelInputAttachments.omittedImages.length === 1 ? '' : 's'} not sent because image input is disabled for ${messageBackendContext.resolvedModel}.`,
          level: 'warning',
        }, managed.workspace.id)
      }

      sendSpan.mark('chat.starting')
      const chatOptions = (labelSkillAnchorResolution?.block || labelSkillBootstrapForChat?.entries.length)
        ? {
            internal: {
              ...(labelSkillAnchorResolution?.block ? {
                labelSkillAnchors: {
                  block: labelSkillAnchorResolution.block,
                  kind: labelSkillAnchorResolution.blockKind === 'revocation' ? 'revocation' as const : 'active' as const,
                  activeBindingIds: labelSkillAnchorResolution.activeAnchors.map(anchor => anchor.bindingId),
                  configHash: labelSkillAnchorResolution.configHash,
                },
              } : {}),
              ...(labelSkillBootstrapForChat?.entries.length && labelSkillAnchorResolution ? {
                labelSkillBootstrap: {
                  entries: labelSkillBootstrapForChat.entries,
                  overflowBindingIds: labelSkillBootstrapForChat.overflowBindingIds,
                  configHash: labelSkillAnchorResolution.configHash,
                  onRegistered: (event: LabelSkillBootstrapRegisteredEvent) => {
                    this.markLabelSkillBootstrapCompleted(managed, event)
                  },
                },
              } : {}),
            },
          }
        : undefined
      const chatIterator = agent.chat(effectiveMessage, modelInputAttachments.attachments, chatOptions)
      sessionLog.info('Got chat iterator, starting iteration...')

      for await (const event of chatIterator) {
        // Log events (skip noisy text_delta)
        if (event.type !== 'text_delta') {
          if (event.type === 'tool_start') {
            sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`)
          } else if (event.type === 'tool_result') {
            sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`)
          } else {
            sessionLog.info('Got event:', event.type)
          }
        }

        // Process only events from the exact current turn/runtime. A late old
        // completion/error cannot mutate or terminalize a replacement turn.
        if (!this.isCurrentTurn(managed, turnContext, agent)) break
        await this.processEvent(managed, event, turnContext)
        if (!this.isCurrentTurn(managed, turnContext, agent)) break

        // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
        // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
        // which immediately flushes to disk. This fallback handles edge cases where the
        // callback might not fire (e.g., SDK version mismatch, callback not supported).
        if (!managed.sdkSessionId) {
          const sdkId = agent.getSessionId()
          if (sdkId) {
            managed.sdkSessionId = sdkId
            sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
            // Also flush here since we're in fallback mode
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          }
        }

        // Handle complete event - SDK always sends this (even after interrupt)
        // This is the central place where processing ends
        if (event.type === 'complete') {
          // Skip normal completion handling if auth retry is in progress
          // The retry will handle its own completion
          if (managed.authRetryInProgress) {
            sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling')
            sendSpan.mark('chat.complete.auth_retry_pending')
            sendSpan.end()
            return  // Exit function - retry will handle completion
          }

          // Auth/plan handoff paths already stopped processing and emitted a complete
          // event to the renderer. Ignore the backend's trailing complete to avoid
          // double cleanup and duplicate UI completion events.
          if (!managed.isProcessing) {
            sessionLog.info('Chat completed after explicit handoff/stop; skipping normal completion handling')
            sendSpan.mark('chat.complete.already_stopped')
            sendSpan.end()
            return
          }

          sessionLog.info('Chat completed via complete event')

          // Check if we got an assistant response in this turn
          // If not, the SDK may have hit context limits or other issues
          const lastAssistantMsg = [...managed.messages].reverse().find(m =>
            m.role === 'assistant' && !m.isIntermediate
          )
          const lastUserMsg = [...managed.messages].reverse().find(m => m.role === 'user')

          // If the last user message is newer than any assistant response, we got no reply
          // This can happen due to context overflow or API issues
          if (lastUserMsg && (!lastAssistantMsg || lastUserMsg.timestamp > lastAssistantMsg.timestamp)) {
            sessionLog.warn(`Session ${sessionId} completed without assistant response - possible context overflow or API issue`)

            // Check if there's a captured API error that explains the silent failure.
            // Pass explicit session path to avoid reading from the wrong session
            // (_sessionDir singleton can be clobbered by concurrent sessions).
            const sessionErrorPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
            const apiError = getLastApiError(sessionErrorPath)

            if (apiError && apiError.status === 400) {
              const isImageError = apiError.message?.includes('image exceeds')

              const errorMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: isImageError
                  ? `Image Too Large: ${apiError.message}`
                  : `Request Error: ${apiError.message}`,
                timestamp: this.monotonic(),
                errorCode: isImageError ? 'image_too_large' : 'invalid_request',
                errorTitle: isImageError ? 'Image Too Large' : 'Invalid Request',
                errorDetails: isImageError
                  ? ['An image in the conversation exceeds the 5 MB API limit.',
                     'This session cannot recover — the image is embedded in the history.',
                     'Please start a new session to continue.']
                  : [apiError.message],
                errorCanRetry: false,
              }
              managed.messages.push(errorMessage)
              this.sendEvent({
                type: 'typed_error',
                sessionId,
                error: {
                  code: isImageError ? 'image_too_large' as const : 'invalid_request' as const,
                  title: errorMessage.errorTitle!,
                  message: apiError.message,
                  actions: [],
                  canRetry: false,
                  details: errorMessage.errorDetails,
                },
              }, managed.workspace.id)
            }
          }

          sendSpan.mark('chat.complete')
          sendSpan.end()
          await this.onProcessingStopped(
            sessionId,
            turnContext.retireRuntimeAfterTurn ? 'error' : 'complete',
            turnContext,
          )
          return  // Exit function, skip finally block (onProcessingStopped handles cleanup)
        }

        // NOTE: We no longer break early on !isProcessing or stopRequested.
        // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
        // the generator to yield remaining queued events and then complete naturally.
        // This ensures we don't lose in-flight messages.
      }

      // Loop exited - either via complete event (normal) or generator ended after soft interrupt
      if (!managed.isProcessing) {
        sessionLog.info('Chat loop exited after explicit handoff/stop')
        sendSpan.mark('chat.exit.already_stopped')
        sendSpan.end()
      } else if (managed.stopRequested) {
        sessionLog.info('Chat loop completed after stop request - events drained successfully')
        await this.onProcessingStopped(sessionId, 'interrupted', turnContext)
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
      if (labelSkillBootstrapForChat?.entries.length && labelSkillAnchorResolution) {
        this.markLabelSkillBootstrapFailure(
          managed,
          labelSkillBootstrapForChat.entries.map(entry => ({ bindingId: entry.bindingId, labelId: entry.labelId, skillSlug: entry.skillSlug })),
          labelSkillAnchorResolution.configHash,
          error instanceof Error ? error.message : String(error),
        )
      }

      // Check if this is an abort error (expected when interrupted)
      const isAbortError = error instanceof Error && (
        error.name === 'AbortError' ||
        error.message === 'Request was aborted.' ||
        error.message.includes('aborted')
      )

      if (isAbortError) {
        // Extract abort reason if available (safety net for unexpected abort propagation)
        const reason = (error as DOMException).cause as AbortReason | undefined

        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
        sendSpan.mark('chat.aborted')
        sendSpan.setMetadata('abort_reason', reason || 'unknown')
        sendSpan.end()

        // UI handoff paths (plan submission, auth request) handle their own cleanup
        // by setting isProcessing = false directly. All other abort reasons route
        // through onProcessingStopped for queue draining.
        if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
          await this.onProcessingStopped(sessionId, 'interrupted', turnContext)
        }
      } else {
        sessionLog.error('Error in chat:', error)
        sessionLog.error('Error message:', error instanceof Error ? error.message : String(error))
        sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack')

        // Report chat/SDK errors via runtime hooks (Electron can forward to Sentry)
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat', sessionId })

        sendSpan.mark('chat.error')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        this.sendEvent({
          type: 'error',
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error'
        }, managed.workspace.id)
        // Handle error via centralized handler
        await this.onProcessingStopped(sessionId, 'error', turnContext)
      }
    } finally {
      // Only handle cleanup for unexpected exits (loop break without complete event)
      // Normal completion returns early after calling onProcessingStopped
      // Errors are handled in catch block
      if (managed.isProcessing && managed.processingGeneration === myGeneration && !turnContext.terminalClaimed) {
        sessionLog.info('Finally block cleanup - unexpected runtime exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
        await this.handleRuntimeFailure(
          managed,
          managed.runtimeGeneration,
          agent,
          'crash',
          turnContext,
        )
      }

      // Handoff/auth/error/cancel retirement happens only after the stream's
      // async iterator has unwound through this finally block.
      if (turnContext.retireRuntimeAfterTurn) {
        const generation = managed.runtimeGeneration
        if (generation && turnContext.runtimeEpoch === generation.epoch) {
          await this.disposeManagedAgentRuntime(managed, turnContext.retireRuntimeAfterTurn, generation)
        }
      }
      if (managed.activeTurn === turnContext && !managed.isProcessing) {
        if (turnContext.watchdogTimer) clearTimeout(turnContext.watchdogTimer)
        managed.activeTurn = undefined
        this.persistSession(managed)
      }
    }
    } finally {
      releaseAdmission()
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.isProcessing) {
      return // Not processing, nothing to cancel
    }

    sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '')

    // Collect queued message text for input restoration before clearing
    const queuedTexts = managed.messageQueue.map(q => q.message)

    // Collect queued message IDs so we can remove them from the messages array
    // (they were added when sendMessage was called during processing)
    const queuedMessageIds = new Set(
      managed.messageQueue.map(q => q.messageId).filter((id): id is string => !!id)
    )

    // Clear queue - user explicitly stopped, don't process queued messages
    managed.messageQueue = []

    // Remove queued user messages from the persisted messages array
    if (queuedMessageIds.size > 0) {
      managed.messages = managed.messages.filter(m => !queuedMessageIds.has(m.id))
    }

    // Signal intent to stop - let the event loop drain remaining events before clearing isProcessing.
    // Bind retirement and fallback timer to this exact turn generation.
    managed.stopRequested = true
    const turn = managed.activeTurn
    if (turn) turn.retireRuntimeAfterTurn = 'manual'

    // Track interruption so the next user message gets a context note
    // telling the LLM the previous response was cut short
    managed.wasInterrupted = true

    // Force-abort via Query.close() - sends soft interrupt to the backend
    if (managed.agent) {
      try {
        managed.agent.forceAbort(AbortReason.UserStop)
      } catch (error) {
        // Preserve interruption state/events and let the exact-generation
        // timeout/disposal fallback retire an uncooperative backend.
        sessionLog.warn(`UserStop signal failed for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      }
    }

    // Only show "Response interrupted" message when user explicitly clicked Stop
    // Silent mode is used when redirecting (sending new message while processing)
    if (!silent) {
      const interruptedMessage: Message = {
        id: generateMessageId(),
        role: 'info',
        content: 'Response interrupted',
        timestamp: this.monotonic(),
      }
      managed.messages.push(interruptedMessage)
      this.sendEvent({
        type: 'interrupted',
        sessionId,
        message: interruptedMessage,
        // Include queued texts so the UI can restore them to the input field
        ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
      }, managed.workspace.id)
    } else {
      // Still send interrupted event but without the message (for UI state update)
      this.sendEvent({
        type: 'interrupted',
        sessionId,
        // Include queued texts so the UI can restore them to the input field
        ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
      }, managed.workspace.id)
    }

    // Safety timeout: exact-turn fenced so an old stop timer can never kill a newer turn.
    if (managed.stopTimer) clearTimeout(managed.stopTimer)
    managed.stopTimer = setTimeout(() => {
      managed.stopTimer = undefined
      if (!turn || !this.isCurrentTurn(managed, turn) || !managed.stopRequested || !managed.isProcessing) return
      sessionLog.warn('Generator did not complete after stop request, forcing exact runtime cleanup')
      const generation = managed.runtimeGeneration
      const terminal = this.onProcessingStopped(sessionId, 'timeout', turn)
      if (generation) void this.disposeManagedAgentRuntime(managed, 'manual', generation)
      void terminal
    }, 5000)
    managed.stopTimer.unref?.()

    // NOTE: We don't clear isProcessing or send complete event here anymore.
    // The event loop will drain remaining events and call onProcessingStopped when done.
  }

  /**
   * Post-dispatch auth failures have no typed proof that the prompt was never
   * committed. Refresh credentials for the next explicit retry, fence the exact
   * runtime for disposal after stream unwind, and never auto-replay side effects.
   */
  private attemptAuthRetry(
    sessionId: string,
    managed: ManagedSession,
    workspaceId: string,
    _failureErrorCode?: string,
  ): boolean {
    if (managed.authRetryAttempted) return false

    managed.authRetryAttempted = true
    managed.authRetryInProgress = false
    managed.runtimeQueuePaused = true
    const turn = managed.activeTurn
    if (turn) turn.retireRuntimeAfterTurn = 'replacement'

    resetSummarizationClient()
    if (!this.closing) {
      void this.reinitializeAuth().catch((error) => {
        sessionLog.warn(`[auth-retry] Credential refresh failed for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      })
    }

    this.sendEvent({
      type: 'info',
      sessionId,
      message: 'Authentication expired. Credentials will refresh; retry this message explicitly.',
      level: 'warning',
      timestamp: this.monotonic(),
    }, workspaceId)

    // False deliberately lets the original typed/plain auth error persist and
    // remain retryable. Automatic replay is unsafe after backend invocation.
    return false
  }

  /**
   * Listeners for the in-process session-completion seam (see SessionCompletionEvent).
   * Used by the Tasks Conductor; empty until something subscribes, so zero overhead otherwise.
   */
  private sessionCompletionListeners = new Set<(evt: SessionCompletionEvent) => void>()

  /**
   * Subscribe to in-process session completion (Tasks Conductor seam).
   * Returns an unsubscribe function. Not a renderer event; not agent-facing.
   */
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.sessionCompletionListeners.add(listener)
    return () => {
      this.sessionCompletionListeners.delete(listener)
    }
  }

  private emitSessionComplete(evt: SessionCompletionEvent): void {
    if (this.sessionCompletionListeners.size === 0) return
    for (const listener of this.sessionCompletionListeners) {
      try {
        listener(evt)
      } catch (err) {
        sessionLog.error(`onSessionComplete listener threw for session ${evt.sessionId}:`, err)
      }
    }
  }

  /**
   * Central handler for when processing stops (any reason).
   * Single source of truth for cleanup and queue processing.
   *
   * @param sessionId - The session that stopped processing
   * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
   */
  private onProcessingStopped(
    sessionId: string,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
    expectedTurn?: ManagedTurnContext,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return Promise.resolve()
    const turn = expectedTurn ?? managed.activeTurn
    if (expectedTurn && managed.activeTurn !== expectedTurn) return Promise.resolve()
    if (turn?.terminalClaimed) return turn.terminalPromise ?? Promise.resolve()

    if (turn) {
      turn.terminalClaimed = true
      if (turn.watchdogTimer) clearTimeout(turn.watchdogTimer)
      turn.watchdogTimer = undefined
    }
    const terminalPromise = this.finalizeProcessingStopped(managed, reason, turn)
    if (turn) turn.terminalPromise = terminalPromise
    return terminalPromise
  }

  private async finalizeProcessingStopped(
    managed: ManagedSession,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
    turn?: ManagedTurnContext,
  ): Promise<void> {
    const sessionId = managed.id
    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    // 1. Cleanup state
    this.setProcessing(managed, false)
    managed.stopRequested = false  // Reset for next turn
    if (managed.stopTimer) {
      clearTimeout(managed.stopTimer)
      managed.stopTimer = undefined
    }

    // 1b. Orphan backstop: with the default per-turn subprocess model, any
    // background sub-agent still marked `running` dies when this turn's
    // subprocess is torn down. Flip those registry entries to `orphaned` so a
    // later "status?" query never reports a dead task as running. Suppressed
    // when WS2 keep-alive keeps the query alive across turns.
    this.markOrphanedBackgroundTasks(
      sessionId,
      turn?.retireRuntimeAfterTurn === 'watchdog' || turn?.retireRuntimeAfterTurn === 'backend_crash',
    )

    const turnStartFinalMessageId = managed.turnStartFinalMessageId
    managed.turnStartFinalMessageId = undefined

    // Clear agent control overlay between turns. The session keeps browser
    // ownership (boundSessionId) — only the visual overlay is removed.
    // Full unbind happens below when the queue is empty (session truly done).
    const turnBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (turnBpm) {
      // Same guard as the queue-empty teardown below: a remote BPM throw on a
      // headless server must not abort processing-stop handling.
      try {
        await turnBpm.clearVisualsForSession(sessionId)
      } catch (err) {
        sessionLog.warn(`Browser-pane visual clear failed for ${sessionId} (continuing):`, err)
      }
    }

    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    //    IMPORTANT: only apply this when the turn produced a NEW final assistant message.
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const currentFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        // User is watching - mark as read immediately
        await this.markSessionRead(sessionId)
      } else {
        // User is not watching - mark as unread for NEW badge
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.sessionStatus !== 'done') {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setSessionStatus(sessionId, 'done')
    }

    // 4. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
      this.clearExternalMetadataGuardTimer(sessionId)
      const pendingHeader = managed.pendingExternalMetadata
      managed.pendingExternalMetadata = undefined
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`)
      this.applyExternalSessionMetadata(managed, pendingHeader)
    }

    // 5. Check queue and process or complete. Crash/watchdog paths preserve
    // queued identities but pause automatic replay until explicit user action.
    if (managed.messageQueue.length > 0 && !managed.runtimeQueuePaused && !this.closing) {
      this.processNextQueuedMessage(sessionId)
    } else {
      // Session is truly done — release browser ownership.
      // The window stays alive (hidden) and becomes reusable by future sessions.
      // On the next turn, getOrCreateForSession() will re-bind it.
      const doneBpm = this.getBrowserPaneManagerForSession(sessionId)
      if (doneBpm) {
        // Teardown must never block completion. On a headless/WebUI server the BPM is
        // remote and these calls throw (BROWSER_NO_CAPABLE_CLIENT) when no desktop
        // browser client is connected — which previously aborted onProcessingStopped
        // before emitSessionComplete, hanging the Tasks Conductor completion seam.
        try {
          await doneBpm.clearVisualsForSession(sessionId)
          doneBpm.unbindAllForSession(sessionId)
        } catch (err) {
          sessionLog.warn(`Browser-pane teardown failed for ${sessionId} (continuing to completion):`, err)
        }
      }

      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,  // Propagate unread state to renderer
        // WS2: when keep-alive keeps the persistent query open across turns, the
        // turn ending does NOT kill background sub-agents. Tell the renderer so its
        // chip orphan-backstop does not falsely flip live tasks to `orphaned`; a
        // real `task_completed` will arrive when the agent actually finishes.
        backgroundTasksAlive: this.keepBackgroundTasksAlive,
      }, managed.workspace.id)

      // Tasks Conductor seam: signal true completion (queue empty) with the stop
      // reason + this turn's final assistant message, so the Conductor can advance
      // the corresponding node. In-process only; never sent to the renderer/agents.
      this.emitSessionComplete({
        sessionId,
        workspaceId: managed.workspace.id,
        reason,
        finalMessageId: currentFinalMessageId,
        finalText: currentFinalMessageId
          ? managed.messages.find(m => m.id === currentFinalMessageId)?.content
          : undefined,
        tokenUsage: managed.tokenUsage,
      })
    }

    // 6. Always persist, then mark the queue-empty/inactive runtime idle.
    this.persistSession(managed)
    if (managed.activeTurn === turn) managed.activeTurn = undefined
    if (!turn?.retireRuntimeAfterTurn && !managed.isProcessing && managed.runtimeGeneration?.state === 'ready') {
      managed.runtimeIdleSince = Date.now()
      void this.reapIdleRuntimes()
    }
  }

  /**
   * Process the next message in the queue.
   * Called by onProcessingStopped when queue has messages.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0 || managed.runtimeQueuePaused || managed.deleting || this.closing) return

    // Reserve admission before removing the queued item. This closes the
    // queue-shift → setImmediate gap where detach could otherwise observe an
    // empty queue before replay acquires sendMessage admission.
    const releaseReplayAdmission = this.acquireWorkspaceAdmission(managed.workspace.id, 'session')
    const next = managed.messageQueue.shift()!
    sessionLog.info('replay queued', {
      sessionId,
      messageId: next.messageId,
      queueLengthAfterShift: managed.messageQueue.length,
    })

    // Update UI: queued → processing
    if (next.messageId) {
      const existingMessage = managed.messages.find(m => m.id === next.messageId)
      if (existingMessage) {
        // Clear isQueued flag and persist - prevents re-queueing if crash during processing
        existingMessage.isQueued = false
        this.persistSession(managed)

        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: existingMessage,
          status: 'processing',
          optimisticMessageId: next.optimisticMessageId
        }, managed.workspace.id)
      }
    }

    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
      if (this.closing || managed.deleting) {
        releaseReplayAdmission()
        return
      }
      void this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId
      ).catch(err => {
        sessionLog.error('replay failed', {
          sessionId,
          messageId: next.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Report queued message failures via runtime hooks
        sessionRuntimeHooks.captureException(err, { errorSource: 'chat-queue', sessionId })
        // Surface a typed error so the UI can show a clear, actionable banner
        // instead of a generic "Unknown error" (#616).
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: 'queued_message_replay_failed',
            title: 'Queued message could not be sent',
            message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
            originalError: err instanceof Error ? err.message : String(err),
          },
        }, managed.workspace.id)
        // sendMessage setup/stream paths own terminalization; only backstop a
        // still-active turn here to avoid duplicate complete/error finalizers.
        if (managed.isProcessing) void this.onProcessingStopped(sessionId, 'error', managed.activeTurn)
      }).finally(releaseReplayAdmission)
    })
  }

  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`)

    // Try to kill the actual process using the stored command
    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        // Use pkill to find and kill processes matching the command
        // The -f flag matches against the full command line
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        // Escape the command for use in pkill pattern
        // We search for the unique command string in process args
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        sessionLog.info(`Attempting to kill process with command: ${command.slice(0, 100)}...`)

        // Use pgrep first to find the PID, then kill it
        // This is safer than pkill -f which can match too broadly
        try {
          const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`)
          const pids = stdout.trim().split('\n').filter(Boolean)

          if (pids.length > 0) {
            sessionLog.info(`Found ${pids.length} process(es) to kill: ${pids.join(', ')}`)
            // Kill each process
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid}`)
                sessionLog.info(`Sent SIGTERM to process ${pid}`)
              } catch (killErr) {
                // Process may have already exited
                sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`)
              }
            }
          } else {
            sessionLog.info(`No processes found matching command`)
          }
        } catch (pgrepErr) {
          // pgrep returns exit code 1 when no processes found, which is fine
          sessionLog.info(`No matching processes found (pgrep returned no results)`)
        }

        // Clean up the stored command
        managed.backgroundShellCommands.delete(shellId)
      } catch (err) {
        sessionLog.error(`Error killing shell process: ${err}`)
      }
    } else {
      sessionLog.warn(`No command stored for shell ${shellId}, cannot kill process`)
    }

    // Always emit shell_killed to remove from UI regardless of process kill success
    this.sendEvent({
      type: 'shell_killed',
      sessionId,
      shellId,
    }, managed.workspace.id)

    return { success: true }
  }

  /**
   * Evict stale entries from both background-task maps to bound memory.
   * - backgroundTaskOutputs: completed outputs older than 1h (existing behavior).
   * - backgroundTaskRegistry: terminal/orphaned entries older than 1h. Running
   *   entries are never evicted here (they are resolved on completion or orphaned
   *   at turn end).
   */
  private evictStaleBackgroundTasks(managed: ManagedSession): void {
    const ONE_HOUR = 3_600_000
    const now = Date.now()
    for (const [tid, info] of managed.backgroundTaskOutputs) {
      if (now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskOutputs.delete(tid)
        this.taskOutputIndex.delete(tid)
      }
    }
    for (const [tid, info] of managed.backgroundTaskRegistry) {
      if (info.status !== 'running' && info.completedAt && now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskRegistry.delete(tid)
      }
    }
  }

  /**
   * Mark still-running background tasks for a session as `orphaned`.
   *
   * Called when a turn finishes (onProcessingStopped). With the default per-turn
   * subprocess model, background sub-agents die when the query/subprocess is torn
   * down at turn end, but their terminal notifications may never arrive (or arrive
   * only on a later turn's subprocess). Marking them `orphaned` here keeps a
   * "status?" query truthful — it must never report a dead task as "running".
   *
   * No-op once WS2 keep-alive is enabled: with a persistent query the tasks
   * genuinely outlive the turn, so `keepBackgroundTasksAlive` short-circuits this.
   */
  private markOrphanedBackgroundTasks(sessionId: string, forceRuntimeRetired = false): void {
    if (this.keepBackgroundTasksAlive && !forceRuntimeRetired) return
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    const now = Date.now()
    let orphaned = 0
    for (const info of managed.backgroundTaskRegistry.values()) {
      if (info.status === 'running') {
        info.status = 'orphaned'
        info.completedAt = now
        orphaned++
      }
    }
    if (orphaned > 0) {
      sessionLog.info(`[bg-lifecycle] turn ended — orphaned ${orphaned} still-running background task(s)`, {
        sessionId,
      })
    }
  }

  /**
   * Enumerate background tasks for a session for a "status?" query.
   * Returns the main-process registry snapshot — the real source of truth across
   * subprocess boundaries (the SDK's in-subprocess task tools cannot see tasks
   * from a prior, torn-down subprocess).
   */
  listBackgroundTasks(sessionId: string): RunningBackgroundTask[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) return []
    return Array.from(managed.backgroundTaskRegistry.values())
      .map((t) => ({ ...t }))
      .sort((a, b) => b.startTime - a.startTime)
  }

  /**
   * Get output from a background task
   *
   * Looks up the output file stored when a task_completed event was received,
   * reads its contents, and returns them. Falls back to the SDK-provided summary
   * if the file cannot be read.
   *
   * @param taskId - The task or shell ID
   * @returns Task output content, or null if task not found
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    // O(1) lookup via taskOutputIndex
    const sessionId = this.taskOutputIndex.get(taskId)
    if (!sessionId) {
      sessionLog.info(`No output found for task: ${taskId} (task may still be running)`)
      return null
    }

    const managed = this.sessions.get(sessionId)
    const info = managed?.backgroundTaskOutputs.get(taskId)
    if (!info) {
      // Index out of sync — clean up stale entry
      this.taskOutputIndex.delete(taskId)
      return null
    }

    sessionLog.info(`Found output for task ${taskId}: file=${info.outputFile}, status=${info.status}`)
    try {
      const content = await readFile(info.outputFile, 'utf-8')
      // Delete after successful read to prevent memory leak
      managed!.backgroundTaskOutputs.delete(taskId)
      this.taskOutputIndex.delete(taskId)
      return content
    } catch (err) {
      sessionLog.error(`Failed to read task output file: ${info.outputFile}`, err)
      // Fall back to SDK-provided summary
      return info.summary || null
    }
  }

  /**
   * Respond to a pending permission request
   * Returns true if the response was delivered, false if agent/session is gone
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
          expectedCommandHash: requestMeta.commandHash,
        })
        if (!brokerResult.ok) {
          sessionLog.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`)
          // Broker rejection should fail closed.
          managed.agent.respondToPermission(requestId, false, false)
          this.resolvePermissionProtection(managed)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes)
        }
      }

      sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      this.resolvePermissionProtection(managed)
      return true
    } else {
      sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * Respond to a pending credential request
   * Returns true if the response was delivered, false if no pending request found
   *
   * Supports both:
   * - New unified auth flow (via handleCredentialInput)
   * - Legacy callback flow (via pendingCredentialResolvers)
   */
  async respondToCredential(sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.sessions.get(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  /**
   * Set the permission mode for a session ('safe', 'ask', 'allow-all')
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // No-op only when BOTH managed state and mode-manager state already match.
      // If managed state matches but diagnostics drifted, heal authoritative mode state.
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        sessionLog.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // Update in-memory managed mode first
      managed.permissionMode = mode

      // Reconcile mode-manager state for this specific session.
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      sessionLog.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // Forward to the agent instance so backends can propagate mode changes downstream.
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      }, managed.workspace.id)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      sessionLog.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  async setSessionLabels(sessionId: string, labels: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = labels
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Apply the reserved Task labeling to a session. Every task gets its own ITEM label —
   * a child of the root "Task" label named `TASK-<slug>-<N>` (plain boolean, no value) —
   * and the task's whole family carries that same item label, so one label filters one
   * task. Top-level sessions mint a fresh item label from their name; a session with
   * `parentSessionId` inherits the parent's item label — and a parent that lacks one (a
   * plain chat gaining its first subtask) is labeled in the same pass, so "becoming a
   * task" holds by construction. Idempotent: a session already carrying an item label
   * keeps it. Returns the resolved ITEM label id — slugs can collide-shift, so callers
   * MUST use it rather than deriving ids themselves.
   */
  async applyTaskLabel(
    sessionId: string,
    opts?: { parentSessionId?: string },
  ): Promise<{ labelId: string } | undefined> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return undefined
    const rootPath = managed.workspace.rootPath

    const itemOf = (labels: string[] | undefined): string | undefined =>
      findTaskItemLabelId(labels, loadLabelConfig(rootPath).labels)
    const withItemEntry = (labels: string[] | undefined, itemId: string): string[] => [
      ...(labels ?? []).filter(entry => extractLabelId(entry) !== itemId),
      itemId,
    ]

    const existing = itemOf(managed.labels)
    if (existing) return { labelId: existing }

    let itemId: string
    const parent = opts?.parentSessionId ? this.sessions.get(opts.parentSessionId) : undefined
    if (parent) {
      const parentItem = itemOf(parent.labels)
      if (parentItem) {
        itemId = parentItem
      } else {
        itemId = ensureTaskItemLabel(rootPath, parent.name || 'task').itemId
        await this.setSessionLabels(parent.id, withItemEntry(parent.labels, itemId))
      }
    } else {
      itemId = ensureTaskItemLabel(rootPath, managed.name || 'task').itemId
    }

    await this.setSessionLabels(sessionId, withItemEntry(managed.labels, itemId))
    return { labelId: itemId }
  }

  /**
   * Bind or unbind a session to/from a workspace project.
   * Pass `null` to unbind. The session's working directory is NOT changed retroactively —
   * the project binding is only used as a default for newly created sessions.
   */
  async setSessionProjectId(sessionId: string, projectId: string | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.projectId = projectId ?? undefined
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'project_id_changed',
        sessionId: managed.id,
        projectId: managed.projectId ?? null,
      }, managed.workspace.id)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  private resolveNextCustomGroupOrder(workspaceRootPath: string, customGroupId: string, excludeSessionId?: string): number {
    let maxOrder = -1
    for (const session of this.sessions.values()) {
      if (session.id === excludeSessionId) continue
      if (session.workspace.rootPath !== workspaceRootPath) continue
      if (session.customGroupId !== customGroupId) continue
      if (typeof session.customGroupOrder === 'number' && Number.isFinite(session.customGroupOrder)) {
        maxOrder = Math.max(maxOrder, session.customGroupOrder)
      }
    }
    return maxOrder + 1
  }

  /** Bind or unbind a session to/from a workspace custom chat group. */
  async setSessionCustomGroupId(sessionId: string, customGroupId: string | null, customGroupOrder?: number | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    const nextGroupId = customGroupId ?? undefined
    let nextOrder: number | undefined
    if (nextGroupId) {
      if (typeof customGroupOrder === 'number' && Number.isFinite(customGroupOrder)) {
        nextOrder = customGroupOrder
      } else if (managed.customGroupId === nextGroupId && typeof managed.customGroupOrder === 'number') {
        nextOrder = managed.customGroupOrder
      } else {
        nextOrder = this.resolveNextCustomGroupOrder(managed.workspace.rootPath, nextGroupId, sessionId)
      }
    }

    if (managed.customGroupId === nextGroupId && managed.customGroupOrder === nextOrder) return

    managed.customGroupId = nextGroupId
    managed.customGroupOrder = nextOrder
    this.setMetadataWriteGuard(managed)

    this.persistSession(managed)
    await this.flushSession(managed.id)
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { customGroupId: managed.customGroupId, customGroupOrder: managed.customGroupOrder } }, managed.workspace.id)
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
  }

  /** Reorder sessions within a single custom chat group. */
  async reorderCustomGroupSessions(anchorSessionId: string, customGroupId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return

    const anchor = this.sessions.get(anchorSessionId)
    if (!anchor) throw new Error(`Session ${anchorSessionId} not found`)
    const workspaceRootPath = anchor.workspace.rootPath
    const seen = new Set<string>()
    const targets: ManagedSession[] = []

    for (const id of sessionIds) {
      if (seen.has(id)) throw new Error(`Duplicate session id in reorder request: ${id}`)
      seen.add(id)
      const managed = this.sessions.get(id)
      if (!managed) throw new Error(`Session ${id} not found`)
      if (managed.workspace.rootPath !== workspaceRootPath) {
        throw new Error(`Cannot reorder sessions across workspaces: ${id}`)
      }
      if (managed.customGroupId !== customGroupId) {
        throw new Error(`Session ${id} does not belong to custom group ${customGroupId}`)
      }
      targets.push(managed)
    }

    if (targets.length <= 1) return

    const watcher = this.configWatchers.get(workspaceRootPath)
    for (const [index, managed] of targets.entries()) {
      if (managed.customGroupOrder === index) continue
      managed.customGroupOrder = index
      this.setMetadataWriteGuard(managed)
      this.persistSession(managed)
      this.sendEvent({ type: 'session_metadata_changed', sessionId: managed.id, changes: { customGroupId: managed.customGroupId, customGroupOrder: managed.customGroupOrder } }, managed.workspace.id)
      watcher?.notifyFileChange(`sessions/${managed.id}/session.jsonl`)
    }

    await Promise.all(targets.map(managed => this.flushSession(managed.id)))
  }

  /**
   * Set or clear the explicit Memory connection/space selection for a session.
   * This persists structurally canonical refs; availability/authorization is resolved at runtime.
   */
  async setSessionMemorySelection(
    sessionId: string,
    selection: {
      enabledMemorySpaceRefs?: SessionHeader['enabledMemorySpaceRefs']
      memoryWriteTargetRef?: SessionHeader['memoryWriteTargetRef']
      memorySelectionMode?: SessionHeader['memorySelectionMode']
    },
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    const normalized = normalizeSessionHeaderMemorySelection({
      id: managed.id,
      createdAt: managed.createdAt,
      workspaceRootPath: managed.workspace.rootPath,
      messages: [],
      tokenUsage: managed.tokenUsage,
      ...selection,
      lastUsedAt: managed.lastMessageAt ?? Date.now(),
      messageCount: managed.messages.length,
    } as unknown as SessionHeader)

    managed.enabledMemorySpaceRefs = normalized.enabledMemorySpaceRefs?.map(ref => ({ ...ref }))
    managed.memoryWriteTargetRef = normalized.memoryWriteTargetRef ? { ...normalized.memoryWriteTargetRef } : undefined
    managed.memorySelectionMode = normalized.memorySelectionMode
    this.setMetadataWriteGuard(managed)

    const changes = {
      enabledMemorySpaceRefs: managed.enabledMemorySpaceRefs,
      memoryWriteTargetRef: managed.memoryWriteTargetRef,
      memorySelectionMode: managed.memorySelectionMode,
    }
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id)
    this.persistSession(managed)
    await this.flushSession(managed.id)
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
  }

  /**
   * Set the kanban board column for a session ('todo' | 'in-progress' | 'done').
   * Pass `null` to clear (board falls back to the default column). Independent of sessionStatus.
   */
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.kanbanColumn = column ?? undefined
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Self-writes don't re-emit through the file watcher (kanbanColumn isn't in the header
      // signature), so push a live metadata event for the board to consume.
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { kanbanColumn: column ?? undefined } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Record the total DAG node count on a Conductor orchestrator session. The board uses this as a
   * stable progress denominator so it doesn't grow as child sessions are spawned lazily at dispatch.
   */
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.taskNodeCount = count
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Self-writes don't re-emit through the file watcher (taskNodeCount isn't in the header
      // signature), so push a live metadata event so the progress denominator updates immediately.
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { taskNodeCount: count } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Promote a hidden generate-time orchestrator (`taskDraft`) into the real, board-visible
   * orchestrator for `taskSlug`. This is the single narrow path that lets "Generate → Create & Run"
   * reuse the draft session instead of minting a second top-level tile (#bug1).
   *
   * Returns `true` on success (including an idempotent re-adopt of the same slug). Returns `false`
   * — leaving the session untouched — when the session is missing, isn't a draft, or is already
   * bound to a *different* slug. Callers fall back to `createSession` on `false`.
   *
   * Deliberately does NOT touch tools/sources/capabilities: the orchestrator keeps everything it
   * was created with so it can still author/verify the run.
   */
  async adoptGeneratedTaskOrchestrator(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn('adoptGeneratedTaskOrchestrator: session not found', { sessionId, taskSlug })
      return false
    }
    // Idempotency: already bound to this slug → no-op success. Bound to a different slug → refuse,
    // so a stale draft ref can't hijack an unrelated orchestrator.
    if (managed.taskSlug) {
      if (managed.taskSlug === taskSlug) return true
      sessionLog.warn('adoptGeneratedTaskOrchestrator: slug mismatch, refusing to rebind', {
        sessionId, existing: managed.taskSlug, requested: taskSlug,
      })
      return false
    }
    // Only hidden generate-time drafts are eligible. A non-draft session without a slug isn't a
    // generate orchestrator and must not be silently captured.
    if (!managed.taskDraft) {
      sessionLog.warn('adoptGeneratedTaskOrchestrator: session is not a task draft', { sessionId, taskSlug })
      return false
    }

    // What actually changes — so we fire canonical live-updates (agent + caches + per-field events)
    // only when needed. With generate now seeding model/connection/mode, these are usually all false.
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
    const connectionChanged = Boolean(
      reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection,
    )
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)

    // Promote task metadata (no canonical mutator for these). Connection is set directly because
    // setSessionConnection() refuses a session that has already sent messages (a generate draft has);
    // the connection_changed event below keeps the renderer in sync.
    managed.taskSlug = taskSlug
    managed.taskDraft = false
    if (reconcile?.projectId !== undefined) managed.projectId = reconcile.projectId
    if (connectionChanged) {
      this.assertLlmConnectionEnabledForWorkspace(managed.workspace.rootPath, reconcile!.llmConnection!)
      managed.llmConnection = reconcile!.llmConnection
    }
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
    if (renamed) managed.name = reconcile!.name!

    // Route model / cwd / permission mode through the canonical mutators so the LIVE agent, caches,
    // and per-field events stay consistent — not just the on-disk metadata (the split-brain the
    // follow-up review flagged). Each targets only the changed field; persist below captures the mode.
    if (modelChanged) await this.updateSessionModel(sessionId, managed.workspace.id, reconcile!.model!)
    if (cwdChanged) this.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!)
    if (modeChanged) this.setSessionPermissionMode(sessionId, reconcile!.permissionMode!)

    this.setMetadataWriteGuard(managed)
    this.persistSession(managed)
    await this.flushSession(managed.id)

    // One-shot board promotion: clearing taskDraft (sent as `false`, never `undefined` — undefined
    // is dropped over the JSON wire) reveals the already-announced tile; taskSlug/projectId
    // reconcile its metadata. `false` is falsy for the board's `if (meta.taskDraft)` skip.
    const changes: { taskDraft: boolean; taskSlug: string; projectId?: string } = { taskDraft: false, taskSlug }
    if (reconcile?.projectId !== undefined) changes.projectId = reconcile.projectId
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id)
    if (renamed) {
      this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
    }
    if (connectionChanged) {
      this.sendEvent({
        type: 'connection_changed',
        sessionId,
        connectionSlug: managed.llmConnection!,
        supportsBranching: resolveSupportsBranching(managed),
      }, managed.workspace.id)
    }
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    sessionLog.info('adoptGeneratedTaskOrchestrator: promoted draft', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
    return true
  }

  /**
   * User-initiated bind of an *existing, visible* session (e.g. a quick-add tile) to a task slug.
   *
   * This is distinct from {@link adoptGeneratedTaskOrchestrator}, which is the narrow draft-only
   * promotion path. A quick-add tile is a normal non-draft session with no `taskSlug`; the draft
   * guard there correctly refuses it, so the editor's "save this spec onto this tile" flow needs
   * its own path. The guard in the adopt method stays untouched.
   *
   * Returns `true` on success (including an idempotent re-bind of the same slug). Returns `false`
   * — leaving the session untouched — when the session is missing or already bound to a *different*
   * slug. Callers MUST treat `false` as a hard error and must NOT fall back to creating a fresh
   * orchestrator (that would mint a duplicate tile).
   *
   * Unlike adopt, this reconciles `llmConnection` too (a fresh create sets it; adopt skips it) so
   * the bound tile doesn't render a stale backend.
   */
  async bindExistingSessionToTask(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn('bindExistingSessionToTask: session not found', { sessionId, taskSlug })
      return false
    }
    if (managed.taskSlug) {
      if (managed.taskSlug === taskSlug) return true
      sessionLog.warn('bindExistingSessionToTask: slug mismatch, refusing to rebind', {
        sessionId, existing: managed.taskSlug, requested: taskSlug,
      })
      return false
    }

    // What actually changes — so we fire canonical live-updates (agent + caches + per-field events)
    // only when needed. A quick-add tile is already live, so these keep its running agent in step.
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
    const connectionChanged = Boolean(
      reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection,
    )
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)

    // Promote task metadata (no canonical mutator for these). Connection is set directly because
    // setSessionConnection() refuses a session that has already sent messages (a quick-add tile has);
    // the connection_changed event below keeps the renderer in sync.
    managed.taskSlug = taskSlug
    managed.taskDraft = false
    if (reconcile?.projectId !== undefined) managed.projectId = reconcile.projectId
    if (connectionChanged) {
      this.assertLlmConnectionEnabledForWorkspace(managed.workspace.rootPath, reconcile!.llmConnection!)
      managed.llmConnection = reconcile!.llmConnection
    }
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
    if (renamed) managed.name = reconcile!.name!

    // Route model / cwd / permission mode through the canonical mutators so the LIVE agent, caches,
    // and per-field events stay consistent — not just the on-disk metadata (the split-brain the
    // follow-up review flagged). updateSessionModel emits session_model_changed itself.
    if (modelChanged) await this.updateSessionModel(sessionId, managed.workspace.id, reconcile!.model!)
    if (cwdChanged) this.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!)
    if (modeChanged) this.setSessionPermissionMode(sessionId, reconcile!.permissionMode!)

    this.setMetadataWriteGuard(managed)
    this.persistSession(managed)
    await this.flushSession(managed.id)

    const changes: { taskDraft: boolean; taskSlug: string; projectId?: string } = { taskDraft: false, taskSlug }
    if (reconcile?.projectId !== undefined) changes.projectId = reconcile.projectId
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id)
    if (renamed) {
      this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
    }
    if (connectionChanged) {
      this.sendEvent({
        type: 'connection_changed',
        sessionId,
        connectionSlug: managed.llmConnection!,
        supportsBranching: resolveSupportsBranching(managed),
      }, managed.workspace.id)
    }
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    sessionLog.info('bindExistingSessionToTask: bound existing session', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
    return true
  }

  /**
   * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Generate an AI title for a session from the user's first message.
   * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
   * If no agent exists, creates a temporary one using the session's connection.
   */
  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    if (this.closing || managed.deleting) return
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10 && !this.closing && !managed.deleting) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
      if (this.closing || managed.deleting) return
      agent = managed.agent
    }

    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        isTemporary = true
        await agent.postInit()
        sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`)
      } catch (error) {
        if (isTemporary && agent) await disposeBackendRuntime(agent, { reason: 'construction_failed' })
        sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error)
        return
      }
    }

    if (!agent) {
      sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`)
      return
    }

    try {
      // Race-free language resolution from persisted UI language; undefined => auto-detect (#885).
      const titleLanguage = resolveTitleLanguageName()
      sessionLog.info(`[generateTitle] language at call time`, {
        sessionId: managed.id,
        persistedUiLanguage: getPersistedUiLanguage() ?? null,
        resolvedLanguage: i18n.resolvedLanguage ?? null,
        titleLanguage: titleLanguage ?? null,
      })
      const title = await agent.generateTitle(userMessage, { language: titleLanguage })
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // Flush immediately to ensure disk is up-to-date before notifying renderer.
        // This prevents race condition where lazy loading reads stale disk data
        // (the persistence queue has a 500ms debounce).
        await this.flushSession(managed.id)
        // Now safe to notify renderer - disk is authoritative
        this.sendEvent({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id)
        sessionLog.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        sessionLog.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      sessionLog.error(`Failed to generate title for session ${managed.id}:`, error)

      // Surface quota/auth errors to the user — these indicate the main chat call will also fail
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
        this.sendEvent({
          type: 'typed_error',
          sessionId: managed.id,
          error: {
            code: 'provider_error',
            title: 'API Error',
            message: `API error: ${errorMsg.slice(0, 200)}`,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
          }
        }, managed.workspace.id)
      }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        await disposeBackendRuntime(agent, { reason: 'manual' })
      }
    }
  }

  private async processEvent(
    managed: ManagedSession,
    event: AgentEvent,
    expectedTurn?: ManagedTurnContext,
    expectedRuntime?: ManagedRuntimeGeneration,
  ): Promise<void> {
    if (expectedTurn && !this.isCurrentTurn(managed, expectedTurn, expectedTurn.agent)) return
    if (expectedRuntime && !this.isCurrentRuntime(managed, expectedRuntime, expectedRuntime.agent)) return
    if (expectedTurn) this.noteTurnActivity(managed, expectedTurn, event)

    const sessionId = managed.id
    const workspaceId = managed.workspace.id

    switch (event.type) {
      case 'text_delta':
        managed.streamingText += event.text
        // Queue delta for batched sending (performance: reduces IPC from 50+/sec to ~20/sec)
        this.queueDelta(sessionId, workspaceId, event.text, event.turnId)
        break

      case 'text_complete': {
        // Flush any pending deltas before sending complete (ensures renderer has all content)
        this.flushDelta(sessionId, workspaceId)

        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.monotonic(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        }
        managed.messages.push(assistantMessage)
        managed.streamingText = ''

        // Update lastMessageRole and lastFinalMessageId for badge/unread display (only for final messages)
        if (!event.isIntermediate) {
          managed.lastMessageRole = 'assistant'
          managed.lastFinalMessageId = assistantMessage.id

          const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)

          // Claude branch-cutoff support: persist message UUID + SDK session lineage in sidecar.
          // Used to guard resumeSessionAt so we only send anchors valid for the parent SDK session.
          if (event.turnId && managed.sdkSessionId && isClaudeMessageUuid(event.turnId)) {
            try {
              await saveClaudeTurnAnchor(sessionPath, assistantMessage.id, managed.sdkSessionId, event.turnId)
            } catch (error) {
              sessionLog.warn(`Failed to persist Claude turn anchor for session ${sessionId}:`, error)
            }
          }

          // Pi branch-cutoff support: remember the SDK message id → Craft
          // assistant message id mapping. The actual anchor arrives as a
          // separate `pi_turn_anchor` event one microtask later — the SDK
          // updates its leaf only AFTER firing message_end (see #782).
          if (event.sdkMessageId) {
            let cache = managed.piSdkMessageToCraftMessage
            if (!cache) {
              cache = new Map()
              managed.piSdkMessageToCraftMessage = cache
            }
            cache.set(event.sdkMessageId, assistantMessage.id)
            // Prune oldest entries when over the cap. Map preserves insertion
            // order, so the first key is the oldest.
            if (cache.size > PI_SDK_MESSAGE_ID_CACHE_LIMIT) {
              const oldest = cache.keys().next().value
              if (oldest !== undefined) cache.delete(oldest)
            }
          }
        }

        this.sendEvent({ type: 'text_complete', sessionId, text: event.text, isIntermediate: event.isIntermediate, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: assistantMessage.timestamp, messageId: assistantMessage.id }, workspaceId)

        // Persist session after complete message to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'pi_turn_anchor': {
        // Follow-up to a `text_complete` from the Pi backend, carrying the
        // correct leaf id captured AFTER the SDK appended its assistant entry
        // (the synchronous `message_end` listener could not see it — #782).
        // Look up the Craft assistant message id by SDK message id and
        // persist the anchor to the sidecar.
        const cache = managed.piSdkMessageToCraftMessage
        const craftMessageId = cache?.get(event.sdkMessageId)
        if (!craftMessageId) {
          sessionLog.debug(`pi_turn_anchor for unknown sdkMessageId=${event.sdkMessageId}; ignoring`)
          break
        }
        const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)
        try {
          await savePiTurnAnchor(sessionPath, craftMessageId, event.sdkTurnAnchor)
        } catch (error) {
          sessionLog.warn(`Failed to persist Pi turn anchor for session ${sessionId}:`, error)
        }
        break
      }

      case 'tool_start': {
        // Format tool input paths to relative for better readability
        const formattedToolInput = formatToolInputPaths(event.input)

        // Resolve call_llm model for TurnCard badge display.
        // Resolve call_llm model short names to full IDs for display.
        // Note: Pi sessions override the model in PiEventAdapter (call_llm always uses miniModel).
        if (event.toolName === 'mcp__session__call_llm' && formattedToolInput?.model) {
          const shortName = String(formattedToolInput.model)
          const modelDef = MODEL_REGISTRY.find(m => m.id === shortName)
            || MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === shortName.toLowerCase())
            || MODEL_REGISTRY.find(m => m.name.toLowerCase() === shortName.toLowerCase())
          if (modelDef) {
            formattedToolInput.model = modelDef.id
          }
        }

        // Resolve tool display metadata (icon, displayName) for skills/sources
        // Only resolve when we have input (second event for SDK dual-event pattern)
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources)
        }

        // Check if a message with this toolUseId already exists FIRST
        // SDK sends two events per tool: first from stream_event (empty input),
        // second from assistant message (complete input)
        const existingStartMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        const isDuplicateEvent = !!existingStartMsg

        // Use parentToolUseId directly from the event — CraftAgent resolves this
        // from SDK's parent_tool_use_id (authoritative, handles parallel Tasks correctly).
        // No stack or map needed; the event carries the correct parent from the start.
        const parentToolUseId = event.parentToolUseId

        // Track if we need to send an event to the renderer
        // Send on: first occurrence OR when we have new input data to update
        let shouldSendEvent = !isDuplicateEvent

        if (existingStartMsg) {
          // Update existing message with complete input (second event has full input)
          if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
            const hadInputBefore = existingStartMsg.toolInput && Object.keys(existingStartMsg.toolInput).length > 0
            existingStartMsg.toolInput = formattedToolInput
            // Send update event if we're adding input that wasn't there before
            if (!hadInputBefore) {
              shouldSendEvent = true
            }
          }
          // Also set parent if not already set
          if (parentToolUseId && !existingStartMsg.parentToolUseId) {
            existingStartMsg.parentToolUseId = parentToolUseId
          }
          // Set toolDisplayMeta if not already set (has base64 icon for viewer)
          if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
            existingStartMsg.toolDisplayMeta = toolDisplayMeta
          }
          // Update toolIntent if not already set (second event has intent from complete input)
          if (event.intent && !existingStartMsg.toolIntent) {
            existingStartMsg.toolIntent = event.intent
          }
          // Update toolDisplayName if not already set
          if (event.displayName && !existingStartMsg.toolDisplayName) {
            existingStartMsg.toolDisplayName = event.displayName
          }
        } else {
          // Add tool message immediately (will be updated on tool_result)
          // This ensures tool calls are persisted even if they don't complete
          const toolStartMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${event.toolName}...`,
            timestamp: this.monotonic(),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput,
            toolStatus: 'executing',
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
          }
          managed.messages.push(toolStartMessage)
        }

        // Activate browser agent control overlay on actionable browser tool starts.
        // Skip browser_tool help/release commands to avoid pointless overlay flashes.
        const shouldActivateOverlay = shouldActivateBrowserOverlay(
          event.toolName,
          formattedToolInput,
        )

        const overlayBpm = this.getBrowserPaneManagerForSession(sessionId)
        if (overlayBpm && shouldActivateOverlay) {
          // Ensure first browser action in a turn gets an instance before overlay activation.
          overlayBpm.getOrCreateForSession(sessionId, { workspaceId })

          const resolvedDisplayName = toolDisplayMeta?.displayName
            ?? event.displayName
            ?? event.toolName
          overlayBpm.setAgentControl(
            sessionId,
            { displayName: resolvedDisplayName, intent: event.intent },
            { workspaceId },
          )
        }

        // Send event to renderer on first occurrence OR when input data is updated
        if (shouldSendEvent) {
          const timestamp = existingStartMsg?.timestamp ?? this.monotonic()
          this.sendEvent({
            type: 'tool_start',
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput ?? {},
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
            timestamp,
          }, workspaceId)
        }
        break
      }

      case 'tool_result': {
        // toolName comes directly from CraftAgent (resolved via ToolIndex)
        const toolName = event.toolName || 'unknown'

        // Format absolute paths to relative paths for better readability
        const rawFormattedResult = event.result ? formatPathsToRelative(event.result) : ''

        // Safety net: prevent massive tool results from bloating session JSONL (protects all backends)
        const MAX_PERSISTED_RESULT_CHARS = 200_000 // ~50K tokens
        const formattedResult = rawFormattedResult.length > MAX_PERSISTED_RESULT_CHARS
          ? rawFormattedResult.slice(0, MAX_PERSISTED_RESULT_CHARS) +
            `\n\n[Truncated for storage: ${rawFormattedResult.length.toLocaleString()} chars total]`
          : rawFormattedResult

        // Some backends omit explicit isError but still prefix with [ERROR].
        const inferredError = event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(formattedResult)

        // Update existing tool message (created on tool_start) instead of creating new one
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        // Track if already completed to avoid sending duplicate events
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed'

        sessionLog.info(`RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}`)

        // parentToolUseId comes from CraftAgent (SDK-authoritative) or existing message
        const parentToolUseId = existingToolMsg?.parentToolUseId || event.parentToolUseId

        if (existingToolMsg) {
          // Keep lightweight status text in `content` and store full payload in `toolResult` only.
          existingToolMsg.toolResult = formattedResult
          existingToolMsg.toolStatus = inferredError ? 'error' : 'completed'
          existingToolMsg.isError = inferredError
          // If message doesn't have parent set, use event's parentToolUseId
          if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
            existingToolMsg.parentToolUseId = event.parentToolUseId
          }
        } else {
          // No matching tool_start found — create message from result.
          // This is normal for background subagent child tools where tool_result arrives
          // without a prior tool_start. If tool_start arrives later, findToolMessage will
          // locate this message by toolUseId and update it with input/intent/displayMeta.
          sessionLog.info(`RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`)
          const fallbackWorkspaceRootPath = managed.workspace.rootPath
          const fallbackSources = loadAllSources(fallbackWorkspaceRootPath)
          const fallbackToolDisplayMeta = await resolveToolDisplayMeta(toolName, undefined, fallbackWorkspaceRootPath, fallbackSources)

          const toolMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: '',
            timestamp: this.monotonic(),
            toolName: toolName,
            toolUseId: event.toolUseId,
            toolResult: formattedResult,
            toolStatus: inferredError ? 'error' : 'completed',
            toolDisplayMeta: fallbackToolDisplayMeta,
            parentToolUseId,
            isError: inferredError,
          }
          managed.messages.push(toolMessage)
        }

        // Send event to renderer if: (a) first completion, or (b) result content changed
        // (e.g., safety net auto-completed with empty result, then real result arrived later)
        const resultChanged = wasAlreadyComplete && formattedResult && existingToolMsg?.toolResult !== formattedResult
        if (!wasAlreadyComplete || resultChanged) {
          // Use existing tool message timestamp, or fallback message timestamp for ordering
          const toolResultTimestamp = existingToolMsg?.timestamp ?? (managed.messages.find(m => m.toolUseId === event.toolUseId)?.timestamp)
          this.sendEvent({
            type: 'tool_result',
            sessionId,
            toolUseId: event.toolUseId,
            toolName: toolName,
            result: formattedResult,
            turnId: event.turnId,
            parentToolUseId,
            isError: inferredError,
            timestamp: toolResultTimestamp,
          }, workspaceId)
        }

        // Safety net: when a parent Task completes, mark all its still-pending child tools as completed.
        // This handles the case where child tool_result events never arrive (e.g., subagent internal tools
        // whose results aren't surfaced through the parent stream).
        if (isParentTaskTool(toolName) || toolName === 'TaskOutput') {
          const pendingChildren = managed.messages.filter(
            m => m.parentToolUseId === event.toolUseId
              && m.toolStatus !== 'completed'
              && m.toolStatus !== 'error'
          )
          for (const child of pendingChildren) {
            child.toolStatus = 'completed'
            child.toolResult = child.toolResult || ''
            sessionLog.info(`CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`)
            this.sendEvent({
              type: 'tool_result',
              sessionId,
              toolUseId: child.toolUseId!,
              toolName: child.toolName || 'unknown',
              result: child.toolResult || '',
              turnId: child.turnId,
              parentToolUseId: event.toolUseId,
            }, workspaceId)
          }
        }

        // Persist session after tool completes to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'status':
        this.sendEvent({
          type: 'status',
          sessionId,
          message: event.message,
          statusType: event.message.includes('Compacting') ? 'compacting' : undefined
        }, workspaceId)
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')
        const infoTimestamp = this.monotonic()

        // Persist compaction messages so they survive reload
        // Other info messages are transient (just sent to renderer)
        if (isCompactionComplete) {
          const compactionMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: event.message,
            timestamp: infoTimestamp,
            statusType: 'compaction_complete',
          }
          managed.messages.push(compactionMessage)

          // Mark compaction complete in the session state.
          // This is done here (backend) rather than in the renderer so it's
          // not affected by CMD+R during compaction. The frontend reload
          // recovery will see awaitingCompaction=false and trigger execution.
          void markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
          this.advanceLabelSkillContextEpochAfterCompaction(managed)
          sessionLog.info(`Session ${sessionId}: compaction complete, marked pending plan ready and advanced label-skill context epoch`)

          // Emit usage_update so the context count badge refreshes immediately
          // after compaction, without waiting for the next message
          if (managed.tokenUsage) {
            this.sendEvent({
              type: 'usage_update',
              sessionId,
              tokenUsage: {
                inputTokens: managed.tokenUsage.inputTokens,
                contextWindow: managed.tokenUsage.contextWindow,
              },
            }, workspaceId)
          }
        }

        this.sendEvent({
          type: 'info',
          sessionId,
          message: event.message,
          statusType: isCompactionComplete ? 'compaction_complete' : undefined,
          timestamp: infoTimestamp,
        }, workspaceId)
        break
      }

      case 'error': {
        // Skip errors after handoff (plan submission, auth request) — the SDK may emit
        // an error from the interrupted query after we've already stopped processing.
        if (!managed.isProcessing) {
          sessionLog.info('Skipping error event after handoff/stop:', event.message)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
          sessionLog.info('Skipping abort error event (expected during interrupt)')
          break
        }

        // Defensive: detect auth-expiry text in plain errors that weren't classified
        // as typed_error (e.g. Pi SDK error path or future provider changes).
        const lowerErr = event.message.toLowerCase()
        const isPlainAuthError =
          lowerErr.includes('token is expired') ||
          lowerErr.includes('authentication token is expired') ||
          lowerErr.includes('please try signing in again') ||
          (lowerErr.includes('401') && (lowerErr.includes('unauthorized') || lowerErr.includes('auth')))

        if (isPlainAuthError) {
          this.attemptAuthRetry(sessionId, managed, workspaceId)
          const timestamp = this.monotonic()
          const content = 'Authentication expired. Credentials were refreshed; retry this message explicitly.'
          const errorMessage: Message = {
            id: generateMessageId(),
            role: 'error',
            content,
            timestamp,
            errorCode: 'expired_oauth_token',
            errorTitle: 'Session Expired',
            errorCanRetry: true,
          }
          managed.messages.push(errorMessage)
          this.sendEvent({
            type: 'typed_error',
            sessionId,
            error: {
              code: 'expired_oauth_token',
              title: 'Session Expired',
              message: content,
              actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
              canRetry: true,
            },
            timestamp,
          }, workspaceId)
          break
        }

        // AgentEvent uses `message` not `error`
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.monotonic()
        }
        managed.messages.push(errorMessage)
        this.sendEvent({ type: 'error', sessionId, error: event.message, timestamp: errorMessage.timestamp }, workspaceId)
        break
      }

      case 'typed_error':
        // Skip errors after handoff (plan submission, auth request)
        if (!managed.isProcessing) {
          sessionLog.info('Skipping typed_error event after handoff/stop:', event.error.message || event.error.title)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
          sessionLog.info('Skipping typed abort error event (expected during interrupt)')
          break
        }
        // Typed errors have structured information - send both formats for compatibility
        sessionLog.info('typed_error:', JSON.stringify(event.error, null, 2))

        // Post-dispatch auth has no safe replay proof. Refresh for the next
        // explicit retry and make the persisted terminal error retryable.
        const isAuthError = event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'
        if (isAuthError) this.attemptAuthRetry(sessionId, managed, workspaceId, event.error.code)
        const errorCanRetry = isAuthError ? true : event.error.canRetry
        const errorActions = isAuthError
          ? [{ key: 'r', label: 'Retry', action: 'retry' as const }]
          : event.error.actions

        // Build rich error message with all diagnostic fields for persistence and UI display
        const typedErrorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          // Combine title and message for content display (handles undefined gracefully)
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.monotonic(),
          // Rich error fields for diagnostics and retry functionality
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry,
        }
        managed.messages.push(typedErrorMessage)
        // Send typed_error event with full structure for renderer to handle
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: event.error.code,
            title: event.error.title,
            message: event.error.message,
            actions: errorActions,
            canRetry: errorCanRetry,
            details: event.error.details,
            originalError: event.error.originalError,
          },
          timestamp: typedErrorMessage.timestamp,
        }, workspaceId)
        break

      case 'task_backgrounded':
        try {
          this.assertWorkspaceAdmission(workspaceId, 'background')
        } catch (error) {
          sessionLog.warn('[workspace-detach] rejected late background task admission', {
            workspaceId,
            sessionId,
            taskId: event.taskId,
          })
          break
        }
        // Record in the running-task registry so a cross-subprocess "status?"
        // query can enumerate live tasks (WS3). The renderer still shows the
        // chip via its own atom; this is the main-process source of truth.
        if (managed) {
          managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            toolUseId: event.toolUseId,
            intent: event.intent,
            startTime: Date.now(),
            status: 'running',
            turnId: event.turnId,
            // Workflow launches carry a wf_ id + a live sub-agent completion count.
            ...(event.workflowId ? { workflowId: event.workflowId } : {}),
            ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
          })
          sessionLog.info(`[bg-lifecycle] task backgrounded`, {
            sessionId,
            taskId: event.taskId,
            intent: event.intent,
            turnId: event.turnId,
          })
        }
        // Forward background task event directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'workflow_agent_completed':
        // One sub-agent of a running Workflow finished (SubagentStop, attributed
        // by wf_ id). Bump the owning workflow chip's completed count so the user
        // sees live fan-out progress. Lightweight: registry counter + renderer
        // forward, no persistence (this can fire dozens of times per workflow).
        if (managed) {
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.workflowId && info.workflowId === event.workflowId) {
              info.agentsCompleted = (info.agentsCompleted ?? 0) + 1
              break
            }
          }
        }
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_progress':
        // Update elapsed/last-progress on the registry entry (best-effort — the
        // async-by-default path may not emit progress; the renderer derives
        // elapsed from startTime as a fallback).
        if (managed) {
          // task_progress is keyed by toolUseId, not taskId — find the entry.
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.toolUseId && info.toolUseId === event.toolUseId) {
              info.elapsedSeconds = event.elapsedSeconds
              info.lastProgressAt = Date.now()
              break
            }
          }
        }
        // Forward background task event directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_completed': {
        // Capture whether we'd already recorded a terminal result for this task
        // BEFORE mutating state below, so the idle auto-surface (further down)
        // fires at most once even if a duplicate terminal notification arrives.
        // A Workflow's completion notification may key on either the returned
        // Task ID (the registry key) or the wf_ run id, so fall back to a
        // workflowId match before giving up.
        const priorEntry = managed
          ? (managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId))
          : undefined
        const wasAlreadyTerminal = priorEntry
          ? priorEntry.status !== 'running'
          : this.taskOutputIndex.has(event.taskId)

        // Store output for later retrieval via getTaskOutput()
        if (managed) {
          managed.backgroundTaskOutputs.set(event.taskId, {
            outputFile: event.outputFile || '',
            summary: event.summary || '',
            status: event.status,
            completedAt: Date.now(),
          })
          // O(1) index for getTaskOutput() — avoids scanning all sessions
          this.taskOutputIndex.set(event.taskId, sessionId)

          // Resolve the running-task registry entry to its terminal status so a
          // later "status?" query reflects reality instead of a stale "running".
          // Match by taskId, or by workflowId (a workflow may complete under its
          // wf_ run id rather than the returned Task ID).
          const running = managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId)
          if (running) {
            running.status = event.status
            running.completedAt = Date.now()
          } else {
            // Terminal notification for a task we never saw backgrounded (e.g.
            // it completed in the same subprocess before task_backgrounded was
            // matched). Record it so status queries are still truthful.
            managed.backgroundTaskRegistry.set(event.taskId, {
              taskId: event.taskId,
              startTime: Date.now(),
              status: event.status,
              completedAt: Date.now(),
            })
          }
          sessionLog.info(`[bg-lifecycle] task completed`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })

          this.evictStaleBackgroundTasks(managed)
        }
        // Forward to renderer for UI update
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)

        // WS2 keep-alive: when a background agent finishes while the session is
        // IDLE, nobody is consuming its result — the main agent already ended its
        // turn, so the completion only updates the registry/chip and the findings
        // never make it back into the conversation ("the agent never returned the
        // result"). Wake the session with a system-generated follow-up so the agent
        // reads the output and presents it. During an active turn (isProcessing)
        // the terminal notification reaches the agent through the live stream, so
        // we skip then. Gated on keep-alive because only that mode delivers this
        // event between turns; guarded against duplicate notifications.
        if (managed && this.keepBackgroundTasksAlive && !managed.isProcessing && !wasAlreadyTerminal) {
          const taskIntent = managed.backgroundTaskRegistry.get(event.taskId)?.intent
          const outputFile = event.outputFile || managed.backgroundTaskOutputs.get(event.taskId)?.outputFile
          const label = taskIntent ? `"${taskIntent}"` : `task ${event.taskId}`
          const nudge = event.status === 'completed'
            ? [
                `[background-task-completed] The background agent you launched (${label}) has finished.`,
                outputFile ? `Its full output is saved at: ${outputFile}` : '',
                `Read that output file and present the results to the user now. Do NOT spawn another background agent — just read the file and summarize the findings inline.`,
              ].filter(Boolean).join('\n')
            : [
                `[background-task-${event.status}] The background agent you launched (${label}) ended with status "${event.status}".`,
                outputFile ? `Any partial output is at: ${outputFile}.` : '',
                `Briefly let the user know it did not complete successfully. Do NOT spawn another background agent.`,
              ].filter(Boolean).join('\n')
          sessionLog.info(`[bg-lifecycle] surfacing completed background task to idle session`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })
          // Ride the normal turn machinery (resume + persistence). `hidden: true`
          // keeps the nudge out of the transcript — the agent's response (the
          // presented result) renders as a normal assistant turn.
          void this.sendMessage(sessionId, nudge, [], [], { hidden: true }).catch((err) => {
            sessionLog.error(`[bg-lifecycle] failed to surface completed task ${event.taskId}:`, err)
          })
        }
        break
      }

      case 'shell_backgrounded':
        try {
          this.assertWorkspaceAdmission(workspaceId, 'background')
        } catch {
          sessionLog.warn('[workspace-detach] rejected late background shell admission', {
            workspaceId,
            sessionId,
            shellId: event.shellId,
          })
          break
        }
        // Store the command for later process killing
        if (event.command && managed) {
          managed.backgroundShellCommands.set(event.shellId, event.command)
          sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`)
        }
        // Forward to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'source_activated': {
        // A source was auto-activated mid-turn. The server schedules a re-send of the
        // original message with a "[<slug> activated]" suffix so headless deployments
        // (WebUI, docker server) chain activations the same way the renderer used to.
        // The renderer still receives the event to render activation feedback, but no
        // longer fires its own auto_retry (see processor.ts).
        sessionLog.info(`Source "${event.sourceSlug}" activated for session ${sessionId}, scheduling auto-retry`)

        this.sendEvent({
          type: 'source_activated',
          sessionId,
          sourceSlug: event.sourceSlug,
          originalMessage: event.originalMessage,
        }, workspaceId)

        if (!managed) break

        const originalMessage = event.originalMessage ?? ''
        if (!originalMessage.trim()) {
          sessionLog.warn(`Source "${event.sourceSlug}" activated for session ${sessionId}, but originalMessage was empty; skipping auto-retry`)
          break
        }

        const messageWithSuffix = `${originalMessage}\n\n[${event.sourceSlug} activated]`
        const messageCountAtSchedule = managed.messages.length

        // Stash the retry payload so a duplicate sendMessage from a legacy renderer
        // (mixed-version rollout: new server + v0.9.5 Electron client) gets deduped.
        // 2s window covers WS latency tail on flaky mobile / proxy links.
        managed.autoRetryPending = {
          content: messageWithSuffix,
          deadlineMs: Date.now() + 2000,
          committed: false,
        }

        if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
        managed.autoRetryTimer = setTimeout(() => {
          const current = this.sessions.get(sessionId)
          if (!current) return
          current.autoRetryTimer = undefined
          if (this.closing || current.deleting) {
            current.autoRetryPending = undefined
            return
          }

          // If a user follow-up arrived in the 100ms window, skip — they preempted us.
          if (current.messages.length > messageCountAtSchedule) {
            sessionLog.info(`Auto-retry skipped for ${sessionId}: follow-up message arrived first`)
            current.autoRetryPending = undefined
            return
          }

          // Note: do NOT clear autoRetryPending here — sendMessage() needs to see it
          // so a legacy renderer's duplicate RPC arriving ~50ms later gets dropped.
          // The pending slot is cleared by the deadline check in sendMessage, by the
          // next matching sendMessage that drops as a duplicate, or by session deletion.
          this.sendMessage(sessionId, messageWithSuffix).catch(err => {
            sessionLog.error(`Auto-retry sendMessage failed for ${sessionId}:`, err)
          })
        }, 100)
        break
      }

      case 'complete':
        // Complete event from CraftAgent - accumulate usage from this turn
        // Actual 'complete' sent to renderer comes from the finally block in sendMessage
        if (event.usage) {
          // Initialize tokenUsage if not set
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = current context size (full conversation sent this turn), NOT accumulated
          // Each API call sends the full conversation history, so we use the latest value
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens and costUsd are accumulated across all turns (total session usage)
          managed.tokenUsage.outputTokens += event.usage.outputTokens
          managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          managed.tokenUsage.costUsd += event.usage.costUsd ?? 0
          // Cache tokens reflect current state, not accumulated
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0
          // Update context window (use latest value - may change if model switches)
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // Real-time usage update for context display during processing
        // Update managed session's tokenUsage with latest context size
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // Update only inputTokens (current context size) - other fields accumulate on complete
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }

          // Send to renderer for immediate UI update
          this.sendEvent({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
              inputTokens: event.usage.inputTokens,
              contextWindow: event.usage.contextWindow,
            },
          }, workspaceId)
        }
        break

      case 'steer_undelivered':
        // Steer message was not delivered (no PreToolUse fired before turn ended).
        // Re-queue it so it's sent as a normal message on the next turn.
        sessionLog.info(`Steer message undelivered, re-queuing for session ${sessionId}`)
        managed.messageQueue.push({ message: event.message })
        managed.wasInterrupted = true
        break

      // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
      // the agent no longer has a change_working_directory tool
    }
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!this.eventSink) {
      sessionLog.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  /**
   * Queue a text delta for batched sending (performance optimization)
   * Instead of sending 50+ IPC events per second, batches deltas and flushes every 50ms
   */
  private queueDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      // Append to existing batch
      existing.delta += delta
      // Keep the latest turnId (should be the same, but just in case)
      if (turnId) existing.turnId = turnId
    } else {
      // Start new batch
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    // Schedule flush if not already scheduled
    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushDelta(sessionId, workspaceId)
      }, DELTA_BATCH_INTERVAL_MS)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  /**
   * Flush any pending deltas for a session (sends batched IPC event)
   * Called on timer or when streaming ends (text_complete)
   */
  private flushDelta(sessionId: string, workspaceId: string): void {
    // Clear the timer
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    // Send batched delta if any
    const pending = this.pendingDeltas.get(sessionId)
    if (pending && pending.delta) {
      this.sendEvent({
        type: 'text_delta',
        sessionId,
        delta: pending.delta,
        turnId: pending.turnId
      }, workspaceId)
      this.pendingDeltas.delete(sessionId)
    }
  }

  /**
   * Execute a prompt automation by creating a new session and sending the prompt.
   *
   * The options-object form replaced the previous positional-args signature
   * once the param list outgrew readability — `thinkingLevel` was the trigger.
   * When `thinkingLevel` is omitted, `createSession` falls back to the
   * workspace default (then DEFAULT_THINKING_LEVEL).
   */
  async executePromptAutomation(
    input: ExecutePromptAutomationInput,
  ): Promise<{ sessionId: string }> {
    const releaseAdmission = this.acquireWorkspaceAdmission(input.workspaceId, 'automation')
    try {
    const {
      workspaceId,
      workspaceRootPath,
      prompt,
      labels,
      permissionMode,
      mentions,
      llmConnection,
      model,
      thinkingLevel,
      automationName,
      telegramTopic,
      waitForCompletion,
    } = input

    // Warn if llmConnection was specified but doesn't resolve
    if (llmConnection) {
      const connection = resolveSessionConnection(llmConnection)
      if (!connection) {
        sessionLog.warn(`[Automations] llmConnection "${llmConnection}" not found, using default`)
      } else {
        this.assertLlmConnectionEnabledForWorkspace(workspaceRootPath, llmConnection)
      }
    }

    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? this.resolveAutomationMentions(workspaceRootPath, mentions) : undefined

    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // Create a new session for this automation
    const session = await this.createSession(workspaceId, {
      name: sessionName,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      llmConnection,
      model,
      thinkingLevel,
    })

    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = this.sessions.get(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, timestamp: Date.now() }
      this.persistSession(managed)
    }

    // (session_created is emitted by createSession above; triggeredBy is set synchronously
    // before the renderer's hydrate round-trip resolves, so it is observed.)

    // Bind the new session to its Telegram forum topic if the matcher
    // declared `telegramTopic`. Done before `sendMessage` so the first
    // assistant tokens already route through the bound topic. Failure
    // is logged inside the binder; the session continues unbound.
    if (this.automationBinder && telegramTopic && telegramTopic.trim().length > 0) {
      try {
        await this.automationBinder({
          workspaceId,
          sessionId: session.id,
          topicName: telegramTopic.trim(),
        })
      } catch (err) {
        sessionLog.warn('[Automations] automation binder threw', {
          sessionId: session.id,
          telegramTopic,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Send the prompt.
    // Test runs pass `waitForCompletion: false` so we return as soon as the
    // session exists and the prompt is dispatched — otherwise the RPC blocks
    // until the entire turn (including tool calls) finishes and trips the 30s
    // client timeout (craft-agents-oss#943). The session streams live either
    // way; a background failure surfaces in the session UI and is logged here.
    if (waitForCompletion === false) {
      void this.sendMessage(session.id, prompt, undefined, undefined, {
        skillSlugs: resolved?.skillSlugs,
      }).catch((err) => {
        sessionLog.error('[Automations] background sendMessage failed for test run', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return { sessionId: session.id }
    }

    await this.sendMessage(session.id, prompt, undefined, undefined, {
      skillSlugs: resolved?.skillSlugs,
    })

    return { sessionId: session.id }
    } finally {
      releaseAdmission()
    }
  }

  /**
   * Resolve @mentions in automation prompts to source and skill slugs
   */
  private resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  private async generateRemoteTransferSummary(
    managed: ManagedSession,
    routing?: { connectionSlug: string; model: string },
  ): Promise<string | null> {
    if (this.closing || managed.deleting) return null
    await this.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !m.isIntermediate)
      .map(m => ({
        type: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const summaryConnectionSlug = routing?.connectionSlug
      ?? this.resolveWorkspaceLlmConnectionSlug(workspaceRootPath, managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: summaryConnectionSlug,
      workspaceDefaultConnectionSlug: undefined,
      managedModel: routing?.model ?? managed.model ?? defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ?? backendContext.connection.defaultModel ?? getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
      ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          id: `${managed.id}-${routing ? 'continuation' : 'remote-transfer'}-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: managed.workingDirectory,
          sdkCwd: managed.sdkCwd,
          model: routing?.model ?? managed.model,
          llmConnection: routing?.connectionSlug ?? managed.llmConnection,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.connection?.piAuthProvider },
    })

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      await disposeBackendRuntime(agent, { reason: 'manual' })
    }
  }

  async continueSession(
    sessionId: string,
    workspaceId: string,
    input: ContinueSessionInput,
  ): Promise<ContinueSessionResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    if (managed.workspace.id !== workspaceId) throw new Error('Session does not belong to this workspace')

    const connectionSlug = input?.connectionSlug?.trim()
    if (!connectionSlug) throw new Error('A destination connection is required')
    const targetConnection = getLlmConnection(connectionSlug)
    if (!targetConnection) throw new Error(`LLM connection "${connectionSlug}" was not found`)
    this.assertLlmConnectionEnabledForWorkspace(managed.workspace.rootPath, connectionSlug)

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    // The source chat may be locked to a connection that is now disabled for this
    // workspace. That is exactly the recovery case Continue With is meant to solve:
    // only the destination connection must be workspace-enabled. Resolve the source
    // historically so we can preserve metadata/fallbacks without blocking handoff.
    const sourceContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model ?? workspaceConfig?.defaults?.model,
    })
    const sourceProcessingGeneration = managed.processingGeneration

    const destination = await runContinuationTransaction(
      {
        id: managed.id,
        name: managed.name,
        isProcessing: managed.isProcessing,
        queuedMessageCount: managed.messageQueue.length,
        currentConnectionSlug: managed.llmConnection
          ? getLlmConnection(managed.llmConnection)?.slug
          : sourceContext.connection?.slug,
        permissionMode: managed.permissionMode,
        thinkingLevel: managed.thinkingLevel,
        workingDirectory: managed.workingDirectory,
        labels: managed.labels,
        enabledSourceSlugs: managed.enabledSourceSlugs,
        enabledMemorySpaceRefs: managed.enabledMemorySpaceRefs,
        memoryWriteTargetRef: managed.memoryWriteTargetRef,
        memorySelectionMode: managed.memorySelectionMode,
        projectId: managed.projectId,
      },
      {
        slug: targetConnection.slug,
        name: targetConnection.name,
        configuredModelIds: (targetConnection.models ?? [])
          .map(candidate => typeof candidate === 'string' ? candidate : candidate.id),
        defaultModel: targetConnection.defaultModel,
      },
      input,
      {
        summarize: () => this.generateRemoteTransferSummary(managed, {
          connectionSlug,
          model: input.model.trim(),
        }),
        assertSourceUnchanged: () => {
          if (
            managed.isProcessing ||
            managed.messageQueue.length > 0 ||
            managed.processingGeneration !== sourceProcessingGeneration
          ) {
            throw new Error('The source conversation changed while preparing the handoff. Try again when it is idle.')
          }
        },
        create: (options, summary) => this.createSession(
          workspaceId,
          options,
          { emitCreatedEvent: false, initialTransferredSessionSummary: summary },
        ),
      },
    )

    sessionLog.info('Created cross-provider continuation', {
      sourceSessionId: managed.id,
      destinationSessionId: destination.id,
      sourceConnection: sourceContext.connection?.slug,
      destinationConnection: connectionSlug,
      destinationModel: input.model,
    })

    return { session: destination }
  }

  async exportRemoteSessionTransfer(sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`)
      return null
    }

    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const summary = await this.generateRemoteTransferSummary(managed)
    if (!summary) {
      sessionLog.warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`)
      return null
    }

    return {
      sourceSessionId: managed.id,
      name: managed.name,
      sessionStatus: managed.sessionStatus,
      labels: managed.labels,
      permissionMode: managed.permissionMode,
      summary,
    }
  }

  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }

    const summary = payload.summary.trim()
    const session = await this.createSession(
      workspaceId,
      {
        name: payload.name,
        permissionMode: payload.permissionMode,
        sessionStatus: payload.sessionStatus,
        labels: payload.labels,
      },
      { initialTransferredSessionSummary: summary },
    )

    return { sessionId: session.id }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    const sessionId = mode === 'move'
      ? bundle.session.header.id
      : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // Build the complete target session before any filesystem side effect.
    const header = normalizeSessionHeaderMemorySelection(bundle.session.header)
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      sdkSessionId: header.sdkSessionId, // Preserved initially; fork logic below may clear it
      // Always regenerate sdkCwd for the target workspace.
      // The source sdkCwd points to a path on the originating server
      // which doesn't exist here (cross-server transfer).
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      permissionMode: header.permissionMode,
      previousPermissionMode: header.previousPermissionMode,
      sessionStatus: header.sessionStatus,
      labels: header.labels,
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      model: header.model,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      // Bundle validation + normalization preserve only structurally valid,
      // canonical selection state. Availability/authorization stays in the
      // session Memory resolver rather than the transfer boundary.
      enabledMemorySpaceRefs: header.enabledMemorySpaceRefs,
      memoryWriteTargetRef: header.memoryWriteTargetRef,
      memorySelectionMode: header.memorySelectionMode,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    // Fork-specific: set up SDK branching if branchInfo provided
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // Resume-first: try to find a compatible LLM connection on the target workspace.
      // If found and the session has an sdkSessionId, preserve it for API-level resume.
      // If not, clear SDK state and fall back to transferred session summary.
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(workspaceRootPath, sourceProviderType)
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // Resume path: compatible credentials exist — preserve SDK session ID
        sessionLog.info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`)
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        // Summary path: no compatible connection or no SDK session — clear for fresh start
        if (storedSession.llmConnection) {
          sessionLog.info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`)
        }
        storedSession.sdkSessionId = undefined
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      // Clear working directory — the source path won't exist on a different server.
      // The user can set a new cwd after the session is transferred.
      storedSession.workingDirectory = undefined
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        sessionLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
    }

    // Check LLM connection compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.llmConnection) {
      sessionLog.info(`[import] Checking LLM connection: "${storedSession.llmConnection}"`)
      const conn = resolveSessionConnection(storedSession.llmConnection, undefined)
      if (!conn) {
        sessionLog.warn(`[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`)
        warnings.push(`LLM connection "${storedSession.llmConnection}" not found in target — session will use default`)
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        sessionLog.info(`[import] LLM connection "${storedSession.llmConnection}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      sessionLog.info('[import] No LLM connection in bundle — will use default')
    }

    // Preflight the FINAL reconstructed target header before creating the
    // session directory, restoring files, registering runtime state, or events.
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    preflightSessionJsonl(sessionFile, storedSession)
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)
    sessionLog.info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`)
    writeSessionJsonl(sessionFile, storedSession)
    const persistedHeader = readSessionHeader(sessionFile)
    if (persistedHeader) sessionPersistenceQueue.initializeBaseline(sessionId, persistedHeader)

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.sessions.set(sessionId, managed)

    // Initialize automation metadata
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(sessionId, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Built by hand (not via createSession), so announce it explicitly.
    this.notifySessionCreated(workspaceId, sessionId)

    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an LLM connection on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  private getWorkspaceEnabledLlmConnectionSet(workspaceRootPath: string): Set<string> | undefined {
    const enabled = loadWorkspaceConfig(workspaceRootPath)?.defaults?.enabledLlmConnectionSlugs
    return Array.isArray(enabled) ? new Set(enabled) : undefined
  }

  private assertLlmConnectionEnabledForWorkspace(workspaceRootPath: string, connectionSlug: string): void {
    const enabled = this.getWorkspaceEnabledLlmConnectionSet(workspaceRootPath)
    if (enabled && !enabled.has(connectionSlug)) {
      throw new Error(`LLM connection "${connectionSlug}" is disabled for this workspace`)
    }
  }

  private resolveWorkspaceLlmConnectionSlug(
    workspaceRootPath: string,
    requestedSlug?: string,
    workspaceDefaultSlug?: string,
  ): string | undefined {
    const enabled = this.getWorkspaceEnabledLlmConnectionSet(workspaceRootPath)

    if (!enabled) {
      return resolveSessionConnection(requestedSlug, workspaceDefaultSlug)?.slug
    }

    if (requestedSlug) {
      const connection = getLlmConnection(requestedSlug)
      if (!connection) throw new Error(`LLM connection "${requestedSlug}" not found`)
      if (!enabled.has(requestedSlug)) {
        throw new Error(`LLM connection "${requestedSlug}" is disabled for this workspace`)
      }
      return requestedSlug
    }

    if (workspaceDefaultSlug && enabled.has(workspaceDefaultSlug) && getLlmConnection(workspaceDefaultSlug)) {
      return workspaceDefaultSlug
    }

    const globalDefault = getDefaultLlmConnection()
    if (globalDefault && enabled.has(globalDefault) && getLlmConnection(globalDefault)) {
      return globalDefault
    }

    const firstEnabled = getLlmConnections().find(connection => enabled.has(connection.slug))
    if (firstEnabled) return firstEnabled.slug

    throw new Error('No LLM connections are enabled for this workspace')
  }

  private findCompatibleLlmConnection(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = this.resolveWorkspaceLlmConnectionSlug(workspaceRootPath, undefined, wsConfig?.defaults?.defaultLlmConnection)
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // Fall back: any enabled connection with matching provider type
    const enabled = this.getWorkspaceEnabledLlmConnectionSet(workspaceRootPath)
    const connections = getLlmConnections()
    const match = connections.find(c => c.providerType === providerType && (!enabled || enabled.has(c.slug)))
    return match?.slug ?? null
  }

  /**
   * Awaited, idempotent, bounded shutdown. Admission closes synchronously;
   * flush cannot prevent exact parallel runtime teardown in the finally path.
   */
  cleanup(options?: { deadline?: number; skipFlush?: boolean }): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.closing = true
    const deadline = options?.deadline ?? (Date.now() + this.runtimeLifecycleConfig.shutdownTimeoutMs)

    const waitUntil = async <T>(promise: Promise<T>, until: number): Promise<T | undefined> => {
      const remaining = Math.max(0, until - Date.now())
      if (remaining === 0) return undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), remaining)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    this.cleanupPromise = (async () => {
      sessionLog.info('Cleaning up resources...')

      if (this.idleReaperTimer) {
        clearInterval(this.idleReaperTimer)
        this.idleReaperTimer = undefined
      }

      // Close every deferred producer before the first await.
      for (const managed of this.sessions.values()) {
        managed.deleting = true
        if (managed.autoRetryTimer) {
          clearTimeout(managed.autoRetryTimer)
          managed.autoRetryTimer = undefined
        }
        managed.autoRetryPending = undefined
        if (managed.stopTimer) {
          clearTimeout(managed.stopTimer)
          managed.stopTimer = undefined
        }
        if (managed.activeTurn?.watchdogTimer) clearTimeout(managed.activeTurn.watchdogTimer)
        if (managed.activeTurn) managed.activeTurn.terminalClaimed = true
        try {
          if (managed.isProcessing) managed.agent?.forceAbort(AbortReason.UserStop)
        } catch {
          // Exact disposal is the hard backstop.
        }
        try {
          this.setProcessing(managed, false)
        } catch (error) {
          sessionLog.warn(`Failed to update processing state during shutdown for ${managed.id}: ${error instanceof Error ? error.message : error}`)
          managed.isProcessing = false
        }
        this.persistSession(managed)
      }

      for (const [, timer] of this.deltaFlushTimers) clearTimeout(timer)
      this.deltaFlushTimers.clear()
      this.pendingDeltas.clear()

      for (const [path, watcher] of this.configWatchers) {
        try {
          watcher.stop()
          sessionLog.info(`Stopped config watcher for ${path}`)
        } catch (error) {
          sessionLog.warn(`Failed to stop config watcher for ${path}: ${error instanceof Error ? error.message : error}`)
        }
      }
      this.configWatchers.clear()

      for (const timer of this.externalMetadataGuardTimers.values()) clearTimeout(timer)
      this.externalMetadataGuardTimers.clear()
      for (const managed of this.sessions.values()) managed.pendingExternalMetadata = undefined

      for (const [workspacePath, automationSystem] of this.automationSystems) {
        try {
          automationSystem.dispose()
          sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`)
        } catch (error) {
          sessionLog.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error)
        }
      }
      this.automationSystems.clear()

      try {
        if (!options?.skipFlush) {
          const flushDeadline = Math.min(deadline, Date.now() + this.runtimeLifecycleConfig.flushTimeoutMs)
          await waitUntil(sessionPersistenceQueue.flushAll(), flushDeadline)
        }
      } catch (error) {
        sessionLog.error('Failed to flush sessions during shutdown:', error)
      } finally {
        const generations = [...this.runtimeRegistry.values()]
        const disposals = generations.map(({ managed, generation }) => {
          if (managed.runtimeGeneration === generation) {
            return this.disposeManagedAgentRuntime(managed, 'shutdown', generation, deadline)
          }
          return this.disposeRuntimeGeneration(managed, generation, 'shutdown', deadline)
        })
        await waitUntil(Promise.allSettled(disposals), deadline)
      }

      this.pendingCredentialResolvers.clear()
      this.pendingPermissionRequests.clear()
      this.adminRememberApprovals.clear()
      this.agentRefreshLocks.clear()
      this.workspaceLifecycles.clear()
      for (const sessionId of this.sessions.keys()) unregisterSessionScopedToolCallbacks(sessionId)

      sessionLog.info('Cleanup complete')
    })().catch((error) => {
      // Terminal shutdown is fail-closed: after admission is closed, callers must
      // continue host exit rather than strand a permanently-closing live app.
      sessionLog.error('SessionManager cleanup failed:', error)
    })

    return this.cleanupPromise
  }
}
