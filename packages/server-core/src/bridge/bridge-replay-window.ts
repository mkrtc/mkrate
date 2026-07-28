import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SECURITY_LIMITS, type TimelineEvent, type TimelinePayload } from '@mkrate/bridge-protocol'

interface ReplayEntry {
  readonly event: TimelineEvent
  readonly dedupeKey?: string
}

interface BindingWindow {
  sequence: number
  readonly entries: ReplayEntry[]
  readonly dedupe: Map<string, TimelineEvent>
  readonly snapshotCheckpoints: number[]
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
}

/** Bounded, process-local, per-binding replay. A new epoch means Desktop restart. */
export class BridgeReplayWindow {
  private readonly maxEvents: number
  private readonly epoch: string
  private readonly windows = new Map<string, BindingWindow>()

  constructor(options: BridgeReplayWindowOptions = {}) {
    this.maxEvents = options.maxEvents ?? SECURITY_LIMITS.replayMaxEvents
    this.epoch = options.epoch ?? randomUUID().replaceAll('-', '')
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
    return { events, baseCursor: this.cursor(bindingId, window.sequence) }
  }

  replay(bindingId: string, afterCursor: string | null, sessionId?: string): ReplayReadResult {
    const window = this.getWindow(bindingId)
    const currentCursor = this.cursor(bindingId, window.sequence)
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

  clearBinding(bindingId: string): void {
    this.windows.delete(bindingId)
  }

  private getWindow(bindingId: string): BindingWindow {
    let window = this.windows.get(bindingId)
    if (!window) {
      window = { sequence: 0, entries: [], dedupe: new Map(), snapshotCheckpoints: [0] }
      this.windows.set(bindingId, window)
    }
    return window
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
