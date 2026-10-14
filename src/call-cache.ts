// Bounded detail models; the hook stores serialized entries in session-only host state.
import type { CallDetailIndex, CallOverview, DetailAvailability, InspectedCall, InspectorCalls, ResolvedCall, ResolvedInspectorCalls, SelectedCall, StoredInspectorCalls } from '../types'
import { isRecord } from './guards.ts'
import { utf8Bytes } from './weight.ts'

export const CALL_CACHE_BYTES = 16 * 1024 * 1024
export const CALL_CACHE_ENTRIES = 128
export const CALL_ENTRY_BYTES = 2 * 1024 * 1024
export const CALL_OVERVIEW_BYTES = 16 * 1024
export const EMPTY_STORED: StoredInspectorCalls = { version: 2, queue: [], last: null, history: [] }
export const EMPTY_DETAILS: CallDetailIndex = { version: 1, epoch: '', writer: '', entries: [], active: null }
export const isFullCall = (call: ResolvedCall): call is InspectedCall => 'ir' in call

/** Host addresses are reused, rather than accumulating a tombstone for every call id. */
export function normalizeDetailIndex(raw: unknown): CallDetailIndex {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.epoch !== 'string' || raw.epoch.length > 200 || !Array.isArray(raw.entries) || raw.entries.length > CALL_CACHE_ENTRIES) return EMPTY_DETAILS
  const ids = new Set<string>(); const slots = new Set<number>()
  let total = 0
  for (const entry of raw.entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || utf8Bytes(entry.id) > CALL_OVERVIEW_BYTES || typeof entry.slot !== 'number' || !Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= CALL_CACHE_ENTRIES || typeof entry.bytes !== 'number' || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > CALL_ENTRY_BYTES || ids.has(entry.id) || slots.has(entry.slot)) return EMPTY_DETAILS
    ids.add(entry.id); slots.add(entry.slot); total += entry.bytes
  }
  if (total > CALL_CACHE_BYTES) return EMPTY_DETAILS
  return { version: 1, epoch: raw.epoch, writer: typeof raw.writer === 'string' ? raw.writer : '', entries: raw.entries as CallDetailIndex['entries'], active: typeof raw.active === 'string' && utf8Bytes(raw.active) <= CALL_OVERVIEW_BYTES ? raw.active : null }
}

/** Keep surviving slots stable and allocate the lowest free slot to new models. */
export function detailIndexFor(cache: CallCache, previous: CallDetailIndex): CallDetailIndex {
  const retained = cache.serialized()
  const previousSlots = new Map(previous.entries.filter(entry => cache.has(entry.id)).map(entry => [entry.id, entry.slot]))
  const occupied = new Set(previousSlots.values())
  const entries = retained.map(({ id, bytes }) => {
    let slot = previousSlots.get(id)
    if (slot === undefined) {
      slot = 0
      while (occupied.has(slot)) slot += 1
      occupied.add(slot)
    }
    return { id, slot, bytes }
  })
  return { ...previous, entries }
}

/** Serialized copies isolate cache ownership from callers and count actual retained UTF-8 bytes. */
export class CallCache {
  private entries = new Map<string, { json: string; bytes: number }>()
  private total = 0
  private pinned: string | undefined
  private active: string | undefined
  get bytes(): number { return this.total }
  get size(): number { return this.entries.size }
  has(id: string): boolean { return this.entries.has(id) }
  pin(selection: SelectedCall): void { this.pinned = selection.kind === 'call' ? selection.id : undefined }
  pinActive(id: string): void { this.active = id }
  releaseActive(id: string): void { if (this.active === id) this.active = undefined }
  get(id: string): InspectedCall | undefined {
    const entry = this.entries.get(id)
    return entry === undefined ? undefined : JSON.parse(entry.json) as InspectedCall
  }
  put(call: InspectedCall): DetailAvailability {
    let json: string
    try { json = JSON.stringify(call) } catch { this.delete(call.id); return 'oversize' }
    const bytes = utf8Bytes(json)
    this.delete(call.id)
    if (bytes > CALL_ENTRY_BYTES || utf8Bytes(call.id) > CALL_OVERVIEW_BYTES) return 'oversize'
    while (this.total + bytes > CALL_CACHE_BYTES || this.entries.size >= CALL_CACHE_ENTRIES) {
      const victim = [...this.entries.keys()].find(id => id !== this.pinned && id !== this.active)
      if (victim === undefined) return 'expired'
      this.delete(victim)
    }
    this.entries.set(call.id, { json, bytes })
    this.total += bytes
    return 'available'
  }
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id) && id !== this.pinned && id !== this.active) this.delete(id)
  }
  clear(): void { this.entries.clear(); this.total = 0; this.pinned = undefined; this.active = undefined }
  /** Copies of the owned strings for the hook's per-entry host writes. */
  serialized(): { id: string; json: string; bytes: number }[] {
    return [...this.entries].map(([id, entry]) => ({ id, ...entry }))
  }
  delete(id: string): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) this.total -= entry.bytes
    this.entries.delete(id)
  }
}

/** Import only actual full models from the pre-catalog host format; never infer missing details. */
export function legacyDetails(raw: unknown): CallCache {
  const cache = new CallCache()
  if (!isRecord(raw) || raw.version !== undefined && raw.version !== 1) return cache
  const latest: InspectedCall[] = []
  const ids = new Set<string>()
  const keep = (value: unknown) => {
    if (latest.length >= CALL_CACHE_ENTRIES || !isRecord(value) || typeof value.id !== 'string' || ids.has(value.id)) return
    if (typeof value.server !== 'string' || typeof value.operation !== 'string' || typeof value.variables !== 'string' || typeof value.arrivedAt !== 'number' || !Number.isFinite(value.arrivedAt)) return
    if (!['pending', 'ran', 'errored', 'denied', 'interrupted'].includes(String(value.status)) || value.tool !== undefined && !['search', 'introspect', 'validate', 'dry_run'].includes(String(value.tool))) return
    if (!isRecord(value.ir) || value.ir.toolCallId !== value.id || !['analyzing', 'ready', 'partial', 'invalid', 'unparseable'].includes(String(value.ir.state)) || !Array.isArray(value.ir.roots) || !value.ir.roots.every(root => isRecord(root) && typeof root.name === 'string')) return
    ids.add(value.id)
    latest.push(value as unknown as InspectedCall)
  }
  // Pending arrivals are newest; settled history is already newest first.
  if (Array.isArray(raw.queue)) for (let index = raw.queue.length - 1; index >= 0 && latest.length < CALL_CACHE_ENTRIES; index--) keep(raw.queue[index])
  if (Array.isArray(raw.history)) for (const call of raw.history) { keep(call); if (latest.length === CALL_CACHE_ENTRIES) break }
  keep(raw.last)
  // Older entries are the first evicted when the serialized byte budget fills.
  for (const call of latest.reverse()) cache.put(call)
  return cache
}

/** Small genuine metadata, with no stand-in IR or printed operation. */
export function overviewOf(call: InspectedCall, details: DetailAvailability = 'available'): CallOverview {
  const headline = call.ir.summary?.headline ?? (call.ir.roots.map(root => root.name).slice(0, 8).join(', ') || (call.tool ?? 'execute'))
  return {
    id: call.id, server: call.server, status: call.status, arrivedAt: call.arrivedAt,
    ...(call.tool !== undefined && { tool: call.tool }), ...(call.owner !== undefined && { owner: call.owner }),
    details, overview: { headline: headline.slice(0, 1_000), headlineSource: call.ir.summary === undefined ? 'derived' : 'model', ...(call.ir.opName !== undefined && { operationName: call.ir.opName.slice(0, 1_000) }), ...(call.ir.opType !== undefined && { operationKind: call.ir.opType }) },
  }
}

const isOverview = (raw: unknown): raw is CallOverview => isRecord(raw) && typeof raw.id === 'string' && typeof raw.server === 'string' && typeof raw.status === 'string' && typeof raw.arrivedAt === 'number' && isRecord(raw.overview) && typeof raw.overview.headline === 'string' && ['available', 'expired', 'reloaded', 'oversize'].includes(String(raw.details)) && utf8Bytes(JSON.stringify(raw)) <= CALL_OVERVIEW_BYTES

/** Normalize metadata only; the writer separately imports authentic bounded legacy details. */
export function normalizeStoredCalls(raw: unknown): StoredInspectorCalls {
  if (!isRecord(raw)) return EMPTY_STORED
  const convert = (value: unknown): CallOverview | undefined => {
    if (isOverview(value)) return value
    if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.ir) || !Array.isArray(value.ir.roots)) return undefined
    try {
      const compact = overviewOf(value as unknown as InspectedCall, 'reloaded')
      return isOverview(compact) ? compact : undefined
    } catch { return undefined }
  }
  const queue = Array.isArray(raw.queue) ? raw.queue.slice(-CALL_CACHE_ENTRIES).flatMap(one => convert(one) ?? []) : []
  const previous = convert(raw.last)
  const history = Array.isArray(raw.history) ? raw.history.slice(0, CALL_CACHE_ENTRIES).flatMap(one => convert(one) ?? []) : previous === undefined ? [] : [previous]
  return { version: 2, ...(typeof raw.writer === 'string' && { writer: raw.writer }), queue, last: history[0] ?? previous ?? null, history }
}

export function resolveCalls(state: StoredInspectorCalls, cache: CallCache, onlyId?: string): ResolvedInspectorCalls {
  const resolve = (call: CallOverview): ResolvedCall => {
    if (onlyId !== undefined && call.id !== onlyId) return call
    const full = cache.get(call.id)
    return full === undefined ? { ...call, details: call.details === 'available' ? 'reloaded' : call.details } : { ...full, status: call.status }
  }
  return { queue: state.queue.map(resolve), last: state.last === null ? null : resolve(state.last), history: state.history.map(resolve) }
}

export function fullCalls(state: ResolvedInspectorCalls): InspectorCalls {
  return { queue: state.queue.filter(isFullCall), last: state.last !== null && isFullCall(state.last) ? state.last : null, history: state.history.filter(isFullCall) }
}

/** Merge changed full models with metadata whose details expired, preserving their historical positions. */
export function storeCalls(previous: StoredInspectorCalls, next: InspectorCalls, selection: SelectedCall, availability: ReadonlyMap<string, DetailAvailability> = new Map()): StoredInspectorCalls {
  const convert = (call: InspectedCall) => overviewOf(call, availability.get(call.id) ?? 'available')
  const changed = new Map(next.history.map(call => [call.id, convert(call)]))
  const previousIds = new Set(previous.history.map(call => call.id))
  const history = [...next.history.filter(call => !previousIds.has(call.id)).map(convert), ...previous.history.map(call => changed.get(call.id) ?? call)]
  const selected = selection.kind === 'call' ? history.find(call => call.id === selection.id) : undefined
  // Navigation shares the detail-cache entry budget across all tool kinds.
  // A selected older call reserves one of those slots instead of expanding the bound.
  let unselected = 0
  const retained = history.filter(call => {
    if (call.id === selected?.id) return true
    return ++unselected <= CALL_CACHE_ENTRIES - (selected === undefined ? 0 : 1)
  })
  const settledIds = new Set(next.history.map(call => call.id))
  const pendingIds = new Set(next.queue.map(call => call.id))
  const queue = [...previous.queue.filter(call => !pendingIds.has(call.id) && !settledIds.has(call.id)), ...next.queue.map(convert)]
  return { version: 2, ...(previous.writer !== undefined && { writer: previous.writer }), queue, last: retained[0] ?? null, history: retained }
}

/** Settlement is metadata-owned too: unavailable details cannot keep a dialog pending. */
export function settleStoredCalls(state: StoredInspectorCalls, id: string, status: Exclude<InspectedCall['status'], 'pending'>, selection: SelectedCall): StoredInspectorCalls {
  const call = state.queue.find(call => call.id === id)
  let history = state.history
  if (call !== undefined) history = [{ ...call, status }, ...history.filter(one => one.id !== id)]
  else history = history.map(one => one.id === id && one.status === 'interrupted' && status !== 'interrupted' ? { ...one, status } : one)
  const updated = { ...state, queue: state.queue.filter(call => call.id !== id), history, last: history[0] ?? null }
  return storeCalls(updated, { queue: [], last: null, history: [] }, selection)
}

export function normalizeSelection(raw: unknown, state: StoredInspectorCalls): SelectedCall {
  if (isRecord(raw) && isRecord(raw.selection)) {
    if (raw.selection.kind === 'live') return { kind: 'live' }
    if (raw.selection.kind === 'call' && typeof raw.selection.id === 'string') return { kind: 'call', id: raw.selection.id }
  }
  if (isRecord(raw) && typeof raw.cursor === 'number') {
    const call = state.history[Math.min(Math.max(Math.floor(raw.cursor), 0), state.history.length - 1)]
    if (call !== undefined) return { kind: 'call', id: call.id }
  }
  return { kind: 'live' }
}
