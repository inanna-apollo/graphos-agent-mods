// The pane's queue of Agent Services calls. Pure: no $.
//
// Permission dialogs come one at a time, in order, so the pane shows the
// oldest pending call: the one the dialog is about. When nothing is pending
// it shows the last call that settled, marked as such, so it never goes blank.

import type { CallStatus, InspectedCall, InspectorCalls, ResolvedCall, ResolvedInspectorCalls, SelectedCall } from '../types'
import { isRecord } from './guards.ts'
import { truncationOf } from './result.ts'

export const EMPTY: InspectorCalls = { queue: [], last: null, history: [] }

const LOOKUPS: readonly unknown[] = ['search', 'introspect', 'validate', 'dry_run']

/** A call the pane can draw: an id, an IR with a `roots` list (older builds stored other shapes), and no tool but `execute` (absent) or a lookup. */
const isCall = (value: unknown): value is InspectedCall => {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.ir)) return false
  if (value.tool !== undefined && !LOOKUPS.includes(value.tool)) return false
  return Array.isArray(value.ir.roots)
}

/** An `execute` call, not a lookup. */
export const isExecute = (call: InspectedCall): boolean => call.tool === undefined

/**
 * $.state outlives the code that wrote it (a hot reload keeps it), so state
 * from an older version of the mod is normal: fill what is missing, drop
 * entries that are not calls. Well-formed state comes back as is.
 */
export function normalizeCalls(raw: unknown): InspectorCalls {
  if (!isRecord(raw)) return EMPTY
  const state = raw as Partial<InspectorCalls>
  if (
    Array.isArray(state.queue) && Array.isArray(state.history) && 'last' in state &&
    state.queue.every(isCall) && state.history.every(isCall) && (state.last === null || isCall(state.last))
  ) {
    return state as InspectorCalls
  }
  const queue = Array.isArray(state.queue) ? state.queue.filter(isCall) : []
  const last = isCall(state.last) ? state.last : null
  const history = Array.isArray(state.history) ? state.history.filter(isCall) : last === null ? [] : [last]
  return { queue, last: history[0] ?? last, history }
}

export const HISTORY_MAX = 128
/** Shared with execute history so discovery remains useful throughout a demo. */
export const LOOKUP_MAX = HISTORY_MAX

/** Models stay whole in session memory; only host metadata is compacted. */
function kept(history: InspectedCall[]): InspectedCall[] {
  return history.slice(0, HISTORY_MAX)
}

export function arrive(state: InspectorCalls, call: InspectedCall): InspectorCalls {
  state = normalizeCalls(state)
  if (state.queue.some(one => one.id === call.id)) return state
  return { ...state, queue: [...state.queue, call] }
}

/**
 * Moves a pending call to the history with how it ended. `interrupted` is
 * the one provisional ending: an abort cut the wait, not the call, so a
 * result that still comes in replaces it.
 */
export function settle(state: InspectorCalls, id: string, status: Exclude<CallStatus, 'pending'>): InspectorCalls {
  state = normalizeCalls(state)
  const call = state.queue.find(one => one.id === id)
  if (call === undefined) {
    const isLate = status !== 'interrupted' && state.history.some(one => one.id === id && one.status === 'interrupted')
    if (!isLate) return state
    const history = state.history.map(one => (one.id === id ? { ...one, status } : one))
    return { ...state, history, last: history[0] ?? null }
  }
  const last = { ...call, status }
  return { queue: state.queue.filter(one => one.id !== id), last, history: kept([last, ...state.history]) }
}

/**
 * Settles, as interrupted, every pending call whose tool.call hook can no
 * longer settle it: one owned by another module instance than `owner` (a hot
 * reload or a worker respawn mid-dialog took its hook away), or every pending
 * call when `owner` is undefined (the session ended). The same state when
 * there is none, so a caller can skip the write.
 */
export function settleOrphans(state: InspectorCalls, owner?: string): InspectorCalls {
  state = normalizeCalls(state)
  const orphans = state.queue.filter(call => owner === undefined || call.owner !== owner)
  return orphans.reduce((current, call) => settle(current, call.id, 'interrupted'), state)
}

export type Shown = { call: InspectedCall | null; waiting: number }

/**
 * The call the pane draws, and how many like it are pending: the oldest
 * execute waiting at its prompt, else the oldest lookup waiting, else the
 * last call that settled. An execute's dialog holds the pane however many
 * searches run beside it, and `1 of N` counts dialogs of the shown kind.
 */
export function shown(state: InspectorCalls): Shown {
  state = normalizeCalls(state)
  const executes = state.queue.filter(isExecute)
  const pending = executes.length > 0 ? executes : state.queue
  return { call: pending[0] ?? state.last, waiting: pending.length }
}

/** Where the pane's cursor stands: null follows live, N shows `history[N]`. */
export type Cursor = number | null

/** The call at a cursor; a cursor past the history (or null) follows live. */
export function shownAt(state: InspectorCalls, cursor: Cursor): Shown {
  state = normalizeCalls(state)
  const call = cursor === null ? undefined : state.history[Math.min(Math.max(cursor, 0), state.history.length - 1)]
  return call === undefined ? shown(state) : { call, waiting: shown(state).waiting }
}

/** One step back in time, clamped at the oldest. From live, the first step skips the call live already shows. */
export function older(cursor: Cursor, state: InspectorCalls): Cursor {
  state = normalizeCalls(state)
  if (state.history.length === 0) return null
  const live = state.queue.length > 0 ? -1 : 0
  return Math.min((cursor ?? live) + 1, state.history.length - 1)
}

/** One step toward now; stepping past the newest settled call follows live again. */
export function newer(cursor: Cursor): Cursor {
  return cursor === null || cursor <= 0 ? null : cursor - 1
}

/**
 * Where the pane stands in its history, for the buttons and the position.
 * `older` / `newer` are the cursors a press moves to (`null` follows live),
 * absent when there is no such step.
 */
export type Nav = {
  /** Settled calls kept. */
  count: number
  /** 1 is the oldest kept, `count` the newest: `3 of 12`. 0 when the shown call is not in the history (pending). */
  position: number
  /** The shown call is the live one. */
  isLive: boolean
  older?: Cursor
  /** The step toward now, on any past call; `null` returns to live. */
  newer?: Cursor
}

/** The pane's place in its history; undefined with no more than one settled call. */
export function navOf(state: InspectorCalls, cursor: Cursor): Nav | undefined {
  state = normalizeCalls(state)
  const count = state.history.length
  if (count <= 1) return undefined
  const isQueued = state.queue.length > 0
  const index = cursor === null ? (isQueued ? -1 : 0) : Math.min(Math.max(cursor, 0), count - 1)
  const isLive = cursor === null || (!isQueued && index === 0)
  const stepNewer = newer(index)
  return {
    count,
    position: index < 0 ? 0 : count - index,
    isLive,
    ...(index < count - 1 && { older: older(cursor === null ? null : index, state) }),
    // The newest settled call is live: the step onto it follows live again (null).
    ...(!isLive && { newer: stepNewer === 0 && !isQueued ? null : stepNewer }),
  }
}

// What the engine hands back when the person refuses at the permission
// dialog: an errored result carrying this text (seen live, 2.1.290).
const REFUSED = /doesn't want to proceed with this tool use|tool use was rejected/i

/** How a settled `tool.call` result reads: refused (by a hook or at the dialog), failed, or ran. */
export function statusOf(result: { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown }): Exclude<CallStatus, 'pending'> {
  if (result.deny !== undefined) return 'denied'
  if (result.isError !== true) return 'ran'
  // The engine can flag a saved-output stand-in as an error even though the
  // operation ran. Only a recognized engine tool-results path qualifies.
  if ((truncationOf(result.text) ?? truncationOf(result.result))?.path !== undefined) return 'ran'
  const text = [result.text, result.result].find((one): one is string => typeof one === 'string') ?? ''
  return REFUSED.test(text) ? 'denied' : 'errored'
}

/**
 * Whether what a call's verdict line says can no longer change: it settled
 * for good (an interruption may still be replaced by a late result), its
 * analysis is over, and a call that ran has its outcome.
 */
export function isFinal(call: InspectedCall): boolean {
  if (call.status === 'pending' || call.status === 'interrupted' || call.ir.state === 'analyzing') return false
  if (!isExecute(call)) return call.status !== 'ran' || call.found !== undefined
  return call.status !== 'ran' || call.outcome !== undefined
}

/** Replaces one call's IR wherever it is: still pending, or the last settled. */
export function patchIR(state: InspectorCalls, id: string, ir: InspectedCall['ir']): InspectorCalls {
  state = normalizeCalls(state)
  const queue = state.queue.map(one => (one.id === id ? { ...one, ir } : one))
  const last = state.last?.id === id ? { ...state.last, ir } : state.last
  return { queue, last, history: state.history.map(one => (one.id === id ? { ...one, ir } : one)) }
}

/** Records how a call fared against the trust rules, wherever it is. */
export function patchTrust(state: InspectorCalls, id: string, trust: NonNullable<InspectedCall['trust']>): InspectorCalls {
  state = normalizeCalls(state)
  const queue = state.queue.map(one => (one.id === id ? { ...one, trust } : one))
  const last = state.last?.id === id ? { ...state.last, trust } : state.last
  return { queue, last, history: state.history.map(one => (one.id === id ? { ...one, trust } : one)) }
}

/** Records a bounded result preview wherever the call is; older calls preserve the same facts. */
export function patchOutcome(state: InspectorCalls, id: string, outcome: NonNullable<InspectedCall['outcome']>): InspectorCalls {
  state = normalizeCalls(state)
  const queue = state.queue.map(one => (one.id === id ? { ...one, outcome } : one))
  const last = state.last?.id === id ? { ...state.last, outcome } : state.last
  return { queue, last, history: state.history.map(one => (one.id === id ? { ...one, outcome } : one)) }
}

/** Records what a settled lookup's response said, and the IR read from it, wherever the call is. */
export function patchLookup(state: InspectorCalls, id: string, found: NonNullable<InspectedCall['found']>, ir: InspectedCall['ir']): InspectorCalls {
  state = normalizeCalls(state)
  const change = (one: InspectedCall): InspectedCall => (one.id === id ? { ...one, found, ir } : one)
  const last = state.last === null ? null : change(state.last)
  return { queue: state.queue.map(change), last, history: state.history.map(change) }
}

/** Records which subagent made a call, wherever the call is. */
export function patchAgent(state: InspectorCalls, id: string, agent: NonNullable<InspectedCall['agent']>): InspectorCalls {
  state = normalizeCalls(state)
  const queue = state.queue.map(one => (one.id === id ? { ...one, agent } : one))
  const last = state.last?.id === id ? { ...state.last, agent } : state.last
  return { queue, last, history: state.history.map(one => (one.id === id ? { ...one, agent } : one)) }
}


/** Resolved UI state includes explicit unavailable metadata, never a substitute IR. */
export type ResolvedShown = { call: ResolvedCall | null; waiting: number }
export function shownResolvedAt(state: ResolvedInspectorCalls, selection: SelectedCall): ResolvedShown {
  const executes = state.queue.filter(call => call.tool === undefined)
  const pending = executes.length > 0 ? executes : state.queue
  const live = pending[0] ?? state.last
  const call = selection.kind === 'live' ? live : [...state.queue, ...state.history].find(call => call.id === selection.id) ?? null
  return { call, waiting: pending.length }
}
export function selectionOlder(selection: SelectedCall, state: ResolvedInspectorCalls): SelectedCall {
  if (state.history.length === 0) return { kind: 'live' }
  const index = selection.kind === 'live' ? (state.queue.length > 0 ? -1 : 0) : state.history.findIndex(call => call.id === selection.id)
  return { kind: 'call', id: state.history[Math.min(index + 1, state.history.length - 1)]!.id }
}
export function selectionNewer(selection: SelectedCall, state: ResolvedInspectorCalls): SelectedCall {
  if (selection.kind === 'live') return selection
  const index = state.history.findIndex(call => call.id === selection.id)
  if (index <= 0 || (index === 1 && state.queue.length === 0)) return { kind: 'live' }
  return { kind: 'call', id: state.history[index - 1]!.id }
}
export type ResolvedNav = Omit<Nav, 'older' | 'newer'> & { older?: SelectedCall; newer?: SelectedCall }
export function navResolvedOf(state: ResolvedInspectorCalls, selection: SelectedCall): ResolvedNav | undefined {
  const count = state.history.length
  if (count <= 1) return undefined
  const index = selection.kind === 'live' ? (state.queue.length > 0 ? -1 : 0) : state.history.findIndex(call => call.id === selection.id)
  const isLive = selection.kind === 'live'
  return { count, position: index < 0 ? 0 : count - index, isLive,
    ...(index < count - 1 && { older: selectionOlder(selection, state) }),
    ...(!isLive && { newer: selectionNewer(selection, state) }),
  }
}
