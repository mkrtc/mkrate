import { createHash } from 'node:crypto'
import { canonicalJson, SECURITY_LIMITS } from '@mkrate/bridge-protocol'

export type BridgeResultCacheErrorCode = 'REQUEST_ID_REUSE' | 'CACHE_FULL'

export class BridgeResultCacheError extends Error {
  constructor(readonly code: BridgeResultCacheErrorCode) {
    super(code)
    this.name = 'BridgeResultCacheError'
  }
}

interface InFlightEntry<T> {
  readonly canonicalCommandHash: string
  readonly state: 'in-flight'
  readonly promise: Promise<T>
  lastAccessedAtMs: number
}

interface CompletedEntry<T> {
  readonly canonicalCommandHash: string
  readonly state: 'completed'
  readonly promise: Promise<T>
  readonly expiresAtMs: number
  lastAccessedAtMs: number
}

type CacheEntry<T> = InFlightEntry<T> | CompletedEntry<T>

export interface BridgeResultCacheOptions {
  ttlMs?: number
  maxEntriesPerBinding?: number
  now?: () => number
}

/**
 * Process-local idempotency cache. It deliberately makes no exactly-once claim
 * across Desktop restarts: a new process starts with an empty cache and callers
 * must reconcile from a session snapshot after an ambiguous send outcome.
 */
export class BridgeResultCache<T> {
  private readonly ttlMs: number
  private readonly maxEntriesPerBinding: number
  private readonly now: () => number
  private readonly bindings = new Map<string, Map<string, CacheEntry<T>>>()

  constructor(options: BridgeResultCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SECURITY_LIMITS.idempotencyRetentionMs
    this.maxEntriesPerBinding = options.maxEntriesPerBinding ?? SECURITY_LIMITS.idempotencyRecordsPerBinding
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error('ttlMs must be a positive integer')
    if (!Number.isSafeInteger(this.maxEntriesPerBinding) || this.maxEntriesPerBinding <= 0) {
      throw new Error('maxEntriesPerBinding must be a positive integer')
    }
  }

  run(bindingId: string, requestId: string, command: unknown, execute: () => Promise<T> | T): Promise<T> {
    const now = this.now()
    const cache = this.getBinding(bindingId)
    this.pruneExpired(cache, now)
    const canonicalCommandHash = createHash('sha256').update(canonicalJson(command)).digest('hex')
    const existing = cache.get(requestId)
    if (existing) {
      if (existing.canonicalCommandHash !== canonicalCommandHash) {
        throw new BridgeResultCacheError('REQUEST_ID_REUSE')
      }
      existing.lastAccessedAtMs = now
      this.touch(cache, requestId, existing)
      return existing.promise
    }

    this.ensureCapacity(cache)
    const promise = Promise.resolve().then(execute)
    const entry: InFlightEntry<T> = {
      canonicalCommandHash,
      state: 'in-flight',
      promise,
      lastAccessedAtMs: now,
    }
    cache.set(requestId, entry)

    void promise.then(
      () => {
        if (cache.get(requestId) !== entry) return
        const completed: CompletedEntry<T> = {
          canonicalCommandHash,
          state: 'completed',
          promise,
          expiresAtMs: this.now() + this.ttlMs,
          lastAccessedAtMs: this.now(),
        }
        cache.set(requestId, completed)
        this.touch(cache, requestId, completed)
      },
      () => {
        // Failures are cached too. Retrying an ambiguously failed send under the
        // same request identity must return the same failure instead of re-sending.
        if (cache.get(requestId) !== entry) return
        const completed: CompletedEntry<T> = {
          canonicalCommandHash,
          state: 'completed',
          promise,
          expiresAtMs: this.now() + this.ttlMs,
          lastAccessedAtMs: this.now(),
        }
        cache.set(requestId, completed)
        this.touch(cache, requestId, completed)
      },
    )
    return promise
  }

  clearBinding(bindingId: string): void {
    this.bindings.delete(bindingId)
  }

  size(bindingId: string): number {
    const cache = this.bindings.get(bindingId)
    if (!cache) return 0
    this.pruneExpired(cache, this.now())
    return cache.size
  }

  private getBinding(bindingId: string): Map<string, CacheEntry<T>> {
    let cache = this.bindings.get(bindingId)
    if (!cache) {
      cache = new Map()
      this.bindings.set(bindingId, cache)
    }
    return cache
  }

  private pruneExpired(cache: Map<string, CacheEntry<T>>, now: number): void {
    for (const [requestId, entry] of cache) {
      if (entry.state === 'completed' && entry.expiresAtMs <= now) cache.delete(requestId)
    }
  }

  private ensureCapacity(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size < this.maxEntriesPerBinding) return
    for (const [requestId, entry] of cache) {
      if (entry.state === 'completed') {
        cache.delete(requestId)
        return
      }
    }
    // Never evict an in-flight record: that would permit the same request to
    // execute twice while the original side effect is still unresolved.
    throw new BridgeResultCacheError('CACHE_FULL')
  }

  private touch(cache: Map<string, CacheEntry<T>>, requestId: string, entry: CacheEntry<T>): void {
    cache.delete(requestId)
    cache.set(requestId, entry)
  }
}
