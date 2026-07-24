import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncSessionJsonlFile,
  type SessionJsonlSyncFsAdapter,
} from '../jsonl.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session JSONL fsync durability', () => {
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

  it('flushes a real temp file without changing content and cleans up', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-jsonl-fsync-'));
    tempDirs.push(root);
    const path = join(root, 'session.jsonl.tmp');
    const content = '{"id":"fsync-smoke"}\n';
    writeFileSync(path, content);

    syncSessionJsonlFile(path);

    expect(readFileSync(path, 'utf8')).toBe(content);
    rmSync(root, { recursive: true, force: true });
    const index = tempDirs.indexOf(root);
    if (index >= 0) tempDirs.splice(index, 1);
    expect(existsSync(root)).toBe(false);
  });
});
