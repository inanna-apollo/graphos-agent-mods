import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { InspectedCall, StoredInspectorCalls } from '../types'
import { CALL_ENTRY_BYTES } from '../src/call-cache.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const TOOLS = ['execute', 'search', 'introspect', 'validate', 'dry_run'] as const
const toolId = <T extends typeof TOOLS[number]>(tool: T) => `mcp__${SERVER}__${tool}` as const
const OPERATION = 'query Issues { jira_searchIssues(jql: "project = SYN", maxResults: 2) { issues { key self fields } } }'
const RESPONSE = JSON.stringify({ data: { jira_searchIssues: { issues: [
  { key: 'SYN-1', self: 'https://synthetic.atlassian.net/rest/api/3/issue/1', fields: { summary: 'Keep observer work separate' } },
  { key: 'SYN-2', self: 'https://synthetic.atlassian.net/rest/api/3/issue/2', fields: { summary: 'Preserve terminal results' } },
] } } })
const LINKS = '[bases]\natlassian = ""\nslack = ""\n\n[[record]]\nservice = "jira"\nfield = "key"\nmatch = "^[A-Z][A-Z0-9_]+-\\\\d+$"\nurl = "{atlassian}/browse/{value}"\n'
const PROPS = { title: 'GraphOS Inspector', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const inputFor = (tool: typeof TOOLS[number]) => tool === 'search' ? { terms: ['synthetic issues'] }
  : tool === 'introspect' ? { type: 'SyntheticIssue', depth: 1 }
  : { operation: OPERATION, variables: '{"marker":"original input"}' }
const answer = (text = RESPONSE) => ({ result: { content: [{ type: 'text' as const, text }], isError: false } })

function gate() {
  let release!: () => void
  let reach!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  const arrived = new Promise<void>(resolve => reach = resolve)
  return { hit: false, arrived, release, async wait() { this.hit = true; reach(); await held } }
}

/** Advance host work until the actual boundary is observed, never infer arrival from elapsed time. */
async function until(clock: MockClock, condition: () => boolean | Promise<boolean>) {
  for (let step = 0; step < 100; step++) {
    if (await condition()) return
    await clock.advance(10)
  }
  expect(await condition()).toBe(true)
}

function world(on: On, options: { discovery?: ReturnType<typeof gate>; step?: 'links' | 'saved response' | 'learned store'; observer?: ReturnType<typeof gate>; saved?: string } = {}) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  on('tool.list', async () => {
    if (options.discovery !== undefined) await options.discovery.wait()
    return { value: TOOLS.map(tool => ({ name: toolId(tool), description: '', mcp: true })) }
  })
  // No inspection request reaches a real MCP server or a model.
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('mcp.call', () => { throw new Error('Unexpected enrichment request') })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds synthetic issues"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/synthetic\n' : e.argv[0] === 'uname' ? 'Darwin\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', async (_, e) => {
    if (e.path === options.saved) { await options.observer?.wait(); return { value: RESPONSE } }
    if (e.path.endsWith('/links.toml') && !e.path.includes('/.claude/')) return { value: LINKS }
    throw new Error('ENOENT')
  })
  on('store.get', async (_, e) => {
    if (options.step === 'links' && e.key === 'learnedSites') await options.observer?.wait()
    return { value: stored.get(e.key) }
  })
  on('store.set', async (_, e) => {
    if (options.step === 'learned store' && e.key === 'learnedSites') await options.observer?.wait()
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'fixture' } }))
  on('ui.log', () => ({ value: undefined }))
  return { clock, stored }
}

for (const tool of TOOLS) {
  for (const outcome of ['result', 'exception'] as const) {
    test(`${tool} forwards its original input and ${outcome} while observer arrival storage is held`, async ($, on) => {
      const { clock } = world(on)
      const storage = gate()
      const order: string[] = []
      let intercept = true
      on('state.set', { key: 'calls' }, async (_, e, next) => {
        if (intercept) { intercept = false; order.push('observer storage'); await storage.wait() }
        return next(e)
      })
      const original = inputFor(tool)
      const failure = new Error(`original ${tool} failure`)
      const expected = answer()
      let executions = 0
      let forwarded: unknown
      on('tool.call', { tool: new RegExp(`^${toolId(tool)}$`) }, (_, e) => {
        executions += 1
        order.push('original tool')
        forwarded = Object.fromEntries(Object.keys(original).map(key => [key, (e as Record<string, unknown>)[key]]))
        if (outcome === 'exception') throw failure
        return expected
      })
      let returned = false
      let received: unknown
      let rejected: unknown
      const running = $.tool.call({ tool: toolId(tool), ...original }).then(value => { returned = true; received = value }, error => { returned = true; rejected = error })
      await until(clock, () => storage.hit)
      await storage.arrived
      // Proves setup ran and the engine received its answer before storage recovers.
      expect(executions).toBe(1)
      expect(order).toEqual(['original tool', 'observer storage'])
      expect(forwarded).toEqual(original)
      expect(returned).toBe(true)
      if (outcome === 'result') expect(received).toEqual(expected)
      else {
        // The harness skips a throwing mock implementation, so next rejects with
        // the engine's missing-implementation error. Inspector must relay that error.
        expect((rejected as Error).name).toBe('HooksError')
        expect((rejected as Error).message).toBe('no implementation for tool.call')
      }
      storage.release()
      await running
      expect(executions).toBe(1)
    })
  }

  test(`${tool} runs and returns while observer discovery is held`, async ($, on) => {
    const discovery = gate()
    const { clock } = world(on, { discovery })
    let executions = 0
    on('tool.call', { tool: new RegExp(`^${toolId(tool)}$`) }, () => { executions += 1; return answer() })
    let returned = false
    const running = $.tool.call({ tool: toolId(tool), ...inputFor(tool) }).then(value => { returned = true; return value })
    await until(clock, () => discovery.hit)
    await discovery.arrived
    expect(executions).toBe(1)
    expect(returned).toBe(true)
    discovery.release()
    expect(await running).toEqual(answer())
    expect(executions).toBe(1)
  })
}

for (const step of ['links', 'saved response', 'learned store'] as const) {
  test(`execute returns its exact response while observer ${step} is held`, async ($, on) => {
    const observer = gate()
    const saved = '/home/synthetic/.claude/projects/p/s/tool-results/saved.txt'
    const { clock } = world(on, { step, observer, ...(step === 'saved response' && { saved }) })
    const standIn = `<persisted-output>\nOutput too large (58.2KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n{"data":`
    const expected = answer(step === 'saved response' ? standIn : RESPONSE)
    let executions = 0
    on('tool.call', { tool: toolId('execute') }, () => { executions += 1; return expected })
    let received: unknown
    const running = $.tool.call({ tool: toolId('execute'), operation: OPERATION }).then(value => received = value)
    await until(clock, () => observer.hit)
    await observer.arrived
    expect(executions).toBe(1)
    expect(received).toEqual(expected)
    observer.release()
    await running
    expect(executions).toBe(1)
  })
}

test('a terminal result preceding its held arrival recovers linked, foldable Jira rows in the already mounted pane', async ($, on) => {
  const { clock } = world(on)
  const storage = gate()
  let intercept = true
  let saved: StoredInspectorCalls | undefined
  const writes: StoredInspectorCalls[] = []
  on('state.set', { key: 'calls' }, async (_, e, next) => {
    if (intercept) { intercept = false; await storage.wait() }
    const result = await next(e)
    if (result.value?.isSet) { saved = e.value as StoredInspectorCalls; writes.push(saved) }
    return result
  })
  let executions = 0
  let skippedExecutions = 0
  let id = ''
  const full = JSON.parse(RESPONSE) as { data: { jira_searchIssues: { issues: { key: string; self: string; fields: { summary: string } }[] } } }
  full.data.jira_searchIssues.issues.push(...Array.from({ length: 6 }, (_, index) => ({ key: `SYN-${index + 3}`, self: `https://synthetic.atlassian.net/rest/api/3/issue/${index + 3}`, fields: { summary: `Retained result ${index + 3}` } })))
  on('tool.call', { tool: toolId('execute') }, (_, e) => { executions += 1; id = e.tool_use_id; return answer(JSON.stringify(full)) })
  on('tool.call', { tool: toolId('search') }, () => { skippedExecutions += 1; return answer('{"results":[]}') })
  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  let returned = false
  const running = $.tool.call({ tool: toolId('execute'), operation: OPERATION.replace('maxResults: 2', 'maxResults: 8') }).then(value => { returned = true; return value })
  await until(clock, () => storage.hit)
  await storage.arrived
  expect(executions).toBe(1)
  expect(returned).toBe(true)
  expect(id).not.toBe('')
  await clock.advance(1_500)
  expect(await pane.find({ text: /observation paused/ })).toBeDefined()
  expect(await $.tool.call({ tool: toolId('search'), terms: ['while storage is held'] })).toEqual(answer('{"results":[]}'))
  expect(skippedExecutions).toBe(1)
  expect(await pane.find({ text: /1 calls could not be inspected/ })).toBeDefined()
  storage.release()
  await running
  await until(clock, async () => (await pane.find({ type: 'Markdown', text: /synthetic\.atlassian\.net\/browse\/SYN-1/ })) !== undefined)
  expect(saved?.queue).toHaveLength(0)
  expect(saved?.history.find(call => call.id === id)?.status).toBe('ran')
  expect(await pane.find({ text: /Keep observer work separate/ })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: /synthetic\.atlassian\.net\/browse\/SYN-2/ })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: /synthetic\.atlassian\.net\/browse\/SYN-8/ })).toBeUndefined()
  const more = await pane.find({ type: 'Button', text: /3 more/ })
  expect(more?.key).toBeDefined()
  await pane.press({ key: more!.key! })
  expect(await pane.find({ type: 'Markdown', text: /synthetic\.atlassian\.net\/browse\/SYN-8/ })).toBeDefined()
  const fewer = await pane.find({ type: 'Button', text: /show fewer/i })
  expect(fewer?.key).toBeDefined()
  await pane.press({ key: fewer!.key! })
  expect(await pane.find({ type: 'Markdown', text: /synthetic\.atlassian\.net\/browse\/SYN-8/ })).toBeUndefined()
  // The late arrival is reconciled at commit, so settled work never reappears as pending.
  expect(writes.some(state => state.queue.some(call => call.id === id))).toBe(false)
  expect(executions).toBe(1)
  expect(skippedExecutions).toBe(1)
})

test('an oversized successful response is forwarded once and records only an Inspector retention diagnostic', async ($, on) => {
  const { clock } = world(on)
  const expected = answer(JSON.stringify({ data: { jira_searchIssues: { issues: [{ key: 'SYN-1', fields: { summary: 'x'.repeat(CALL_ENTRY_BYTES) } }] } } }))
  let executions = 0
  let id = ''
  let retained: InspectedCall | undefined
  on('tool.call', { tool: toolId('execute') }, (_, e) => {
    executions += 1
    id = e.tool_use_id
    return expected
  })
  on('state.set', { key: 'callDetails' }, async (_, e, next) => {
    const result = await next(e)
    if (result.value?.isSet && e.value?.id === id && e.value.json !== null) retained = JSON.parse(e.value.json) as InspectedCall
    return result
  })

  expect(await $.tool.call({ tool: toolId('execute'), operation: OPERATION })).toEqual(expected)
  expect(executions).toBe(1)
  expect(id).not.toBe('')
  await until(clock, () => retained?.status === 'ran' && /preview.*not retained/i.test(retained.ir.checks?.error ?? ''))
  expect(retained).toBeDefined()
  expect(retained!.id).toBe(id)
  expect(retained!.status).toBe('ran')
  expect(retained!.outcome).toBeUndefined()
  expect(retained!.ir.checks?.error).toMatch(/preview.*not retained.*retention limit/i)

  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PROPS })
  expect(await pane.find({ type: 'Button', key: 'checks' })).toBeDefined()
  await pane.press({ key: 'checks' })
  expect(await pane.find({ text: /preview.*not retained.*retention limit/i })).toBeDefined()
  expect(executions).toBe(1)
})
