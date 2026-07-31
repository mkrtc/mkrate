import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SECURITY_LIMITS, type TimelineEvent, type TimelinePayload } from '@mkrate/bridge-protocol'

interface ReplayEntry {
  readonly event: TimelineEvent
  readonly dedupeKey?: string
}

export interface BridgeReplayPersistenceState {
  sequence: number
  entries: Array<{ event: TimelineEvent; dedupeKey?: string }>
  snapshotCheckpoints: number[]
  resyncRequired: boolean
}

export interface BridgeReplayPersistence {
  loadReplay(bindingId: string): BridgeReplayPersistenceState | null
  saveReplay(bindingId: string, state: BridgeReplayPersistenceState, options?: { clearResync?: boolean }): void
  deleteReplay(bindingId: string): void
  markResyncRequired(bindingId: string): void
}

interface BindingWindow {
  sequence: number
  readonly entries: ReplayEntry[]
  readonly dedupe: Map<string, TimelineEvent>
  readonly snapshotCheckpoints: number[]
  resyncRequired: boolean
}

export type ReplayReadResult =
  | { kind: 'ok'; events: TimelineEvent[]; throughCursor: string }
  | { kind: 'resync-required'; currentCursor: string }

export interface AppendTimelineEventInput {
  sessionId: string
  occurredAtMs: number
  payload: TimelinePayload
  dedupeKey?: string
}

export interface BridgeReplayWindowOptions {
  maxEvents?: number
  epoch?: string
  persistence?: BridgeReplayPersistence
}

/** Bounded per-binding replay with optional crash-atomic Desktop persistence. */
export class BridgeReplayWindow {
  private readonly maxEvents: number
  private readonly epoch: string
  private readonly persistence?: BridgeReplayPersistence
  private readonly windows = new Map<string, BindingWindow>()

  constructor(options: BridgeReplayWindowOptions = {}) {
    this.maxEvents = options.maxEvents ?? SECURITY_LIMITS.replayMaxEvents
    this.epoch = options.epoch ?? randomUUID().replaceAll('-', '')
    this.persistence = options.persistence
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents <= 0 || this.maxEvents > SECURITY_LIMITS.replayMaxEvents) {
      throw new Error(`maxEvents must be between 1 and ${SECURITY_LIMITS.replayMaxEvents}`)
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.epoch)) throw new Error('epoch is invalid')
  }

  append(bindingId: string, input: AppendTimelineEventInput): TimelineEvent {
    const window = this.getWindow(bindingId)
    if (input.dedupeKey) {
      const duplicate = window.dedupe.get(input.dedupeKey)
      if (duplicate) return duplicate
    }

    const sequence = ++window.sequence
    const event: TimelineEvent = {
      eventId: this.eventId(bindingId, sequence),
      sessionId: input.sessionId,
      cursor: this.cursor(bindingId, sequence),
      occurredAtMs: input.occurredAtMs,
      payload: input.payload,
    }
    window.entries.push({ event, dedupeKey: input.dedupeKey })
    if (input.dedupeKey) window.dedupe.set(input.dedupeKey, event)
    while (window.entries.length > this.maxEvents) {
      const evicted = window.entries.shift()!
      if (evicted.dedupeKey && window.dedupe.get(evicted.dedupeKey) === evicted.event) {
        window.dedupe.delete(evicted.dedupeKey)
      }
    }
    this.persist(bindingId, window)
    return event
  }

  /**
   * Allocate event identities for a snapshot without adding a second journal.
   * The caller must hold its session serialization barrier. Later live appends
   * receive a sequence strictly greater than the returned base cursor.
   */
  allocateSnapshot(bindingId: string, inputs: readonly Omit<AppendTimelineEventInput, 'dedupeKey'>[]): {
    events: TimelineEvent[]
    baseCursor: string
  } {
    const window = this.getWindow(bindingId)
    const events = inputs.map(input => {
      const sequence = ++window.sequence
      return {
        eventId: this.eventId(bindingId, sequence),
        sessionId: input.sessionId,
        cursor: this.cursor(bindingId, sequence),
        occurredAtMs: input.occurredAtMs,
        payload: input.payload,
      } satisfies TimelineEvent
    })
    this.addSnapshotCheckpoint(window, window.sequence)
    window.resyncRequired = false
    // Persist the replacement snapshot cursor and cleared resync marker in one
    // authority-store transaction. A crash cannot expose "resync cleared" with
    // the pre-snapshot replay state.
    this.persist(bindingId, window, true)
    return { events, baseCursor: this.cursor(bindingId, window.sequence) }
  }

  replay(bindingId: string, afterCursor: string | null, sessionId?: string): ReplayReadResult {
    const window = this.getWindow(bindingId)
    const currentCursor = this.cursor(bindingId, window.sequence)
    if (window.resyncRequired) return { kind: 'resync-required', currentCursor }
    if (afterCursor === null) return { kind: 'ok', events: [], throughCursor: currentCursor }
    const afterSequence = this.parseCursor(bindingId, afterCursor)
    if (afterSequence === null || afterSequence > window.sequence) {
      return { kind: 'resync-required', currentCursor }
    }
    const isExactCursor = afterSequence === window.sequence
      || window.snapshotCheckpoints.includes(afterSequence)
      || window.entries.some(entry => this.sequenceOf(bindingId, entry.event.cursor) === afterSequence)
    if (!isExactCursor) return { kind: 'resync-required', currentCursor }

    if (window.entries.length === 0) {
      return afterSequence === window.sequence
        ? { kind: 'ok', events: [], throughCursor: currentCursor }
        : { kind: 'resync-required', currentCursor }
    }
    const oldest = this.sequenceOf(bindingId, window.entries[0]!.event.cursor)
    if (afterSequence < oldest - 1) return { kind: 'resync-required', currentCursor }

    const events = window.entries
      .map(entry => entry.event)
      .filter(event => this.sequenceOf(bindingId, event.cursor) > afterSequence && (!sessionId || event.sessionId === sessionId))
    return { kind: 'ok', events, throughCursor: currentCursor }
  }

  currentCursor(bindingId: string): string {
    return this.cursor(bindingId, this.getWindow(bindingId).sequence)
  }

  markResyncRequired(bindingId: string): void {
    const window = this.getWindow(bindingId)
    window.resyncRequired = true
    this.persistence?.markResyncRequired(bindingId)
    this.persist(bindingId, window)
  }

  clearBinding(bindingId: string): void {
    this.windows.delete(bindingId)
    this.persistence?.deleteReplay(bindingId)
  }

  private getWindow(bindingId: string): BindingWindow {
    let window = this.windows.get(bindingId)
    if (!window) {
      const stored = this.persistence?.loadReplay(bindingId)
      const entries = stored?.entries.map(entry => ({ event: entry.event, ...(entry.dedupeKey ? { dedupeKey: entry.dedupeKey } : {}) })) ?? []
      window = {
        sequence: stored?.sequence ?? 0,
        entries,
        dedupe: new Map(entries.flatMap(entry => entry.dedupeKey ? [[entry.dedupeKey, entry.event] as const] : [])),
        snapshotCheckpoints: stored?.snapshotCheckpoints ?? [0],
        resyncRequired: stored?.resyncRequired ?? false,
      }
      this.windows.set(bindingId, window)
    }
    return window
  }

  private persist(bindingId: string, window: BindingWindow, clearResync = false): void {
    this.persistence?.saveReplay(bindingId, {
      sequence: window.sequence,
      entries: window.entries.map(entry => ({ event: entry.event, ...(entry.dedupeKey ? { dedupeKey: entry.dedupeKey } : {}) })),
      snapshotCheckpoints: [...window.snapshotCheckpoints],
      resyncRequired: window.resyncRequired,
    }, { clearResync })
  }

  private cursor(bindingId: string, sequence: number): string {
    if (sequence > 0xffff_ffff) throw new Error('replay sequence exhausted')
    const epoch = this.bindingEpoch(bindingId).readUInt32BE(0)
    return ((BigInt(epoch) << 32n) | BigInt(sequence)).toString(10)
  }

  private eventId(bindingId: string, sequence: number): string {
    const bytes = Buffer.alloc(16)
    this.bindingEpoch(bindingId).copy(bytes, 0)
    bytes.writeBigUInt64BE(BigInt(sequence), 8)
    return bytes.toString('base64url')
  }

  private parseCursor(bindingId: string, cursor: string): number | null {
    if (!/^(?:0|[1-9][0-9]{0,19})$/.test(cursor)) return null
    const value = BigInt(cursor)
    if (value > 0xffff_ffff_ffff_ffffn) return null
    const epoch = Number(value >> 32n)
    if (epoch !== this.bindingEpoch(bindingId).readUInt32BE(0)) return null
    return Number(value & 0xffff_ffffn)
  }

  private sequenceOf(bindingId: string, cursor: string): number {
    const sequence = this.parseCursor(bindingId, cursor)
    if (sequence === null) throw new Error('internal replay cursor is invalid')
    return sequence
  }

  private bindingEpoch(bindingId: string): Buffer {
    return createHash('sha256').update(this.epoch).update('\0').update(bindingId).digest().subarray(0, 8)
  }

  private addSnapshotCheckpoint(window: BindingWindow, sequence: number): void {
    if (window.snapshotCheckpoints.at(-1) === sequence) return
    window.snapshotCheckpoints.push(sequence)
    while (window.snapshotCheckpoints.length > this.maxEvents) window.snapshotCheckpoints.shift()
  }
}
