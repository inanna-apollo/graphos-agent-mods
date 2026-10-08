// GraphOS Inspector: explains each Agent Services execute call while you decide on it.
// The only module that touches $. It never denies or rewrites a call: every
// tool.call path ends in next(e) with e unchanged. It approves only a call
// that fits the person's own trust rules (src/trust.ts), and only where the
// engine would have asked.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderSurface, Timer } from 'claude-code'

import type { InspectedCall, InspectorCalls } from '../types'
import { adaptExecute } from '../src/adapter.ts'
import { escapeText } from '../src/escape.ts'
import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import { cacheForServer, enrich, isAllowedWithoutPrompt, scopesOf } from '../src/enrich.ts'
import type { CallGas, EnrichCache } from '../src/enrich.ts'
import { normalize } from '../src/normalize.ts'
import { allowedOrigins, configOf, loadLinkConfig } from '../src/links.ts'
import type { BaseSource, LinkConfig } from '../src/links.ts'
import { describeBases, hostOf, learnable, learnedOf, setupPrompt, sitesIn, sitesOfGraph } from '../src/sites.ts'
import type { Sites } from '../src/sites.ts'
import { setupReport } from '../src/setup.ts'
import type { ToolState } from '../src/setup.ts'
import { versionNote } from '../src/version.ts'
import { OPEN_TIMEOUT_MS, openArgv } from '../src/open.ts'
import { arrive, normalizeCalls, EMPTY, isFinal, navOf, newer, older, patchAgent, patchIR, patchOutcome, patchTrust, settle, settleOrphans, shownAt, statusOf } from '../src/queue.ts'
import { MAX_SAVED, outcomeOf, pickResult, responseIn, savedOutcome, truncationOf } from '../src/result.ts'
import { gasServers, splitMcpTool } from '../src/servers.ts'
import { buildPrompt, cacheKey, MAX_TOKENS, parseSummary, SYSTEM_PROMPT } from '../src/summary.ts'
import type { CallIR, Summary } from '../src/ir.ts'
import { CLOSED, RawView, viewOf } from '../src/view.tsx'
import { noticeOf } from '../src/view/notice.ts'
import { trustVerdictOf } from '../src/view/trust.ts'
import { describeRules, fitCall, parseTrust } from '../src/trust.ts'
import { agentOf, pluginOf } from '../src/view/agent.ts'
import { spinnerTextOf } from '../src/view/spinner.ts'
import { ResultBlockView, ResultRows } from '../src/view/transcript.tsx'
import type { TranscriptKit } from '../src/view/transcript.tsx'
import { resultBlockOf } from '../src/view/transcript.ts'
import type { ResultBlock } from '../src/view/transcript.ts'
import { statusLine } from '../src/view/status.ts'
import type { Fit, TrustRule } from '../src/trust.ts'
import { COLOR } from '../src/view/ui/theme.ts'
import type { Kit } from '../src/view/kit.ts'
import { rawTitleOf } from '../src/view/raw.tsx'
import type { PaneChange } from '../src/view.tsx'
import { snapshotOptionsOf } from '../src/snapshot/options.ts'
import { findCall, planSnapshots } from '../src/snapshot/write.ts'
import type { SnapshotOptions } from '../src/snapshot/options.ts'

const PANE = 'gas'
// Every MCP server's `execute` tool (the hook matchers spell it inline): the Agent Services one among them, told apart by isGasServer.
const EXECUTE_TOOL = /^mcp__.+__execute$/
const TITLE = 'GraphOS Inspector'
// The raw operation of the call shown, in its own docked pane.
const RAW_PANE = 'gas-raw'
// The content is laid out for about 60 columns: ask the dock for that much and
// leave the rest to the transcript. A width the person dragged to still wins.
const DOCK_COLUMNS = 64
const calls = atom({ plugin: 'graphos-agent-mods', key: 'calls' } as const, EMPTY)
const hasAutoOpened = atom({ plugin: 'graphos-agent-mods', key: 'hasAutoOpened' } as const, false)
const pumper = atom({ plugin: 'graphos-agent-mods', key: 'pumper' } as const, '')
const tally = atom({ plugin: 'graphos-agent-mods', key: 'tally' } as const, { calls: 0, unasked: 0, bytes: 0 })
const spinner = atom({ plugin: 'graphos-agent-mods', key: 'spinner' } as const, { id: '', text: '' })

/** The calls state, normalized: stored state can predate this code (a reload keeps it). */
async function readCalls($: EngineInterface): Promise<InspectorCalls> {
  const raw = await read($, calls)
  return normalizeCalls(raw)
}

/** Updates the calls state; the callback only ever sees the normalized shape. */
function updateCalls($: EngineInterface, change: (state: InspectorCalls) => InspectorCalls) {
  return update($, calls, current => change(normalizeCalls(current)))
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
  return shownAt(await readCalls($), (await read($, paneUi)).cursor ?? null).call
}

/** Opens the raw pane titled for the call shown, or closes it; true when it is open after. */
async function toggleRaw($: EngineInterface): Promise<boolean> {
  if (await isRawOpen($)) {
    await $.ui.close({ id: RAW_PANE })
    return false
  }
  const opened = await $.ui.open({ id: RAW_PANE, title: rawTitleOf(await shownCall($)), focus: true, closeOnEscape: true, columns: DOCK_COLUMNS })
  return opened.isPlaced
}

/** Keeps an open raw pane's title on the call it shows (opening again retitles in place). */
async function retitleRaw($: EngineInterface) {
  try {
    if (await isRawOpen($)) await $.ui.open({ id: RAW_PANE, title: rawTitleOf(await shownCall($)) })
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
function gasCaller($: EngineInterface, server: string): CallGas {
  return async (tool, args) => {
    // Hard guard, not just a type: the mod never runs a GraphQL operation.
    if (!READ_ONLY_GAS_TOOLS.has(tool)) throw new Error(`GraphOS Inspector never calls ${String(tool)}`)
    const name = `mcp__${server}__${tool}`
    // Allowed by the person's rules, and not capped below allow by their organization.
    const verdict = await $.tool.check({ tool: name, input: args })
    const { decision, ceiling } = verdict
    if (!isAllowedWithoutPrompt(verdict)) throw new NotAllowed(name, ceiling !== undefined && ceiling !== 'allow' ? ceiling : decision)
    return $.mcp.call(server, tool, args)
  }
}

class NotAllowed extends Error {
  constructor(
    readonly tool: string,
    readonly decision: string,
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
async function summarize($: EngineInterface, call: InspectedCall, enrichMs: number) {
  const key = await cacheKey(call.ir, variablesOf(call))
  let summary = summaries.get(key)
  if (summary === undefined) {
    const prompt = buildPrompt(call.ir)
    const started = await $.clock.now()
    const stop = new AbortController()
    const answer = await withinStep($, 'Haiku', $.model.complete({ model: 'haiku', system: SYSTEM_PROMPT, prompt, maxTokens: MAX_TOKENS, effort: 'low', timeoutMs: 8_000 }, { signal: stop.signal })).finally(() => stop.abort())
    const parsed = answer.isAnswered ? parseSummary(answer.text) : undefined
    summary = parsed?.summary ?? null
    if (await isTiming($)) logTiming($, {
      at: started,
      root: call.ir.roots.map(root => root.name).join(','),
      sinceArrivedMs: started - call.arrivedAt,
      enrichMs,
      haikuMs: (await $.clock.now()) - started,
      systemChars: SYSTEM_PROMPT.length,
      promptChars: prompt.length,
      usage: answer.usage,
      ...(answer.isAnswered ? { rejected: parsed?.rejected ?? null } : { reason: answer.reason }),
      ...(answer.isAnswered && parsed?.rejected !== undefined && { text: answer.text.slice(0, 200) }),
    })
    // Cache real answers only (an API error may pass); keep the newest 200.
    if (answer.isAnswered) {
      summaries.set(key, summary)
      const oldest = summaries.size > 200 ? summaries.keys().next().value : undefined
      if (oldest !== undefined) summaries.delete(oldest)
    }
  }
  if (summary === null) return
  const found = summary
  await updateCalls($, current => {
    const latest = [...current.queue, ...current.history].find(one => one.id === call.id)
    return latest === undefined ? current : patchIR(current, call.id, { ...latest.ir, summary: found })
  })
  inSpinnerOrder(() => headlineSpinner($, call.id, { ...call.ir, summary: found }))
  await snap($, call.id, 'summary')
}

// Timeout for each analysis stage: Agent Services checks and the headline.
const STEP_MS = 20_000

class StepTimeout extends Error {
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
  const stop = new AbortController()
  const timeout = new Promise<never>((_, reject) => {
    $.clock.sleep(ms, { signal: stop.signal }).then(
      () => reject(new StepTimeout(step)),
      () => undefined,
    )
  })
  return Promise.race([work, timeout]).finally(() => stop.abort())
}

/**
 * The IR of a call whose analysis failed or ran out of time: settled
 * (`partial`), every check marked failed with the reason, policy left unknown.
 */
function failedIR(ir: CallIR, error: unknown): CallIR {
  const reason = error instanceof StepTimeout ? error.message : `analysis failed: ${error instanceof Error ? error.message : String(error)}`
  const checks = { policy: 'failed', validation: 'failed', schema: 'failed', error: reason.slice(0, 160) } as const
  const { isSummarizing: _dropped, ...settled } = annotate(ir, { isIncomplete: true, checks })
  return settled.state === 'analyzing' ? { ...settled, state: 'partial', checks } : settled
}

/** A call the pump should analyse: its checks or its headline are still out, and this instance has not tried it. */
const needsAnalysis = (call: InspectedCall) => (call.ir.state === 'analyzing' || call.ir.isSummarizing === true) && !attempted.has(call.id)

/**
 * One call's analysis, start to end, detached from every other call's: the
 * Agent Services checks, then the Haiku headline, each bounded by STEP_MS. However it
 * ends, the call leaves `analyzing` and stops shimmering, and it is never
 * retried by this instance.
 */
async function analyse($: EngineInterface, call: InspectedCall) {
  let failure: unknown
  try {
    let ir = call.ir
    let enrichMs = 0
    if (ir.state === 'analyzing') {
      const started = await $.clock.now()
      try {
        ir = await withinStep($, 'Agent Services', enrich(gasCaller($, call.server), cacheForServer(caches, call.server), ir, call.operation, variablesOf(call)))
      } catch (error) {
        ir = failedIR(ir, error)
      }
      enrichMs = (await $.clock.now()) - started
    }
    // Summarize once the IR carries what the summary must describe; the pane shimmers the headline meanwhile.
    const willSummarize = ir.state !== 'unparseable' && ir.summary === undefined
    const enriched = ir
    await updateCalls($, current => patchIR(current, call.id, willSummarize ? { ...enriched, isSummarizing: true } : enriched))
    void snap($, call.id, 'enriched')
    if (willSummarize) {
      try {
        await summarize($, { ...call, ir }, enrichMs)
      } catch {
        // Haiku failed, answered garbage or ran out of time: the deterministic headline stays.
      }
    }
  } catch (error) {
    failure = error
  } finally {
    // Never leave the call analysing or shimmering, whatever failed above.
    await updateCalls($, current => {
      const latest = findCall(current, call.id)
      if (latest === undefined) return current
      if (latest.ir.state === 'analyzing') return patchIR(current, call.id, failedIR(latest.ir, failure ?? new Error('stopped')))
      if (latest.ir.isSummarizing !== true) return current
      const { isSummarizing: _done, ...rest } = latest.ir
      return patchIR(current, call.id, rest)
    }).catch(() => undefined)
    void snap($, call.id, 'ready')
    void recordVerdict($, call.id)
  }
}

/**
 * Starts the analysis of every call that needs one, each on its own: a slow
 * Haiku answer or a hung Agent Services call holds up no other call. Runs on a clock
 * tick, its own dispatch, apart from the tool.call hook and its dialog.
 */
async function pump($: EngineInterface) {
  let state = await readCalls($)
  // Pending calls whose hook went with an older instance settle as interrupted: they can hold the pane no longer.
  const orphans = state.queue.filter(call => call.owner !== INSTANCE)
  if (orphans.length > 0) {
    state = await updateCalls($, current => settleOrphans(current, INSTANCE))
    // No hook is left to end their spinner text.
    for (const orphan of orphans) endSpinner($, orphan.id)
  }
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

/** The verdict line (src/view/notice.ts) of each Agent Services execute call among a row's calls, in order. */
async function verdictsOf($: EngineInterface, calls: readonly { tool: string; tool_use_id?: string }[]): Promise<string[]> {
  const ids: string[] = []
  for (const call of calls) {
    const id = call.tool_use_id
    if (id === undefined) continue
    // A recorded verdict is an Agent Services call's: no server lookup.
    if (verdicts.has(id)) {
      ids.push(id)
      continue
    }
    const server = EXECUTE_TOOL.test(call.tool) ? splitMcpTool(call.tool)?.server : undefined
    if (server !== undefined && (await isGasServer($, server))) ids.push(id)
  }
  if (ids.length === 0) return []
  // Settled rows read the record and so subscribe to nothing; a reload reads the kept copy once.
  if (ids.some(id => !verdicts.has(id))) await loadVerdicts($)
  const open = ids.filter(id => !verdicts.has(id))
  if (open.length > 0) {
    // Only a call still in play reads the calls state, which redraws its row as its analysis lands.
    const state = await readCalls($)
    for (const id of open) {
      const call = findCall(state, id)
      if (call !== undefined && isFinal(call)) rememberVerdict(id, verdictOf(call))
    }
    return ids.flatMap(id => {
      if (verdicts.has(id)) return verdicts.get(id) ?? []
      const call = findCall(state, id)
      return (call === undefined ? undefined : verdictOf(call)) ?? []
    })
  }
  return ids.flatMap(id => verdicts.get(id) ?? [])
}

/** The verdict line of a call (src/view/notice.ts): with the outcome once it ran. */
const verdictOf = (call: InspectedCall) => {
  // Lead with trust-rule attribution and avoid repeating the checkmark.
  const trusted = trustVerdictOf(call.trust)
  const notice = noticeOf(call.ir, call.status === 'ran' ? call.outcome : undefined)
  const parts = [trusted, trusted !== undefined && notice?.startsWith('✓ ') === true ? notice.slice(2) : notice].filter(part => part !== undefined)
  return parts.length === 0 ? null : parts.join(' · ')
}

// Each settled Agent Services call's final verdict line by tool_use_id (null: it has
// none), newest last: the record a row keeps however long ago its call left
// the history. Mirrored in $.state (`verdicts`) so a reload keeps it.
const VERDICTS_MAX = 500
const verdicts = new Map<string, string | null>()
let verdictsLoad: Promise<void> | undefined
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

/** Reads the kept record into memory once per instance; what memory has already wins. */
function loadVerdicts($: EngineInterface): Promise<void> {
  verdictsLoad ??= read($, verdictLog).then(
    log => {
      for (const [id, text] of Object.entries(log)) if (!verdicts.has(id) && (typeof text === 'string' || text === null)) rememberVerdict(id, text)
    },
    () => undefined,
  )
  return verdictsLoad
}

/**
 * Records call `id`'s verdict once it is final (src/queue.ts isFinal), in
 * memory and in $.state. Called where a call settles and where its analysis
 * ends, never while drawing. Best effort.
 */
async function recordVerdict($: EngineInterface, id: string) {
  try {
    const call = findCall(await readCalls($), id)
    if (call === undefined || !isFinal(call)) return
    const text = verdictOf(call)
    rememberVerdict(id, text)
    rememberResultBlock(id, resultBlockOfCall(call))
    await update($, verdictLog, log => {
      if (log[id] === text) return log
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
  if (resultBlocks.has(id)) return resultBlocks.get(id) ?? undefined
  const server = splitMcpTool(tool)?.server
  if (server === undefined || !(await isGasServer($, server))) return undefined
  const call = findCall(await readCalls($), id)
  // A call that left the state (a long session, a reload) has nothing to read again: recorded, so the row stops listening to the calls state.
  if (call === undefined) {
    rememberResultBlock(id, null)
    return undefined
  }
  if (!isFinal(call)) return undefined
  const block = resultBlockOfCall(call)
  rememberResultBlock(id, block)
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
            const tone = glyph === '⚑' ? COLOR.deny : glyph === '✓' ? COLOR.allow : undefined
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

async function isGasServer($: EngineInterface, server: string, options: { isFresh?: boolean } = {}): Promise<boolean> {
  if (servers?.has(server)) return true
  const now = await $.clock.now().catch(() => undefined)
  const missedAt = misses.get(server)
  if (options.isFresh !== true && now !== undefined && missedAt !== undefined && now - missedAt < SERVERS_TTL_MS) return false
  listing ??= $.tool.list().then(gasServers).finally(() => (listing = undefined))
  const found = await listing
  servers = found
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
  const file = await userLinksFile($)
  const user = file === undefined ? undefined : await readText($, file)
  const shipped = await readText($, `${$.plugin.root}/links.toml`)
  const loaded = loadLinkConfig({ ...(shipped !== undefined && { shipped }), ...(user !== undefined && { user }), learned: await readLearned($) })
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
// what runs unasked. No file, no rules: every call asks as it always did.
let trustRules: TrustRule[] = []
let trustLoad: Promise<TrustLoaded> | undefined
// trust.graphql was saved since the rules in memory were read: shown in the
// standing line until the person runs `/gas trust`.
let isTrustFileChanged = false
const isTrustOff = atom({ plugin: 'graphos-agent-mods', key: 'isTrustOff' } as const, false)

type TrustLoaded = { file: string | undefined; problems: string[]; isPresent: boolean }

async function reloadTrust($: EngineInterface): Promise<TrustLoaded> {
  const file = await userFile($, 'trust.graphql')
  const text = file === undefined ? undefined : await readText($, file)
  const { rules, problems } = text === undefined ? { rules: [], problems: [] } : parseTrust(text)
  trustRules = rules
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

// The standing line under the prompt (src/view/status.ts), pushed where the
// state it counts changes (a call arriving or settling, trust rules loading,
// switching or being reloaded) and never on a timer. Sent only when its text
// changed, and one send after another, so an older line never lands over a newer.
let shownStatus: string | undefined
let statusChain: Promise<void> = Promise.resolve()

/**
 * What the caller has just written: a dispatch's `$` reads one moment, so it cannot read its own write back.
 * `isReadingRules: false` keeps the line from reading trust.graphql for the rule count: reporting that the file
 * was saved must never be what reads it.
 */
type KnownFacts = { tally?: { calls: number; unasked: number; bytes?: number }; isTrustOff?: boolean; isReadingRules?: boolean }
// `/gas trust off`, as the last command left it: the atom is the record, this is what a long-lived dispatch's `$` cannot read back.
let isTrustOffNow: boolean | undefined

function showStatus($: EngineInterface, known: KnownFacts = {}): Promise<void> {
  statusChain = statusChain
    .then(async () => {
      // A reloaded module has not read the rules yet: the line must not forget them.
      if (known.isReadingRules !== false) await ensureTrust($)
      const counted = known.tally ?? (await read($, tally))
      const isOff = known.isTrustOff ?? isTrustOffNow ?? (await read($, isTrustOff))
      const text = statusLine({ calls: counted.calls, unasked: counted.unasked, bytes: counted.bytes ?? 0, rules: trustRules.length, isTrustOff: isOff, isTrustFileChanged })
      if (text === shownStatus) return
      $.ui.status(text)
      // Only once it was sent: a send that threw is tried again with the next change.
      shownStatus = text
    })
    .catch(() => undefined)
  return statusChain
}

/** One more Agent Services call this session; the line follows. Never rejects. */
async function countCall($: EngineInterface) {
  try {
    await showStatus($, { tally: await update($, tally, counted => ({ ...counted, calls: counted.calls + 1 })) })
  } catch {
    // The line is a convenience.
  }
}

/** A response Claude read, `bytes` of it (src/weight.ts); the line follows. Never rejects. */
async function countRead($: EngineInterface, bytes: number) {
  try {
    await showStatus($, { tally: await update($, tally, counted => ({ ...counted, bytes: (counted.bytes ?? 0) + bytes })) })
  } catch {
    // The line is a convenience.
  }
}

/** One more call that ran with no dialog because it fit a trust rule (its `trust.isAllowed`); the line follows. Never rejects. */
async function countUnasked($: EngineInterface) {
  try {
    await showStatus($, { tally: await update($, tally, counted => ({ ...counted, unasked: counted.unasked + 1 })) })
  } catch {
    // The line is a convenience.
  }
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
  spinnerChain = spinnerChain.then(work).then(() => undefined, () => undefined)
}

/** The call `id` runs now, unasked: the spinner reads its headline, else `Agent Services · <operation name>`. */
async function beginSpinner($: EngineInterface, server: string, id: string) {
  if (!(await isGasServer($, server))) return
  const call = findCall(await readCalls($), id)
  if (call === undefined) return
  const text = spinnerTextOf(call.ir)
  // Decided as it is written: an end asked for before now wins.
  await update($, spinner, current => (endedSpinners.has(id) ? current : { id, text }))
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
  try {
    const info = (await withinStep($, 'the agent list', $.agent.list(), AGENT_LIST_MS)).find(one => one.id === agentId)
    if (info === undefined) return
    const agent = { ...agentOf(agentId, info), ...(plugin !== undefined && { plugin }) }
    await updateCalls($, state => patchAgent(state, callId, agent))
    void snap($, callId, 'agent')
  } catch {
    // The line says `from subagent` and no more.
  }
}

/** How long the pane waits for the agent list. */
const AGENT_LIST_MS = 5_000

/**
 * The pane's side of a call arriving: back to live (CLOSED has cursor: null),
 * the raw pane retitled, and the pane opened once unasked. Runs beside the
 * permission dialog, never ahead of it; best effort, never rejects.
 */
async function showArrival($: EngineInterface) {
  try {
    await update($, paneUi, () => CLOSED)
    await retitleRaw($)
    // Unasked, the engine seats a pane only where it can dock (144 columns).
    if (!(await read($, hasAutoOpened))) {
      const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
      if (opened.isPlaced) await update($, hasAutoOpened, () => true)
    }
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
    servers = [...gasServers(await $.tool.list())]
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
  if (!hasLoadedLinks) await reloadLinks($).catch(() => undefined)
  hasLoadedLinks = true
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
function learnSites($: EngineInterface, ir: CallIR, result: unknown): Promise<void> {
  learning = learning.then(() => learnFrom($, ir, result)).catch(() => undefined)
  return learning
}
async function learnFrom($: EngineInterface, ir: CallIR, result: unknown) {
  // The cheap gate: nothing is parsed unless a base a response can teach is still unset.
  const wanted = learnable(baseSources)
  if (wanted.length === 0) return
  const found = sitesIn(ir, responseIn(result))
  const fresh = wanted.filter(site => found[site] !== undefined)
  if (fresh.length === 0) return
  const before = linkConfig.bases
  await $.store.set(LEARNED_KEY, { ...(await readLearned($)), ...Object.fromEntries(fresh.map(site => [site, found[site]])) })
  await reloadLinks($)
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
 * cannot take effect on its own. The person is told once per change (the
 * standing line keeps saying it), and how to apply it.
 */
function trustSaved($: EngineInterface) {
  const isNew = !isTrustFileChanged
  isTrustFileChanged = true
  // Said without reading the file: this instance may not have read it yet, and a save is not what loads it.
  void showStatus($, { isReadingRules: false })
  if (isNew) $.ui.log('GraphOS Inspector: trust.graphql changed. Run /gas trust to reload it; until then, the rules loaded earlier stand.')
}

export const register: Register = (on, options) => {
  // Start with shipped links; session setup loads user mappings and learned sites.
  linkConfig = configOf()
  hasLoadedLinks = false
  snapshots = snapshotOptionsOf(options)
  on('session.start', async ($, e, next) => {
    // Arrivals start the pump on this session's `$`, as it always ran: its dispatch is over, so its reads see every write.
    wakePump = () => startPump($)
    // One round picks up what a reload left analysing.
    wakePump()
    await ensureLinks($)
    await ensureTrust($)
    void showStatus($)
    void noteVersion($).catch(() => undefined)
    try {
      // Immediate: the command only reads and writes the pane, so typed mid-turn it need not wait for the turn to end.
      await $.command.register({ name: 'gas', description: 'Show the GraphOS Inspector pane for the current Agent Services call', argumentHint: '[setup|older|newer|live|raw|trust|links]', immediate: true })
    } catch {
      // No command host (a test engine); the pane still opens on its own.
    }
    return next(e)
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
      isTrustOffNow = isOff
      if (step === 'trust off') {
        void showStatus($, { isTrustOff: true })
        return { text: 'Trust rules off for this session: every Agent Services call asks. /gas trust on turns them back on.' }
      }
      // What is on disk is what is loaded now: cleared before the read, so a save that lands during it is not lost.
      isTrustFileChanged = false
      trustLoad = reloadTrust($)
      const { file, problems, isPresent } = await trustLoad
      void showStatus($, { isTrustOff: isOff })
      const where = file === undefined ? 'no rules file location (HOME is unknown)' : isPresent ? file : `${file} (not found: create it to add rules; see trust.example.graphql in ${$.plugin.root})`
      const listed = trustRules.length === 0 ? 'No rules: every Agent Services call asks.' : `${trustRules.length} rule${trustRules.length === 1 ? '' : 's'}: an Agent Services query that fits one runs without asking.\n${describeRules(trustRules).map(line => `  ${line}`).join('\n')}`
      const notes = problems.length === 0 ? '' : `\nSkipped: ${problems.join('; ')}`
      const state = isOff ? '\nOff for this session (/gas trust on).' : ''
      return { text: `Trust rules reloaded from ${where}.\n${listed}${notes}${state}\nPatterns match the text, not what it means; mutations and change-named roots always ask.` }
    }
    if (step === 'timing on' || step === 'timing off') {
      await $.store.set(TIMING_KEY, step === 'timing on')
      return { text: `Summary timing ${step === 'timing on' ? 'on' : 'off'}: the last ${TIMING_KEEP} summaries go to ${$.plugin.root}/timing.log.` }
    }
    if (step === 'snapshot') {
      const state = await readCalls($)
      const { call, waiting } = shownAt(state, (await read($, paneUi)).cursor)
      if (call === null) return { text: 'No Agent Services call to snapshot yet.' }
      const widths = snapshots.widths
      const dir = await emitSnapshot($, call, waiting, 'manual', widths, true)
      return { text: `${dir === undefined ? 'Could not write the snapshot.' : `Snapshot written to ${dir}`} (automatic snapshots: ${(await isSnapshotting($)) ? 'on' : 'off'})` }
    }
    if (step === 'older' || step === 'newer' || step === 'live') {
      const state = await readCalls($)
      await update($, paneUi, ui => ({ ...ui, cursor: step === 'live' ? null : step === 'older' ? older(ui.cursor, state) : newer(ui.cursor) }))
    }
    if (step === 'raw') {
      const isOpen = await toggleRaw($)
      return { text: isOpen ? 'Raw operation opened.' : 'Raw operation closed.' }
    }
    await retitleRaw($)
    // No holdToasts: that is for a dialog the person answers and leaves, and this pane stays docked.
    // No closeOnEscape: Esc hands the keys back and the pane stays (Esc is also how a person interrupts Claude); × or ctrl+x x closes it.
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: DOCK_COLUMNS })
    return { text: opened.isPlaced ? 'GraphOS Inspector opened.' : 'GraphOS Inspector could not open here.' }
  })

  on('tool.call', { tool: /^mcp__.+__execute$/ }, async ($, e, next) => {
    const server = splitMcpTool(e.tool)?.server
    if (server === undefined || !(await isGasServer($, server, { isFresh: true }))) return next(e)

    // Before the dialog only what must be: the call recorded, so the pump
    // and the pane can find it while the person decides.
    // Who made it: Claude (the engine's call site) or a plugin's hook.
    const plugin = pluginOf(next.origin?.plugin)
    const call = inspectedCall(e, server, await $.clock.now(), plugin)
    // A call another instance left pending (a reload or a respawn took its hook mid-dialog) can hold the pane no longer.
    const orphans: string[] = []
    await updateCalls($, state => {
      // Captured as it is decided (the callback may run again on a conflict): their spinner text has no hook left to end it.
      orphans.length = 0
      orphans.push(...normalizeCalls(state).queue.filter(one => one.owner !== INSTANCE).map(one => one.id))
      return arrive(settleOrphans(state, INSTANCE), call)
    })
    for (const id of orphans) endSpinner($, id)
    // The pump starts its analysis beside the dialog (no wait: the timer is set at once). With no
    // session.start in this instance (a reload can skip it), on this call's `$`, which has seen its arrival.
    try {
      if (wakePump !== undefined) wakePump()
      else startPump($)
    } catch {
      // The session's `$` is gone (a throw here would leave the call pending with no hook to settle it).
      wakePump = undefined
      startPump($)
    }
    void snap($, call.id, 'arrive')
    // Everything else runs beside the dialog, never ahead of it.
    void showArrival($)
    void countCall($)
    if (e.agentId !== undefined) void resolveAgent($, call.id, e.agentId, plugin)

    // An abort (the person's Esc, a hook above settling first) may leave next(e) unsettled: the call stops pending then.
    const onAbort = () => {
      void updateCalls($, state => settle(state, call.id, 'interrupted')).catch(() => undefined)
      endSpinner($, call.id)
    }
    if (next.signal.aborted) onAbort()
    else next.signal.addEventListener('abort', onAbort, { once: true })
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      await updateCalls($, state => settle(state, e.tool_use_id, next.signal.aborted ? 'interrupted' : 'errored')).catch(() => undefined)
      void snap($, e.tool_use_id, 'errored')
      void recordVerdict($, e.tool_use_id)
      throw error
    } finally {
      // The call is over: an Esc from here on interrupts nothing of it.
      next.signal.removeEventListener('abort', onAbort)
      endSpinner($, e.tool_use_id)
    }
    // The call ran and Claude has its result as the engine gave it: reading the response for the pane can fail on its own, and never makes the call look errored.
    try {
      await ensureLinks($)
      const status = statusOf(ran)
      const settled = await updateCalls($, state => settle(state, e.tool_use_id, status))
      void snap($, e.tool_use_id, 'settled')
      // Counted as unasked once it ran, and only if a trust rule (never the engine's own allow) let it through.
      if (status === 'ran' && findCall(settled, e.tool_use_id)?.trust?.isAllowed === true) void countUnasked($)
      // An errored call (refused at the dialog, or the tool failed) carries
      // the engine's text, not a GraphQL response: no RESULT for it.
      // An oversized result comes back as an error text naming the file Claude Code saved it to.
      const stood = ran.deny === undefined ? truncationOf(ran.text) ?? truncationOf(ran.result) : undefined
      if (status === 'ran') {
        // Core relays the tool's text as `text` and its content blocks as `result`.
        // The latest IR names fields by their real names; which scalars show is decided when drawn.
        const current = await readCalls($)
        const latest = [...current.queue, ...current.history].find(one => one.id === e.tool_use_id)
        const ir = latest?.ir ?? call.ir
        const result = pickResult(ran.text, ran.result)
        // The site this response shows, before the rows' links are worked out from it.
        await learnSites($, ir, result)
        let outcome = outcomeOf(ir, result, linkConfig)
        if (stood !== undefined && outcome.isUnreadable !== true) outcome = savedOutcome(outcome)
        if (outcome.isTooLarge === true && stood?.path !== undefined) {
          // Read the saved copy back: only a path Claude Code saved (src/result.ts), bounded.
          try {
            const saved = await $.fs.read(stood.path)
            if (saved.length <= MAX_SAVED) {
              await learnSites($, ir, saved)
              const full = outcomeOf(ir, saved, linkConfig)
              if (full.isUnreadable !== true) outcome = savedOutcome(full)
            }
          } catch {
            // Unreadable here: the pane says the response was too large to preview.
          }
        }
        const patched = await updateCalls($, state => patchOutcome(state, e.tool_use_id, outcome))
        // Its result row is drawn as this hook returns: the block is on record by then, so the row reads only that.
        const done = findCall(patched, e.tool_use_id)
        if (done !== undefined && isFinal(done)) rememberResultBlock(e.tool_use_id, resultBlockOfCall(done))
        void snap($, e.tool_use_id, 'outcome')
        // A result Claude Code kept out of the context (saved to a file, only a preview shown) was not read.
        if (outcome.weight !== undefined && outcome.weight.isPersisted !== true) void countRead($, outcome.weight.bytes)
      }
    } catch {
      // The pane keeps what it had of the call, settled (a second settle changes nothing); the result Claude reads is untouched.
      await updateCalls($, state => settle(state, e.tool_use_id, statusOf(ran))).catch(() => undefined)
    }
    void recordVerdict($, e.tool_use_id)
    return ran
  }).catch(($, e, next) => next(e))

  // Trust rules may lift ask to allow. Preserve existing allow/deny decisions,
  // organization ceilings, and the engine's verdict if matching fails.
  on('tool.check', { tool: /^mcp__.+__execute$/ }, async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    // A query from a plugin (no call behind it) is answered as the engine would.
    if (id === undefined) return verdict
    const server = splitMcpTool(e.tool)?.server
    // The engine's own rules allowed it: no dialog, the call runs at once, and the spinner can say what it is.
    if (verdict.decision === 'allow' && server !== undefined) inSpinnerOrder(() => beginSpinner($, server, id))
    if (verdict.decision !== 'ask') return verdict
    if ((e.ceiling !== undefined && e.ceiling !== 'allow') || (verdict.ceiling !== undefined && verdict.ceiling !== 'allow')) return verdict
    if (server === undefined || !(await isGasServer($, server))) return verdict
    await ensureTrust($)
    if (trustRules.length === 0 || (await read($, isTrustOff))) return verdict
    const fit = fitCall(e.input, trustRules)
    await updateCalls($, state => patchTrust(state, id, keptFit(fit))).catch(() => undefined)
    if (!fit.isAllowed) return verdict
    const rules = [...new Set(fit.fits.map(one => one.rule))]
    // Let through by a trust rule: no dialog either.
    inSpinnerOrder(() => beginSpinner($, server, id))
    return { decision: 'allow' as const, reason: `GraphOS Inspector trust rule${rules.length === 1 ? '' : 's'} ${rules.join(', ')}` }
  })

  on('session.end', async ($, e, next) => {
    if (pumpTimer !== undefined) stopPump(pumpTimer)
    // A /clear goes on in this process with no session.start: the next call starts the pump on its own `$`.
    wakePump = undefined
    // Nothing pending outlives the session: a /clear goes on in this process, its pane fresh.
    await updateCalls($, state => settleOrphans(state)).catch(() => undefined)
    inSpinnerOrder(() => update($, spinner, () => NO_SPINNER))
    // The next session counts from nothing.
    const fresh = await update($, tally, () => ({ calls: 0, unasked: 0, bytes: 0 })).catch(() => undefined)
    if (fresh !== undefined) void showStatus($, { tally: fresh })
    return next(e)
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
  // Only an `execute` row can be an Agent Services call's; an expanded group's rows are
  // ToolUse rows of their own, which carry the line, so the group does not.
  on('ui.render', { component: 'ToolUse', props: { tool: /^mcp__.+__execute$/ } }, async ($, e, next) => {
    const drawn = await next(e)
    const texts = await verdictsOf($, [e.props])
    if (texts.length === 0) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return <VerdictRows Box={Box} Text={Text} drawn={drawn} texts={texts} />
  })
  // A folded group draws no result of its own, so each call that has a RESULT
  // block (below) has it under its verdict line here, call by call.
  on('ui.render', { component: 'ToolGroup', props: { isExpanded: false, calls: { tool: /^mcp__.+__execute$/ } } }, async ($, e, next) => {
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
  on('ui.render', { component: 'ToolResult', props: { tool: /^mcp__.+__execute$/ } }, async ($, e, next) => {
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
    // Auth links (UPSTREAM_AUTH_REQUIRED) open on click where the surface has Link.
    const Link = 'Link' in elements ? elements.Link : undefined
    // A pressed link opens through $.process (CLI only): off the terminal the surface opens it itself.
    const Markdown = 'Markdown' in elements ? (e.surface === 'terminal' ? elements.Markdown : surfaceOpened(elements.Markdown)) : undefined
    // Surface modules run on the terminal and desktop only.
    const Client = (e.surface === 'terminal' || e.surface === 'desktop') && !faulted.has(e.surface) && 'Client' in elements ? elements.Client : undefined
    await ensureLinks($)
    const act = (change: PaneChange) => {
      const { toggleRaw: isRawToggle, openUrl: url, draftPrompt: draft, ...state } = change
      if (isRawToggle === true) void toggleRaw($).catch(() => undefined)
      if (url !== undefined) void openLink($, url)
      if (draft !== undefined) void draftPrompt($, draft)
      if (Object.keys(state).length === 0) return
      void update($, paneUi, current => ({ ...current, ...state })).then(() => retitleRaw($))
    }
    // Stored state can predate this code (a reload keeps it): normalize both.
    const ui = { ...CLOSED, ...(await read($, paneUi)) }
    const state = await readCalls($)
    const nav = navOf(state, ui.cursor)
    try {
      return viewOf(
        { Box, Text, Code, Button, ...(Client !== undefined && { Client }), ...(Link !== undefined && { Link }), ...(Markdown !== undefined && { Markdown }) },
        shownAt(state, ui.cursor),
        e.props.bodyColumns,
        ui,
        act,
        { isFocused: e.props.isFocused, surface: e.surface, bodyRows: e.props.scroll.bodyRows, scrollOffset: e.props.scroll.offset, links: linkConfig, ...(nav !== undefined && { nav }) },
      )
    } catch {
      // Never a blank pane: fall back to the call's operation, escaped.
      const call = shownAt(state, null).call
      return (
        <Box flexDirection="column">
          <Text dimColor>GraphOS Inspector could not draw this call.</Text>
          {call !== null && <Code source={escapeText(call.operation).text} language="graphql" wrap="wrap" />}
        </Box>
      )
    }
  })

  // The raw operation of whichever call the main pane shows.
  on('ui.render', { component: 'Pane', requestId: RAW_PANE }, async ($, e) => {
    const { Box, Text, Code, Button } = $.ui.resolve(e)
    const state = await readCalls($)
    const call = shownAt(state, (await read($, paneUi)).cursor ?? null).call
    return <RawView kit={{ Box, Text, Code, Button }} call={call} onClose={() => void $.ui.close({ id: RAW_PANE }).catch(() => undefined)} />
  })
}
