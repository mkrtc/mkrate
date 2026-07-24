/**
 * Tests for the durable, secret-free, versioned, strictly-validated saga journal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SagaJournalStore, SAGA_JOURNAL_FILE, type SagaJournalEntry } from '../saga-journal.ts';
import { MemoryError } from '../types.ts';
import { randomUuid } from '../../../utils/uuid.ts';

let dir: string;
let filePath: string;
let store: SagaJournalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saga-journal-'));
  filePath = join(dir, SAGA_JOURNAL_FILE);
  store = new SagaJournalStore({ dir, filePath });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<SagaJournalEntry> = {}): SagaJournalEntry {
  return {
    sagaId: randomUuid(),
    operation: 'createConnection',
    idempotencyKey: 'createConnection:x',
    actor: 'test',
    attempt: 1,
    status: 'prepared',
    preconditions: { rootRevision: 0 },
    stagedSlots: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function writeRawDoc(doc: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`);
}

describe('SagaJournalStore basics', () => {
  test('missing journal loads as a fresh empty document', () => {
    expect(store.load()).toEqual({ version: 1, entries: [] });
  });

  test('upsert → get → remove round-trips; persists atomically with 0600 mode', () => {
    const e = entry();
    store.upsert(e);
    expect(existsSync(filePath)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(store.getEntry(e.sagaId)).toEqual(e);

    store.upsert({ ...e, status: 'config:done' });
    expect(store.getEntry(e.sagaId)?.status).toBe('config:done');
    expect(store.listEntries()).toHaveLength(1);

    store.remove(e.sagaId);
    expect(store.getEntry(e.sagaId)).toBeNull();
  });

  test('recovers a corrupt primary from a good backup', () => {
    const e = entry();
    store.upsert(e);
    store.upsert({ ...e, status: 'stage:done' });
    writeFileSync(filePath, 'not json at all');
    expect(store.load().entries).toHaveLength(1);
  });

  test('a corrupt primary AND missing backup fails closed', () => {
    writeFileSync(filePath, 'garbage');
    expect(() => store.load()).toThrow(MemoryError);
  });
});

describe('SagaJournalStore strict validation (fail closed)', () => {
  test('rejects a future/unknown version', () => {
    writeRawDoc({ version: 2, entries: [] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an unknown ROOT field', () => {
    writeRawDoc({ version: 1, entries: [], extra: true });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an unknown ENTRY field', () => {
    const e = entry();
    writeRawDoc({ version: 1, entries: [{ ...e, sneaky: 'x' }] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an unknown PRECONDITIONS field (nested)', () => {
    const e = entry({ preconditions: { rootRevision: 0, mystery: 1 } as never });
    writeRawDoc({ version: 1, entries: [e] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an unknown nested field inside a known object (createInput)', () => {
    const e = entry({
      preconditions: {
        createInput: { name: 'A', url: 'u', collection: 'c', embedding: { model: 'm', dimension: 8, extra: 1 } },
      } as never,
    });
    writeRawDoc({ version: 1, entries: [e] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an unknown status value', () => {
    writeRawDoc({ version: 1, entries: [{ ...entry(), status: 'reconciled' }] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('rejects an invalid credentialMode value', () => {
    const e = entry({ preconditions: { credentialModeBefore: 'bogus' } as never });
    writeRawDoc({ version: 1, entries: [e] });
    expect(() => store.load()).toThrow(MemoryError);
  });

  test('accepts a well-formed entry with a full valid preconditions object', () => {
    writeRawDoc({
      version: 1,
      entries: [entry({
        operation: 'updateConnectionConfig',
        connectionId: randomUuid(),
        status: 'config:done',
        preconditions: {
          connectionRevision: 2,
          configBefore: { name: 'A' },
          configAfter: { name: 'B' },
          credentialModeBefore: 'stored-api-key',
          credentialModeAfter: 'stored-api-key',
          hadKeyBefore: true,
        },
      })],
    });
    expect(store.load().entries).toHaveLength(1);
  });
});

describe('SagaJournalStore secrecy', () => {
  test('refuses to journal a secret-shaped field', () => {
    expect(() => store.upsert(entry({ preconditions: { apiKey: 'sk-secret' } as never }))).toThrow(/secret/i);
    expect(() => store.upsert(entry({ preconditions: { nested: { credential: 'sk' } } as never }))).toThrow(/secret/i);
  });

  test('a benign config-bearing entry is secret-free on disk', () => {
    store.upsert(entry({
      operation: 'updateConnectionConfig',
      connectionId: randomUuid(),
      preconditions: { connectionRevision: 1, configBefore: { name: 'X' }, configAfter: { name: 'Y' }, credentialModeBefore: 'stored-api-key' },
    }));
    const text = readFileSync(filePath, 'utf8');
    expect(text).not.toContain('sk-');
    expect(text).toContain('"credentialModeBefore": "stored-api-key"');
  });
});
