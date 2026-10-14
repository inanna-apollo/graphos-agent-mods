import { expect, mock, test } from 'claude-code/testing'
import { buildIR } from '../src/build.ts'
import { normalize } from '../src/normalize.ts'
import { outcomeOf } from '../src/result.ts'
import { EMPTY_DETAILS, overviewOf } from '../src/call-cache.ts'
import { dryRunCall, introspectCall, searchCall, validCall } from './lookup-fixtures.ts'
import { observeCache, untilCache } from './cache-observer.ts'
import type { CallDetailIndex, CallDetailSlot, InspectedCall, StoredInspectorCalls } from '../types'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const TOOLS = ['execute', 'search', 'introspect', 'validate', 'dry_run'] as const
const PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 50 }, view: {} }
const command = (args: string) => ({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
const operation = (index: number) => `query History${index}($key: String!) { jira_searchIssues(jql: $key, maxResults: 3) { issues { key fields } } }`
const response = (index: number) => ({ data: { jira_searchIssues: { issues: [
  { key: `HIST-${index + 1}`, fields: { summary: `Retained issue from call ${index}` } },
  { key: `HIST-${index + 101}`, fields: { summary: `Second issue from call ${index}` } },
] } } })

function previousModel(index: number): InspectedCall {
  const id = `previous-${index}`
  const tool = index % TOOLS.length
  if (tool > 0) {
    const call = [searchCall, introspectCall, validCall, dryRunCall][tool - 1]!()
    return { ...call, id, owner: 'retired-module', arrivedAt: index, ir: { ...call.ir, toolCallId: id } }
  }
  const query = operation(index)
  const variables = { key: `project = HIST AND issue = HIST-${index + 1}` }
  const ir = buildIR(id, normalize(query, variables))
  return { id, server: SERVER, operation: query, variables: JSON.stringify(variables), owner: 'retired-module', arrivedAt: index, status: 'ran', ir, outcome: outcomeOf(ir, JSON.stringify(response(index))) }
}

test('one hundred sequential mixed tool calls keep their full models past both former history limits', { timeoutMs: 15_000 }, async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: TOOLS.map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'fixture' } }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Reads retained history"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  let executions = 0
  let latestId = ''
  on('tool.call', { tool: /^mcp__claude_ai_GraphOS_Agent_Services__(?:execute|search|introspect|validate|dry_run)$/ }, (_, e) => {
    latestId = e.tool_use_id
    const index = executions++
    const tool = e.tool.split('__').at(-1)
    const reply = tool === 'execute' ? response(index)
      : tool === 'search' ? { results: [], scopes: ['jira'] }
      : tool === 'introspect' ? { types: ['type HistoryIssue { key: String! summary: String }'] }
      : tool === 'validate' ? { valid: true }
      : { results: [{ denyOperation: false, fields: [] }] }
    return { result: { content: [{ type: 'text' as const, text: JSON.stringify(reply) }], isError: false } }
  })
  const ids: string[] = []
  for (let index = 0; index < 100; index++) {
    const tool = TOOLS[index % TOOLS.length]!
    if (tool === 'execute') await $.tool.call({ tool: EXECUTE, operation: operation(index), variables: JSON.stringify({ key: `HIST-${index + 1}` }) })
    else if (tool === 'search') await $.tool.call({ tool: `mcp__${SERVER}__search`, terms: [`history issue ${index}`], scope: 'jira' })
    else if (tool === 'introspect') await $.tool.call({ tool: `mcp__${SERVER}__introspect`, type: 'HistoryIssue', scope: 'jira', depth: 1 })
    else if (tool === 'validate') await $.tool.call({ tool: `mcp__${SERVER}__validate`, operation: operation(index), scope: 'jira' })
    else await $.tool.call({ tool: `mcp__${SERVER}__dry_run`, requests: [{ operation: operation(index), scope: 'jira' }] })
    const id = latestId
    ids.push(id)
    await untilCache(clock, () => observed.models.some(call => call.id === id && call.status === 'ran' && (call.tool === undefined ? call.outcome !== undefined : call.found !== undefined)))
  }
  expect(executions).toBe(100)
  expect(observed.calls?.history).toHaveLength(100)
  expect(observed.calls?.queue).toHaveLength(0)
  const models = new Map(observed.models.map(call => [call.id, call]))
  expect(models.size).toBe(100)
  for (const [index, id] of ids.entries()) {
    const call = models.get(id)
    expect(call?.status).toBe('ran')
    if (index % TOOLS.length === 0) expect(call?.outcome?.preview?.[0]?.items[0]?.text).toContain(`Retained issue from call ${index}`)
    else expect(call?.found).toBeDefined()
  }
})

test('a fresh module reload preserves one hundred mixed prior details through a new call and older navigation', async ($, on) => {
  const clock = mock.clock(on)
  const models = Array.from({ length: 100 }, (_, index) => previousModel(index))
  const history = [...models].reverse().map(call => overviewOf(call))
  const calls: StoredInspectorCalls = { version: 2, queue: [], last: history[0]!, history }
  const slots = new Map<string, CallDetailSlot>(models.map((call, slot) => [String(slot), { epoch: 'retained-history-session', writer: '', id: call.id, json: JSON.stringify(call) }]))
  const index: CallDetailIndex = { ...EMPTY_DETAILS, epoch: 'retained-history-session', entries: models.map((call, slot) => ({ id: call.id, slot, bytes: new TextEncoder().encode(slots.get(String(slot))!.json!).length })) }
  const seed: Record<string, unknown> = { calls, callDetailIndex: index, paneUi: { field: null, arg: null, selection: { kind: 'call', id: models[0]!.id } } }
  on('state.get', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    const value = e.key === 'callDetails' ? slots.get(e.id) : seed[e.key]
    return result.value?.value === undefined && value !== undefined ? { value: { value, version: 0 } } as typeof result : result
  })
  let savedCalls = calls
  let savedIndex = index
  on('state.set', { plugin: 'graphos-agent-mods' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) {
      if (e.key === 'calls') savedCalls = e.value
      if (e.key === 'callDetailIndex') savedIndex = e.value
      if (e.key === 'callDetails') {
        if (e.value?.json == null) slots.delete(e.id)
        else slots.set(e.id, e.value)
      }
    }
    return result
  })
  on('tool.list', () => ({ value: TOOLS.map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'fixture' } }))
  let executions = 0
  on('tool.call', { tool: EXECUTE }, () => { executions += 1; return { result: { content: [{ type: 'text' as const, text: JSON.stringify(response(100)) }], isError: false } } })
  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PROPS })
  expect(await pane.find({ text: /Retained issue from call 0/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /query History0/ })).toBeDefined()
  await $.tool.call({ tool: EXECUTE, operation: operation(100), variables: '{"key":"HIST-101"}' })
  await untilCache(clock, () => savedCalls.history.length === 101 && savedIndex.entries.length === 101 && [...slots.values()].some(slot => slot.json?.includes('Retained issue from call 100')))
  expect(executions).toBe(1)
  expect(savedCalls.queue).toHaveLength(0)
  expect(savedIndex.entries).toHaveLength(101)
  const restored = new Map([...slots.values()].flatMap(slot => slot.json === null ? [] : [[slot.id, JSON.parse(slot.json) as InspectedCall] as const]))
  for (const previous of models) expect(restored.get(previous.id)).toEqual(previous)
  expect(await pane.find({ text: /Retained issue from call 0/ })).toBeDefined()
  await $.command.run(command('newer'))
  expect(await raw.find({ type: 'Code', text: /confluence/ })).toBeDefined()
  expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
})
