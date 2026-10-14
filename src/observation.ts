import { CALL_CACHE_BYTES, CALL_CACHE_ENTRIES, CALL_ENTRY_BYTES } from './call-cache.ts'
import { utf8Bytes } from './weight.ts'

export type ObservationJob<A, T> = {
  id: string
  arrival: A
  terminal?: T
  phase: 'arrival' | 'update' | 'terminal'
  revision: number
  version: number
}
type Entry<A, T> = { arrival: A; terminal?: T; arrivalBytes: number; bytes: number; arrived: boolean; version: number; published: number }

/** Transient delivery, not history. In-flight payloads remain charged until acknowledged. */
export class ObservationQueue<A, T> {
  private entries = new Map<string, Entry<A, T>>()
  private active: ObservationJob<A, T> | undefined
  private activeArrivalBytes = 0
  private activeExtra = 0
  private retired = new Map<ObservationJob<A, T>, number>()
  private revision = 0
  private heldBytes = 0
  private suspended = false
  private missed = 0

  private limits: { entries: number; bytes: number; entryBytes: number }
  constructor(limits = { entries: CALL_CACHE_ENTRIES, bytes: CALL_CACHE_BYTES, entryBytes: CALL_ENTRY_BYTES }) { this.limits = limits }

  private get reserve() { return Math.min(1024, Math.floor(this.limits.entryBytes / 4)) }

  get paused() { return this.suspended }
  get skipped() { return this.missed }
  get size() { return this.entries.size + this.retired.size }
  get bytes() { return this.heldBytes }
  get hasReady() { return [...this.entries.values()].some(entry => !entry.arrived || entry.published !== entry.version || entry.terminal !== undefined) }
  setPaused(value: boolean) { this.suspended = value }

  private snapshot<V>(value: V): { value: V; bytes: number } | undefined {
    try {
      const json = JSON.stringify(value)
      if (json === undefined || json.length > this.limits.entryBytes) return undefined
      const bytes = utf8Bytes(json)
      return bytes <= this.limits.entryBytes ? { value: JSON.parse(json) as V, bytes } : undefined
    } catch { return undefined }
  }

  admit(id: string, arrival: A, fallback?: () => A): boolean {
    if (this.entries.has(id)) return false
    let held = !this.suspended && this.size < this.limits.entries ? this.snapshot(arrival) : undefined
    if ((held === undefined || held.bytes + this.reserve > this.limits.entryBytes) && !this.suspended && this.size < this.limits.entries && fallback !== undefined) held = this.snapshot(fallback())
    if (held === undefined || held.bytes + this.reserve > this.limits.entryBytes || this.heldBytes + held.bytes + this.reserve > this.limits.bytes) {
      this.missed = Math.min(Number.MAX_SAFE_INTEGER, this.missed + 1)
      return false
    }
    this.entries.set(id, { arrival: held.value, arrivalBytes: held.bytes, bytes: held.bytes + this.reserve, arrived: false, version: 0, published: -1 })
    this.heldBytes += held.bytes + this.reserve
    return true
  }

  /** First terminal event wins. Oversized responses use an explicit bounded terminal fallback. */
  finish(id: string, terminal: T, fallback: T): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.terminal !== undefined) return false
    const fits = (held: { value: T; bytes: number } | undefined) => held !== undefined && entry.arrivalBytes + held.bytes <= this.limits.entryBytes && this.heldBytes + Math.max(0, held.bytes - this.reserve) <= this.limits.bytes
    let held = this.snapshot(terminal)
    if (!fits(held)) held = this.snapshot(fallback)
    if (!fits(held) || held === undefined) {
      // A full arrival can leave no space even for fallback. Drop its payload;
      // the caller must keep fallback small enough for the chosen entry budget.
      if (this.active?.id === id) {
        this.retired.set(this.active, entry.bytes + this.activeExtra)
        this.active = undefined
        this.activeExtra = 0
        this.activeArrivalBytes = 0
        this.entries.delete(id)
      } else this.remove(id)
      this.missed = Math.min(Number.MAX_SAFE_INTEGER, this.missed + 1)
      return false
    }
    entry.terminal = held.value
    entry.bytes += Math.max(0, held.bytes - this.reserve)
    this.heldBytes += Math.max(0, held.bytes - this.reserve)
    return true
  }

  updateArrival(id: string, change: (arrival: A) => A): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    const held = this.snapshot(change(entry.arrival))
    if (held === undefined) return false
    const bytes = entry.bytes - entry.arrivalBytes + held.bytes
    // A suspended drain may still hold the previous arrival object. Charge that
    // snapshot too, until acknowledgement, instead of hiding it behind a replacement.
    const extra = this.active?.id === id && this.activeExtra === 0 ? this.activeArrivalBytes : 0
    if (bytes > this.limits.entryBytes || this.heldBytes - entry.bytes + bytes + extra > this.limits.bytes) return false
    this.heldBytes += bytes - entry.bytes + extra
    this.activeExtra += extra
    entry.bytes = bytes
    entry.arrivalBytes = held.bytes
    entry.arrival = held.value
    entry.version += 1
    return true
  }

  getArrival(id: string): A | undefined { return this.entries.get(id)?.arrival }
  getTerminal(id: string): T | undefined { return this.entries.get(id)?.terminal }

  take(): ObservationJob<A, T> | undefined {
    if (this.active !== undefined) return undefined
    for (const [id, entry] of this.entries) {
      if (entry.arrived && entry.published === entry.version && entry.terminal === undefined) continue
      this.active = { id, arrival: entry.arrival, ...(entry.terminal !== undefined && { terminal: entry.terminal }), phase: !entry.arrived ? 'arrival' : entry.published !== entry.version ? 'update' : 'terminal', revision: this.revision, version: entry.version }
      this.activeArrivalBytes = entry.arrivalBytes
      return this.active
    }
    return undefined
  }

  complete(job: ObservationJob<A, T>): void {
    if (this.releaseRetired(job)) return
    if (this.active !== job || job.revision !== this.revision) return
    this.active = undefined
    this.releaseActiveExtra()
    const entry = this.entries.get(job.id)
    if (entry === undefined) return
    if (job.phase === 'terminal') this.remove(job.id)
    else { entry.arrived = true; entry.published = job.version }
  }

  discard(job: ObservationJob<A, T>): void {
    if (this.releaseRetired(job)) return
    if (this.active !== job || job.revision !== this.revision) return
    this.active = undefined
    this.releaseActiveExtra()
    this.remove(job.id)
  }

  private remove(id: string) {
    const entry = this.entries.get(id)
    if (entry !== undefined) this.heldBytes -= entry.bytes
    this.entries.delete(id)
  }

  private releaseRetired(job: ObservationJob<A, T>): boolean {
    const bytes = this.retired.get(job)
    if (bytes === undefined) return false
    this.heldBytes -= bytes
    this.retired.delete(job)
    return true
  }

  private releaseActiveExtra() {
    this.heldBytes -= this.activeExtra
    this.activeExtra = 0
    this.activeArrivalBytes = 0
  }

  clear(): void {
    // A host write cannot be cancelled. Its drain still owns this payload,
    // so retirement keeps charging it until that drain acknowledges it.
    if (this.active !== undefined) this.retired.set(this.active, (this.entries.get(this.active.id)?.bytes ?? 0) + this.activeExtra)
    this.revision += 1
    this.entries.clear()
    this.active = undefined
    this.activeExtra = 0
    this.activeArrivalBytes = 0
    this.heldBytes = [...this.retired.values()].reduce((total, bytes) => total + bytes, 0)
    this.suspended = false
    this.missed = 0
  }
}
