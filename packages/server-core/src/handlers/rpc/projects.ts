import {
  RPC_CHANNELS,
  type ProjectMemoryUiAddRequest,
  type ProjectMemoryUiPayload,
  type ProjectMemoryUiSearchHit,
  type ProjectMemoryUiSearchRequest,
  type ProjectMemoryUiStatus,
  type ProjectMemoryConnectionSnapshot,
  type ProjectMemoryConnectionSummary,
  type ProjectMemoryConnectionDetail,
  type ProjectMemoryConnectionCreateRequest,
  type ProjectMemoryConnectionUpdateRequest,
  type ProjectMemoryConnectionDeleteRequest,
  type ProjectMemoryConnectionCheckRequest,
  type ProjectMemoryConnectionCheckResult,
  type ProjectMemorySpaceCreateRequest,
  type ProjectMemorySpaceUpdateRequest,
  type ProjectMemorySpaceDeleteRequest,
} from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config/storage'
import {
  buildEnvironmentMemoryConnection,
  environmentMemoryConnectionHasApiKey,
  getProjectMemoryStore,
  MemoryConnectionRepository,
  MemoryConnectionService,
  QdrantProjectMemoryStore,
  toMemoryConnectionDetailDto,
  toMemoryConnectionSummaryDto,
  type MemoryConnectionConfig,
  type ProjectMemoryPayload,
  type ProjectMemoryStatus,
} from '@craft-agent/shared/project-memory'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const MAX_MEMORY_CONTENT_LENGTH = 50_000
const MAX_MEMORY_TITLE_LENGTH = 200
const MAX_MEMORY_TAGS = 20
const MAX_MEMORY_TAG_LENGTH = 64

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
  RPC_CHANNELS.projects.MEMORY_STATUS,
  RPC_CHANNELS.projects.MEMORY_ADD,
  RPC_CHANNELS.projects.MEMORY_SEARCH,
  RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT,
  RPC_CHANNELS.projects.MEMORY_CONNECTION_GET,
  RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE,
  RPC_CHANNELS.projects.MEMORY_CONNECTION_UPDATE,
  RPC_CHANNELS.projects.MEMORY_CONNECTION_DELETE,
  RPC_CHANNELS.projects.MEMORY_CONNECTION_CHECK,
  RPC_CHANNELS.projects.MEMORY_SPACE_CREATE,
  RPC_CHANNELS.projects.MEMORY_SPACE_UPDATE,
  RPC_CHANNELS.projects.MEMORY_SPACE_DELETE,
] as const

function normalizeProjectMemoryStatus(status: ProjectMemoryStatus): ProjectMemoryUiStatus {
  if (!status.enabled) {
    return { ...status, state: 'disabled', message: 'Project memory is disabled' }
  }
  if (status.ok) {
    return { ...status, state: 'ready' }
  }

  const error = status.error ?? 'Project memory status check failed'
  const lower = error.toLowerCase()
  let state: ProjectMemoryUiStatus['state'] = 'error'
  if (lower.includes('qdrant 404') || lower.includes('not found')) {
    state = 'not-initialized'
  } else if (
    lower.includes('vector size')
    || lower.includes('distance')
    || lower.includes('vector configuration')
    || lower.includes('expected cosine')
  ) {
    state = 'config-mismatch'
  } else if (
    lower.includes('failed to fetch')
    || lower.includes('econnrefused')
    || lower.includes('connection refused')
    || lower.includes('network')
    || lower.includes('timeout')
  ) {
    state = 'unreachable'
  }
  return { ...status, state, message: error, error }
}

function normalizeMemoryConnectionCheckStatus(status: ProjectMemoryStatus): ProjectMemoryConnectionCheckResult {
  if (status.ok) {
    return {
      ok: true,
      state: 'ready',
      message: 'Connection is ready',
      url: status.url,
      collection: status.collection,
      dimension: status.dimension,
    }
  }

  const error = status.error ?? 'Connection check failed'
  const lower = error.toLowerCase()
  let state: ProjectMemoryConnectionCheckResult['state'] = 'error'
  if (lower.includes('qdrant 404') || lower.includes('not found')) {
    state = 'not-initialized'
  } else if (
    lower.includes('vector size')
    || lower.includes('distance')
    || lower.includes('vector configuration')
    || lower.includes('expected cosine')
  ) {
    state = 'config-mismatch'
  } else if (
    lower.includes('failed to fetch')
    || lower.includes('fetch failed')
    || lower.includes('econnrefused')
    || lower.includes('connection refused')
    || lower.includes('network')
    || lower.includes('timeout')
  ) {
    state = 'unreachable'
  }

  return {
    ok: false,
    state,
    message: error,
    url: status.url,
    collection: status.collection,
    dimension: status.dimension,
  }
}

function requireWorkspaceFromContext(ctx: RequestContext) {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) throw new Error('Workspace context is required')
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  return { workspaceId: workspace.id, workspace }
}

async function resolveProjectForMemory(ctx: RequestContext, projectIdOrSlug: string) {
  const trimmed = projectIdOrSlug?.trim()
  if (!trimmed) throw new Error('projectIdOrSlug is required')
  const { workspaceId, workspace } = requireWorkspaceFromContext(ctx)
  const { loadProject, loadProjectById } = await import('@craft-agent/shared/projects')
  const project = loadProject(workspace.rootPath, trimmed) ?? loadProjectById(workspace.rootPath, trimmed)
  if (!project) throw new Error(`Project not found: ${trimmed}`)
  return { workspaceId, projectId: project.config.id }
}

// A single memory runtime per server process. The repository, service (which owns
// the A5 saga coordinator, journal, and cross-process lease), and the one-shot
// recovery gate are all shared so a crashed saga is resolved exactly once before
// any handler mutates memory state.
const memoryRuntime: {
  repo: MemoryConnectionRepository | null
  service: MemoryConnectionService | null
  ready: Promise<void> | null
} = { repo: null, service: null, ready: null }

function getMemoryConnectionRepo(): MemoryConnectionRepository {
  if (!memoryRuntime.repo) {
    memoryRuntime.repo = new MemoryConnectionRepository()
  }
  return memoryRuntime.repo
}

function getMemoryConnectionService(): MemoryConnectionService {
  if (!memoryRuntime.service) {
    memoryRuntime.service = new MemoryConnectionService({
      repository: getMemoryConnectionRepo(),
      credentialManager: getCredentialManager(),
    })
  }
  return memoryRuntime.service
}

/**
 * Gate every memory handler on durable startup recovery + legacy migration,
 * running them exactly once per process. Fails closed: if recovery or migration
 * cannot complete (corrupt journal, migration collision, …) the gate rejects and
 * the handler rejects with it, rather than operating on unrecovered state. On
 * failure the gate is cleared so a later request can retry once the cause is fixed.
 */
function ensureMemoryReady(): Promise<void> {
  if (!memoryRuntime.ready) {
    const service = getMemoryConnectionService()
    memoryRuntime.ready = service.ensureReady().catch((error) => {
      memoryRuntime.ready = null
      throw error
    })
  }
  return memoryRuntime.ready
}

/** Test-only: drop the shared memory runtime so a suite can start from clean state. */
export function __resetMemoryConnectionRuntimeForTests(): void {
  memoryRuntime.repo = null
  memoryRuntime.service = null
  memoryRuntime.ready = null
}

function getEnvironmentConnection(repo: MemoryConnectionRepository): MemoryConnectionConfig {
  return buildEnvironmentMemoryConnection(repo.getInstallationId())
}

async function getConnectionHasApiKey(connectionId: string, isEnvironment: boolean): Promise<boolean> {
  if (isEnvironment) return environmentMemoryConnectionHasApiKey()

  try {
    const manager = getCredentialManager()
    return await manager.hasMemoryApiKey(connectionId)
  } catch {
    return false
  }
}

async function buildConnectionSummary(
  connection: MemoryConnectionConfig,
  isEnvironment: boolean,
): Promise<ProjectMemoryConnectionSummary> {
  const hasApiKey = await getConnectionHasApiKey(connection.connectionId, isEnvironment)
  return toMemoryConnectionSummaryDto(connection, { isEnvironment, hasApiKey })
}

function getMemoryConnectionById(
  repo: MemoryConnectionRepository,
  connectionId: string,
): { connection: MemoryConnectionConfig; isEnvironment: boolean } | null {
  const environmentConnection = getEnvironmentConnection(repo)
  if (connectionId === environmentConnection.connectionId) {
    return { connection: environmentConnection, isEnvironment: true }
  }

  const stored = repo.getConnection(connectionId)
  if (!stored) return null

  return { connection: stored, isEnvironment: false }
}

async function buildConnectionDetail(connectionId: string): Promise<ProjectMemoryConnectionDetail> {
  const repo = getMemoryConnectionRepo()
  const found = getMemoryConnectionById(repo, connectionId)
  if (!found) throw new Error(`Connection not found: ${connectionId}`)

  const { connection, isEnvironment } = found
  return toMemoryConnectionDetailDto(
    connection,
    {
      isEnvironment,
      hasApiKey: await getConnectionHasApiKey(connection.connectionId, isEnvironment),
    },
  )
}

async function buildConnectionSnapshot(): Promise<ProjectMemoryConnectionSnapshot> {
  const repo = getMemoryConnectionRepo()
  const environmentConnection = getEnvironmentConnection(repo)

  const snapshots = [
    await buildConnectionSummary(environmentConnection, true),
    ...await Promise.all(
      repo
        .listConnections()
        .filter((connection) => connection.connectionId !== environmentConnection.connectionId)
        .map((connection) => buildConnectionSummary(connection, false)),
    ),
  ]

  return {
    revision: repo.getRootRevision(),
    connections: snapshots,
  }
}

function normalizeTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings')
  if (tags.length > MAX_MEMORY_TAGS) throw new Error(`tags must contain at most ${MAX_MEMORY_TAGS} entries`)
  const normalized = tags.map((tag) => {
    if (typeof tag !== 'string') throw new Error('tags must be an array of strings')
    const trimmed = tag.trim()
    if (!trimmed) throw new Error('tags must not be empty')
    if (trimmed.length > MAX_MEMORY_TAG_LENGTH) throw new Error(`tags must be at most ${MAX_MEMORY_TAG_LENGTH} characters`)
    return trimmed
  })
  return normalized.length ? Array.from(new Set(normalized)) : undefined
}

function validateAddRequest(input: ProjectMemoryUiAddRequest): ProjectMemoryUiAddRequest & { tags?: string[] } {
  if (!input || typeof input !== 'object') throw new Error('Project memory add input is required')
  if (input.source !== 'manual-note' && input.source !== 'decision') {
    throw new Error('source must be manual-note or decision')
  }
  const content = input.content?.trim()
  if (!content) throw new Error('content is required')
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters`)
  }
  const title = input.title?.trim()
  if (title && title.length > MAX_MEMORY_TITLE_LENGTH) {
    throw new Error(`title must be at most ${MAX_MEMORY_TITLE_LENGTH} characters`)
  }
  return {
    ...input,
    projectIdOrSlug: input.projectIdOrSlug?.trim(),
    title: title || undefined,
    content,
    tags: normalizeTags(input.tags),
  }
}

function validateSearchRequest(input: ProjectMemoryUiSearchRequest): ProjectMemoryUiSearchRequest {
  if (!input || typeof input !== 'object') throw new Error('Project memory search input is required')
  const query = input.query?.trim()
  if (!query) throw new Error('query is required')
  const limit = input.limit === undefined ? undefined : Math.max(1, Math.min(Math.trunc(Number(input.limit)), 50))
  if (input.limit !== undefined && !Number.isFinite(Number(input.limit))) throw new Error('limit must be a number')
  return { projectIdOrSlug: input.projectIdOrSlug?.trim(), query, limit }
}

function toUiPayload(payload: ProjectMemoryPayload): ProjectMemoryUiPayload {
  if (payload.source !== 'manual-note' && payload.source !== 'decision') {
    throw new Error(`Unexpected project memory source in UI payload: ${payload.source}`)
  }
  if (!payload.projectId) throw new Error('Project memory payload is missing projectId')
  return {
    id: payload.id,
    source: payload.source,
    title: payload.title,
    content: payload.content,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    tags: payload.tags,
    projectId: payload.projectId,
  }
}

export const __testProjectMemory = {
  normalizeProjectMemoryStatus,
  validateAddRequest,
  validateSearchRequest,
}

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    const projects = loadWorkspaceProjects(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, projects)
  }

  // List all projects for a workspace
  server.handle(RPC_CHANNELS.projects.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PROJECTS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    return loadWorkspaceProjects(workspace.rootPath)
  })

  // Get one project (by id or slug)
  server.handle(RPC_CHANNELS.projects.GET_ONE, async (_ctx, workspaceId: string, projectIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadProject, loadProjectById } = await import('@craft-agent/shared/projects')
    return loadProject(workspace.rootPath, projectIdOrSlug)
      ?? loadProjectById(workspace.rootPath, projectIdOrSlug)
  })

  // Create a new project
  server.handle(RPC_CHANNELS.projects.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/projects').CreateProjectInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createProject } = await import('@craft-agent/shared/projects')
    const project = createProject(workspace.rootPath, {
      name: input.name?.trim() || 'New Project',
      description: input.description,
      workingDirectory: input.workingDirectory,
      details: input.details,
      colorTheme: input.colorTheme,
    })
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Created project: ${project.slug}`)
    return project
  })

  // Update project (partial patch). Slug stays stable.
  server.handle(RPC_CHANNELS.projects.UPDATE, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    patch: Partial<Omit<import('@craft-agent/shared/projects').ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateProject } = await import('@craft-agent/shared/projects')
    const updated = updateProject(workspace.rootPath, projectSlug, patch)
    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a project; unbinds projectId from any sessions that referenced it.
  server.handle(RPC_CHANNELS.projects.DELETE, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { loadProject, deleteProject } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspace.rootPath, projectSlug)
    if (!project) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }

    const { unbindProjectFromSessions } = await import('@craft-agent/shared/sessions')
    const touched = await unbindProjectFromSessions(workspace.rootPath, project.config.id)
    deleteProject(workspace.rootPath, projectSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted project ${projectSlug} (unbound ${touched} sessions)`)
  })

  // List assets in a project
  server.handle(RPC_CHANNELS.projects.LIST_ASSETS, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { listProjectAssets } = await import('@craft-agent/shared/projects')
    return listProjectAssets(workspace.rootPath, projectSlug)
  })

  // Upload an asset (base64 / text / sourcePath)
  server.handle(RPC_CHANNELS.projects.UPLOAD_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@craft-agent/shared/projects').UploadProjectAssetInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { uploadProjectAsset } = await import('@craft-agent/shared/projects')
    const asset = uploadProjectAsset(workspace.rootPath, projectSlug, input)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
  })

  // Delete an asset by filename
  server.handle(RPC_CHANNELS.projects.DELETE_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    filename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteProjectAsset } = await import('@craft-agent/shared/projects')
    deleteProjectAsset(workspace.rootPath, projectSlug, filename)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })

  // Project memory backend status for UI. Uses request workspace context; no renderer scopes.
  // (Operates on the Qdrant project-memory store, not the saga-managed connection
  // state, so it is not gated on connection recovery.)
  server.handle(RPC_CHANNELS.projects.MEMORY_STATUS, async () => {
    return normalizeProjectMemoryStatus(await getProjectMemoryStore().status())
  })

  // UI-safe manual memory add. Forces canonical workspace/project and project scope.
  server.handle(RPC_CHANNELS.projects.MEMORY_ADD, async (ctx, input: ProjectMemoryUiAddRequest) => {
    const validated = validateAddRequest(input)
    const { workspaceId, projectId } = await resolveProjectForMemory(ctx, validated.projectIdOrSlug)
    const payload = await getProjectMemoryStore().add({
      scope: 'project',
      workspaceId,
      projectId,
      source: validated.source,
      title: validated.title,
      content: validated.content,
      tags: validated.tags,
    })
    return toUiPayload(payload)
  })

  // UI-safe project-only memory search. Forces canonical workspace/project and project scope.
  server.handle(RPC_CHANNELS.projects.MEMORY_SEARCH, async (ctx, input: ProjectMemoryUiSearchRequest): Promise<ProjectMemoryUiSearchHit[]> => {
    const validated = validateSearchRequest(input)
    const { workspaceId, projectId } = await resolveProjectForMemory(ctx, validated.projectIdOrSlug)
    const hits = await getProjectMemoryStore().search({
      query: validated.query,
      scopes: [{ scope: 'project', workspaceId, projectId }],
      limit: validated.limit,
    })
    return hits.map((hit) => ({ score: hit.score, payload: toUiPayload(hit.payload) }))
  })

  // List all memory connections + derived environment connection in a revisioned snapshot.
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT, async () => {
    await ensureMemoryReady()
    return buildConnectionSnapshot()
  })

  // Get one memory connection detail by id.
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTION_GET, async (_ctx, connectionId: string): Promise<ProjectMemoryConnectionDetail> => {
    await ensureMemoryReady()
    if (typeof connectionId !== 'string' || !connectionId.trim()) {
      throw new Error('connectionId is required')
    }
    return buildConnectionDetail(connectionId)
  })

  // Create a new memory connection entry (root revision required).
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE, async (_ctx, input: ProjectMemoryConnectionCreateRequest): Promise<ProjectMemoryConnectionSummary> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory connection create input')
    const { expectedRootRevision, name, url, collection, embedding, enabled, proactiveRemoteSearch, apiKey } = input
    return getMemoryConnectionService().createConnection({
      expectedRootRevision,
      name,
      url,
      collection,
      embedding,
      enabled,
      proactiveRemoteSearch,
      apiKey,
    })
  })

  // Update name/enabled/proactiveRemoteSearch on a stored memory connection.
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTION_UPDATE, async (_ctx, input: ProjectMemoryConnectionUpdateRequest): Promise<ProjectMemoryConnectionSummary> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory connection update input')
    const { connectionId, expectedRevision, ...patch } = input
    return getMemoryConnectionService().patchConnection({ connectionId, expectedRevision, ...patch })
  })

  // Delete a stored memory connection by id (root revision required).
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTION_DELETE, async (_ctx, input: ProjectMemoryConnectionDeleteRequest): Promise<{ success: true }> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory connection delete input')
    const { connectionId, expectedRootRevision } = input
    await getMemoryConnectionService().deleteConnection(connectionId, expectedRootRevision)
    return { success: true }
  })

  // Check a Qdrant connection without persisting it or storing the provided API key.
  server.handle(RPC_CHANNELS.projects.MEMORY_CONNECTION_CHECK, async (_ctx, input: ProjectMemoryConnectionCheckRequest): Promise<ProjectMemoryConnectionCheckResult> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory connection check input')
    const { url, collection, embedding, apiKey } = input
    if (typeof url !== 'string' || !url.trim()) throw new Error('url is required')
    if (typeof collection !== 'string' || !collection.trim()) throw new Error('collection is required')
    const dimension = embedding?.dimension
    if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new Error('embedding.dimension must be a positive integer')

    const status = await new QdrantProjectMemoryStore({
      enabled: true,
      url,
      collection,
      dimension,
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined,
    }).status()
    return normalizeMemoryConnectionCheckStatus(status)
  })

  // Create a new workspace/project/custom memory space on a connection.
  server.handle(RPC_CHANNELS.projects.MEMORY_SPACE_CREATE, async (_ctx, input: ProjectMemorySpaceCreateRequest): Promise<ProjectMemoryConnectionDetail> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory space create input')
    const { connectionId, expectedRevision, ...space } = input
    const result = await getMemoryConnectionService().addSpace(connectionId, space, expectedRevision)
    return buildConnectionDetail(result.connection.connectionId)
  })

  // Update one memory space on a connection.
  server.handle(RPC_CHANNELS.projects.MEMORY_SPACE_UPDATE, async (_ctx, input: ProjectMemorySpaceUpdateRequest): Promise<ProjectMemoryConnectionDetail> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory space update input')
    const { connectionId, expectedRevision, spaceId, ...patch } = input
    const result = await getMemoryConnectionService().updateSpace(connectionId, spaceId, patch, expectedRevision)
    return buildConnectionDetail(result.connection.connectionId)
  })

  // Delete one memory space from a connection.
  server.handle(RPC_CHANNELS.projects.MEMORY_SPACE_DELETE, async (_ctx, input: ProjectMemorySpaceDeleteRequest): Promise<ProjectMemoryConnectionDetail> => {
    await ensureMemoryReady()
    if (!input || typeof input !== 'object') throw new Error('Invalid memory space delete input')
    const { connectionId, expectedRevision, spaceId } = input
    const connection = await getMemoryConnectionService().deleteSpace(connectionId, spaceId, expectedRevision)
    return buildConnectionDetail(connection.connectionId)
  })
}
