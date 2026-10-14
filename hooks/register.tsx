// GraphOS Inspector: explains each Agent Services execute call while you decide on it,
// and Claude's search, introspect, validate and dry_run calls as they run.
// The only module that touches $. It never denies or rewrites a call: every
// tool.call path ends in next(e) with e unchanged. It approves only a call
// that fits the person's own trust rules (src/trust.ts), and only where the
// engine would have asked.

import { atom, memberOf, read, update } from 'claude-code'
import type { Args, EngineInterface, Next, NextResult, Register, RenderNode, RenderSurface, Timer } from 'claude-code'

import type { CallDetailIndex, CallDetailSlot, InspectedCall, InspectorCalls, ResolvedInspectorCalls, SelectedCall, StoredInspectorCalls } from '../types'
import { adaptExecute } from '../src/adapter.ts'
import { escapeText } from '../src/escape.ts'
import { annotate } from '../src/annotate.ts'
import { appendCheckContext, checkFailureContext } from '../src/checks.ts'
import { buildIR } from '../src/build.ts'
import { cacheForServer, enrich, enrichSchema, isAllowedWithoutPrompt, scopesOf } from '../src/enrich.ts'
import { accessFromIR, adaptLookup, isOperationLookup, lookupErrorOf, lookupToolOf, pendingIR, settledLookup } from '../src/lookup.ts'
import type { AdaptedLookup } from '../src/lookup.ts'
import { CallCache, CALL_CACHE_ENTRIES, EMPTY_DETAILS, EMPTY_STORED, detailIndexFor, fullCalls, isFullCall, legacyDetails, normalizeDetailIndex, normalizeSelection, normalizeStoredCalls, overviewOf, resolveCalls, settleStoredCalls, storeCalls } from '../src/call-cache.ts'
import { utf8Bytes } from '../src/weight.ts'
import { ObservationQueue } from '../src/observation.ts'
import type { ObservationJob } from '../src/observation.ts'
import type { CallGas, EnrichCache, GasTool } from '../src/enrich.ts'
import { normalize } from '../src/normalize.ts'
import { allowedOrigins, configOf, loadLinkConfig } from '../src/links.ts'
import type { BaseSource, LinkConfig } from '../src/links.ts'
import { describeBases, hostOf, learnable, learnedOf, setupPrompt, sitesIn, sitesOfGraph } from '../src/sites.ts'
import type { Sites } from '../src/sites.ts'
import { setupReport } from '../src/setup.ts'
import type { ToolState } from '../src/setup.ts'
import { versionNote } from '../src/version.ts'
import { OPEN_TIMEOUT_MS, openArgv } from '../src/open.ts'
import { navResolvedOf, selectionOlder, selectionNewer, shownResolvedAt, arrive, EMPTY, isExecute, isFinal, patchAgent, patchIR, patchLookup, patchOutcome, patchTrust, settle, settleOrphans, statusOf } from '../src/queue.ts'
import { MAX_SAVED, outcomeOf, pickResult, responseIn, savedOutcome, truncationOf } from '../src/result.ts'
import { desktopGasServers, gasServers, splitMcpTool } from '../src/servers.ts'
import { buildLookupPrompt, buildPrompt, cacheKey, MAX_TOKENS, parseSummary, summarySystemPrompt } from '../src/summary.ts'
import type { CallIR, LookupTool, Summary } from '../src/ir.ts'
import { CLOSED, RawView, viewOf } from '../src/view.tsx'
import { lookupNoticeOf, noticeOf } from '../src/view/notice.ts'
import { trustVerdictOf } from '../src/view/trust.ts'
import { describeRules, fitCall, parseTrust } from '../src/trust.ts'
import { agentOf, pluginOf } from '../src/view/agent.ts'
import { spinnerTextOf } from '../src/view/spinner.ts'
import { ResultBlockView, ResultRows } from '../src/view/transcript.tsx'
import type { TranscriptKit } from '../src/view/transcript.tsx'
import { resultBlockOf } from '../src/view/transcript.ts'
import type { ResultBlock } from '../src/view/transcript.ts'
import type { Fit, TrustRule } from '../src/trust.ts'
import { BACKGROUND, QUIET } from '../src/view/ui/theme.ts'
import type { Kit } from '../src/view/kit.ts'
import { rawTitleOf } from '../src/view/raw.tsx'
import type { PaneChange } from '../src/view.tsx'
import { snapshotOptionsOf } from '../src/snapshot/options.ts'
import { findCall, planSnapshots } from '../src/snapshot/write.ts'
import type { SnapshotOptions } from '../src/snapshot/options.ts'

const PANE = 'gas'
// Candidate tools: the terminal connector name or Desktop UUIDs. Discovery verifies
// the connector identity before retaining a call, enriching it, or applying trust.
const EXECUTE_TOOL = /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__execute$/
// Its tools whose calls the pane shows: execute, and the lookups beside it.
const GAS_TOOL = /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__(?:execute|search|introspect|validate|dry_run)$/
const TITLE = 'GraphOS Inspector'
// The raw operation of the call shown, in its own docked pane.
const RAW_PANE = 'gas-raw'
// The content is laid out for about 60 columns: ask the dock for that much and
// leave the rest to the transcript. A width the person dragged to still wins.
const DOCK_COLUMNS = 64
const callDetailIndex = atom({ plugin: 'graphos-agent-mods', key: 'callDetailIndex' } as const, EMPTY_DETAILS)
const detailSlots = atom({ plugin: 'graphos-agent-mods', key: 'callDetails' } as const, null as CallDetailSlot | null)
const calls = atom({ plugin: 'graphos-agent-mods', key: 'calls' } as const, EMPTY_STORED)
const hasAutoOpened = atom({ plugin: 'graphos-agent-mods', key: 'hasAutoOpened' } as const, false)
const pumper = atom({ plugin: 'graphos-agent-mods', key: 'pumper' } as const, '')
const spinner = atom({ plugin: 'graphos-agent-mods', key: 'spinner' } as const, { id: '', text: '' })

// A single writer coordinates overview and detail state. Full models have no module-owned cache.
const taskStops = new Set<AbortController>()
let generation = 0
let writes: Promise<unknown> = Promise.resolve()
let pendingWrites = 0
let writerClaim: Promise<boolean> | undefined
async function readStoredCalls($: EngineInterface): Promise<StoredInspectorCalls> {
  return normalizeStoredCalls(await read($, calls))
}
/** Hydration is ephemeral: the host owns the only retained full-model cache. */
async function loadCallCache($: EngineInterface, index: CallDetailIndex, onlyId?: string, fresh = false): Promise<CallCache> {
  const cache = new CallCache()
  for (const entry of index.entries) {
    if (onlyId !== undefined && entry.id !== onlyId) continue
    const held = fresh ? await update($, memberOf(detailSlots, { requestId: String(entry.slot) }), current => current) : await read($, memberOf(detailSlots, { requestId: String(entry.slot) }))
    if (held?.epoch !== index.epoch || held.id !== entry.id || held.json === null) continue
    try {
      const call = JSON.parse(held.json) as InspectedCall
      if (call.id !== entry.id || typeof call.operation !== 'string' || typeof call.variables !== 'string' || call.ir === undefined || !Array.isArray(call.ir.roots)) continue
      if (cache.put(call) !== 'available' || cache.serialized().find(one => one.id === call.id)?.bytes !== entry.bytes) cache.delete(call.id)
    } catch { /* Corrupt or incompatible detail state remains an explicit overview. */ }
  }
  return cache
}
async function readDisplayCalls($: EngineInterface): Promise<ResolvedInspectorCalls> {
  const stored = await readStoredCalls($)
  const selection = normalizeSelection(await read($, paneUi), stored)
  const id = shownResolvedAt(stored, selection).call?.id ?? ''
  const cache = await loadCallCache($, normalizeDetailIndex(await read($, callDetailIndex)), id)
  return resolveCalls(stored, cache, id)
}
async function readCalls($: EngineInterface): Promise<InspectorCalls> {
  const stored = await readStoredCalls($)
  const cache = await loadCallCache($, normalizeDetailIndex(await read($, callDetailIndex)))
  return fullCalls(resolveCalls(stored, cache))
}
async function readUi($: EngineInterface) {
  const raw = await read($, paneUi)
  return { ...CLOSED, ...raw, selection: normalizeSelection(raw, await readStoredCalls($)) }
}
/** The retained data epoch survives reload; a writer claim fences the retired module's CAS retries. */
function ensureCallWriter($: EngineInterface): Promise<boolean> {
  if (writerClaim !== undefined) return writerClaim
  const token = generation
  writerClaim = (async () => {
    const previousRaw = await read($, calls)
    const previous = normalizeStoredCalls(previousRaw)
    let legacy = new CallCache()
    const owned = await update($, calls, current => {
      const stored = normalizeStoredCalls(current)
      if (token !== generation || stored.writer !== previous.writer && stored.writer !== INSTANCE) return stored
      // Capture the successful CAS input before replacing full legacy objects with metadata.
      legacy = legacyDetails(current)
      return { ...stored, writer: INSTANCE }
    })
    if (token !== generation || owned.writer !== INSTANCE) return false
    const previousIndexRaw = await read($, callDetailIndex)
    const previousIndex = normalizeDetailIndex(previousIndexRaw)
    const hadNoCatalog = previousIndexRaw?.version === 1 && previousIndexRaw.epoch === '' && Array.isArray(previousIndexRaw.entries) && previousIndexRaw.entries.length === 0
    let isMigration = false
    const ownedIndex = await update($, callDetailIndex, current => {
      const index = normalizeDetailIndex(current)
      if (token !== generation || index.writer !== previousIndex.writer && index.writer !== INSTANCE) return index
      // A nonempty epoch includes an ended-session tombstone. It is never a migration target.
      isMigration = legacy.size > 0 && hadNoCatalog && current?.version === 1 && current.epoch === '' && Array.isArray(current.entries) && current.entries.length === 0
      const claimed = { ...index, writer: INSTANCE, epoch: index.epoch || `${INSTANCE}:${token}` }
      return isMigration ? detailIndexFor(legacy, claimed) : claimed
    })
    if (token !== generation || ownedIndex.writer !== INSTANCE) return false
    const migrated = new Map(isMigration ? legacy.serialized().map(entry => [entry.id, entry]) : [])
    const slots = await Promise.all(Array.from({ length: CALL_CACHE_ENTRIES }, (_, slot) => update($, memberOf(detailSlots, { requestId: String(slot) }), current => {
      if (token !== generation || current !== null && current.writer !== previousIndex.writer && current.writer !== INSTANCE) return current
      const retained = ownedIndex.entries.find(entry => entry.slot === slot)
      const imported = retained === undefined ? undefined : migrated.get(retained.id)
      if (imported !== undefined) return { epoch: ownedIndex.epoch, writer: INSTANCE, id: imported.id, json: imported.json }
      return current === null || current.epoch !== ownedIndex.epoch || retained?.id !== current.id ? { epoch: ownedIndex.epoch, writer: INSTANCE, id: '', json: null } : { ...current, writer: INSTANCE }
    })))
    if (token !== generation) return false
    if (isMigration) {
      const available = new Set(slots.flatMap(slot => slot !== null && slot.epoch === ownedIndex.epoch && slot.writer === INSTANCE && slot.json === migrated.get(slot.id)?.json ? [slot.id] : []))
      await update($, calls, current => {
        const stored = normalizeStoredCalls(current)
        if (token !== generation || stored.writer !== INSTANCE) return stored
        const restore = (call: typeof stored.history[number]) => available.has(call.id) ? { ...call, details: 'available' as const } : call
        const history = stored.history.map(restore)
        return { ...stored, queue: stored.queue.map(restore), history, last: history[0] ?? (stored.last === null ? null : restore(stored.last)) }
      })
    }
    return token === generation
  })()
  return writerClaim
}

function updateCalls($: EngineInterface, change: (state: InspectorCalls) => InspectorCalls, expectedGeneration = generation, observerWrite = false): Promise<InspectorCalls> {
  if (observations.paused && !observerWrite) return Promise.resolve(EMPTY)
  pendingWrites += 1
  const run = writes.catch(() => undefined).then(async () => {
    if (generation !== expectedGeneration || observations.paused && !observerWrite) return EMPTY
    if (!await ensureCallWriter($)) return EMPTY
    const owner = await read($, pumper)
    if (owner !== '' && owner !== INSTANCE) return EMPTY
    const ui = await readUi($)
    let index = normalizeDetailIndex(await update($, callDetailIndex, current => current))
    if (index.epoch === '') index = await update($, callDetailIndex, current => generation === expectedGeneration && normalizeDetailIndex(current).epoch === '' ? { ...EMPTY_DETAILS, epoch: `${INSTANCE}:${expectedGeneration}` } : normalizeDetailIndex(current))
    const cache = await loadCallCache($, index, undefined, true)
    cache.pin(ui.selection)
    if (index.active !== null) cache.pinActive(index.active)
    if (generation !== expectedGeneration) return EMPTY
    let candidate: InspectorCalls = EMPTY
    let changedModels: InspectedCall[] = []
    const committed = await update($, calls, current => {
      if (generation !== expectedGeneration || normalizeStoredCalls(current).writer !== INSTANCE) return normalizeStoredCalls(current)
      let stored = normalizeStoredCalls(current)
      for (const orphan of stored.queue.filter(call => call.owner !== INSTANCE)) stored = settleStoredCalls(stored, orphan.id, 'interrupted', ui.selection)
      const before = fullCalls(resolveCalls(stored, cache))
      const models = new Map([...before.queue, ...before.history].map(call => [call.id, call]))
      candidate = change(before)
      changedModels = [...candidate.queue, ...candidate.history].filter(call => models.get(call.id) !== call)
      return storeCalls(stored, candidate, ui.selection)
    })
    if (generation !== expectedGeneration || committed.writer !== INSTANCE) return EMPTY
    const availability = new Map<string, ReturnType<CallCache['put']>>()
    for (const call of changedModels) availability.set(call.id, cache.put(call))
    const ids = new Set([...committed.queue, ...committed.history].map(call => call.id))
    cache.retain(ids)
    const planned = detailIndexFor(cache, index)
    const changedIds = new Set(changedModels.map(call => call.id))
    const plannedIds = new Set(planned.entries.map(entry => entry.id))
    // Free replaced/evicted payloads before growth. A failed clear stops admission while
    // the old catalog still accounts for that slot; no full model becomes an untracked orphan.
    for (const entry of index.entries) if (changedIds.has(entry.id) || !plannedIds.has(entry.id)) {
      await update($, memberOf(detailSlots, { requestId: String(entry.slot) }), current => generation === expectedGeneration && current?.epoch === index.epoch && current.writer === INSTANCE ? { epoch: index.epoch, writer: INSTANCE, id: '', json: null } : current)
    }
    const reserved = await update($, callDetailIndex, current => generation === expectedGeneration && normalizeDetailIndex(current).writer === INSTANCE && normalizeDetailIndex(current).epoch === index.epoch ? { ...planned, active: normalizeDetailIndex(current).active } : normalizeDetailIndex(current))
    if (generation !== expectedGeneration || reserved.epoch !== index.epoch || reserved.writer !== INSTANCE) return EMPTY
    const serialized = new Map(cache.serialized().map(entry => [entry.id, entry]))
    for (const entry of planned.entries) {
      if (!changedIds.has(entry.id)) continue
      const model = serialized.get(entry.id)!
      // The host's 4 Mi-character value limit is above our 2 MiB serialized entry limit.
      // Host CAS retries reapply the writer and data-epoch guards after every conflict.
      await update($, memberOf(detailSlots, { requestId: String(entry.slot) }), current => generation !== expectedGeneration || current !== null && (current.epoch !== index.epoch || current.writer !== INSTANCE) ? current : { epoch: index.epoch, writer: INSTANCE, id: entry.id, json: model.json })
      if (generation !== expectedGeneration) return EMPTY
    }
    await update($, calls, current => {
      if (generation !== expectedGeneration || normalizeStoredCalls(current).writer !== INSTANCE) return normalizeStoredCalls(current)
      const stored = normalizeStoredCalls(current)
      const repair = (call: typeof stored.history[number]) => ({ ...call, details: cache.has(call.id) ? 'available' as const : availability.get(call.id) === 'oversize' ? 'oversize' as const : call.details === 'available' ? 'expired' as const : call.details })
      const history = stored.history.map(repair)
      return { ...stored, queue: stored.queue.map(repair), history, last: history[0] ?? null }
    })
    return readCalls($)
  })
  writes = run.then(() => { pendingWrites -= 1 }, () => { pendingWrites -= 1 })
  return run
}

/** Every possible slot is cleared, including writes that were held before their reservation landed. */
async function clearSessionDetails($: EngineInterface, token = generation) {
  const previous = normalizeDetailIndex(await read($, callDetailIndex))
  if (token !== generation) return
  // Empty, unclaimed state has no prior owner; a changed claim still wins on CAS retry.
  if (previous.writer !== INSTANCE && !(previous.writer === '' && previous.entries.length === 0)) throw new Error('Inspector cleanup ownership changed')
  const epoch = `${INSTANCE}:${token}`
  const cleared = await update($, callDetailIndex, current => {
    const index = normalizeDetailIndex(current)
    return token === generation && index.writer === previous.writer && index.epoch === previous.epoch ? { ...EMPTY_DETAILS, epoch, writer: INSTANCE } : index
  })
  if (token !== generation) return
  if (cleared.writer !== INSTANCE || cleared.epoch !== epoch) throw new Error('Inspector cleanup ownership changed')
  const slots = await Promise.all(Array.from({ length: CALL_CACHE_ENTRIES }, (_, slot) => update($, memberOf(detailSlots, { requestId: String(slot) }), current => {
    if (token !== generation || current !== null && !(current.writer === previous.writer && current.epoch === previous.epoch || current.writer === INSTANCE && current.epoch === epoch)) return current
    return { epoch, writer: INSTANCE, id: '', json: null }
  })))
  if (token !== generation) return
  if (slots.some(slot => slot?.writer !== INSTANCE || slot.epoch !== epoch)) throw new Error('Inspector cleanup ownership changed')
}

function updateForGeneration($: EngineInterface, token: number, change: (state: InspectorCalls) => InspectorCalls) {
  return updateCalls($, change, token)
}

/** Is the raw pane open? The engine's record, not ours: it closes on Esc too. */
async function isRawOpen($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === RAW_PANE)
  } catch {
    return false
  }
}

/** The call the main pane shows right now. */
async function shownCall($: EngineInterface) {
  return shownResolvedAt(await readDisplayCalls($), (await readUi($)).selection).call
}

/** Opens the raw pane titled for the call shown, or closes it; true when it is open after. */
async function toggleRaw($: EngineInterface): Promise<boolean> {
  if (await isRawOpen($)) {
    await $.ui.close({ id: RAW_PANE })
    return false
  }
  const opened = await $.ui.open({ id: RAW_PANE, title: `Raw · ${rawTitleOf(await shownCall($))}`, focus: true, columns: DOCK_COLUMNS })
  return opened.isPlaced
}

/** Keeps an open raw pane's title on the call it shows (opening again retitles in place). */
async function retitleRaw($: EngineInterface) {
  try {
    if (await isRawOpen($)) await $.ui.open({ id: RAW_PANE, title: `Raw · ${rawTitleOf(await shownCall($))}` })
  } catch {
    // Best effort: a stale title only.
  }
}

const paneUi = atom({ plugin: 'graphos-agent-mods', key: 'paneUi' } as const, CLOSED)

// Cache server discovery to avoid listing tools on every transcript redraw.
// Negative results expire after SERVERS_TTL_MS. Actual calls refresh the list
// because a server may have connected since the previous lookup.
const SERVERS_TTL_MS = 30_000
let servers: Set<string> | undefined
let serversAt: number | undefined
// When a listing last said each server is not Agent Services ($.clock time).
const misses = new Map<string, number>()
// The listing in flight, shared by every row drawing at once.
let listing: Promise<Set<string>> | undefined
// Schema and scope lookups, valid for one bundleDigest (enrich clears it on a change).
const caches = new Map<string, EnrichCache>()
// Calls already claimed by this instance's analysis pump. Enrichment handles
// its own bounded retry when the server's schema generation changes.
const attempted = new Set<string>()
// Summaries by cacheKey (operation, variables, bundleDigest, prompt); null
// when Haiku's answer failed the checks, so a rejected one is not re-asked.
const summaries = new Map<string, Summary | null>()

// Surfaces where a Client (the live line) failed, until a reload.
const faulted = new Set<string>()

// A text file per distinct rendering of each call (src/snapshot), a design-review tool. Its two options are not in the manifest, so a person never sees them: unset is the default (off, 50/64/84 columns), and `/gas snapshots on|off` turns it on.
let snapshots: SnapshotOptions = { isOn: false, widths: [] }

/** Writes the plan for one call; resolves with its folder, undefined when nothing was written. Never rejects. */
async function emitSnapshot($: EngineInterface, call: InspectedCall, waiting: number, stage: string, widths: number[], force: boolean): Promise<string | undefined> {
  try {
    const plan = planSnapshots({ call, waiting, stage, widths, force })
    if (plan === undefined) return undefined
    const when = new Date(await $.clock.now()).toISOString()
    for (const file of plan.files) {
      await $.fs.write(`${$.plugin.root}/snapshots/${plan.dir}/${file.name}`, `# stage: ${stage} | status: ${call.status} | ${when} | ${file.cols} columns\n${file.body}\n`)
    }
    return `${$.plugin.root}/snapshots/${plan.dir}`
  } catch {
    return undefined
  }
}

// `/gas snapshots on|off`, kept in $.store across sessions.
const SNAPSHOTS_KEY = 'snapshots'

async function isSnapshotting($: EngineInterface): Promise<boolean> {
  if (snapshots.isOn) return true
  try {
    return (await $.store.get(SNAPSHOTS_KEY)) === true
  } catch {
    return false
  }
}

/** After a state change of call `id`, when snapshots are on. */
async function snap($: EngineInterface, id: string, stage: string) {
  if (!(await isSnapshotting($))) return
  try {
    const state = await readCalls($)
    const call = findCall(state, id)
    if (call !== undefined) await emitSnapshot($, call, state.queue.length, stage, snapshots.widths, false)
  } catch {
    // Best effort.
  }
}

const PUMP_MS = 200
// This module instance. A hot reload may leave the previous instance's timer
// running and may skip session.start (seen in other mods), so the newest
// instance claims the pump in $.state and an older timer stops at its next tick.
const INSTANCE = `${Math.random()}`.slice(2)
// Runs only while a call waits for its analysis to start: started when a call
// arrives (and once at session.start, for calls a reload left behind), stopped
// at the first tick that has started them all. An idle session never polls.
let pumpTimer: Timer | undefined
// Starts the pump on the session's `$` (set at session.start, dropped at session.end).
let wakePump: (() => void) | undefined

/**
 * (Re)starts this instance's pump on `$` and claims it; called once a call's
 * arrival is written. A tool.call's `$` reads one moment while its dialog is
 * up (its own writes included), so the session's is used where there is one.
 * Never waits: the timer is set before it returns.
 */
function startPump($: EngineInterface) {
  if (pumpTimer !== undefined) stopPump(pumpTimer)
  const claim = update($, pumper, () => INSTANCE).then(
    () => true,
    () => false,
  )
  const timer = $.clock.every(PUMP_MS, () => void tick($, timer, claim).catch(() => undefined))
  pumpTimer = timer
}

function stopPump(timer: Timer) {
  timer.cancel()
  if (pumpTimer === timer) pumpTimer = undefined
}

/** One period of the pump: starts every analysis that waits, then stops; a read that failed tries again next period. */
async function tick($: EngineInterface, timer: Timer, claim: Promise<boolean>) {
  // A newer instance (a hot reload) claimed the pump: this one stops.
  if ((await claim) && (await read($, pumper)) !== INSTANCE) return stopPump(timer)
  await pump($)
  stopPump(timer)
}

const READ_ONLY_GAS_TOOLS: ReadonlySet<string> = new Set(['search', 'introspect', 'validate', 'dry_run'])

/**
 * Only read-only Agent Services tools go through here, on the same server the call uses.
 *
 * A plugin's $.mcp.call goes through the same permission check as the
 * model's tool calls: outside auto mode it raises its own dialog, queued
 * behind the one the user is deciding on (seen live, see docs/spikes.md). The mod
 * must never interrupt, so it calls a tool only when the user's rules
 * already allow it; anything else stays unknown in the pane.
 */
function gasCaller($: EngineInterface, server: string, token = generation): CallGas {
  return async (tool, args) => {
    if (token !== generation) throw new Error('Inspector session ended')
    // Hard guard, not just a type: the mod never runs a GraphQL operation.
    if (!READ_ONLY_GAS_TOOLS.has(tool)) throw new Error(`GraphOS Inspector never calls ${String(tool)}`)
    const name = `mcp__${server}__${tool}`
    // Allowed by the person's rules, and not capped below allow by their organization.
    const verdict = await $.tool.check({ tool: name, input: args })
    if (token !== generation) throw new Error('Inspector session ended')
    const { decision, ceiling } = verdict
    if (!isAllowedWithoutPrompt(verdict)) throw new NotAllowed(tool, decision, ceiling)
    return $.mcp.call(server, tool, args)
  }
}

class NotAllowed extends Error {
  readonly checkCause = 'not-allowed'
  constructor(
    readonly tool: GasTool,
    readonly decision: string,
    readonly ceiling?: string,
  ) {
    super(`${tool} is not allowed without a prompt (${decision})`)
  }
}

function variablesOf(call: InspectedCall): Record<string, unknown> {
  try {
    const parsed: unknown = call.variables === '' ? {} : JSON.parse(call.variables)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// Dev timing, off unless `/gas timing on` (kept in $.store). The newest
// entries live in memory and the file is rewritten whole, one write at a
// time, so there is no read-modify-write race and the file stays small.
const TIMING_KEY = 'timing'
const TIMING_KEEP = 50
const timingLines: string[] = []
let timingWrite: Promise<void> = Promise.resolve()

async function isTiming($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(TIMING_KEY)) === true
  } catch {
    return false
  }
}

/** One JSON line per summary in the plugin folder (git-ignored). Never blocks or fails the summary. */
function logTiming($: EngineInterface, entry: Record<string, unknown>) {
  timingLines.push(JSON.stringify(entry))
  if (timingLines.length > TIMING_KEEP) timingLines.shift()
  const body = `${timingLines.join('\n')}\n`
  timingWrite = timingWrite.then(() => $.fs.write(`${$.plugin.root}/timing.log`, body)).catch(() => undefined)
}

/**
 * One Haiku summary of an enriched call, from the IR only (never the raw
 * operation). parseSummary rejects an answer with no usable headline before
 * it is stored; a rejected or failed answer leaves the deterministic
 * headline in place.
 */
async function summarize($: EngineInterface, call: InspectedCall, enrichMs: number, token = generation) {
  if (token !== generation) return
  const key = await cacheKey(call.ir, variablesOf(call), isExecute(call) ? undefined : call)
  if (token !== generation) return
  let summary = summaries.get(key)
  if (summary === undefined) {
    const prompt = isExecute(call) ? buildPrompt(call.ir) : buildLookupPrompt(call)
    const system = summarySystemPrompt(call.tool)
    const started = await $.clock.now()
    const stop = new AbortController()
    taskStops.add(stop)
    const answer = await withinStep($, 'Haiku', $.model.complete({ model: 'haiku', system, prompt, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: 8_000 }, { signal: stop.signal })).finally(() => { stop.abort(); taskStops.delete(stop) })
    const parsed = answer.isAnswered ? parseSummary(answer.text) : undefined
    summary = parsed?.summary ?? null
    if (await isTiming($)) logTiming($, {
      at: started,
      root: call.ir.roots.map(root => root.name).join(','),
      sinceArrivedMs: started - call.arrivedAt,
      enrichMs,
      haikuMs: (await $.clock.now()) - started,
      systemChars: system.length,
      promptChars: prompt.length,
      usage: answer.usage,
      ...(answer.isAnswered ? { rejected: parsed?.rejected ?? null } : { reason: answer.reason }),
      ...(answer.isAnswered && parsed?.rejected !== undefined && { text: answer.text.slice(0, 200) }),
    })
    // Cache real answers only (an API error may pass); keep the newest 200.
    if (token !== generation) return
    if (answer.isAnswered) {
      summaries.set(key, summary)
      const oldest = summaries.size > 200 ? summaries.keys().next().value : undefined
      if (oldest !== undefined) summaries.delete(oldest)
    }
  }
  if (token !== generation || summary === null) return
  const found = summary
  await updateForGeneration($, token, current => {
    const latest = [...current.queue, ...current.history].find(one => one.id === call.id)
    return latest === undefined ? current : patchIR(current, call.id, { ...latest.ir, summary: found })
  })
  inSpinnerOrder(() => headlineSpinner($, call.id, { ...call.ir, summary: found }))
  await snap($, call.id, 'summary')
}

// Timeout for each analysis stage: Agent Services checks and the headline.
const STEP_MS = 20_000

class StepTimeout extends Error {
  readonly checkCause = 'analysis-timeout'
  constructor(readonly step: string) {
    super(`no answer from ${step} in ${STEP_MS / 1000} s`)
  }
}

/**
 * `work`, or a StepTimeout once `ms` have passed on $.clock. The work itself
 * runs on (an MCP call cannot be cut); only the waiting ends. A clock that
 * cannot sleep sets no bound.
 */
function withinStep<T>($: EngineInterface, step: string, work: Promise<T>, ms = STEP_MS): Promise<T> {
  const token = generation
  const stop = new AbortController()
  taskStops.add(stop)
  const timeout = new Promise<never>((_, reject) => {
    $.clock.sleep(ms, { signal: stop.signal }).then(
      () => reject(new StepTimeout(step)),
      () => { if (token !== generation) reject(new Error('Inspector session ended')) },
    )
  })
  return Promise.race([work, timeout]).finally(() => { stop.abort(); taskStops.delete(stop) })
}

/**
 * The IR of a call whose analysis failed or ran out of time: settled
 * (`partial`), every check marked failed with the reason, policy left unknown.
 */
function failedIR(ir: CallIR, error: unknown): CallIR {
  const reason = error instanceof StepTimeout ? error.message : `analysis failed: ${error instanceof Error ? error.message : String(error)}`
  const checks = appendCheckContext({ policy: 'failed', validation: 'failed', schema: 'failed', error: reason.slice(0, 160) }, (['policy', 'validation', 'schema'] as const).map(check => checkFailureContext(check, { kind: 'call' }, error)))
  const { isSummarizing: _dropped, ...settled } = annotate(ir, { isIncomplete: true, checks })
  return settled.state === 'analyzing' ? { ...settled, state: 'partial', checks } : settled
}

/**
 * A call the pump should analyse: its checks or its headline are still out,
 * and this instance has not tried it. A lookup only once its answer is read:
 * the schema pass annotates the answer, and must not land before it.
 */
const needsAnalysis = (call: InspectedCall) => (call.ir.state === 'analyzing' || call.ir.isSummarizing === true) && (isExecute(call) || call.found !== undefined) && !attempted.has(call.id)

/** A lookup's IR at rest: one that will not be analysed (it failed, or has no answer) stops saying it is being checked. */
const restingIR = (ir: CallIR): CallIR => (ir.state === 'analyzing' ? { ...ir, state: 'partial' } : ir)

/**
 * One call's analysis, start to end, detached from every other call's: the
 * Agent Services checks, then the Haiku headline, each bounded by STEP_MS. However it
 * ends, the call leaves `analyzing` and stops shimmering, and it is never
 * retried by this instance.
 */
async function analyse($: EngineInterface, call: InspectedCall) {
  const token = generation
  if (!isExecute(call)) return analyseLookup($, call, token)
  let failure: unknown
  try {
    let ir = call.ir
    let enrichMs = 0
    if (ir.state === 'analyzing') {
      const started = await $.clock.now()
      try {
        ir = await withinStep($, 'Agent Services', enrich(gasCaller($, call.server, token), cacheForServer(caches, call.server), ir, call.operation, variablesOf(call)))
      } catch (error) {
        ir = failedIR(ir, error)
      }
      enrichMs = (await $.clock.now()) - started
    }
    // Summarize once the IR carries what the summary must describe; the pane shimmers the headline meanwhile.
    const willSummarize = ir.state !== 'unparseable' && ir.summary === undefined
    const enriched = ir
    await updateForGeneration($, token, current => patchIR(current, call.id, willSummarize ? { ...enriched, isSummarizing: true } : enriched))
    void snap($, call.id, 'enriched')
    if (willSummarize) {
      try {
        await summarize($, { ...call, ir }, enrichMs, token)
      } catch {
        // Haiku failed, answered garbage or ran out of time: the deterministic headline stays.
      }
    }
  } catch (error) {
    failure = error
  } finally {
    // Never leave the call analysing or shimmering, whatever failed above.
    await updateForGeneration($, token, current => {
      const latest = findCall(current, call.id)
      if (latest === undefined) return current
      if (latest.ir.state === 'analyzing') return patchIR(current, call.id, failedIR(latest.ir, failure ?? new Error('stopped')))
      if (latest.ir.isSummarizing !== true) return current
      const { isSummarizing: _done, ...rest } = latest.ir
      return patchIR(current, call.id, rest)
    }).catch(() => undefined)
    void snap($, call.id, 'ready')
    void recordVerdict($, call.id, token)
  }
}

/**
 * A validate or dry_run call's operation, filled in with the schema (its
 * descriptions and types for the cards) by the mod's own cached search and
 * introspect reads, under the same guard as an execute's analysis. The
 * call's own answer stands whatever happens. Every readable lookup can get
 * a Haiku headline once its schema/check facts are available.
 */
async function analyseLookup($: EngineInterface, call: InspectedCall, token = generation) {
  const ir = call.ir
  const access = accessFromIR(ir)
  const checks = ir.checks ?? { policy: 'skipped' as const, validation: 'skipped' as const, schema: 'skipped' as const }
  const own = { ...(ir.validation !== undefined && { validation: ir.validation }), ...(access !== undefined && { access }), checks }
  // Left as the answer had it: its state from its own validation and policy, the schema not read.
  const fallback = (error?: unknown) => annotate(ir, { ...own, checks: error === undefined ? own.checks : appendCheckContext({ ...own.checks, schema: 'failed' }, [checkFailureContext('schema', { kind: 'call' }, error)]), isIncomplete: true, ...(ir.services !== undefined && { services: ir.services }), ...(ir.service !== undefined && { scope: ir.service }) })
  let done = ir
  const started = await $.clock.now()
  if (isOperationLookup(call.tool!)) {
    try {
      done = await withinStep($, 'Agent Services', enrichSchema(gasCaller($, call.server, token), cacheForServer(caches, call.server), ir, own))
      if (done.state === 'analyzing') done = fallback()
    } catch (error) {
      done = fallback(error)
    }
  }
  await updateForGeneration($, token, current => patchIR(current, call.id, done)).catch(() => undefined)
  void snap($, call.id, 'enriched')
  try {
    if (call.found?.unreadable === undefined && call.found?.error === undefined && call.found?.typeKind !== 'absent' && done.state !== 'unparseable' && done.summary === undefined) {
      await summarize($, { ...call, ir: done }, (await $.clock.now()) - started, token)
    }
  } catch {
    // The factual lookup headline stays when Haiku cannot explain the answer.
  } finally {
    await updateForGeneration($, token, current => {
      const latest = findCall(current, call.id)
      if (latest?.ir.isSummarizing !== true) return current
      const { isSummarizing: _done, ...rest } = latest.ir
      return patchIR(current, call.id, rest)
    }).catch(() => undefined)
  }
  void recordVerdict($, call.id, token)
}

/**
 * Starts the analysis of every call that needs one, each on its own: a slow
 * Haiku answer or a hung Agent Services call holds up no other call. Runs on a clock
 * tick, its own dispatch, apart from the tool.call hook and its dialog.
 */
async function pump($: EngineInterface) {
  if (observations.paused) return
  const token = generation
  let state = await readCalls($)
  if (token !== generation) return
  // Pending calls whose hook went with an older instance settle as interrupted: they can hold the pane no longer.
  const orphans = state.queue.filter(call => call.owner !== INSTANCE)
  if (orphans.length > 0) {
    state = await updateCalls($, current => settleOrphans(current, INSTANCE))
    // No hook is left to end their spinner text.
    for (const orphan of orphans) endSpinner($, orphan.id)
  }
  if (token !== generation) return
  const all = [...state.queue, ...(state.last === null ? [] : [state.last]), ...state.history]
  // Forget calls that left the state, so the set stays bounded.
  const live = new Set(all.map(call => call.id))
  for (const id of attempted) if (!live.has(id)) attempted.delete(id)
  for (const call of all) {
    if (!needsAnalysis(call)) continue
    // Claimed before any await: a later tick never starts it again.
    attempted.add(call.id)
    void analyse($, call).catch(() => undefined)
  }
}

/** The verdict line (src/view/notice.ts) of each Agent Services call among a row's calls, in order. */
async function verdictsOf($: EngineInterface, rows: readonly { tool: string; tool_use_id?: string }[]): Promise<string[]> {
  const ids = rows.flatMap(row => row.tool_use_id !== undefined && (verdicts.has(row.tool_use_id) || GAS_TOOL.test(row.tool)) ? [row.tool_use_id] : [])
  if (ids.length === 0) return []
  const saved = await read($, verdictLog).catch(() => ({} as Record<string, string | null>))
  const state = await readCalls($)
  return ids.flatMap(id => {
    if (verdicts.has(id)) return verdicts.get(id) ?? []
    if (Object.hasOwn(saved, id)) return saved[id] ?? []
    const call = findCall(state, id)
    return (call === undefined ? undefined : verdictOf(call)) ?? []
  })
}

/** The verdict line of a call (src/view/notice.ts): with the outcome once it ran. */
const verdictOf = (call: InspectedCall) => {
  if (!isExecute(call)) return lookupNoticeOf(call) ?? null
  // Lead with trust-rule attribution and avoid repeating the checkmark.
  const trusted = trustVerdictOf(call.trust, call.status)
  const notice = noticeOf(call.ir, call.status === 'ran' ? call.outcome : undefined)
  const parts = [trusted, trusted !== undefined && notice?.startsWith('✓ ') === true ? notice.slice(2) : notice].filter(part => part !== undefined)
  return parts.length === 0 ? null : parts.join(' · ')
}

// Each settled Agent Services call's final verdict line by tool_use_id (null: it has
// none), newest last: the record a row keeps however long ago its call left
// the history. Mirrored in $.state (`verdicts`) so a reload keeps it.
const VERDICTS_MAX = 500
const verdicts = new Map<string, string | null>()
const verdictLog = atom({ plugin: 'graphos-agent-mods', key: 'verdicts' } as const, {})

function rememberVerdict(id: string, text: string | null) {
  verdicts.delete(id)
  verdicts.set(id, text)
  while (verdicts.size > VERDICTS_MAX) {
    const oldest = verdicts.keys().next().value
    if (oldest === undefined) break
    verdicts.delete(oldest)
  }
}

/**
 * Records call `id`'s verdict once it is final (src/queue.ts isFinal), in
 * memory and in $.state. Called where a call settles and where its analysis
 * ends, never while drawing. Best effort.
 */
async function recordVerdict($: EngineInterface, id: string, token: number) {
  if (token !== generation) return
  try {
    const call = findCall(await readCalls($), id)
    if (token !== generation || call === undefined || !isFinal(call)) return
    const text = verdictOf(call)
    if (token !== generation) return
    rememberVerdict(id, text)
    if (call.status !== 'ran' || call.outcome !== undefined) rememberResultBlock(id, resultBlockOfCall(call))
    await update($, verdictLog, log => {
      if (token !== generation || log[id] === text) return log
      const { [id]: _replaced, ...rest } = log
      const kept = Object.entries(rest).slice(-(VERDICTS_MAX - 1))
      return { ...Object.fromEntries(kept), [id]: text }
    })
  } catch {
    // The row reads the calls state instead.
  }
}

// Each settled Agent Services call's RESULT block for the transcript (src/view/transcript.ts)
// by tool_use_id (null: it has none), newest last: the record a settled row
// reads, so it redraws for no other call's writes, as a verdict does. Kept in
// memory only: a reload finds the last 20 calls' outcomes in the calls state and
// draws no block for an older row (the engine's own drawing stays).
const RESULT_BLOCKS_MAX = 200
const resultBlocks = new Map<string, ResultBlock | null>()

function rememberResultBlock(id: string, block: ResultBlock | null) {
  resultBlocks.delete(id)
  resultBlocks.set(id, block)
  while (resultBlocks.size > RESULT_BLOCKS_MAX) {
    const oldest = resultBlocks.keys().next().value
    if (oldest === undefined) break
    resultBlocks.delete(oldest)
  }
}

/** A settled call's block: only one that ran and whose response was read has one. */
const resultBlockOfCall = (call: InspectedCall): ResultBlock | null => (call.status === 'ran' && call.outcome !== undefined ? (resultBlockOf(call.outcome, call.ir, linkConfig) ?? null) : null)

/**
 * The block under an Agent Services call's result row: from the record, which the call's
 * settling and the end of its analysis write (recordVerdict, and the hook where
 * it settles), else from the calls state, which redraws the row as the call lands.
 */
async function resultBlockOfRow($: EngineInterface, tool: string, id: string): Promise<ResultBlock | undefined> {
  if (!GAS_TOOL.test(tool)) return undefined
  // Only final, complete blocks enter this cache. Provisional rows subscribe
  // below until evidence arrives; completed rows avoid unrelated redraws.
  if (resultBlocks.has(id)) return resultBlocks.get(id) ?? undefined
  const call = findCall(await readCalls($), id)
  // A call that left the state (a long session, a reload) has nothing to read again: recorded, so the row stops listening to the calls state.
  if (call === undefined) {
    return undefined
  }
  if (!isFinal(call)) return undefined
  const block = resultBlockOfCall(call)
  return block ?? undefined
}

/**
 * Markdown whose links the surface opens as it opens any link: a press
 * handler and its link list are left off. Where the plugin cannot open a
 * browser itself (a remote surface; $.process runs on the CLI only).
 */
function surfaceOpened(Markdown: Kit['Markdown'] & {}): NonNullable<Kit['Markdown']> {
  return ({ onLinkPress: _press, pressableLinks: _links, ...props }) => Markdown(props)
}

/**
 * The elements a transcript RESULT block draws with, on the surface it is drawn
 * for. Its record keys press as the pane's do (Markdown with `onLinkPress`); off
 * the terminal, where the plugin cannot open a browser itself, the surface opens
 * the link.
 */
function transcriptKit(elements: ReturnType<EngineInterface['ui']['resolve']>, surface: RenderSurface): TranscriptKit {
  const { Box, Text } = elements
  const Markdown = 'Markdown' in elements ? (surface === 'terminal' ? elements.Markdown : surfaceOpened(elements.Markdown)) : undefined
  return { Box, Text, ...(Markdown !== undefined && { Markdown }) }
}

/** One dim-labelled verdict line per text, its ⚑ or ✓ in the policy color. */
function verdictLines(Box: Kit['Box'], Text: Kit['Text'], texts: string[]): RenderNode[] {
  return texts.map(text => {
    // Each part ` · ` apart; a part that opens with ⚑ or ✓ takes its policy color on the glyph (a write's change leads with ✎, so its policy part is not first).
    const parts = text.split(/( · )/)
    return (
      <Box paddingLeft={2}>
        <Text wrap="wrap">
          <Text dimColor>{'⎿  GraphOS Inspector  '}</Text>
          {parts.map(part => {
            const glyph = part.slice(0, 1)
            const tone = glyph === '⚑' ? 'error' : glyph === '✓' ? 'success' : undefined
            return tone === undefined ? <Text>{part}</Text> : <Text><Text color={tone}>{glyph}</Text>{part.slice(1)}</Text>
          })}
        </Text>
      </Box>
    )
  })
}

/** The engine's row, then one dim-labelled verdict line per Agent Services call, its ⚑ or ✓ in the policy color. */
function VerdictRows({ Box, Text, drawn, texts }: { Box: Kit['Box']; Text: Kit['Text']; drawn: RenderNode; texts: string[] }) {
  return (
    <Box flexDirection="column">
      {drawn}
      {verdictLines(Box, Text, texts)}
    </Box>
  )
}

// Why a draft did not land in the prompt box, in words the person can act on.
const NO_COMPOSER = 'this session has no prompt box'
const DIALOG_OPEN = 'close the open dialog first, then try again'
const NOT_TAKEN = 'the prompt box did not take it'

/**
 * Appends a draft to the prompt box without submitting it or replacing existing
 * text. Returns a failure reason or undefined on success; does not reject.
 */
async function fillPrompt($: EngineInterface, draft: string): Promise<string | undefined> {
  try {
    const box = await $.prompt.read()
    // Repeated clicks must not duplicate the draft.
    if (box.text.includes(draft)) return undefined
    const { isFilled, refusal } = box.text.trim() === '' ? await $.prompt.fill({ text: draft }) : await $.prompt.fill({ text: `\n${draft}`, mode: 'append' })
    return isFilled ? undefined : refusal === 'no_composer' ? NO_COMPOSER : DIALOG_OPEN
  } catch {
    return NOT_TAKEN
  }
}

/**
 * Drafts an access request for review. Submission requires a separate user action.
 * Report failures in the transcript because another pane may be holding toasts.
 */
async function draftPrompt($: EngineInterface, draft: string, what = 'the access request') {
  const why = await fillPrompt($, draft)
  if (why !== undefined) $.ui.log(`GraphOS Inspector could not draft ${what}: ${why}.`)
}

/** Desktop's read-only host inventory supplies the display-name → tool-ID mapping.
 * It is optional: missing/denied/broken discovery never grants a call permission.
 */
async function discoverGasServers($: EngineInterface): Promise<Set<string>> {
  const tools = await $.tool.list()
  const terminal = gasServers(tools)
  const tool = 'mcp__ccd_connectors__session_connectors_status'
  if (!tools.some(t => t.mcp && t.name === tool)) return terminal
  try {
    const ids = await withinStep($, 'Desktop connector discovery', (async () => {
      const verdict = await $.tool.check({ tool, input: {} })
      if (!isAllowedWithoutPrompt(verdict)) throw new Error('Desktop connector inventory is not allowed')
      const result = await $.tool.call({ tool })
      if (result.isError || typeof result.text !== 'string') throw new Error('Desktop connector inventory failed')
      return desktopGasServers(result.text)
    })(), 2_000)
    return gasServers(tools, ids)
  } catch (error) {
    if (terminal.size > 0) return terminal
    throw error
  }
}

async function isGasServer($: EngineInterface, server: string, options: { isFresh?: boolean } = {}): Promise<boolean> {
  const token = generation
  const now = await $.clock.now().catch(() => undefined)
  if (options.isFresh !== true && servers?.has(server) && now !== undefined && serversAt !== undefined && now - serversAt < SERVERS_TTL_MS) return true
  const missedAt = misses.get(server)
  if (options.isFresh !== true && now !== undefined && missedAt !== undefined && now - missedAt < SERVERS_TTL_MS) return false
  if (token !== generation) return false
  if (listing === undefined) {
    const pending = discoverGasServers($)
    listing = pending
    void pending.finally(() => { if (listing === pending) listing = undefined }).catch(() => undefined)
  }
  const found = await listing
  if (token !== generation) return false
  servers = found
  serversAt = now
  if (found.has(server)) misses.delete(server)
  else if (now !== undefined) misses.set(server, now)
  return found.has(server)
}

function inspectedCall(
  e: { tool_use_id: string; operation?: unknown; variables?: unknown; agentId?: string },
  server: string,
  arrivedAt: number,
  plugin?: string,
): InspectedCall {
  const adapted = adaptExecute(e)
  // A subagent's call carries its agent: the id now (free), the label once the list answers (resolveAgent).
  // A plugin's call carries the plugin's name, so it never reads as Claude's.
  const agent = e.agentId === undefined && plugin === undefined ? undefined : { ...agentOf(e.agentId ?? ''), ...(plugin !== undefined && { plugin }) }
  const base = { id: e.tool_use_id, server, status: 'pending' as const, owner: INSTANCE, arrivedAt, ...(agent !== undefined && { agent }) }
  if (!adapted.ok) {
    const ir = buildIR(e.tool_use_id, { ok: false, reason: 'unparseable', message: adapted.error })
    return { ...base, operation: adapted.operation, variables: adapted.variables, inputError: adapted.error, ir }
  }
  const { operation, variables } = adapted.input
  const shownVariables = Object.keys(variables).length === 0 ? '' : JSON.stringify(variables, null, 2)
  return { ...base, operation, variables: shownVariables, ir: buildIR(e.tool_use_id, normalize(operation, variables)) }
}

/** The tool's own arguments of a tool.call or tool.check event: the keys beside them (the tool, the call's id, its loop) left out. */
function inputOf(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e
  return input
}

/**
 * Records a call as it arrives, before the dialog: settling the calls an
 * older instance left pending (a reload or a respawn took their hook
 * mid-dialog), then waking the pump to start its analysis beside the dialog.
 */
async function arriveCall($: EngineInterface, call: InspectedCall, token: number) {
  const orphans = (await readStoredCalls($)).queue.filter(one => one.owner !== INSTANCE).map(one => one.id)
  if (token !== generation) return
  await update($, pumper, current => token === generation ? INSTANCE : current)
  if (token !== generation) return
  await updateCalls($, state => {
    const arrived = arrive(settleOrphans(state, INSTANCE), call)
    const terminal = observations.getTerminal(call.id)
    const status = terminal?.status ?? (observations.getArrival(call.id)?.interrupted === true ? 'interrupted' : undefined)
    return status === undefined ? arrived : settle(arrived, call.id, status)
  }, token, true)
  if (token !== generation) return
  for (const id of orphans) endSpinner($, id)
  if (!observations.paused) wake($)
}

/**
 * Starts the pump now (no wait: the timer is set at once): on the session's
 * `$`, else, with no session.start in this instance (a reload or a /clear
 * skips it), on this call's `$`, which has seen the call's own writes.
 */
function wake($: EngineInterface) {
  try {
    if (wakePump !== undefined) wakePump()
    else startPump($)
  } catch {
    // The session's `$` is gone (a throw here would leave the call pending with no hook to settle it).
    wakePump = undefined
    startPump($)
  }
}

/**
 * Settles call `id`, keeping a person who stepped back on the call they
 * chose: the stable call id survives every settlement and history insertion.
 */
async function settleShown($: EngineInterface, id: string, status: Exclude<InspectedCall['status'], 'pending'>, token = generation): Promise<InspectorCalls> {
  const state = await updateCalls($, current => settle(current, id, status), token, true)
  if (generation !== token) return state
  const owner = await read($, pumper)
  if (owner !== '' && owner !== INSTANCE) return state
  await update($, callDetailIndex, current => token === generation && current.writer === INSTANCE && current.active === id ? { ...current, active: null } : current)
  const ui = await readUi($)
  await update($, calls, current => generation === token ? settleStoredCalls(normalizeStoredCalls(current), id, status, ui.selection) : normalizeStoredCalls(current))
  return state
}

/** A lookup (search, introspect, validate, dry_run) as it arrives: its input read, its operations parsed, nothing asked of Agent Services. */
function lookupCall(e: Args<'tool.call'>, server: string, tool: LookupTool, arrivedAt: number, plugin: string | undefined): { call: InspectedCall; adapted: AdaptedLookup } {
  const adapted = adaptLookup(tool, inputOf(e))
  const agent = e.agentId === undefined && plugin === undefined ? undefined : { ...agentOf(e.agentId ?? ''), ...(plugin !== undefined && { plugin }) }
  const call: InspectedCall = {
    id: e.tool_use_id,
    server,
    tool,
    input: adapted.input,
    status: 'pending',
    owner: INSTANCE,
    arrivedAt,
    operation: adapted.operation,
    variables: adapted.variables,
    ...(adapted.error !== undefined && { inputError: adapted.error }),
    ...(agent !== undefined && { agent }),
    ir: pendingIR(e.tool_use_id, tool, adapted),
  }
  return { call, adapted }
}

/** Reads a lookup's detached answer only after the engine has received it. */
async function observeLookupResult($: EngineInterface, e: Args<'tool.call'>, server: string, tool: LookupTool, plugin: string | undefined, ran: NextResult<'tool.call'>, token: number) {
  const { call, adapted } = lookupCall(e, server, tool, 0, plugin)
  const id = call.id
  const status = statusOf(ran)
  if (status === 'ran') {
    const stood = ran.deny === undefined ? truncationOf(ran.text) ?? truncationOf(ran.result) : undefined
    let result = pickResult(ran.text, ran.result)
    let isPersisted = false
    if (stood?.path !== undefined) {
      // Read the saved copy back: only a path Claude Code saved (src/result.ts), bounded.
      try {
        const saved = await $.fs.read(stood.path)
        if (saved.length <= MAX_SAVED) {
          result = saved
          isPersisted = true
        }
      } catch {
        // Unreadable here: the pane says what the stand-in says.
      }
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
    // Claude read a preview only of an answer Claude Code saved to a file.
    const bytes = isPersisted || stood !== undefined ? 0 : utf8Bytes(text)
    const settled = settledLookup(id, tool, adapted, responseIn(result), bytes, text)
    const found = { ...settled.found, ...((isPersisted || stood !== undefined) && { isPersisted: true }) }
    // An operation the schema can fill in waits for the pump, its own answer shown meanwhile.
    const isReadable = found.unreadable === undefined && found.error === undefined && found.typeKind !== 'absent' && settled.ir.state !== 'unparseable'
    const ir = { ...settled.ir, ...(isOperationLookup(tool) && settled.ir.state !== 'unparseable' && { state: 'analyzing' as const }), ...(isReadable && { isSummarizing: true }) }
    await updateCalls($, state => patchLookup(state, id, found, ir), token, true)
    if (!observations.paused && (ir.state === 'analyzing' || ir.isSummarizing === true)) wake($)
  } else {
    // A failed lookup says Agent Services' error; a refused one has the engine's own words.
    const result = pickResult(ran.text, ran.result)
    const said = typeof result === 'string' ? result : JSON.stringify(result ?? '')
    const error = status === 'errored' ? lookupErrorOf(responseIn(result), said) : undefined
    let ir = restingIR(call.ir)
    if (status === 'errored') {
      const check = tool === 'dry_run' ? 'policy' : tool === 'validate' ? 'validation' : 'schema'
      ir = { ...ir, checks: appendCheckContext({ policy: 'skipped', validation: 'skipped', schema: 'skipped', [check]: 'failed' }, [checkFailureContext(check, { kind: 'call' }, new Error(error ?? 'the tool call failed'), 'tool-response', tool)]) }
    }
    await updateCalls($, state => patchLookup(state, id, { bytes: 0, ...(error !== undefined && { error }) }, ir), token, true)
  }
  await recordVerdict($, id, token)
}

type ObservationArrival = { plugin?: string; trust?: Fit; interrupted?: boolean } & (
  | { inputUnavailable?: false; event: Args<'tool.call'> }
  | { inputUnavailable: true; event: Pick<Args<'tool.call'>, 'tool' | 'tool_use_id'> }
)
type ObservationTerminal =
  | { kind: 'result'; status: Exclude<InspectedCall['status'], 'pending'>; ran: NextResult<'tool.call'> }
  | { kind: 'errored' | 'interrupted' | 'unavailable'; status: Exclude<InspectedCall['status'], 'pending'> }
const observations = new ObservationQueue<ObservationArrival, ObservationTerminal>()
let observerTimer: Timer | undefined
let observerBusy = false
let wakeObserver: (() => void) | undefined
let notifyObserver: (() => void) | undefined
let sessionDetailsNeedClearing = false
let sessionObservation: { token: number; run: () => Promise<void> } | undefined

/** Queue payloads are detached JSON. Engine handles and forwarding closures stay outside it. */
function observeCall($: EngineInterface, e: Args<'tool.call'>, origin: string): boolean {
  try {
    // The host stamps origin per dispatch. Equal tool inputs can belong to separate callers.
    if (origin === $.plugin.name) return false
    const admitted = observations.admit(e.tool_use_id, { event: e, plugin: pluginOf(origin) }, () => ({ event: { tool: e.tool, tool_use_id: e.tool_use_id }, plugin: pluginOf(origin), inputUnavailable: true }))
    scheduleObservation($)
    if (!admitted) $.ui.invalidate('ui.render')
    return admitted
  } catch { return false }
}

function finishObservation($: EngineInterface, id: string, terminal: ObservationTerminal) {
  try {
    observations.finish(id, terminal, { kind: 'unavailable', status: terminal.status })
    scheduleObservation($)
  } catch { /* Observing the answer cannot affect its delivery. */ }
}

function observeTrust($: EngineInterface, id: string, evidence: Fit, token: number) {
  if (token !== generation) return
  if (observations.updateArrival(id, arrival => ({ ...arrival, trust: evidence }))) scheduleObservation($)
}

/** A host clock dispatch has fresh state visibility; never drain inside tool.call. */
function scheduleObservation($: EngineInterface) {
  wakeObserver = () => scheduleObservation($)
  notifyObserver = () => $.ui.invalidate('ui.render')
  if (observerBusy || observerTimer !== undefined) return
  try {
    observerTimer = $.clock.after(1, () => {
      observerTimer = undefined
      void drainObservations($).catch(() => undefined)
    })
  } catch { observations.setPaused(true) }
}

async function observeJob($: EngineInterface, job: ObservationJob<ObservationArrival, ObservationTerminal>, token: number): Promise<boolean> {
  const { event: e, plugin, inputUnavailable } = job.arrival
  const split = splitMcpTool(e.tool)
  const server = split?.server
  if (server === undefined) return false
  const lookup = lookupToolOf(split?.tool ?? '')
  if (job.phase === 'arrival') {
    if (!await isGasServer($, server, { isFresh: true }) || token !== generation) return false
    const arrivedAt = await $.clock.now()
    if (token !== generation) return false
    if (inputUnavailable === true) {
      if (!await ensureCallWriter($) || token !== generation) return false
      const terminal = observations.getTerminal(job.id)
      await update($, calls, current => {
        const stored = normalizeStoredCalls(current)
        if (token !== generation || stored.writer !== INSTANCE) return stored
        const overview = { id: job.id, server, status: 'pending' as const, owner: INSTANCE, arrivedAt, details: 'oversize' as const, ...(lookup !== undefined && { tool: lookup }), overview: { headline: 'Call input exceeded the retained-detail size limit.', headlineSource: 'derived' as const } }
        const added = { ...stored, queue: [...stored.queue.filter(one => one.id !== job.id), overview] }
        const status = terminal?.status ?? (observations.getArrival(job.id)?.interrupted === true ? 'interrupted' : undefined)
        return status === undefined ? added : settleStoredCalls(added, job.id, status, { kind: 'live' })
      })
      return token === generation
    }
    let call = lookup === undefined ? inspectedCall(e, server, arrivedAt, plugin) : lookupCall(e, server, lookup, arrivedAt, plugin).call
    const trust = observations.getArrival(job.id)?.trust
    if (trust !== undefined) call = { ...call, trust }
    await arriveCall($, call, token)
    if (token !== generation) return false
    if (!observations.paused) {
      void snap($, job.id, 'arrive')
      void showArrival($, { isLookup: lookup !== undefined })
      if (e.agentId !== undefined) void resolveAgent($, job.id, e.agentId, plugin)
    }
  } else if (job.phase === 'update') {
    if (observations.getArrival(job.id)?.interrupted === true && observations.getTerminal(job.id) === undefined) {
      await settleShown($, job.id, 'interrupted', token)
      if (token !== generation) return false
      endSpinner($, job.id)
    }
    if (inputUnavailable === true) return true
    const trust = observations.getArrival(job.id)?.trust
    if (trust !== undefined) await updateCalls($, state => patchTrust(state, job.id, trust), token, true)
  } else {
    const terminal = observations.getTerminal(job.id)
    if (terminal === undefined) return false
    await settleShown($, job.id, terminal.status, token)
    if (token !== generation) return false
    endSpinner($, job.id)
    if (inputUnavailable === true) return token === generation
    if (terminal.kind === 'result') {
      if (lookup === undefined) await observeExecuteResult($, e, server, plugin, terminal.ran, token)
      else await observeLookupResult($, e, server, lookup, plugin, terminal.ran, token)
    } else {
      // No answer is retained after abort, throw, or a bounded-payload fallback.
      const state = await readCalls($)
      const call = findCall(state, job.id)
      if (call !== undefined) await updateCalls($, current => {
        const ir = restingIR(call.ir)
        return patchIR(current, job.id, terminal.kind === 'unavailable' ? { ...ir, checks: { ...(ir.checks ?? { policy: 'skipped', validation: 'skipped', schema: 'skipped' }), error: 'Result preview was not retained because it exceeded the Inspector’s response retention limit.' } } : ir)
      }, token, true)
      await recordVerdict($, job.id, token)
    }
    if (!observations.paused) void snap($, job.id, 'settled')
  }
  return token === generation
}

/** One active drain owns its writer until it really settles, including across /clear. */
async function drainObservations($: EngineInterface) {
  if (observerBusy) return
  observerBusy = true
  const drainGeneration = generation
  let didObserve = false
  try {
    while (true) {
      const pendingSession = sessionObservation
      const job = pendingSession === undefined ? observations.take() : undefined
      if (pendingSession === undefined && job === undefined) break
      const token = generation
      const watchdog = $.clock.after(1_000, () => {
        observations.setPaused(true)
        try { $.ui.invalidate('ui.render') } catch { /* No UI host. */ }
      })
      try {
        if (pendingSession !== undefined) {
          sessionObservation = undefined
          if (pendingSession.token === generation) await pendingSession.run()
        } else if (job !== undefined) {
          didObserve = true
          if (await observeJob($, job, token)) observations.complete(job)
          else observations.discard(job)
        }
      } catch {
        if (job !== undefined) {
          // Best effort terminal repair after a failed parser or host operation.
          const terminal = observations.getTerminal(job.id)
          if (terminal !== undefined && token === generation) await settleShown($, job.id, terminal.status, token).catch(() => undefined)
          observations.discard(job)
        }
      } finally {
        watchdog.cancel()
      }
      // A retired dispatch must not run a new session's setup on its stale frame.
      if (drainGeneration !== generation) break
    }
  } finally {
    observerBusy = false
    const wasPaused = observations.paused
    observations.setPaused(drainGeneration !== generation && sessionObservation !== undefined)
    if (wasPaused !== observations.paused) try { notifyObserver?.() } catch { /* No UI host. */ }
    if (sessionObservation !== undefined) wakeObserver?.()
    if (didObserve && drainGeneration === generation && !observations.paused) try { wake($) } catch { /* Session host retired. */ }
  }
}

/** Parses execute evidence independently of its forwarding hook. */
async function observeExecuteResult($: EngineInterface, e: Args<'tool.call'>, server: string, plugin: string | undefined, ran: NextResult<'tool.call'>, token: number) {
  if (token !== generation) return
  await ensureLinks($)
  if (token !== generation) return
  const status = statusOf(ran)
  // An errored call (refused at the dialog, or the tool failed) carries
  // the engine's text, not a GraphQL response: no RESULT for it.
  // An oversized result comes back as an error text naming the file Claude Code saved it to.
  const stood = ran.deny === undefined ? truncationOf(ran.text) ?? truncationOf(ran.result) : undefined
  if (status === 'ran') {
    // Core relays the tool's text as `text` and its content blocks as `result`.
    // The latest IR names fields by their real names; which scalars show is decided when drawn.
    const current = await readCalls($)
    if (token !== generation) return
    const latest = [...current.queue, ...current.history].find(one => one.id === e.tool_use_id)
    const ir = latest?.ir ?? inspectedCall(e, server, 0, plugin).ir
    const result = pickResult(ran.text, ran.result)
    // The site this response shows, before the rows' links are worked out from it.
    await learnSites($, ir, result, token)
    if (token !== generation) return
    let outcome = outcomeOf(ir, result, linkConfig)
    if (stood !== undefined && outcome.isUnreadable !== true) outcome = savedOutcome(outcome)
    if (outcome.isTooLarge === true && stood?.path !== undefined) {
      // Read the saved copy back: only a path Claude Code saved (src/result.ts), bounded.
      try {
        const saved = await $.fs.read(stood.path)
        if (token !== generation) return
        if (saved.length <= MAX_SAVED) {
          await learnSites($, ir, saved, token)
          if (token !== generation) return
          const full = outcomeOf(ir, saved, linkConfig)
          if (full.isUnreadable !== true) outcome = savedOutcome(full)
        }
      } catch {
        // Unreadable here: the pane says the response was too large to preview.
      }
    }
    const patched = await updateCalls($, state => patchOutcome(state, e.tool_use_id, outcome), token, true)
    if (token !== generation) return
    // State subscriptions redraw the result row when this detached outcome lands.
    const done = findCall(patched, e.tool_use_id)
    if (token === generation && done !== undefined && isFinal(done)) rememberResultBlock(e.tool_use_id, resultBlockOfCall(done))
    void snap($, e.tool_use_id, 'outcome')
  }
  await recordVerdict($, e.tool_use_id, token)
}

/**
 * An execute's permission check: a trust rule may lift its ask to allow.
 * An existing allow or deny, an organization ceiling and the engine's verdict
 * when matching fails all stand. A call that runs unasked names itself on the spinner.
 */
async function checkExecute($: EngineInterface, e: Args<'tool.check'>, verdict: NextResult<'tool.check'>, token: number): Promise<NextResult<'tool.check'>> {
  if (token !== generation) return verdict
  const id = e.tool_use_id
  const server = splitMcpTool(e.tool)?.server
  if (id === undefined) return verdict
  if (verdict.decision === 'allow' && server !== undefined) inSpinnerOrder(() => beginSpinner($, server, id))
  if (verdict.decision !== 'ask') return verdict
  if ((e.ceiling !== undefined && e.ceiling !== 'allow') || (verdict.ceiling !== undefined && verdict.ceiling !== 'allow')) return verdict
  if (server === undefined) return verdict
  const stop = new AbortController()
  taskStops.add(stop)
  // One total budget after the engine answers. Evaluation has no spinner or
  // evidence side effects, so an answer arriving after the deadline cannot
  // claim that the original ask was allowed by a trust rule.
  const evaluate = async (): Promise<Fit | undefined> => {
    if (!(await isGasServer($, server, { isFresh: true })) || token !== generation) return undefined
    await ensureTrust($)
    if (trustRules.length === 0 || (await read($, isTrustOff)) || token !== generation) return undefined
    return fitCall(e.input, trustRules)
  }
  let fit: Fit | undefined
  try {
    fit = await Promise.race([
      evaluate(),
      $.clock.sleep(1_000, { signal: stop.signal }).then(() => undefined, () => undefined),
    ])
  } catch { return verdict }
  finally { stop.abort(); taskStops.delete(stop) }
  if (token !== generation || fit === undefined) return verdict
  const evidence = keptFit(fit)
  observeTrust($, id, evidence, token)
  if (!fit.isAllowed) return verdict
  const rules = [...new Set(fit.fits.map(one => one.rule))]
  inSpinnerOrder(() => beginSpinner($, server, id))
  return { decision: 'allow' as const, reason: `GraphOS Inspector trust rule${rules.length === 1 ? '' : 's'} ${rules.join(', ')}` }
}

/** `~/.claude/graphos-agent-mods/<name>`, from $HOME; undefined when HOME cannot be read. */
async function userFile($: EngineInterface, name: string): Promise<string | undefined> {
  try {
    const home = (await $.process.run(['printenv', 'HOME'], { timeoutMs: 3000 })).stdout.trim()
    return home.startsWith('/') ? `${home}/.claude/graphos-agent-mods/${name}` : undefined
  } catch {
    return undefined
  }
}

const userLinksFile = ($: EngineInterface) => userFile($, 'links.toml')

// Link mappings: the shipped links.toml plus the person's override file; loaded at session.start and on `/gas links`.
let linkConfig: LinkConfig = configOf()
// Where each named base in linkConfig comes from (src/links.ts BaseSource), as of the last load.
let baseSources: Record<string, BaseSource> = {}
let hasLoadedLinks = false

// Sites learned from Agent Services responses (src/sites.ts), kept in $.store between sessions.
// Each is checked again whenever the links load, so a stored value is never trusted for having been stored.
const LEARNED_KEY = 'learnedSites'

async function readLearned($: EngineInterface): Promise<Sites> {
  try {
    return learnedOf(await $.store.get(LEARNED_KEY))
  } catch {
    return {}
  }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function reloadLinks($: EngineInterface): Promise<{ file: string | undefined; problems: string[]; isUser: boolean }> {
  const token = generation
  const file = await userLinksFile($)
  const user = file === undefined ? undefined : await readText($, file)
  const shipped = await readText($, `${$.plugin.root}/links.toml`)
  const loaded = loadLinkConfig({ ...(shipped !== undefined && { shipped }), ...(user !== undefined && { user }), learned: await readLearned($) })
  if (token !== generation) return { file, problems: loaded.problems, isUser: user !== undefined }
  linkConfig = loaded.config
  baseSources = loaded.baseSources
  hasLoadedLinks = true
  return { file, problems: loaded.problems, isUser: user !== undefined }
}

// Trust rules: the person's own trust.graphql, read once per module instance
// (at session.start, or a reloaded module's first Agent Services check) and on `/gas
// trust`, never in between: a rule written into the file mid-session waits
// for the person's next session or their own /gas trust. The mod does watch
// the file (watchedFiles), but only to say it changed: a save is never read,
// let alone applied, so nothing that can write the file mid-session widens
// what runs unasked. No file or rules: the engine's permission settings stand.
let trustRules: TrustRule[] = []
let trustLoad: Promise<TrustLoaded> | undefined
// trust.graphql was saved since the rules in memory were read: reported by `/gas setup`.
let isTrustFileChanged = false
const isTrustOff = atom({ plugin: 'graphos-agent-mods', key: 'isTrustOff' } as const, false)

type TrustLoaded = { file: string | undefined; problems: string[]; isPresent: boolean }

async function reloadTrust($: EngineInterface): Promise<TrustLoaded> {
  const token = generation
  const file = await userFile($, 'trust.graphql')
  const text = file === undefined ? undefined : await readText($, file)
  const { rules, problems } = text === undefined ? { rules: [], problems: [] } : parseTrust(text)
  if (token === generation) trustRules = rules
  return { file, problems, isPresent: text !== undefined }
}

/** The rules, read once per instance unless `/gas trust` reads them again. */
function ensureTrust($: EngineInterface): Promise<TrustLoaded> {
  trustLoad ??= reloadTrust($).catch(() => ({ file: undefined, problems: [], isPresent: false }))
  return trustLoad
}

/** What a call's record keeps of its fit: bounded, since it lives in $.state. */
function keptFit(fit: Fit): Fit {
  if (!fit.isAllowed) return { isAllowed: false, reason: fit.reason.slice(0, 2_000) }
  return { isAllowed: true, fits: fit.fits.slice(0, 50).map(one => ({ root: one.root.slice(0, 300), rule: one.rule.slice(0, 300), reasons: one.reasons.map(reason => reason.slice(0, 600)) })) }
}

// The spinner's text while an Agent Services call runs. Only a call that runs with no
// dialog is named here (the permission check answered allow: the engine's own
// rule or a trust rule): the docs say nothing of the spinner while a
// permission dialog is up, so a call that asks is left to the engine's own
// word. The text is one small record, so a spinner row subscribes to it and to
// no call's state. Begin, headline and end go one after another, in the order
// they were asked, so an end can never land before the begin it follows.
const NO_SPINNER = { id: '', text: '' }
let spinnerChain: Promise<void> = Promise.resolve()
// Calls whose spinner text has been ended, newest last and bounded: a begin that
// is late (the call was aborted, or it settled, before the begin ran) must not set text nothing will clear.
const endedSpinners = new Set<string>()
const ENDED_SPINNERS_MAX = 200

function inSpinnerOrder(work: () => Promise<unknown>) {
  const token = generation
  spinnerChain = spinnerChain.then(() => token === generation ? work() : undefined).then(() => undefined, () => undefined)
}

/** The call `id` runs now, unasked: the spinner reads its headline, else `Agent Services · <operation name>`. */
async function beginSpinner($: EngineInterface, server: string, id: string) {
  const token = generation
  if (!(await isGasServer($, server))) return
  const call = findCall(await readCalls($), id)
  if (call === undefined) return
  const text = spinnerTextOf(call.ir)
  // Decided as it is written: an end asked for before now wins.
  await update($, spinner, current => (token !== generation || endedSpinners.has(id) ? current : { id, text }))
}

/** The headline of call `id` has landed: the spinner reads it, if the call is still the one it names. */
function headlineSpinner($: EngineInterface, id: string, ir: CallIR) {
  const text = spinnerTextOf(ir)
  return update($, spinner, current => (current.id === id ? { id, text } : current))
}

/** Call `id` is over, or gone: the spinner goes back to the engine's own word, unless it already names another call. Asked for in order, and remembered so a later begin is ignored. */
function endSpinner($: EngineInterface, id: string) {
  endedSpinners.add(id)
  const oldest = endedSpinners.size > ENDED_SPINNERS_MAX ? endedSpinners.values().next().value : undefined
  if (oldest !== undefined) endedSpinners.delete(oldest)
  inSpinnerOrder(() => update($, spinner, current => (current.id === id ? NO_SPINNER : current)))
}

let unameText: Promise<string> | undefined

/**
 * Opens a link in the system browser: https on a configured host only. A
 * link it will not or cannot open gets one transcript line saying so.
 */
async function openLink($: EngineInterface, url: unknown) {
  let plan: ReturnType<typeof openArgv> | undefined
  try {
    unameText ??= $.process.run(['uname', '-s'], { timeoutMs: OPEN_TIMEOUT_MS }).then(ran => ran.stdout)
    // The auth links Agent Services returned for the calls in the pane: the one press that may open a host no rule names.
    const calls = await readCalls($)
    const fromGas = [...calls.queue, ...(calls.last === null ? [] : [calls.last]), ...calls.history].flatMap(call => (call.outcome?.authLinks ?? []).map(link => link.url))
    plan = openArgv(url, linkConfig, await unameText, fromGas)
    if ('refused' in plan) {
      $.ui.log(plan.refused === 'no opener for this platform' ? 'GraphOS Inspector cannot open a browser on this system.' : 'GraphOS Inspector did not open that link: its host is not one your link settings name (/gas links).')
      return
    }
    const ran = await $.process.run(plan.argv, { timeoutMs: OPEN_TIMEOUT_MS })
    if (ran.exitCode !== 0) $.ui.log(`GraphOS Inspector could not open ${plan.argv.at(-1)}`)
  } catch {
    unameText = undefined
    // Only a link the checks passed is said in full.
    $.ui.log(plan !== undefined && 'argv' in plan ? `GraphOS Inspector could not open ${plan.argv.at(-1)}` : 'GraphOS Inspector could not open that link.')
  }
}

/**
 * Says which subagent made a call, by what `$.agent.list()` knows of it (its
 * type and task). Runs beside the dialog, never ahead of it, and gives up
 * after a few seconds; the call keeps the bare `from subagent` when the list
 * does not know the agent. Best effort, never rejects.
 */
async function resolveAgent($: EngineInterface, callId: string, agentId: string, plugin: string | undefined) {
  const token = generation
  try {
    const info = (await withinStep($, 'the agent list', $.agent.list(), AGENT_LIST_MS)).find(one => one.id === agentId)
    if (info === undefined) return
    const agent = { ...agentOf(agentId, info), ...(plugin !== undefined && { plugin }) }
    await updateForGeneration($, token, state => patchAgent(state, callId, agent))
    void snap($, callId, 'agent')
  } catch {
    // The line says `from subagent` and no more.
  }
}

/** How long the pane waits for the agent list. */
const AGENT_LIST_MS = 5_000

/**
 * The pane's side of a call arriving: keep its stable selection,
 * the raw pane retitled, and the pane opened once unasked. Runs beside the
 * permission dialog, never ahead of it; best effort, never rejects.
 */
async function showArrival($: EngineInterface, _options: { isLookup?: boolean } = {}) {
  // Stable selections survive every arrival; only a real permission dialog moves them.
  await retitleRaw($)
}

/**
 * The pane opens on its own when a call it inspects waits at a permission
 * dialog, whatever the tool: the person sees what they are approving. Once a
 * session (a pane they closed stays closed), and never for a call that runs
 * without asking. Unasked, the engine seats a pane only where it can dock
 * (144 columns). Best effort, never rejects.
 */
async function openForDialog($: EngineInterface, id: string, token: number) {
  if (token !== generation) return
  try {
    await update($, paneUi, current => token === generation ? { ...CLOSED, selection: { kind: 'call' as const, id } } : current)
    if (token !== generation) return
    await update($, callDetailIndex, current => token === generation && current.writer === INSTANCE ? { ...current, active: id } : current)
    await retitleRaw($)
    if (token !== generation || await read($, hasAutoOpened)) return
    // Register Raw first, then raise Inspector without taking the composer's keys.
    await $.ui.open({ id: RAW_PANE, title: `Raw · ${rawTitleOf(await shownCall($))}`, columns: DOCK_COLUMNS }).catch(() => undefined)
    if (token !== generation) return
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
    if (opened.isPlaced) await update($, hasAutoOpened, current => token === generation ? true : current)
  } catch {
    // No pane host here (a test engine, `-p`); /gas still works where there is one.
  }
}

/** The Claude Code release this session runs on (`$.session.version()`); undefined where the engine has no such call (the mod loads from 2.1.287). */
async function claudeVersion($: EngineInterface): Promise<{ version: string; base?: string } | undefined> {
  try {
    const { version, base } = await $.session.version()
    return { version, ...(base !== undefined && { base }) }
  } catch {
    return undefined
  }
}

// Said once per module instance: a session that starts again (a resume, a /clear that starts one) does not repeat it.
let hasNotedVersion = false

/** One transcript line when the engine is older than the release this was tested on (src/version.ts). */
async function noteVersion($: EngineInterface) {
  if (hasNotedVersion) return
  hasNotedVersion = true
  const note = versionNote((await claudeVersion($))?.base, 'GraphOS Agent Mods')
  if (note !== undefined) $.ui.log(`GraphOS Inspector: ${note}`)
}

/** Tool availability after applying the permission decision and organization ceiling. */
async function toolState($: EngineInterface, tool: string): Promise<ToolState> {
  try {
    const { decision, ceiling } = await $.tool.check({ tool, input: {} })
    if (decision === 'deny') return 'deny'
    if (decision !== 'allow') return 'ask'
    return ceiling !== undefined && ceiling !== 'allow' ? 'capped' : 'allow'
  } catch {
    return 'ask'
  }
}

/** How long `/gas setup` waits for the graph's catalog. */
const SETUP_SEARCH_MS = 8_000

/**
 * Collect setup requirements and pass them to src/setup.ts for display.
 * Catalog discovery uses an allowed search call. Site discovery is drafted
 * into the prompt box for the user to review and submit.
 */
async function setupText($: EngineInterface): Promise<string> {
  const version = await claudeVersion($)
  let servers: string[] | undefined
  try {
    servers = [...await discoverGasServers($)]
  } catch {
    servers = undefined
  }
  const tools: { server: string; tool: string; state: ToolState }[] = []
  for (const server of servers ?? []) for (const tool of READ_ONLY_GAS_TOOLS) tools.push({ server, tool, state: await toolState($, `mcp__${server}__${tool}`) })
  const { file } = await reloadLinks($)
  // Which sites the graph has a service for, from its catalog (one search, only where it is allowed): a graph with no Jira or Slack is not asked about them.
  const first = servers?.[0]
  const unset = learnable(baseSources)
  const scopes = first === undefined || unset.length === 0 ? undefined : await withinStep($, 'Agent Services', scopesOf(gasCaller($, first), cacheForServer(caches, first)), SETUP_SEARCH_MS).catch(() => undefined)
  // An empty catalog leaves the available services unknown.
  const graph = scopes === undefined || scopes.length === 0 ? undefined : sitesOfGraph(scopes)
  const asked = graph === undefined ? [] : unset.filter(site => graph.shown.includes(site) && graph.askable.includes(site))
  const isAsking = asked.length > 0
  const why = isAsking ? await fillPrompt($, setupPrompt(asked)) : undefined
  await ensureTrust($)
  const trustFile = await userFile($, 'trust.graphql')
  return setupReport({
    ...(version !== undefined && { version }),
    ...(servers !== undefined && { servers }),
    tools,
    bases: linkConfig.bases,
    sources: baseSources,
    ...(file !== undefined && { linksFile: file }),
    ...(graph !== undefined && { graph }),
    ...(isAsking && { draft: why === undefined ? { isDrafted: true as const } : { isDrafted: false as const, why } }),
    trust: { count: trustRules.length, isOff: await read($, isTrustOff), isFileChanged: isTrustFileChanged, ...(trustFile !== undefined && { file: trustFile }), example: `${$.plugin.root}/trust.example.graphql` },
  })
}

async function ensureLinks($: EngineInterface) {
  const token = generation
  if (!hasLoadedLinks) await reloadLinks($).catch(() => undefined)
  if (token === generation) hasLoadedLinks = true
}

let learning: Promise<void> = Promise.resolve()

/**
 * Learns the Atlassian site or Slack workspace an Agent Services response shows, when
 * that base is still unset (src/sites.ts says what counts). One at a time, so
 * two responses landing together tell the person once. Called with a response
 * BEFORE its record links are worked out (outcomeOf), so its own rows open on
 * the site it taught. Best effort: never rejects, and a response that teaches
 * nothing costs one look at which bases are unset.
 */
function learnSites($: EngineInterface, ir: CallIR, result: unknown, token = generation): Promise<void> {
  learning = learning.then(() => token === generation ? learnFrom($, ir, result, token) : undefined).catch(() => undefined)
  return learning
}
async function learnFrom($: EngineInterface, ir: CallIR, result: unknown, token: number) {
  if (token !== generation) return
  // The cheap gate: nothing is parsed unless a base a response can teach is still unset.
  const wanted = learnable(baseSources)
  if (wanted.length === 0) return
  const found = sitesIn(ir, responseIn(result))
  const fresh = wanted.filter(site => found[site] !== undefined)
  if (fresh.length === 0) return
  const before = linkConfig.bases
  const learned = await readLearned($)
  if (token !== generation) return
  // The store has no compare-and-set or cancellation: an already issued write
  // may finish after retirement. Fence every subsequent effect at the boundary.
  await $.store.set(LEARNED_KEY, { ...learned, ...Object.fromEntries(fresh.map(site => [site, found[site]])) })
  if (token !== generation) return
  await reloadLinks($)
  if (token !== generation) return
  const hosts = fresh.filter(site => linkConfig.bases[site] !== before[site]).map(site => escapeText(hostOf(linkConfig.bases[site] ?? ''), 100).text)
  if (hosts.length > 0) $.ui.log(`GraphOS Inspector: record links now open on ${hosts.join(' and ')}, learned from an Agent Services response. /gas links says where each site comes from.`)
}

// The person's two config files, absolute, by the same HOME lookup as every
// user file. The engine's file watcher takes absolute paths (they need not be
// in the project) from a SessionStart answer's `watchPaths`, and raises
// FileChanged for them. Not kept when HOME could not be read: asked again.
let watched: { links: string; trust: string } | undefined

async function watchedFiles($: EngineInterface): Promise<{ links: string; trust: string } | undefined> {
  if (watched !== undefined) return watched
  const links = await userFile($, 'links.toml')
  const trust = await userFile($, 'trust.graphql')
  if (links === undefined || trust === undefined) return undefined
  watched = { links, trust }
  return watched
}

/** How long a burst of saves of links.toml settles before it is read: an editor's atomic write is an unlink and an add, and one reload and one line follow it. */
const LINKS_SETTLE_MS = 300
let linksTimer: Timer | undefined

/** links.toml was saved, added or removed: read again shortly. */
function linksSoon($: EngineInterface) {
  linksTimer?.cancel()
  linksTimer = $.clock.after(LINKS_SETTLE_MS, () => void linksSaved($))
}

/** Reads links.toml again and tells the person in one quiet line. A link mapping only decides where a record opens, so a save applies at once. */
async function linksSaved($: EngineInterface) {
  try {
    // The hosts a click may open are what a save can widen: say which are new (not knowable in an instance that has not loaded the links yet).
    const before = hasLoadedLinks ? allowedOrigins(linkConfig) : undefined
    const { problems, isUser } = await reloadLinks($)
    const rows = `${linkConfig.records.length} row rule${linkConfig.records.length === 1 ? '' : 's'}`
    const added = before === undefined ? [] : [...allowedOrigins(linkConfig)].filter(origin => !before.has(origin)).map(origin => escapeText(new URL(origin).host, 100).text)
    const hosts = added.length === 0 ? '' : `; links now open on ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` and ${added.length - 5} more` : ''}`
    $.ui.log(isUser ? `GraphOS Inspector: links.toml reloaded: ${rows}${problems.length === 0 ? '' : `, ${problems.length} skipped`}${hosts}` : `GraphOS Inspector: links.toml removed, the shipped link mappings stand (${rows})${hosts}`)
  } catch {
    $.ui.log('GraphOS Inspector: links.toml changed, but it could not be read again.')
  }
}

/**
 * trust.graphql was saved. It is not read: the rules in memory stand until the
 * person runs `/gas trust`, so a rule an agent writes into it mid-session
 * cannot take effect on its own. The person is told once per change how to apply it.
 */
function trustSaved($: EngineInterface) {
  const isNew = !isTrustFileChanged
  isTrustFileChanged = true
  if (isNew) $.ui.log('GraphOS Inspector: trust.graphql changed. Run /gas trust to reload it; until then, the rules loaded earlier stand.')
}

async function applyPaneChange($: EngineInterface, change: PaneChange, drawnCallId?: string) {
  const token = generation
  const state = await readDisplayCalls($)
  const ui = await readUi($)
  const shown = shownResolvedAt(state, ui.selection).call
  const expected = change.expectedCallId ?? change.detail?.callId ?? drawnCallId
  if (expected !== undefined && shown?.id !== expected) return
  const { toggleRaw: isRawToggle, openUrl: url, draftPrompt: draft, expectedCallId: _expected, ...patch } = change
  if (isRawToggle === true) await toggleRaw($)
  if (url !== undefined) void openLink($, url)
  if (draft !== undefined) void draftPrompt($, draft)
  if (Object.keys(patch).length === 0) return
  const isOpening = patch.field != null || patch.arg != null || patch.row != null || patch.more != null || patch.detail != null || patch.rawPage !== undefined || patch.rawAsSent !== undefined
  const updated = await update($, paneUi, current => {
    if (token !== generation) return current
    const selection = normalizeSelection(current, { ...EMPTY_STORED, history: state.history.map(call => isFullCall(call) ? overviewOf(call) : call) })
    if (expected !== undefined && shownResolvedAt(state, selection).call?.id !== expected) return current
    const base = patch.selection === undefined ? current : { ...CLOSED, selection: patch.selection }
    return { ...base, ...patch, ...(isOpening && patch.selection === undefined && shown !== null && { selection: { kind: 'call' as const, id: shown.id } }) }
  })
  await retitleRaw($)
}

function clearSessionMemory() {
  generation += 1
  observations.clear()
  observations.setPaused(observerBusy || pendingWrites > 0)
  observerTimer?.cancel(); observerTimer = undefined
  sessionObservation = undefined
  writerClaim = undefined
  for (const stop of taskStops) stop.abort()
  taskStops.clear()
  attempted.clear(); caches.clear(); summaries.clear()
  verdicts.clear(); resultBlocks.clear()
  servers = undefined; serversAt = undefined; misses.clear(); listing = undefined
  faulted.clear(); endedSpinners.clear()
  trustRules = []; trustLoad = undefined
  hasLoadedLinks = false; linkConfig = configOf()
  if (pumpTimer !== undefined) stopPump(pumpTimer)
  linksTimer?.cancel(); linksTimer = undefined
  wakePump = undefined
}

export const register: Register = (on, options) => {
  // Clear the retired footer even when hot reload preserves the host's status.
  let hasClearedStatus = false
  // Start with shipped links; session setup loads user mappings and learned sites.
  linkConfig = configOf()
  hasLoadedLinks = false
  snapshots = snapshotOptionsOf(options)
  on('session.start', ($, e, next) => {
    const forwarded = next(e)
    clearSessionMemory()
    const token = generation
    sessionObservation = { token, run: async () => {
      await writes.catch(() => undefined)
      if (token !== generation) return
      if (!await ensureCallWriter($) || token !== generation) return
      if (sessionDetailsNeedClearing) {
        await clearSessionDetails($, token)
        if (token !== generation) return
        sessionDetailsNeedClearing = false
      }
      await update($, pumper, current => token === generation ? INSTANCE : current)
      if (token !== generation) return
      await update($, callDetailIndex, current => token === generation && current.writer === INSTANCE ? { ...current, active: null } : current)
      if (token !== generation) return
      await updateCalls($, current => current.queue.reduce((state, call) => settle(state, call.id, 'interrupted'), current), token, true)
      if (token !== generation) return
      const ui = await readUi($)
      if (token !== generation) return
      await update($, paneUi, current => token === generation ? ui : current)
      if (token !== generation) return
      $.ui.status(undefined)
      hasClearedStatus = true
      // Arrivals start the pump on this session's `$`, as it always ran: its dispatch is over, so its reads see every write.
      wakePump = () => startPump($)
      // One round picks up what a reload left analysing.
      wakePump()
      await ensureLinks($)
      if (token !== generation) return
      await ensureTrust($)
      if (token !== generation) return
      void noteVersion($).catch(() => undefined)
      try {
        // Immediate: the command only reads and writes the pane, so typed mid-turn it need not wait for the turn to end.
        await $.command.register({ name: 'gas', description: 'Show the GraphOS Inspector pane for the current Agent Services call', argumentHint: '[setup|older|newer|live|raw|trust|links]', immediate: true })
      } catch {
        // No command $ (a test engine); the pane still opens on its own.
      }
    } }
    scheduleObservation($)
    return forwarded
  })

  // Watch the person's config files for a save: the engine's watcher takes
  // absolute paths outside the project (2.1.292), and raises FileChanged for them.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    // Watching is a convenience: a HOME lookup that fails leaves the session's own answer as it was.
    const files = await watchedFiles($).catch(() => undefined)
    return files === undefined ? result : { ...result, watchPaths: [...(result.watchPaths ?? []), files.links, files.trust] }
  })

  on('classic.FileChanged', { file_path: /\/\.claude\/graphos-agent-mods\/(links\.toml|trust\.graphql)$/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      const files = await watchedFiles($)
      if (e.file_path === files?.links) linksSoon($)
      else if (e.file_path === files?.trust) trustSaved($)
    } catch {
      // A hook that throws is skipped; the files are watched again at the next session.
    }
    return result
  })

  on('command.run', { command: 'gas' }, async ($, e) => {
    // `/gas older|newer|live` steps the pane through past calls, as its buttons do.
    const step = e.args.trim()
    if (step === 'snapshots on' || step === 'snapshots off') {
      await $.store.set(SNAPSHOTS_KEY, step === 'snapshots on')
      return { text: `Automatic snapshots ${step === 'snapshots on' ? 'on' : 'off'}: each stage of every Agent Services call is written under ${$.plugin.root}/snapshots/.` }
    }
    if (step === 'setup') return { text: await setupText($) }
    if (step === 'links forget') {
      const had = Object.entries(await readLearned($))
      try {
        await $.store.delete(LEARNED_KEY)
      } catch {
        return { text: 'Could not clear the learned sites: the plugin store could not be written.' }
      }
      await reloadLinks($)
      const forgot = had.map(([site, base]) => `${site} (${escapeText(hostOf(base), 100).text})`)
      return { text: forgot.length === 0 ? 'No learned sites to forget.' : `Forgot the learned sites: ${forgot.join(', ')}. Record links to them are off until an Agent Services response shows them again; /gas links says where each site comes from.` }
    }
    if (step === 'links') {
      const { file, problems, isUser } = await reloadLinks($)
      const where = file === undefined ? 'no override location (HOME is unknown)' : `${file} (${isUser ? 'loaded' : 'not found: create it to add mappings'})`
      const notes = problems.length === 0 ? '' : `\nSkipped: ${problems.join('; ')}`
      const sites = describeBases(linkConfig.bases, baseSources, file).join('\n')
      return { text: `Link mappings reloaded: ${linkConfig.records.length} row rules, ${linkConfig.searches.length} search links.\nSites record links open on:\n${sites}\nShipped defaults: ${$.plugin.root}/links.toml\nYour overrides: ${where}${notes}` }
    }
    if (step === 'trust' || step === 'trust on' || step === 'trust off') {
      const isOff = step === 'trust' ? await read($, isTrustOff) : await update($, isTrustOff, () => step === 'trust off')
      if (step === 'trust off') {
        return { text: 'Trust rules off for this session: Agent Services calls follow your existing permission settings. /gas trust on turns them back on.' }
      }
      // What is on disk is what is loaded now: cleared before the read, so a save that lands during it is not lost.
      isTrustFileChanged = false
      trustLoad = reloadTrust($)
      const { file, problems, isPresent } = await trustLoad
      const where = file === undefined ? 'no rules file location (HOME is unknown)' : isPresent ? file : `${file} (not found: create it to add rules; see trust.example.graphql in ${$.plugin.root})`
      const listed = trustRules.length === 0 ? 'No rules: Agent Services calls follow your existing permission settings.' : `${trustRules.length} rule${trustRules.length === 1 ? '' : 's'}: a matching query can run without asking when the organization ceiling allows it.\n${describeRules(trustRules).map(line => `  ${line}`).join('\n')}`
      const notes = problems.length === 0 ? '' : `\nSkipped: ${problems.join('; ')}`
      const state = isOff ? '\nOff for this session (/gas trust on).' : ''
      return { text: `Trust rules reloaded from ${where}.\n${listed}${notes}${state}\nPatterns match the text, not what it means; trust rules never auto-approve mutations or change-named roots.` }
    }
    if (step === 'timing on' || step === 'timing off') {
      await $.store.set(TIMING_KEY, step === 'timing on')
      return { text: `Summary timing ${step === 'timing on' ? 'on' : 'off'}: the last ${TIMING_KEEP} summaries go to ${$.plugin.root}/timing.log.` }
    }
    if (step === 'snapshot') {
      const state = await readCalls($)
      const { call, waiting } = shownResolvedAt(await readDisplayCalls($), (await readUi($)).selection)
      if (call === null) return { text: 'No Agent Services call to snapshot yet.' }
      if (!isFullCall(call)) return { text: 'Details for this call are unavailable.' }
      const widths = snapshots.widths
      const dir = await emitSnapshot($, call, waiting, 'manual', widths, true)
      return { text: `${dir === undefined ? 'Could not write the snapshot.' : `Snapshot written to ${dir}`} (automatic snapshots: ${(await isSnapshotting($)) ? 'on' : 'off'})` }
    }
    if (step === 'older' || step === 'newer' || step === 'live') {
      const state = await readDisplayCalls($)
      const ui = await readUi($)
      const selection = step === 'live' ? { kind: 'live' as const } : step === 'older' ? selectionOlder(ui.selection, state) : selectionNewer(ui.selection, state)
      await update($, paneUi, () => ({ ...CLOSED, selection }))
    }
    if (step === 'raw') {
      const isOpen = await toggleRaw($)
      return { text: isOpen ? 'Raw operation opened.' : 'Raw operation closed.' }
    }
    await retitleRaw($)
    // No holdToasts: that is for a dialog the person answers and leaves, and this pane stays docked.
    // No closeOnEscape: Esc hands the keys back and the pane stays (Esc is also how a person interrupts Claude); × or ctrl+x x closes it.
    await $.ui.open({ id: RAW_PANE, title: `Raw · ${rawTitleOf(await shownCall($))}`, columns: DOCK_COLUMNS }).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: DOCK_COLUMNS })
    return { text: opened.isPlaced ? 'GraphOS Inspector opened.' : 'GraphOS Inspector could not open here.' }
  })

  on('tool.call', { tool: /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__(?:execute|search|introspect|validate|dry_run)$/ }, async ($, e, next) => {
    // Forward before touching discovery, storage, timers, or observation metadata.
    let forwarded: ReturnType<typeof next>
    try { forwarded = next(e) }
    catch (error) {
      observeCall($, e, next.origin.plugin)
      finishObservation($, e.tool_use_id, { kind: 'errored', status: next.signal.aborted ? 'interrupted' : 'errored' })
      throw error
    }
    const token = generation
    const admitted = observeCall($, e, next.origin.plugin)
    const onAbort = () => {
      if (token === generation && admitted && observations.updateArrival(e.tool_use_id, arrival => ({ ...arrival, interrupted: true }))) scheduleObservation($)
    }
    if (admitted) {
      if (next.signal.aborted) onAbort()
      else next.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const ran = await forwarded
      if (token === generation && admitted) finishObservation($, e.tool_use_id, { kind: 'result', status: statusOf(ran), ran })
      return ran
    } catch (error) {
      if (token === generation && admitted) finishObservation($, e.tool_use_id, { kind: 'errored', status: next.signal.aborted ? 'interrupted' : 'errored' })
      throw error
    } finally {
      if (admitted) next.signal.removeEventListener('abort', onAbort)
    }
  })

  // Trust rules may lift an execute's ask to allow. Preserve existing allow/deny decisions,
  // organization ceilings, and the engine's verdict if matching fails. A lookup's
  // verdict is the engine's, untouched. Any call still asking opens the pane (openForDialog).
  on('tool.check', { tool: /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__(?:execute|search|introspect|validate|dry_run)$/ }, async ($, e, next) => {
    const token = generation
    const verdict = await next(e)
    if (token !== generation) return verdict
    // A query from a plugin (no call behind it) is answered as the engine would.
    const id = e.tool_use_id
    if (id === undefined) return verdict
    const tool = splitMcpTool(e.tool)?.tool
    const final = tool === 'execute' ? await checkExecute($, e, verdict, token).catch(() => verdict) : verdict
    if (token !== generation) return verdict
    if (final.decision === 'ask') {
      void (async () => {
        const server = splitMcpTool(e.tool)?.server
        if (server !== undefined && (await isGasServer($, server)) && token === generation) void openForDialog($, id, token)
      })().catch(() => undefined)
    }
    return final
  })

  on('session.end', ($, e, next) => {
    const forwarded = next(e)
    clearSessionMemory()
    sessionDetailsNeedClearing = true
    const token = generation
    sessionObservation = { token, run: async () => {
      await writes.catch(() => undefined)
      if (token !== generation) return
      try {
        const previousCalls = await readStoredCalls($)
        const previousSpinner = await read($, spinner)
        if (token !== generation) return
        await clearSessionDetails($, token)
        if (token !== generation) return
        sessionDetailsNeedClearing = false
        const ui = await readUi($)
        if (token !== generation) return
        const settled = await update($, calls, current => {
          const stored = normalizeStoredCalls(current)
          if (token !== generation || stored.writer !== previousCalls.writer || stored.writer !== INSTANCE && stored.writer !== undefined && stored.writer !== '') return stored
          let state = stored
          for (const call of state.queue) state = settleStoredCalls(state, call.id, 'interrupted', ui.selection)
          return state
        })
        if (token !== generation || settled.writer !== previousCalls.writer || settled.writer !== INSTANCE && settled.writer !== undefined && settled.writer !== '') return
        await update($, spinner, current => token === generation && current.id === previousSpinner.id && current.text === previousSpinner.text ? NO_SPINNER : current)
      } catch { /* A missing observer $ never prevents session teardown. */ }
    } }
    scheduleObservation($)
    return forwarded
  })

  // A live line's surface module failed on a surface: from then on that
  // surface draws the still line (the engine redraws the pane unasked).
  on('ui.fault', ($, e, next) => {
    faulted.add(e.surface)
    return next(e)
  })

  // An Agent Services call's verdict under its row in the transcript (src/view/notice.ts):
  // right above the approval dialog while it is open, and kept as the record
  // of what was approved. The dialog is the engine's alone, and $.ui.notice,
  // the line it offers under it, is not drawn for an MCP tool's dialog
  // (2.1.290-291, tried), so the row is where the line goes. A call draws as
  // its own ToolUse row, or folded into a ToolGroup's one line.
  // Every Agent Services call has one, a lookup's included; an expanded group's rows are
  // ToolUse rows of their own, which carry the line, so the group does not.
  on('ui.render', { component: 'ToolUse', props: { tool: /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__(?:execute|search|introspect|validate|dry_run)$/ } }, async ($, e, next) => {
    const drawn = await next(e)
    const texts = await verdictsOf($, [e.props])
    if (texts.length === 0) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return <VerdictRows Box={Box} Text={Text} drawn={drawn} texts={texts} />
  })
  // A folded group draws no result of its own, so each call that has a RESULT
  // block (below) has it under its verdict line here, call by call.
  on('ui.render', { component: 'ToolGroup', props: { isExpanded: false, calls: { tool: /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__(?:execute|search|introspect|validate|dry_run)$/ } } }, async ($, e, next) => {
    const drawn = await next(e)
    const entries: { texts: string[]; block: ResultBlock | undefined }[] = []
    for (const call of e.props.calls) {
      const texts = await verdictsOf($, [call])
      const block = call.tool_use_id !== undefined && EXECUTE_TOOL.test(call.tool) ? await resultBlockOfRow($, call.tool, call.tool_use_id) : undefined
      if (texts.length > 0 || block !== undefined) entries.push({ texts, block })
    }
    if (entries.length === 0) return drawn
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    if (entries.every(entry => entry.block === undefined)) return <VerdictRows Box={Box} Text={Text} drawn={drawn} texts={entries.flatMap(entry => entry.texts)} />
    const kit = transcriptKit(elements, e.surface)
    // Each call's verdict, then its block, in the group's order.
    return (
      <Box flexDirection="column">
        {drawn}
        {entries.flatMap(entry => [...verdictLines(Box, Text, entry.texts), ...(entry.block === undefined ? [] : [<ResultBlockView kit={kit} block={entry.block} onOpen={url => void openLink($, url)} />])])}
      </Box>
    )
  })

  // A settled call's RESULT under its row (src/view/transcript.ts), ahead of
  // the engine's own result drawing, which stays whole beneath it: what came back
  // and the first records, their keys links a click opens, for where the pane is
  // not docked and for scrollback. A standalone row's result is this event; an
  // expanded group draws each call's output inside its ToolUse row, which this
  // does not reach. Only a call that ran and whose response was read gets one.
  on('ui.render', { component: 'ToolResult', props: { tool: /^mcp__(?:claude_ai_GraphOS_Agent_Services|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__execute$/ } }, async ($, e, next) => {
    const drawn = await next(e)
    const block = await resultBlockOfRow($, e.props.tool, e.props.tool_use_id)
    if (block === undefined) return drawn
    return <ResultRows kit={transcriptKit($.ui.resolve(e), e.surface)} drawn={drawn} block={block} onOpen={url => void openLink($, url)} />
  })

  // While an Agent Services call runs with no dialog, the spinner reads what the call is
  // (src/view/spinner.ts) in place of its word. Only the spinner's tool-use
  // mode is hooked, so the others cost nothing; this one reads one small record.
  // An override the engine already has (its own message) is left as it is.
  on('ui.render', { component: 'Spinner', props: { mode: 'tool-use' } }, async ($, e, next) => {
    const { text } = await read($, spinner)
    if (text === '' || e.props.message !== null) return next(e)
    return next({ ...e, props: { ...e.props, message: text } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Code, Button } = elements
    if (observations.paused) return <Box flexDirection="column" backgroundColor={BACKGROUND}><Text color={QUIET}>GraphOS Inspector observation paused while its storage or analysis is unavailable. Tool calls continue.</Text>{observations.skipped > 0 && <Text color={QUIET}>{observations.skipped} calls could not be inspected.</Text>}</Box>
    // Auth links (UPSTREAM_AUTH_REQUIRED) open on click where the surface has Link.
    const Link = 'Link' in elements ? elements.Link : undefined
    // A pressed link opens through $.process (CLI only): off the terminal the surface opens it itself.
    const Markdown = 'Markdown' in elements ? (e.surface === 'terminal' ? elements.Markdown : surfaceOpened(elements.Markdown)) : undefined
    // Surface modules run on the terminal and desktop only.
    const Client = (e.surface === 'terminal' || e.surface === 'desktop') && !faulted.has(e.surface) && 'Client' in elements ? elements.Client : undefined
    const act = (change: PaneChange) => { void applyPaneChange($, change, shownResolvedAt(state, ui.selection).call?.id).catch(() => undefined) }
    // Stored state can predate this code (a reload keeps it): normalize both.
    const ui = await readUi($)
    const state = await readDisplayCalls($)
    const nav = navResolvedOf(state, ui.selection)
    try {
      const drawn = viewOf(
        { Box, Text, Code, Button, ...(Client !== undefined && { Client }), ...(Link !== undefined && { Link }), ...(Markdown !== undefined && { Markdown }) },
        shownResolvedAt(state, ui.selection),
        e.props.bodyColumns,
        ui,
        act,
        { isFocused: e.props.isFocused, surface: e.surface, bodyRows: e.props.scroll.bodyRows, scrollOffset: e.props.scroll.offset, links: linkConfig, ...(nav !== undefined && { nav }) },
      )
      return observations.skipped === 0 ? drawn : <Box flexDirection="column" backgroundColor={BACKGROUND}><Text color={QUIET}>{observations.skipped} calls could not be inspected.</Text>{drawn}</Box>
    } catch {
      // Never a blank pane: fall back to the call's operation, escaped.
      const call = shownResolvedAt(state, ui.selection).call
      return (
        <Box flexDirection="column" backgroundColor={BACKGROUND} minHeight={e.props.scroll.bodyRows}>
          <Text color={QUIET}>GraphOS Inspector could not draw this call.</Text>
          {call !== null && isFullCall(call) && <Box backgroundColor="userMessageBackground"><Code source={escapeText(call.operation).text} language="graphql" wrap="wrap" /></Box>}
        </Box>
      )
    }
  })

  // The raw operation of whichever call the main pane shows.
  on('ui.render', { component: 'Pane', requestId: RAW_PANE }, async ($, e) => {
    const { Box, Text, Code, Button } = $.ui.resolve(e)
    const state = await readDisplayCalls($)
    const ui = await readUi($)
    const call = shownResolvedAt(state, ui.selection).call
    return <RawView kit={{ Box, Text, Code, Button }} call={call} bodyRows={e.props.scroll.bodyRows} ui={ui} onChange={change => void applyPaneChange($, change, call?.id).catch(() => undefined)} onClose={() => void $.ui.close({ id: RAW_PANE }).catch(() => undefined)} />
  })
}
