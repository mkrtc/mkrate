import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ProjectMemoryConnectionSummary } from '@craft-agent/shared/protocol'
import { __setConfigDirForTests } from '@craft-agent/shared/config/paths'
import type { ProjectMemoryStore, ProjectMemoryPayload, ProjectMemorySearchInput, ProjectMemoryAddInput, ProjectMemoryStatus } from '@craft-agent/shared/project-memory'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

const configDir = mkdtempSync(join(tmpdir(), 'craft-memory-rpc-config-'))
const workspaceRoot = join(configDir, 'workspaces', 'test-workspace')
const projectId = 'proj_canonical'
const projectSlug = 'memory-project'
const defaultEmbedding = { model: 'craft-local-hash-v1', dimension: 384 }

function resetMemoryConnectionConfig() {
  resetMemoryRuntime?.()
  rmSync(join(configDir, 'memory'), { recursive: true, force: true })
}

let handlers: Map<string, HandlerFn>
let setProjectMemoryStoreForTests: (store: ProjectMemoryStore | null) => void
let registerProjectsHandlers: (server: RpcServer, deps: HandlerDeps) => void
let resetMemoryRuntime: (() => void) | undefined

function makePayload(input: ProjectMemoryAddInput): ProjectMemoryPayload {
  return {
    id: 'mem_1',
    scope: input.scope,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    source: input.source,
    title: input.title,
    content: input.content,
    contentHash: 'hash',
    createdAt: 1,
    updatedAt: 2,
    tags: input.tags,
  }
}

function createStore(status: ProjectMemoryStatus = {
  enabled: true,
  provider: 'qdrant',
  url: 'http://qdrant',
  collection: 'craft_memory',
  dimension: 64,
  ok: true,
}) {
  const calls: { add?: ProjectMemoryAddInput; search?: ProjectMemorySearchInput } = {}
  const store: ProjectMemoryStore = {
    async status() { return status },
    async add(input) {
      calls.add = input
      return makePayload(input)
    },
    async search(input) {
      calls.search = input
      return [{ score: 0.75, payload: makePayload({
        scope: 'project',
        workspaceId: input.scopes[0]?.workspaceId,
        projectId: input.scopes[0]?.projectId,
        source: 'decision',
        title: 'Decision',
        content: 'Use Qdrant.',
        tags: ['architecture'],
      }) }]
    },
  }
  return { store, calls }
}

function buildMemoryConnectionCreateInput(expectedRootRevision: number, name = 'Primary') {
  return {
    expectedRootRevision,
    name,
    url: 'https://qdrant.example',
    collection: 'craft_memory',
    embedding: defaultEmbedding,
    enabled: true,
    proactiveRemoteSearch: false,
  }
}

function server(): RpcServer {
  handlers = new Map()
  return {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function deps(): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } } as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

function ctx(workspaceId: string | null = 'test-workspace'): RequestContext {
  return { clientId: 'client-1', workspaceId, webContentsId: 1 }
}

function handler(channel: string): HandlerFn {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`Missing handler ${channel}`)
  return fn
}

beforeAll(async () => {
  process.env.CRAFT_CONFIG_DIR = configDir
  __setConfigDirForTests(configDir)
  mkdirSync(join(workspaceRoot, 'projects', projectSlug), { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'test-workspace',
      name: 'Test Workspace',
      slug: 'test-workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }],
    activeWorkspaceId: 'test-workspace',
    activeSessionId: null,
  }, null, 2))
  writeFileSync(join(workspaceRoot, 'projects', projectSlug, 'config.json'), JSON.stringify({
    id: projectId,
    slug: projectSlug,
    name: 'Memory Project',
    createdAt: 1,
    updatedAt: 1,
  }, null, 2))

  ;({ setProjectMemoryStoreForTests } = await import('@craft-agent/shared/project-memory'))
  const projectsModule = await import('./projects')
  registerProjectsHandlers = projectsModule.registerProjectsHandlers
  resetMemoryRuntime = projectsModule.__resetMemoryConnectionRuntimeForTests
})

afterEach(() => {
  setProjectMemoryStoreForTests(null)
  resetMemoryConnectionConfig()
})

afterAll(() => {
  __setConfigDirForTests(null)
  rmSync(configDir, { recursive: true, force: true })
})

describe('project memory RPC handlers', () => {
  it('normalizes ready, disabled, not-initialized, config-mismatch, unreachable, and generic error statuses', async () => {
    registerProjectsHandlers(server(), deps())
    const statusHandler = handler(RPC_CHANNELS.projects.MEMORY_STATUS)

    for (const [error, state] of [
      ['Qdrant 404 Not Found: collection does not exist', 'not-initialized'],
      ['Qdrant collection vector size 3 does not match expected 64', 'config-mismatch'],
      ['Qdrant collection distance Dot does not match expected Cosine', 'config-mismatch'],
      ['fetch failed: ECONNREFUSED', 'unreachable'],
      ['permission denied', 'error'],
    ] as const) {
      setProjectMemoryStoreForTests(createStore({ enabled: true, provider: 'qdrant', url: 'http://qdrant', collection: 'craft_memory', dimension: 64, ok: false, error }).store)
      expect((await statusHandler(ctx())).state).toBe(state)
    }

    setProjectMemoryStoreForTests(createStore().store)
    expect((await statusHandler(ctx())).state).toBe('ready')

    setProjectMemoryStoreForTests(createStore({ enabled: false, provider: 'qdrant', url: 'http://qdrant', collection: 'craft_memory', dimension: 64, ok: false, error: 'disabled' }).store)
    expect((await statusHandler(ctx())).state).toBe('disabled')
  })

  it('rejects missing workspace and missing project', async () => {
    const { store } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())
    const add = handler(RPC_CHANNELS.projects.MEMORY_ADD)

    await expect(add(ctx(null), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x' })).rejects.toThrow('Workspace context is required')
    await expect(add(ctx(), { projectIdOrSlug: 'missing', source: 'decision', content: 'x' })).rejects.toThrow('Project not found')
  })

  it('uses canonical workspace/project ids and ignores spoofed raw scope inputs on add', async () => {
    const { store, calls } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())

    const result = await handler(RPC_CHANNELS.projects.MEMORY_ADD)(ctx(), {
      projectIdOrSlug: projectSlug,
      source: 'decision',
      title: '  Direction  ',
      content: '  Use Qdrant.  ',
      tags: [' architecture ', 'architecture'],
      scope: 'global',
      workspaceId: 'spoofed-workspace',
      projectId: 'spoofed-project',
    })

    expect(calls.add).toMatchObject({
      scope: 'project',
      workspaceId: 'test-workspace',
      projectId,
      source: 'decision',
      title: 'Direction',
      content: 'Use Qdrant.',
      tags: ['architecture'],
    })
    expect(result).toMatchObject({ id: 'mem_1', projectId, source: 'decision', content: 'Use Qdrant.' })
    expect('scope' in result).toBe(false)
  })

  it('enforces project-only search and ignores spoofed raw scopes', async () => {
    const { store, calls } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())

    const result = await handler(RPC_CHANNELS.projects.MEMORY_SEARCH)(ctx(), {
      projectIdOrSlug: projectId,
      query: '  qdrant  ',
      limit: 3,
      scopes: [{ scope: 'global' }],
      workspaceId: 'spoofed-workspace',
    })

    expect(calls.search).toEqual({
      query: 'qdrant',
      scopes: [{ scope: 'project', workspaceId: 'test-workspace', projectId }],
      limit: 3,
    })
    expect(result[0]).toMatchObject({ score: 0.75, payload: { projectId, source: 'decision' } })
    expect('scope' in result[0].payload).toBe(false)
  })

  it('validates source/content/tags at the server boundary', async () => {
    const { store } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())
    const add = handler(RPC_CHANNELS.projects.MEMORY_ADD)

    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'file', content: 'x' })).rejects.toThrow('source must be manual-note or decision')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: '   ' })).rejects.toThrow('content is required')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x', tags: [''] })).rejects.toThrow('tags must not be empty')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x', tags: ['a'.repeat(65)] })).rejects.toThrow('tags must be at most')
  })

  it('checks memory connection reachability without persisting the connection or api key', async () => {
    registerProjectsHandlers(server(), deps())
    const check = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CHECK)
    const snapshot = handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; headers?: unknown }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify({
        result: {
          config: {
            params: {
              vectors: { size: 384, distance: 'Cosine' },
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    try {
      const result = await check(ctx(), {
        url: 'http://qdrant.example:6333',
        collection: 'craft_memory',
        embedding: defaultEmbedding,
        apiKey: 'sk-check-only',
      })

      expect(result).toMatchObject({ ok: true, state: 'ready', collection: 'craft_memory', dimension: 384 })
      expect(calls[0]?.url).toBe('http://qdrant.example:6333/collections/craft_memory')
      expect(calls[0]?.headers).toMatchObject({ 'api-key': 'sk-check-only' })
      expect((await snapshot(ctx())).revision).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lists memory connection snapshots with revision and environment metadata', async () => {
    registerProjectsHandlers(server(), deps())
    const snapshot = handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)
    const create = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)

    const initial = await snapshot(ctx())
    expect(initial.revision).toBe(0)
    expect(initial.connections).toHaveLength(1)
    expect(initial.connections[0]!.isEnvironment).toBe(true)

    const created = await create(ctx(), { ...buildMemoryConnectionCreateInput(0, 'Default'), apiKey: '  sk-test-default  ' })
    expect(created.hasApiKey).toBe(true)
    expect('apiKey' in created).toBe(false)

    const next = await snapshot(ctx())
    expect(next.revision).toBe(1)
    expect(next.connections).toHaveLength(2)

    const environment = next.connections.find((item: ProjectMemoryConnectionSummary) => item.isEnvironment)
    const stored = next.connections.find((item: ProjectMemoryConnectionSummary) => item.isEnvironment === false)

    expect(typeof environment?.hasApiKey).toBe('boolean')
    expect(stored?.hasApiKey).toBe(true)
    expect(stored?.connectionId).toBe(created.connectionId)
    expect(stored?.revision).toBe(1)
  })

  it('resolves connection detail for stored + environment connections', async () => {
    registerProjectsHandlers(server(), deps())
    const create = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)
    const getConnection = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_GET)

    const snapshotBefore = await handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)(ctx())
    const created = await create(ctx(), buildMemoryConnectionCreateInput(0, 'Primary'))
    const snapshotAfter = await handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)(ctx())

    const storedDetail = await getConnection(ctx(), created.connectionId)
    expect(storedDetail.connectionId).toBe(created.connectionId)
    expect(storedDetail.name).toBe(created.name)
    expect(storedDetail.spaces[0]!.kind).toBe('global')
    expect(storedDetail.spaces[0]!.readOnly).toBe(true)
    expect(storedDetail.spaceCount).toBe(1)

    const envConnectionId = snapshotAfter.connections.find((item: ProjectMemoryConnectionSummary) => item.isEnvironment)?.connectionId
    if (!envConnectionId) {
      throw new Error('Expected environment connection in snapshot')
    }
    const envDetail = await getConnection(ctx(), envConnectionId)
    expect(envDetail.isEnvironment).toBe(true)
    expect(envDetail.credentialMode).toBe('legacy-environment')

    await expect(getConnection(ctx(), 'missing-connection-id')).rejects.toThrow('Connection not found: missing-connection-id')
    expect(snapshotBefore.connections).toHaveLength(1)
  })

  it('enforces root and connection revision guards across connection/space mutations', async () => {
    registerProjectsHandlers(server(), deps())
    const create = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)
    const update = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_UPDATE)
    const deleteConn = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_DELETE)
    const createSpace = handler(RPC_CHANNELS.projects.MEMORY_SPACE_CREATE)
    const updateSpace = handler(RPC_CHANNELS.projects.MEMORY_SPACE_UPDATE)

    const created = await create(ctx(), buildMemoryConnectionCreateInput(0, 'Primary'))
    expect(created.connectionId).toBeTruthy()

    await expect(create(ctx(), buildMemoryConnectionCreateInput(0, 'Conflict'))).rejects.toThrow('revision')

    const updated = await update(ctx(), {
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      name: 'Primary Updated',
      apiKey: 'sk-updated',
    })
    expect(updated.name).toBe('Primary Updated')
    expect(updated.hasApiKey).toBe(true)

    await expect(update(ctx(), {
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      name: 'Stale',
    })).rejects.toThrow('revision')

    const spaceDetail = await createSpace(ctx(), {
      connectionId: created.connectionId,
      expectedRevision: updated.revision,
      kind: 'project',
      name: 'Project Space',
      writable: true,
      workspaceId: 'test-workspace',
      projectId,
    })

    const projectSpace = spaceDetail.spaces.find((item: { kind: string }) => item.kind === 'project')
    expect(projectSpace?.spaceId).toBeTruthy()

    await expect(updateSpace(ctx(), {
      connectionId: created.connectionId,
      expectedRevision: updated.revision,
      spaceId: projectSpace!.spaceId,
      name: 'Stale Space',
    })).rejects.toThrow('revision')

    await expect(deleteConn(ctx(), {
      connectionId: created.connectionId,
      expectedRootRevision: updated.revision,
    })).rejects.toThrow('revision')
  })

  it('routes space mutations through the coordinator: a space create racing a credential update serializes', async () => {
    registerProjectsHandlers(server(), deps())
    const create = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)
    const update = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_UPDATE)
    const createSpace = handler(RPC_CHANNELS.projects.MEMORY_SPACE_CREATE)

    const created = await create(ctx(), buildMemoryConnectionCreateInput(0, 'Primary'))

    // A credential-bearing connection update and a space create both expect the
    // same revision and contend on the one saga lease → exactly one commits.
    const outcomes = await Promise.allSettled([
      update(ctx(), { connectionId: created.connectionId, expectedRevision: created.revision, apiKey: 'sk-race' }),
      createSpace(ctx(), { connectionId: created.connectionId, expectedRevision: created.revision, kind: 'custom', name: 'Race Space', writable: true }),
    ])
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1)
  })

  it('fails closed at the server gate when an orphan saga staging secret has no journal entry', async () => {
    // A staged secret with no owning journal entry (journal lost/truncated) must
    // block every memory handler until an operator resolves it.
    const { CredentialManager } = await import('@craft-agent/shared/credentials')
    const sagaId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    const creds = new CredentialManager({ credentialsConfigDir: configDir })
    await creds.stageSagaSecret(sagaId, 'before', 'sk-orphan-server')
    try {
      registerProjectsHandlers(server(), deps())
      const snapshot = handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)
      const createConn = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)

      await expect(snapshot(ctx())).rejects.toThrow()
      await expect(createConn(ctx(), buildMemoryConnectionCreateInput(0, 'Blocked'))).rejects.toThrow()

      // Explicit resolution: remove the orphan staging → the gate recovers and serves.
      await creds.deleteStagedSagaSecret(sagaId, 'before')
      const ok = await snapshot(ctx())
      expect(ok.revision).toBe(0)
    } finally {
      await creds.deleteStagedSagaSecret(sagaId, 'before').catch(() => undefined)
    }
  })

  it('fails closed when startup saga recovery cannot complete (corrupt journal)', async () => {
    // A present-but-corrupt saga journal must block every memory handler rather
    // than let it operate on unrecovered state.
    mkdirSync(join(configDir, 'memory'), { recursive: true })
    writeFileSync(join(configDir, 'memory', 'saga-journal.json'), '{ this is not valid json')

    registerProjectsHandlers(server(), deps())
    const snapshot = handler(RPC_CHANNELS.projects.MEMORY_CONNECTIONS_SNAPSHOT)
    const create = handler(RPC_CHANNELS.projects.MEMORY_CONNECTION_CREATE)

    await expect(snapshot(ctx())).rejects.toThrow()
    await expect(create(ctx(), buildMemoryConnectionCreateInput(0, 'Blocked'))).rejects.toThrow()

    // After the operator removes the corrupt journal, the gate recovers and serves.
    rmSync(join(configDir, 'memory', 'saga-journal.json'), { force: true })
    const ok = await snapshot(ctx())
    expect(ok.revision).toBe(0)
  })
})
