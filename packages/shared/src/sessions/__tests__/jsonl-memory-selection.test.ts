import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createSession,
  getSessionFilePath,
  loadSession,
  saveSession,
} from '../storage.ts';
import {
  readSessionHeader,
  readSessionHeaderAsync,
  readSessionJsonl,
  MAX_SESSION_HEADER_BYTES,
  syncSessionJsonlFile,
  writeSessionJsonl,
  type SessionJsonlFsAdapter,
  type SessionJsonlSyncFsAdapter,
} from '../jsonl.ts';
import type { StoredSession } from '../types.ts';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'session-memory-persistence-'));
  tempDirs.push(workspace);
  return workspace;
}

function ref() {
  return { connectionId: randomUUID(), spaceId: randomUUID() };
}

function makeStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'memory-selection',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    ...overrides,
  } as StoredSession;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session JSONL Memory selection persistence', () => {
  it('opens temp files read-write before fsync for Windows FlushFileBuffers compatibility', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const fs: SessionJsonlSyncFsAdapter = {
      open: (path, flags) => {
        calls.push(['open', path, flags]);
        return 42;
      },
      sync: (fd) => calls.push(['sync', fd]),
      close: (fd) => calls.push(['close', fd]),
    };

    syncSessionJsonlFile('session.jsonl.tmp', fs);

    expect(calls).toEqual([
      ['open', 'session.jsonl.tmp', 'r+'],
      ['sync', 42],
      ['close', 42],
    ]);
  });

  it('creates, writes, and reads a canonical explicit selection without mutating the caller', async () => {
    const workspace = makeWorkspace();
    const created = await createSession(workspace);
    const session = loadSession(workspace, created.id)!;
    const upper = {
      connectionId: 'AAAAAAAA-E89B-42D3-8456-426614174000',
      spaceId: 'BBBBBBBB-E89B-42D3-8456-426614174001',
    };
    const later = ref();
    session.enabledMemorySpaceRefs = [later, upper];
    session.memoryWriteTargetRef = upper;
    session.memorySelectionMode = 'explicit';

    await saveSession(session);

    // The object handed to persistence remains untouched while the on-disk
    // representation and reload use canonical deterministic values.
    expect(upper.connectionId).toMatch(/[A-F]/);
    const reloaded = loadSession(workspace, created.id)!;
    expect(reloaded.enabledMemorySpaceRefs).toEqual([
      { connectionId: upper.connectionId.toLowerCase(), spaceId: upper.spaceId.toLowerCase() },
      later,
    ].sort((a, b) => a.connectionId.localeCompare(b.connectionId) || a.spaceId.localeCompare(b.spaceId)));
    expect(reloaded.memoryWriteTargetRef).toEqual({
      connectionId: upper.connectionId.toLowerCase(),
      spaceId: upper.spaceId.toLowerCase(),
    });
    expect(reloaded.memorySelectionMode).toBe('explicit');
  });

  it.each([
    ['51 refs', { enabledMemorySpaceRefs: Array.from({ length: 51 }, ref) }],
    ['unknown nested ref field', { enabledMemorySpaceRefs: [{ ...ref(), injected: true }] }],
    ['duplicate refs', (() => { const value = ref(); return { enabledMemorySpaceRefs: [value, value] }; })()],
    ['invalid selection mode', { memorySelectionMode: 'derived' }],
  ])('quarantines malformed persisted %s rather than raw-round-tripping it', (_name, selection) => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    writeSessionJsonl(sessionFile, makeStoredSession({
      ...selection,
      memorySelectionMode: (selection as { memorySelectionMode?: 'explicit' }).memorySelectionMode,
    }));

    const header = readSessionHeader(sessionFile)!;
    expect(header.enabledMemorySpaceRefs).toBeUndefined();
    expect(header.memoryWriteTargetRef).toBeUndefined();
    expect(header.memorySelectionMode).toBeUndefined();
    const rawHeader = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]!);
    expect(rawHeader.enabledMemorySpaceRefs).toBeUndefined();
    expect(rawHeader.memoryWriteTargetRef).toBeUndefined();
    expect(rawHeader.memorySelectionMode).toBeUndefined();
  });

  it('quarantines malformed selection from an existing JSONL header while preserving the session', () => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    const rawHeader = {
      ...makeStoredSession(),
      messageCount: 0,
      enabledMemorySpaceRefs: [{ ...ref(), attackerControlled: 'discard me' }],
      memorySelectionMode: 'explicit',
    };
    writeSessionJsonl(sessionFile, rawHeader as StoredSession);
    // Simulate a legacy/corrupt first line that bypassed the current writer.
    const corrupted = { ...rawHeader, enabledMemorySpaceRefs: [{ ...ref(), attackerControlled: true }] };
    writeFileSync(sessionFile, `${JSON.stringify(corrupted)}\n`);

    const loaded = readSessionJsonl(sessionFile)!;
    expect(loaded.id).toBe('memory-selection');
    expect(loaded.enabledMemorySpaceRefs).toBeUndefined();
    expect(loaded.memoryWriteTargetRef).toBeUndefined();
    expect(loaded.memorySelectionMode).toBeUndefined();
  });

  it('accepts a header exactly at the cap and rejects only an oversized first line', async () => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    const header = {
      ...makeStoredSession(),
      messageCount: 0,
      transferredSessionSummary: '',
    };
    const emptyBytes = Buffer.byteLength(JSON.stringify(header));
    header.transferredSessionSummary = 'x'.repeat(MAX_SESSION_HEADER_BYTES - emptyBytes);
    expect(Buffer.byteLength(JSON.stringify(header))).toBe(MAX_SESSION_HEADER_BYTES);

    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    expect(readSessionHeader(sessionFile)?.id).toBe('memory-selection');
    expect((await readSessionHeaderAsync(sessionFile))?.id).toBe('memory-selection');
    writeFileSync(sessionFile, `${JSON.stringify(header)}\r\n`);
    expect(readSessionHeader(sessionFile)?.id).toBe('memory-selection');
    expect((await readSessionHeaderAsync(sessionFile))?.id).toBe('memory-selection');

    header.transferredSessionSummary += 'x';
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    expect(readSessionHeader(sessionFile)).toBeNull();
    expect(await readSessionHeaderAsync(sessionFile)).toBeNull();
  });

  it('rejects an oversized direct write before replacing valid disk data or creating a temp file', () => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    writeSessionJsonl(sessionFile, makeStoredSession({ name: 'valid A' }));
    const original = readFileSync(sessionFile, 'utf8');

    expect(() => writeSessionJsonl(sessionFile, makeStoredSession({
      name: 'oversized B',
      transferredSessionSummary: 'x'.repeat(MAX_SESSION_HEADER_BYTES),
    }))).toThrow(`Session header exceeds ${MAX_SESSION_HEADER_BYTES} byte limit`);

    expect(readFileSync(sessionFile, 'utf8')).toBe(original);
    expect(readSessionJsonl(sessionFile)?.name).toBe('valid A');
    expect(existsSync(`${sessionFile}.tmp`)).toBe(false);
  });

  it('restores old A when Windows fallback rename fails, then retries to B', () => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    writeSessionJsonl(sessionFile, makeStoredSession({ name: 'A' }));
    const tmpFile = `${sessionFile}.tmp`;
    const backupFile = `${sessionFile}.bak`;
    let tmpTargetAttempts = 0;
    let failRenameRestore = true;
    const fs: SessionJsonlFsAdapter = {
      writeFile: (path, data) => writeFileSync(path, data),
      syncFile: () => {},
      rename: (oldPath, newPath) => {
        if (oldPath === tmpFile && newPath === sessionFile) {
          tmpTargetAttempts++;
          if (tmpTargetAttempts === 1) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
          if (tmpTargetAttempts === 2) throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' });
        }
        if (oldPath === backupFile && newPath === sessionFile && failRenameRestore) {
          failRenameRestore = false;
          throw Object.assign(new Error('injected restore rename failure'), { code: 'EIO' });
        }
        renameSync(oldPath, newPath);
      },
      unlink: (path) => unlinkSync(path),
      copyFile: (source, destination) => copyFileSync(source, destination),
    };

    expect(() => writeSessionJsonl(sessionFile, makeStoredSession({ name: 'B' }), fs))
      .toThrow('injected replacement failure');
    expect(readSessionJsonl(sessionFile)?.name).toBe('A');
    expect(existsSync(tmpFile)).toBe(false);
    expect(existsSync(backupFile)).toBe(false);

    writeSessionJsonl(sessionFile, makeStoredSession({ name: 'B' }), fs);
    expect(readSessionJsonl(sessionFile)?.name).toBe('B');
    expect(existsSync(tmpFile)).toBe(false);
    expect(existsSync(backupFile)).toBe(false);
  });

  it('reads a valid >8 KiB header through sync and async bounded newline readers', async () => {
    const workspace = makeWorkspace();
    const sessionFile = join(workspace, 'session.jsonl');
    const refs = Array.from({ length: 50 }, ref);
    writeSessionJsonl(sessionFile, makeStoredSession({
      enabledMemorySpaceRefs: refs,
      memoryWriteTargetRef: refs[0],
      memorySelectionMode: 'explicit',
      transferredSessionSummary: 'normal metadata '.repeat(700),
    }));

    const rawHeader = readFileSync(sessionFile, 'utf8').split('\n')[0]!;
    expect(Buffer.byteLength(rawHeader)).toBeGreaterThan(8192);
    const syncHeader = readSessionHeader(sessionFile);
    const asyncHeader = await readSessionHeaderAsync(sessionFile);
    expect(syncHeader?.enabledMemorySpaceRefs).toHaveLength(50);
    expect(asyncHeader).toEqual(syncHeader);
  });
});
