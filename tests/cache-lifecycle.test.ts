import { observeCache, untilCache } from './cache-observer.ts'
import { expect, mock, test } from 'claude-code/testing'
import type { CallOverview, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const SEARCH = `mcp__${SERVER}__search`
const TOOLS = ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 64, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const command = (args: string) => ({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
const ran = () => ({ result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } })

for (const ending of ['ran', 'denied', 'errored'] as const) {
  test(`selected history and raw input survive execute and lookup arrivals ending ${ending}`, async ($, on) => {
    const clock = mock.clock(on)
    const observed = observeCache(on)
    on('tool.list', () => ({ value: TOOLS }))
    on('command.run', () => ({ text: '' }))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
    let release!: () => void
    let reached!: () => void
    const held = new Promise<void>(resolve => release = resolve)
    const arrived = new Promise<void>(resolve => reached = resolve)
    on('tool.call', { tool: EXECUTE }, async (_, e) => {
      if (String(e.operation).includes('Third')) {
        reached()
        await held
        if (ending === 'denied') return { deny: 'refused' }
        if (ending === 'errored') return { isError: true, result: 'upstream failed', text: 'upstream failed' }
      }
      return ran()
    })
    on('tool.call', { tool: SEARCH }, ran)
    await $.tool.call({ tool: EXECUTE, operation: 'query First { confluence_search(cql: "first") { totalSize } }' })
    await $.tool.call({ tool: EXECUTE, operation: 'query Second { jira_issue(key: "A-1") { key } }' })
    await untilCache(clock, () => observed.settled('First') && observed.settled('Second'))
    await $.command.run(command('older'))
    const main = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
    const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
    const third = $.tool.call({ tool: EXECUTE, operation: 'query Third { slack_me { id } }' })
    await arrived
    await $.tool.call({ tool: SEARCH, terms: ['issues'] })
    await untilCache(clock, () => observed.calls?.queue.some(call => call.overview.operationName === 'Third') === true)
    expect(await main.find({ text: /confluence_search/ })).toBeDefined()
    expect(await raw.find({ type: 'Code', text: /confluence_search/ })).toBeDefined()
    release()
    await third
    await untilCache(clock, () => observed.settled('Third'))
    expect(await main.find({ text: /confluence_search/ })).toBeDefined()
    expect(await raw.find({ type: 'Code', text: /confluence_search/ })).toBeDefined()
  })
}

test('a real permission request selects its active lookup and clears old expansions', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: TOOLS }))
  on('command.run', () => ({ text: '' }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('tool.call', { tool: EXECUTE }, ran)
  let lookupId = ''
  on('tool.call', { tool: SEARCH }, (_, e) => { lookupId = e.tool_use_id; return ran() })
  await $.tool.call({ tool: EXECUTE, operation: '{ confluence_search(cql: "old") { totalSize } }' })
  await $.tool.call({ tool: EXECUTE, operation: '{ jira_issue(key: "A-1") { key } }' })
  await untilCache(clock, () => observed.settled('confluence_search') && observed.settled('jira_issue'))
  await $.command.run(command('older'))
  await $.tool.call({ tool: SEARCH, terms: ['ActiveLookup'] })
  expect(lookupId).not.toBe('')
  await $.tool.check({ tool: SEARCH, input: { terms: ['ActiveLookup'] }, tool_use_id: lookupId })
  await clock.advance(50)
  const main = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  expect(await main.find({ text: /confluence_search/ })).toBeUndefined()
  expect(await main.find({ text: /ActiveLookup/ })).toBeDefined()
})

test('a failed observer write preserves the original tool input and invokes the tool once', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: TOOLS }))
  on('state.set', { key: 'calls' }, () => ({ deny: 'observer storage unavailable' }))
  const original = { operation: '{ jira_issue(key: "A-1") { key } }', variables: '{"secret":"original"}' }
  let executions = 0
  let input: unknown
  on('tool.call', { tool: EXECUTE }, (_, e) => {
    executions += 1
    input = { operation: e.operation, variables: e.variables }
    return ran()
  })
  await $.tool.call({ tool: EXECUTE, ...original })
  expect(executions).toBe(1)
  expect(input).toEqual(original)
})

test('an oversize inspected input keeps explicit metadata and settles without storing a substitute IR', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: TOOLS }))
  on('tool.call', { tool: EXECUTE }, ran)
  let saved: StoredInspectorCalls | undefined
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet) saved = e.value as StoredInspectorCalls
    return answer
  })
  await $.tool.call({ tool: EXECUTE, operation: '{ jira_issue(key: "A-1") { key } }', variables: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }) })
  await untilCache(clock, () => saved?.history[0]?.details === 'oversize' && saved?.history[0]?.status === 'ran')
  const retained: CallOverview | undefined = saved?.history[0]
  expect(retained?.status).toBe('ran')
  expect(retained?.details).toBe('oversize')
  expect(retained !== undefined && 'ir' in retained).toBe(false)
  expect(saved?.queue).toHaveLength(0)
})

test('session teardown clears full details and ignores the old tool result arriving in the next generation', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: TOOLS }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  const arrived = new Promise<void>(resolve => reached = resolve)
  let oldId = ''
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    if (String(e.operation).includes('OldGeneration')) {
      oldId = e.tool_use_id
      reached()
      await held
    }
    return ran()
  })
  const writes: StoredInspectorCalls[] = []
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet) writes.push(e.value as StoredInspectorCalls)
    return answer
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const old = $.tool.call({ tool: EXECUTE, operation: 'query OldGeneration { confluence_search(cql: "old") { totalSize } }' })
  await arrived
  await untilCache(clock, () => observed.calls?.queue.some(call => call.id === oldId) === true)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
  await untilCache(clock, () => observed.calls?.history.some(call => call.id === oldId && call.status === 'interrupted') === true && observed.models.length === 0)
  await $.tool.call({ tool: EXECUTE, operation: 'query NewGeneration { jira_issue(key: "A-1") { key } }' })
  await untilCache(clock, () => observed.settled('NewGeneration'))
  const oldOverview = writes[writes.length - 1]?.history.find(call => call.id === oldId)
  release()
  await old
  await clock.advance(500)
  expect(writes[writes.length - 1]?.history.find(call => call.id === oldId)).toEqual(oldOverview)
  expect(writes[writes.length - 1]?.history.find(call => call.id === oldId)?.status).toBe('interrupted')
  await $.command.run(command('older'))
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await raw.find({ text: /unavailable/ })).toBeDefined()
  expect(await raw.find({ type: 'Code' })).toBeUndefined()
})

test('an arrival held on its first state read cannot recreate pending calls after session end', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: TOOLS }))
  on('tool.call', { tool: EXECUTE }, ran)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  let reached!: () => void
  let release!: () => void
  const arrived = new Promise<void>(resolve => reached = resolve)
  const held = new Promise<void>(resolve => release = resolve)
  let intercept = true
  let saved: StoredInspectorCalls | undefined
  on('state.get', { key: 'calls' }, async (_, e, next) => {
    if (intercept) { intercept = false; reached(); await held }
    return next(e)
  })
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet) saved = e.value as StoredInspectorCalls
    return answer
  })
  const tool = $.tool.call({ tool: EXECUTE, operation: '{ jira_issue(key: "A-1") { key } }' })
  await untilCache(clock, () => !intercept)
  await arrived
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
  release()
  await tool
  await untilCache(clock, () => saved?.queue.length === 0)
  expect(saved?.queue).toHaveLength(0)
})

test('lookup discovery held across session end cannot adopt the next generation', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  let reached!: () => void
  let release!: () => void
  const arrived = new Promise<void>(resolve => reached = resolve)
  const held = new Promise<void>(resolve => release = resolve)
  let first = true
  let arrivals = 0
  on('tool.list', async () => {
    if (first) { first = false; reached(); await held }
    return { value: TOOLS }
  })
  on('tool.call', { tool: SEARCH }, ran)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('state.set', { key: 'calls' }, (_, e, next) => {
    if ((e.value as StoredInspectorCalls).queue.length > 0) arrivals += 1
    return next(e)
  })
  const tool = $.tool.call({ tool: SEARCH, terms: ['issues'] })
  await untilCache(clock, () => !first)
  await arrived
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
  release()
  await tool
  await untilCache(clock, () => observed.calls?.queue.length === 0)
  expect(arrivals).toBe(0)
})

for (const heldStep of ['verdict', 'discovery'] as const) {
  test(`a permission ${heldStep} resumed after session end preserves its verdict and never selects the old dialog`, async ($, on) => {
    const clock = mock.clock(on)
    let reached!: () => void
    let release!: () => void
    const arrived = new Promise<void>(resolve => reached = resolve)
    const held = new Promise<void>(resolve => release = resolve)
    on('tool.list', async () => {
      if (heldStep === 'discovery') { reached(); await held }
      return { value: TOOLS }
    })
    on('tool.check', async () => {
      if (heldStep === 'verdict') { reached(); await held }
      return { decision: 'ask' as const }
    })
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
    let ended = false
    let writes = 0
    on('state.set', { key: 'paneUi' }, (_, e, next) => {
      if (ended) writes += 1
      return next(e)
    })
    const checking = $.tool.check({ tool: SEARCH, input: { terms: ['issues'] }, tool_use_id: 'old-dialog' })
    await arrived
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as Parameters<typeof $.session.end>[0])
    ended = true
    release()
    const verdict = await checking
    await clock.advance(100)
    expect(verdict.decision).toBe('ask')
    expect(writes).toBe(0)
  })
}

test('a stalled arrival write cannot keep the original tool from running, and its late commit does not recreate pending work', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: TOOLS }))
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  const arrived = new Promise<void>(resolve => reached = resolve)
  let first = true
  let executions = 0
  let saved: StoredInspectorCalls | undefined
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    if (first) { first = false; reached(); await held }
    const answer = await next(e)
    if (answer.value?.isSet) saved = e.value as StoredInspectorCalls
    return answer
  })
  on('tool.call', { tool: EXECUTE }, () => { executions += 1; return ran() })
  const running = $.tool.call({ tool: EXECUTE, operation: '{ jira_issue(key: "A-1") { key } }' })
  await untilCache(clock, () => !first)
  await arrived
  await clock.advance(2_500)
  const executionsBeforeStorageRecovered = executions
  release()
  await running
  await untilCache(clock, () => observed.settled('jira_issue'))
  expect(executionsBeforeStorageRecovered).toBe(1)
  expect(executions).toBe(1)
  expect(saved?.queue).toHaveLength(0)
})

test('a stalled settlement write cannot hold back the tool result', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: TOOLS }))
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  const stalled = new Promise<void>(resolve => reached = resolve)
  let first = true
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    const state = e.value as StoredInspectorCalls
    if (first && state.history.some(call => call.status === 'ran')) {
      first = false
      reached()
      await held
    }
    return next(e)
  })
  on('tool.call', { tool: EXECUTE }, ran)
  let returned = false
  const running = $.tool.call({ tool: EXECUTE, operation: '{ jira_issue(key: "A-1") { key } }' }).then(result => { returned = true; return result })
  await untilCache(clock, () => !first)
  await stalled
  await clock.advance(2_500)
  const returnedBeforeStorageRecovered = returned
  release()
  await running
  expect(returnedBeforeStorageRecovered).toBe(true)
})
