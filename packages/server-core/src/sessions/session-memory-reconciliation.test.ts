import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getSessionFilePath,
  readSessionHeader,
  readSessionJsonl,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { ConfigWatcher } from '@craft-agent/shared/config'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const refA = {
  connectionId: '123e4567-e89b-42d3-8456-426614174000',
  spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000',
}
const refB = {
  connectionId: '123e4567-e89b-42d3-8456-426614174000',
  spaceId: 'bbbbbbbb-e89b-42d3-8456-426614174000',
}
const refC = {
  connectionId: '123e4567-e89b-42d3-8456-426614174000',
  spaceId: 'cccccccc-e89b-42d3-8456-426614174000',
}

type PublicMemorySession = {
  name?: string
  sessionStatus?: string
  enabledMemorySpaceRefs?: Array<typeof refA>
  memoryWriteTargetRef?: typeof refA
  memorySelectionMode?: 'explicit'
}

type DiagnosticCode =
  | 'setup.ready'
  | 'watch.seed' | 'watch.wait'
  | 'mixed.seed' | 'mixed.wait'
  | 'clear.seed' | 'clear.wait'
  | 'malformed.seed' | 'malformed.wait'
  | 'guard.seed' | 'guard.before' | 'guard.wait'
  | 'latest.seed' | 'latest.before' | 'latest.wait'
  | 'cleanup.seed' | 'cleanup.before' | 'cleanup.after'
  | 'fresh.seed' | 'fresh.after'

type DiagnosticStateKey =
  | 'tempReady'
  | 'headerRead' | 'headerSelectionA' | 'headerSelectionB' | 'headerSelectionAbsent'
  | 'managedSelectionA' | 'publicSelectionA' | 'watcherReady'
  | 'matched' | 'precondition' | 'postcondition'
  | 'diskRead' | 'diskSelectionB' | 'namePreserved' | 'singleLine'

function emitDiagnostic(code: DiagnosticCode, state: Partial<Record<DiagnosticStateKey, boolean>>): void {
  console.error(`[MEMORY_EVIDENCE_DIAG] ${JSON.stringify({ code, state })}`)
}

describe('SessionManager external Memory reconciliation', () => {
  let workspaceRootPath: string
  let sessionId: string
  let sm: SessionManager
  let workspace: { id: string; name: string; rootPath: string; createdAt: number }

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-manager-memory-watch-'))
    sessionId = `memory-watch-${Math.random().toString(36).slice(2)}`
    workspace = {
      id: 'ws-memory-watch',
      name: 'Memory Watch',
      rootPath: workspaceRootPath,
      createdAt: 1,
    }
    sm = new SessionManager({
      configWatcherFactory: (workspacePath, callbacks) => {
        const watcher = new ConfigWatcher(workspacePath, callbacks)
        watcher.start = function (this: ConfigWatcher): void {
          ;(this as unknown as { isRunning: boolean }).isRunning = true
        }
        return watcher
      },
    })
    // Keep this test focused on ConfigWatcher -> SessionManager production
    // reconciliation without starting an AutomationSystem scheduler.
    ;(sm as unknown as { automationSystems: Map<string, unknown> }).automationSystems.set(workspaceRootPath, {
      updateSessionMetadata: async () => {},
      dispose: () => {},
    })
    emitDiagnostic('setup.ready', { tempReady: existsSync(workspaceRootPath) })
  })

  afterEach(async () => {
    await sm.flushSession(sessionId).catch(() => {})
    await sm.cleanup()
    sessionPersistenceQueue.cancel(sessionId)
    rmSync(workspaceRootPath, { recursive: true, force: true })
  })

  function stored(selection: 'A' | 'B' | 'none' = 'A', overrides: Partial<StoredSession> = {}): StoredSession {
    const memory = selection === 'none'
      ? {}
      : {
          enabledMemorySpaceRefs: [selection === 'A' ? refA : refB],
          memoryWriteTargetRef: selection === 'A' ? refA : refB,
          memorySelectionMode: 'explicit' as const,
        }
    return {
      id: sessionId,
      workspaceRootPath,
      name: 'Session A',
      sessionStatus: 'todo',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      ...memory,
      ...overrides,
    }
  }

  function seedManaged(initial: StoredSession, code: Extract<DiagnosticCode, `${string}.seed`>): void {
    // Exercise the real ConfigWatcher dispatch/debounce/header-read path without
    // allocating recursive OS watchers. The injected factory stubs start() only
    // on this manager's watcher instance; no global prototype state is changed.
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, initial)
    const managed = createManagedSession(initial as never, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    const header = readSessionHeader(filePath)
    if (header) sessionPersistenceQueue.initializeBaseline(sessionId, header)
    sm.setupConfigWatcher(workspaceRootPath, workspace.id)
    emitDiagnostic(code, {
      headerRead: header !== null,
      headerSelectionA: header?.enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId,
      headerSelectionB: header?.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId,
      headerSelectionAbsent: header?.enabledMemorySpaceRefs === undefined,
      managedSelectionA: managed.enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId,
      publicSelectionA: current().enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId,
      watcherReady: (sm as unknown as { configWatchers: Map<string, unknown> }).configWatchers.has(workspaceRootPath),
    })
  }

  function current(): PublicMemorySession {
    return sm.getSessions(workspace.id).find(session => session.id === sessionId)! as PublicMemorySession
  }

  async function waitFor(
    predicate: (session: PublicMemorySession) => boolean,
    code: Extract<DiagnosticCode, `${string}.wait`>,
  ): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (predicate(current())) {
        emitDiagnostic(code, { matched: true })
        return
      }
      await Bun.sleep(25)
    }
    const matched = predicate(current())
    emitDiagnostic(code, { matched })
    expect(matched).toBe(true)
  }

  async function notifyAndWait(
    predicate: (session: PublicMemorySession) => boolean,
    code: Extract<DiagnosticCode, `${string}.wait`>,
  ): Promise<void> {
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)
    await waitFor(predicate, code)
  }

  it('applies a Memory-only external B update to runtime A -> B through the watch path', async () => {
    seedManaged(stored('A'), 'watch.seed')
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B'))

    await notifyAndWait(session => session.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId, 'watch.wait')

    expect(current().enabledMemorySpaceRefs).toEqual([refB])
    expect(current().memoryWriteTargetRef).toEqual(refB)
    expect(current().memorySelectionMode).toBe('explicit')
  })

  it('reconciles mixed metadata and Memory as one normalized external header', async () => {
    seedManaged(stored('A'), 'mixed.seed')
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B', {
      name: 'Session B',
      sessionStatus: 'needs-review',
    }))

    await notifyAndWait(
      session => session.name === 'Session B' && session.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId,
      'mixed.wait',
    )

    expect(current()).toMatchObject({
      name: 'Session B',
      sessionStatus: 'needs-review',
      enabledMemorySpaceRefs: [refB],
      memoryWriteTargetRef: refB,
      memorySelectionMode: 'explicit',
    })
  })

  it('clears all three runtime fields when the external header removes the selection', async () => {
    seedManaged(stored('A'), 'clear.seed')
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('none'))

    await notifyAndWait(session => session.enabledMemorySpaceRefs === undefined, 'clear.wait')

    expect(current().enabledMemorySpaceRefs).toBeUndefined()
    expect(current().memoryWriteTargetRef).toBeUndefined()
    expect(current().memorySelectionMode).toBeUndefined()
  })

  it('quarantines a malformed external selection without leaving partial runtime residue', async () => {
    seedManaged(stored('A'), 'malformed.seed')
    const validHeader = readSessionHeader(getSessionFilePath(workspaceRootPath, sessionId))!
    const malformed = {
      ...validHeader,
      enabledMemorySpaceRefs: [{ ...refB, injected: true }],
      memoryWriteTargetRef: refB,
      memorySelectionMode: 'explicit',
    }
    writeFileSync(getSessionFilePath(workspaceRootPath, sessionId), `${JSON.stringify(malformed)}\n`)

    await notifyAndWait(session => session.enabledMemorySpaceRefs === undefined, 'malformed.wait')

    expect(current().enabledMemorySpaceRefs).toBeUndefined()
    expect(current().memoryWriteTargetRef).toBeUndefined()
    expect(current().memorySelectionMode).toBeUndefined()
  })

  it('applies idle external B at guard expiry without requiring a second watcher event', async () => {
    seedManaged(stored('A'), 'guard.seed')
    const managed = (sm as unknown as {
      sessions: Map<string, { _metadataWriteGuardUntil?: number }>
    }).sessions.get(sessionId)!
    managed._metadataWriteGuardUntil = Date.now() + 250
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B'))
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)

    await Bun.sleep(140)
    emitDiagnostic('guard.before', { precondition: current().enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId })
    expect(current().enabledMemorySpaceRefs).toEqual([refA])
    await waitFor(session => session.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId, 'guard.wait')
    expect(current().enabledMemorySpaceRefs).toEqual([refB])
  })

  it('applies only the latest of multiple external headers deferred by the guard', async () => {
    seedManaged(stored('A'), 'latest.seed')
    const managed = (sm as unknown as {
      sessions: Map<string, { _metadataWriteGuardUntil?: number }>
    }).sessions.get(sessionId)!
    managed._metadataWriteGuardUntil = Date.now() + 450
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B'))
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)
    await Bun.sleep(140)

    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('none', {
      enabledMemorySpaceRefs: [refC],
      memoryWriteTargetRef: refC,
      memorySelectionMode: 'explicit',
    }))
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)
    await Bun.sleep(140)
    emitDiagnostic('latest.before', { precondition: current().enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId })
    expect(current().enabledMemorySpaceRefs).toEqual([refA])

    const deadline = Date.now() + 1_000
    while (Date.now() < deadline && current().enabledMemorySpaceRefs?.[0]?.spaceId !== refC.spaceId) {
      await Bun.sleep(25)
    }
    emitDiagnostic('latest.wait', { matched: current().enabledMemorySpaceRefs?.[0]?.spaceId === refC.spaceId })
    expect(current().enabledMemorySpaceRefs).toEqual([refC])
  })

  it('cleanup cancels an idle guard timer before it can mutate runtime state', async () => {
    seedManaged(stored('A'), 'cleanup.seed')
    const managed = (sm as unknown as {
      sessions: Map<string, { _metadataWriteGuardUntil?: number }>
    }).sessions.get(sessionId)!
    managed._metadataWriteGuardUntil = Date.now() + 350
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B'))
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)
    await Bun.sleep(140)
    emitDiagnostic('cleanup.before', { precondition: current().enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId })
    expect(current().enabledMemorySpaceRefs).toEqual([refA])

    await sm.cleanup()
    await Bun.sleep(260)
    emitDiagnostic('cleanup.after', { postcondition: current().enabledMemorySpaceRefs?.[0]?.spaceId === refA.spaceId })
    expect(current().enabledMemorySpaceRefs).toEqual([refA])
  })

  it('a fresh manager persistence cannot re-persist stale local A over existing disk B', async () => {
    // No durable queue baseline is initialized: this simulates a fresh manager
    // receiving a stale local snapshot before its first persistence attempt.
    sessionPersistenceQueue.cancel(sessionId)
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, stored('B', { name: 'Disk B' }))
    const seeded = readSessionJsonl(filePath)
    emitDiagnostic('fresh.seed', {
      diskRead: seeded !== null,
      diskSelectionB: seeded?.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId,
      namePreserved: seeded?.name === 'Disk B',
      singleLine: readFileSync(filePath, 'utf8').trim().split('\n').length === 1,
    })
    const staleA = stored('A', { name: 'Disk B' })
    const managed = createManagedSession(staleA as never, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    await sm.renameSession(sessionId, 'stale local rename')
    await sm.flushSession(sessionId)

    const persisted = readSessionJsonl(filePath)!
    emitDiagnostic('fresh.after', {
      diskRead: persisted !== null,
      diskSelectionB: persisted?.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId,
      namePreserved: persisted?.name === 'Disk B',
      singleLine: readFileSync(filePath, 'utf8').trim().split('\n').length === 1,
    })
    expect(persisted.enabledMemorySpaceRefs).toEqual([refB])
    expect(persisted.memoryWriteTargetRef).toEqual(refB)
    expect(persisted.memorySelectionMode).toBe('explicit')
    expect(persisted.name).toBe('Disk B')
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
