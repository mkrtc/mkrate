import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, COMMAND_CAPABILITIES, SECURITY_LIMITS, timelineEventSchema, type CommandCapability, type TimelineEvent } from '@mkrate/bridge-protocol';
import { getConfigDir } from '@craft-agent/shared/config';
import { atomicWriteSecure, ensureDirSecure, readTextFileBounded } from '@craft-agent/shared/project-memory';

const VERSION = 1 as const;
const MAX_BYTES = 16 * 1024 * 1024;

export interface BridgeAuthorityIdentity {
  profileId: string;
  deploymentId: string;
  instanceId: string;
}

export interface DurableBridgeBinding {
  bindingId: string;
  deviceId: string;
  deviceName: string;
  grantedCapabilities: readonly CommandCapability[];
  approvedAtMs: number;
}

export interface DurableReplayState {
  sequence: number;
  entries: Array<{ event: TimelineEvent; dedupeKey?: string }>;
  snapshotCheckpoints: number[];
  resyncRequired: boolean;
}

interface MutationRecord {
  bindingId: string;
  idempotencyKey: string;
  commandHash: string;
  state: 'in-flight' | 'completed';
  outcome?: unknown;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

interface Document {
  version: typeof VERSION;
  identity: BridgeAuthorityIdentity | null;
  epoch: string;
  bindings: DurableBridgeBinding[];
  mutations: MutationRecord[];
  replay: Record<string, DurableReplayState>;
}

export type MutationAdmission<T> =
  | { kind: 'new' }
  | { kind: 'completed'; outcome: T }
  | { kind: 'conflict' }
  | { kind: 'resync-required' };

/**
 * One desktop-owned, versioned, crash-atomic Bridge authority store. It contains
 * only binding authorization, bounded mutating-command outcomes, replay state,
 * cursors/epoch, and explicit resync markers. It never stores credentials,
 * enrollment material, tool definitions, attachment paths, or session snapshots.
 */
export class BridgeAuthorityStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly lockPath: string;
  private doc: Document;

  constructor(dir = join(getConfigDir(), 'bridge')) {
    this.dir = dir;
    this.path = join(dir, 'authority-state.json');
    this.lockPath = join(dir, 'authority-state.lock');
    this.doc = this.load();
  }

  activate(identity: BridgeAuthorityIdentity): void {
    this.transaction(doc => {
      if (doc.identity && !sameIdentity(doc.identity, identity)) {
        throw new Error('Bridge authority state belongs to another profile identity; clear it explicitly first');
      }
      doc.identity ??= { ...identity };
    });
  }

  clearProfile(profileId: string): void {
    this.transaction(doc => {
      if (doc.identity && doc.identity.profileId !== profileId) throw new Error('Bridge authority profile mismatch');
      doc.identity = null;
      doc.epoch = randomUUID().replaceAll('-', '');
      doc.bindings = [];
      doc.mutations = [];
      doc.replay = {};
    });
  }

  listBindings(): DurableBridgeBinding[] {
    this.doc = this.load();
    return this.doc.bindings.map(binding => ({ ...binding, grantedCapabilities: [...binding.grantedCapabilities] }));
  }

  putBinding(binding: DurableBridgeBinding): void {
    this.transaction(doc => {
      requireIdentity(doc);
      doc.bindings = doc.bindings.filter(item => item.bindingId !== binding.bindingId);
      doc.bindings.push({ ...binding, grantedCapabilities: [...binding.grantedCapabilities] });
    });
  }

  removeBinding(bindingId: string): void {
    this.transaction(doc => {
      doc.bindings = doc.bindings.filter(item => item.bindingId !== bindingId);
      doc.mutations = doc.mutations.filter(item => item.bindingId !== bindingId);
      delete doc.replay[bindingId];
    });
  }

  beginMutation<T>(bindingId: string, idempotencyKey: string, command: unknown, now: number): MutationAdmission<T> {
    const hash = createHash('sha256').update(canonicalJson(command)).digest('hex');
    return this.transaction(doc => {
      requireBinding(doc, bindingId);
      doc.mutations = doc.mutations.filter(item => item.state !== 'completed' || item.expiresAtMs > now);
      const existing = doc.mutations.find(item => item.bindingId === bindingId && item.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.commandHash !== hash) return { kind: 'conflict' };
        if (existing.state === 'completed') return { kind: 'completed', outcome: structuredClone(existing.outcome) as T };
        const replay = doc.replay[bindingId] ?? { sequence: 0, entries: [], snapshotCheckpoints: [0], resyncRequired: false };
        replay.resyncRequired = true;
        doc.replay[bindingId] = replay;
        return { kind: 'resync-required' };
      }
      const records = doc.mutations.filter(item => item.bindingId === bindingId);
      if (records.length >= SECURITY_LIMITS.idempotencyRecordsPerBinding) {
        const index = doc.mutations.findIndex(item => item.bindingId === bindingId && item.state === 'completed');
        if (index >= 0) doc.mutations.splice(index, 1);
        else throw new Error('Bridge idempotency store is full');
      }
      doc.mutations.push({
        bindingId,
        idempotencyKey,
        commandHash: hash,
        state: 'in-flight',
        createdAtMs: now,
        updatedAtMs: now,
        expiresAtMs: now + SECURITY_LIMITS.idempotencyRetentionMs,
      });
      return { kind: 'new' };
    });
  }

  completeMutation(bindingId: string, idempotencyKey: string, outcome: unknown, now: number): void {
    this.transaction(doc => {
      requireBinding(doc, bindingId);
      const record = doc.mutations.find(item => item.bindingId === bindingId && item.idempotencyKey === idempotencyKey);
      if (!record || record.state !== 'in-flight') throw new Error('Bridge mutation admission is missing');
      record.state = 'completed';
      record.outcome = structuredClone(outcome);
      record.updatedAtMs = now;
      record.expiresAtMs = now + SECURITY_LIMITS.idempotencyRetentionMs;
    });
  }

  loadReplay(bindingId: string): DurableReplayState | null {
    this.doc = this.load();
    const state = this.doc.replay[bindingId];
    return state ? structuredClone(state) : null;
  }

  saveReplay(bindingId: string, state: DurableReplayState, options: { clearResync?: boolean } = {}): void {
    this.transaction(doc => {
      requireBinding(doc, bindingId);
      const next = structuredClone(state);
      if (doc.replay[bindingId]?.resyncRequired && !options.clearResync) next.resyncRequired = true;
      doc.replay[bindingId] = next;
    });
  }

  deleteReplay(bindingId: string): void {
    this.transaction(doc => { delete doc.replay[bindingId]; });
  }

  markResyncRequired(bindingId: string): void {
    this.transaction(doc => {
      if (!doc.bindings.some(item => item.bindingId === bindingId)) return;
      const current = doc.replay[bindingId] ?? { sequence: 0, entries: [], snapshotCheckpoints: [0], resyncRequired: false };
      current.resyncRequired = true;
      doc.replay[bindingId] = current;
    });
  }

  isResyncRequired(bindingId: string): boolean {
    this.doc = this.load();
    return this.doc.replay[bindingId]?.resyncRequired === true;
  }

  epoch(): string {
    this.doc = this.load();
    return this.doc.epoch;
  }

  private transaction<T>(mutator: (draft: Document) => T): T {
    ensureDirSecure(this.dir);
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
      fsyncSync(fd);
      const draft = structuredClone(this.load());
      const result = mutator(draft);
      validateDocument(draft);
      atomicWriteSecure(this.dir, this.path, `${JSON.stringify(draft, null, 2)}\n`);
      this.doc = draft;
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Bridge authority transaction lock is already held; refusing concurrent mutation');
      }
      throw error;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
        try { unlinkSync(this.lockPath); } catch { /* fail closed on next mutation */ }
      }
    }
  }

  private load(): Document {
    const read = readTextFileBounded(this.path, MAX_BYTES);
    if (read.status === 'missing') return fresh();
    if (read.status !== 'ok') throw new Error(`Bridge authority store is unreadable: ${read.message}`);
    let parsed: unknown;
    try { parsed = JSON.parse(read.text); } catch { throw new Error('Bridge authority store contains invalid JSON'); }
    validateDocument(parsed);
    return parsed;
  }
}

function fresh(): Document {
  return { version: VERSION, identity: null, epoch: randomUUID().replaceAll('-', ''), bindings: [], mutations: [], replay: {} };
}

function validateDocument(value: unknown): asserts value is Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge authority store is invalid');
  const doc = value as Record<string, unknown>;
  const keys = new Set(['version', 'identity', 'epoch', 'bindings', 'mutations', 'replay']);
  if (Object.keys(doc).length !== keys.size || Object.keys(doc).some(key => !keys.has(key))) throw new Error('Bridge authority store fields are invalid');
  if (doc.version !== VERSION || typeof doc.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(doc.epoch)) throw new Error('Bridge authority store version/epoch is invalid');
  if (doc.identity !== null && !validIdentity(doc.identity)) throw new Error('Bridge authority identity is invalid');
  if (!Array.isArray(doc.bindings) || !doc.bindings.every(validBinding)) throw new Error('Bridge authority bindings are invalid');
  const bindingIds = new Set((doc.bindings as DurableBridgeBinding[]).map(binding => binding.bindingId));
  if (bindingIds.size !== (doc.bindings as DurableBridgeBinding[]).length) throw new Error('Bridge authority bindings contain duplicates');
  if (!Array.isArray(doc.mutations) || !doc.mutations.every(validMutation)) throw new Error('Bridge authority mutations are invalid');
  const mutationIds = new Set<string>();
  for (const mutation of doc.mutations as MutationRecord[]) {
    const key = `${mutation.bindingId}\0${mutation.idempotencyKey}`;
    if (!bindingIds.has(mutation.bindingId) || mutationIds.has(key)) throw new Error('Bridge authority mutations are inconsistent');
    mutationIds.add(key);
  }
  if (!doc.replay || typeof doc.replay !== 'object' || Array.isArray(doc.replay)) throw new Error('Bridge authority replay state is invalid');
  for (const [bindingId, replay] of Object.entries(doc.replay as Record<string, unknown>)) {
    if (!bindingIds.has(bindingId) || !validReplay(replay)) throw new Error('Bridge authority replay entry is invalid');
  }
  if (doc.identity === null && (bindingIds.size > 0 || mutationIds.size > 0 || Object.keys(doc.replay).length > 0)) {
    throw new Error('Bridge authority state without an identity must be empty');
  }
}

function validIdentity(value: unknown): value is BridgeAuthorityIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 3 && validId(r.profileId) && validId(r.deploymentId) && validId(r.instanceId);
}

function validBinding(value: unknown): value is DurableBridgeBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = new Set(['bindingId', 'deviceId', 'deviceName', 'grantedCapabilities', 'approvedAtMs']);
  const capabilities = new Set(COMMAND_CAPABILITIES);
  return Object.keys(r).length === keys.size && !Object.keys(r).some(key => !keys.has(key))
    && validId(r.bindingId) && validId(r.deviceId) && typeof r.deviceName === 'string'
    && Array.isArray(r.grantedCapabilities) && new Set(r.grantedCapabilities).size === r.grantedCapabilities.length
    && r.grantedCapabilities.every(item => typeof item === 'string' && capabilities.has(item as CommandCapability))
    && typeof r.approvedAtMs === 'number' && Number.isFinite(r.approvedAtMs);
}

function validMutation(value: unknown): value is MutationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = new Set(['bindingId', 'idempotencyKey', 'commandHash', 'state', 'outcome', 'createdAtMs', 'updatedAtMs', 'expiresAtMs']);
  const expectedKeyCount = r.state === 'completed' ? 8 : 7;
  return Object.keys(r).length === expectedKeyCount && !Object.keys(r).some(key => !keys.has(key))
    && validId(r.bindingId) && validId(r.idempotencyKey) && typeof r.commandHash === 'string' && /^[0-9a-f]{64}$/.test(r.commandHash)
    && (r.state === 'in-flight' || r.state === 'completed')
    && typeof r.createdAtMs === 'number' && Number.isFinite(r.createdAtMs) && r.createdAtMs >= 0
    && typeof r.updatedAtMs === 'number' && Number.isFinite(r.updatedAtMs) && r.updatedAtMs >= r.createdAtMs
    && typeof r.expiresAtMs === 'number' && Number.isFinite(r.expiresAtMs) && r.expiresAtMs >= r.updatedAtMs
    && (r.state === 'in-flight' ? r.outcome === undefined : r.outcome !== undefined);
}

function validReplay(value: unknown): value is DurableReplayState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = new Set(['sequence', 'entries', 'snapshotCheckpoints', 'resyncRequired']);
  return Object.keys(r).length === keys.size && !Object.keys(r).some(key => !keys.has(key))
    && Number.isSafeInteger(r.sequence) && (r.sequence as number) >= 0
    && Array.isArray(r.entries) && r.entries.length <= SECURITY_LIMITS.replayMaxEvents
    && r.entries.every(validReplayEntry)
    && Array.isArray(r.snapshotCheckpoints) && r.snapshotCheckpoints.length <= SECURITY_LIMITS.replayMaxEvents
    && r.snapshotCheckpoints.every(item => Number.isSafeInteger(item) && item >= 0 && item <= (r.sequence as number))
    && typeof r.resyncRequired === 'boolean';
}

function validReplayEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = new Set(['event', 'dedupeKey']);
  return !Object.keys(r).some(key => !keys.has(key))
    && timelineEventSchema.safeParse(r.event).success
    && (r.dedupeKey === undefined || validDedupeKey(r.dedupeKey));
}

function validDedupeKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001F\u007F]/.test(value);
}

function requireIdentity(doc: Document): void {
  if (!doc.identity) throw new Error('Bridge authority identity is not active');
}

function requireBinding(doc: Document, bindingId: string): void {
  requireIdentity(doc);
  if (!doc.bindings.some(item => item.bindingId === bindingId)) throw new Error('Bridge binding is not durable');
}

function sameIdentity(a: BridgeAuthorityIdentity, b: BridgeAuthorityIdentity): boolean {
  return a.profileId === b.profileId && a.deploymentId === b.deploymentId && a.instanceId === b.instanceId;
}
