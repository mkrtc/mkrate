/**
 * Outer cross-process saga lease.
 *
 * The A5 saga coordinates three durable stores (connections config, saga
 * journal, credential store). A single mutation of any one is serialized by that
 * store's own lock, but a *saga* spans all three across multiple steps. The lease
 * is the OUTER lock held for the entire saga (and for startup recovery), so at
 * most one saga — in this process or another — makes progress at a time.
 *
 * Lock graph (must stay acyclic):
 *   saga lease (outer)  →  repository `connections.json.lock` (inner)
 * A saga always takes the lease first, then the repository lock per config write;
 * never the reverse. Space CRUD takes only the inner repository lock and never the
 * lease, so it cannot form a cycle.
 *
 * The lock graph is **non-reentrant by construction**: a saga's steps only call
 * the repository and credential store — never another saga — so the lease is
 * never acquired while already held on the same logical path. Concurrent *distinct*
 * operations on one coordinator are serialized in-process by a FIFO chain (they
 * queue rather than overlap), and across processes by the lease file itself.
 */

import { closeSync, fsyncSync, openSync, statSync, unlinkSync, writeSync } from 'fs';
import { assertNoSymlinkOnPath, ensureDirSecure, readTextFileBounded } from './durable-file.ts';
import { randomUuid } from '../../utils/uuid.ts';
import { safeJsonParse } from '../../utils/files.ts';
import { MemoryError } from './types.ts';

const MAX_LEASE_METADATA_BYTES = 4 * 1024;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const INITIAL_BACKOFF_MS = 8;
const MAX_BACKOFF_MS = 128;
/** A lease older than this whose owner PID is dead (or unknown + aged) may be stolen. */
const LEASE_STALE_MS = 30_000;

export interface SagaLeaseOptions {
  /** Directory holding the lease file (the memory config dir). */
  dir: string;
  /** Full path of the lease file. */
  leasePath: string;
  /** Clock, overridable for tests. */
  now?: () => number;
  /** Max time to wait for the lease before failing closed. */
  acquireTimeoutMs?: number;
  /** Instrumentation fired around the critical section (tests: prove non-overlap). */
  onCritical?: (phase: 'enter' | 'exit') => void;
}

interface LeaseMetadata {
  token: string;
  pid: number;
  createdAtMs: number;
}

export class SagaLease {
  private readonly dir: string;
  private readonly leasePath: string;
  private readonly now: () => number;
  private readonly acquireTimeoutMs: number;
  private readonly onCritical?: (phase: 'enter' | 'exit') => void;
  private readonly ownerToken: string;
  private heldToken: string | null = null;
  /** In-process FIFO chain: concurrent operations queue instead of overlapping. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: SagaLeaseOptions) {
    this.dir = options.dir;
    this.leasePath = options.leasePath;
    this.now = options.now ?? (() => Date.now());
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.onCritical = options.onCritical;
    this.ownerToken = randomUuid();
  }

  /** Whether this instance currently holds the lease (within a `withLease` body). */
  isHeld(): boolean {
    return this.heldToken !== null;
  }

  /**
   * Run `fn` while holding the lease. In-process callers are serialized through a
   * FIFO chain (so two concurrent operations queue rather than both try to acquire
   * the file lease); across processes the lease file enforces mutual exclusion.
   */
  withLease<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => this.acquireRunRelease(fn));
    // Keep the chain alive even if this operation rejects.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async acquireRunRelease<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    this.onCritical?.('enter');
    try {
      return await fn();
    } finally {
      this.onCritical?.('exit');
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    const timeoutAt = this.now() + this.acquireTimeoutMs;
    let backoffMs = INITIAL_BACKOFF_MS;

    while (true) {
      ensureDirSecure(this.dir);
      const token = `${this.ownerToken}-${this.now()}-${randomUuid()}`;
      try {
        this.createLeaseFile(token);
        this.heldToken = token;
        return () => this.release(token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          const code = (error as NodeJS.ErrnoException).code;
          throw new MemoryError('storage_error', `failed to acquire saga lease: ${code ?? 'unknown'}`, { code, path: this.leasePath });
        }
        if (this.tryStealStaleLease()) continue;
        if (this.now() >= timeoutAt) {
          throw new MemoryError('storage_error', 'timed out while waiting for saga lease', { leasePath: this.leasePath });
        }
        await this.sleep(backoffMs);
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      }
    }
  }

  private createLeaseFile(token: string): void {
    assertNoSymlinkOnPath(this.leasePath);
    const metadata: LeaseMetadata = { token, pid: process.pid, createdAtMs: this.now() };
    const payload = JSON.stringify(metadata);
    let fd: number | undefined;
    try {
      fd = openSync(this.leasePath, 'wx', 0o600);
      writeSync(fd, payload);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          try { unlinkSync(this.leasePath); } catch { /* ignore */ }
        }
      }
      throw error;
    }
  }

  private tryStealStaleLease(): boolean {
    const metadata = this.readLeaseMetadata();
    if (metadata) {
      const alive = isProcessAlive(metadata.pid);
      if (alive === undefined) {
        if (this.now() - metadata.createdAtMs < LEASE_STALE_MS) return false;
      } else if (alive) {
        return false;
      }
    } else {
      try {
        const stat = statSync(this.leasePath);
        if (this.now() - stat.mtimeMs < LEASE_STALE_MS) return false;
      } catch {
        return false;
      }
    }
    try {
      unlinkSync(this.leasePath);
      return true;
    } catch {
      return false;
    }
  }

  private readLeaseMetadata(): LeaseMetadata | null {
    const read = readTextFileBounded(this.leasePath, MAX_LEASE_METADATA_BYTES);
    if (read.status !== 'ok') return null;
    try {
      const parsed = safeJsonParse(read.text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const raw = parsed as Record<string, unknown>;
      if (typeof raw.token !== 'string' || raw.token.length < 16) return null;
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
      if (typeof raw.createdAtMs !== 'number' || !Number.isFinite(raw.createdAtMs)) return null;
      return { token: raw.token, pid: raw.pid, createdAtMs: raw.createdAtMs };
    } catch {
      return null;
    }
  }

  private release(token: string): void {
    if (this.heldToken === token) this.heldToken = null;
    try {
      const metadata = this.readLeaseMetadata();
      if (!metadata || metadata.token !== token) return;
      unlinkSync(this.leasePath);
    } catch {
      // ignore
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function isProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}
