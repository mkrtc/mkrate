import { describe, expect, it } from 'bun:test'
import { BridgeResultCache, BridgeResultCacheError } from './bridge-result-cache.ts'

describe('BridgeResultCache', () => {
  it('shares the same in-flight and completed result for an identical request', async () => {
    let resolve!: (value: number) => void
    let calls = 0
    const pending = new Promise<number>(r => { resolve = r })
    const cache = new BridgeResultCache<number>({ ttlMs: 1000, maxEntriesPerBinding: 4 })
    const first = cache.run('binding', 'request', { command: 'x', value: 1 }, () => { calls++; return pending })
    const duplicate = cache.run('binding', 'request', { value: 1, command: 'x' }, () => { calls++; return 99 })
    expect(first).toBe(duplicate)
    resolve(42)
    expect(await first).toBe(42)
    expect(await cache.run('binding', 'request', { command: 'x', value: 1 }, () => 99)).toBe(42)
    expect(calls).toBe(1)
  })

  it('rejects conflicting reuse and isolates the same request ID by binding', async () => {
    const cache = new BridgeResultCache<number>({ ttlMs: 1000, maxEntriesPerBinding: 4 })
    await cache.run('a', 'request', { value: 1 }, () => 1)
    expect(() => cache.run('a', 'request', { value: 2 }, () => 2)).toThrow(BridgeResultCacheError)
    try { cache.run('a', 'request', { value: 2 }, () => 2) } catch (error) {
      expect((error as BridgeResultCacheError).code).toBe('REQUEST_ID_REUSE')
    }
    expect(await cache.run('b', 'request', { value: 2 }, () => 2)).toBe(2)
  })

  it('evicts the least-recently-used completed result', async () => {
    const cache = new BridgeResultCache<number>({ ttlMs: 1000, maxEntriesPerBinding: 2 })
    let calls = 0
    await cache.run('a', 'one', {}, () => { calls++; return 1 })
    await cache.run('a', 'two', {}, () => { calls++; return 2 })
    await Promise.resolve()
    await cache.run('a', 'one', {}, () => { calls++; return 10 }) // touch one
    await cache.run('a', 'three', {}, () => { calls++; return 3 }) // evicts two
    await cache.run('a', 'two', {}, () => { calls++; return 20 })
    expect(calls).toBe(4)
  })

  it('expires completed results but never evicts an in-flight result', async () => {
    let now = 0
    let resolve!: (value: number) => void
    const cache = new BridgeResultCache<number>({ ttlMs: 10, maxEntriesPerBinding: 1, now: () => now })
    const pending = cache.run('a', 'one', {}, () => new Promise<number>(r => { resolve = r }))
    await Promise.resolve()
    expect(() => cache.run('a', 'two', {}, () => 2)).toThrow(BridgeResultCacheError)
    resolve(1)
    await pending
    await Promise.resolve()
    now = 11
    expect(await cache.run('a', 'two', {}, () => 2)).toBe(2)
  })
})
