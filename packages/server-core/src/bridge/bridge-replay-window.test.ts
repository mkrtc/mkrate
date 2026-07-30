import { describe, expect, it } from 'bun:test'
import { BridgeReplayWindow } from './bridge-replay-window.ts'

const payload = { kind: 'progress', label: 'Working', state: 'updated' } as const
const sequence = (cursor: string) => Number(BigInt(cursor) & 0xffff_ffffn)

describe('BridgeReplayWindow', () => {
  it('replays exact per-binding events and deduplicates only within that binding', () => {
    const replay = new BridgeReplayWindow({ maxEvents: 4, epoch: 'epochA' })
    const a1 = replay.append('a', { sessionId: 's', occurredAtMs: 1, payload, dedupeKey: 'same' })
    const duplicate = replay.append('a', { sessionId: 's', occurredAtMs: 2, payload, dedupeKey: 'same' })
    const b1 = replay.append('b', { sessionId: 's', occurredAtMs: 3, payload, dedupeKey: 'same' })
    expect(duplicate).toBe(a1)
    expect(b1.eventId).not.toBe(a1.eventId)
    const read = replay.replay('a', new BridgeReplayWindow({ maxEvents: 4, epoch: 'epochA' }).currentCursor('a'), 's')
    expect(read.kind).toBe('ok')
    if (read.kind === 'ok') expect(read.events).toEqual([a1])
  })

  it('requires resync for stale/future cursors and for a previous Desktop epoch', () => {
    const replay = new BridgeReplayWindow({ maxEvents: 2, epoch: 'epochA' })
    for (let i = 0; i < 3; i++) replay.append('a', { sessionId: 's', occurredAtMs: i, payload })
    const zero = new BridgeReplayWindow({ maxEvents: 2, epoch: 'epochA' }).currentCursor('a')
    expect(replay.replay('a', zero).kind).toBe('resync-required')
    const futureSource = new BridgeReplayWindow({ maxEvents: 2, epoch: 'epochA' })
    for (let i = 0; i < 99; i++) futureSource.append('a', { sessionId: 's', occurredAtMs: i, payload })
    expect(replay.replay('a', futureSource.currentCursor('a')).kind).toBe('resync-required')
    const restarted = new BridgeReplayWindow({ maxEvents: 2, epoch: 'epochB' })
    expect(restarted.replay('a', replay.currentCursor('a')).kind).toBe('resync-required')
  })

  it('does not journal snapshot events and sequences later live events after baseCursor', () => {
    const replay = new BridgeReplayWindow({ maxEvents: 4, epoch: 'epochA' })
    const snapshot = replay.allocateSnapshot('a', [
      { sessionId: 's', occurredAtMs: 1, payload },
      { sessionId: 's', occurredAtMs: 2, payload },
    ])
    expect(sequence(snapshot.baseCursor)).toBe(2)
    expect(replay.replay('a', snapshot.baseCursor)).toEqual({ kind: 'ok', events: [], throughCursor: snapshot.baseCursor })
    // Snapshot consumers resume from baseCursor, not an interior event cursor
    // that has no retained replay journal behind it.
    expect(replay.replay('a', snapshot.events[0]!.cursor).kind).toBe('resync-required')
    const live = replay.append('a', { sessionId: 's', occurredAtMs: 3, payload })
    expect(sequence(live.cursor)).toBe(3)
    const afterSnapshot = replay.replay('a', snapshot.baseCursor)
    if (afterSnapshot.kind === 'ok') expect(afterSnapshot.events).toEqual([live])
  })
})
