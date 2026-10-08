import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({
  name: `mcp__${SERVER}__${tool}`,
  description: '',
  mcp: true,
}))

const OPERATION = `query SearchQueryPlanPages($cql: String!, $limit: Int) {
  confluence_search(cql: $cql, limit: $limit) {
    results { title excerpt url lastModified content { id type } }
    totalSize
  }
}`
const VARIABLES = JSON.stringify({ cql: 'type=page AND text ~ "query plan"', limit: 10 })

const PANE_PROPS = {
  title: 'GraphOS Inspector',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** An Agent Services server beneath the plugin whose execute waits until released. */
function heldExecute(on: On) {
  let release!: () => void
  let reached!: () => void
  const isReleased = new Promise<void>(resolve => (release = resolve))
  const isReached = new Promise<void>(resolve => (reached = resolve))
  mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.call', { tool: EXECUTE }, async () => {
    reached()
    await isReleased
    return { result: { content: [{ type: 'text', text: '{"data":{}}' }], isError: false } }
  })
  return { release, isReached }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows the pending Agent Services call, then marks it ran (${surface})`, async ($, on) => {
    const gas = heldExecute(on)
    const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
    await gas.isReached

    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: PANE_PROPS })
    expect(await pane.find({ text: /awaiting|approval/ })).toBeUndefined()
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()

    gas.release()
    await running
    expect(await pane.find({ text: /^ran$/ })).toBeDefined()
  })
}

test('a server without the full Agent Services tool set (github: no dry_run) is left alone', async ($, on) => {
  on('tool.list', () => ({ value: [{ name: 'mcp__github__execute', description: '', mcp: true }, { name: 'mcp__github__introspect', description: '', mcp: true }, { name: 'mcp__github__validate', description: '', mcp: true }] }))
  on('tool.call', { tool: 'mcp__github__execute' }, () => ({ result: { content: [], isError: false } }))
  await $.tool.call({ tool: 'mcp__github__execute', operation: '{ a }' })

  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
  expect(await pane.find({ text: /No GraphOS Agent Services call yet/ })).toBeDefined()
})

test('the call reaches the server unchanged', async ($, on) => {
  mock.clock(on)
  on('tool.list', () => ({ value: GAS_TOOLS }))
  let seen: unknown
  on('tool.call', { tool: EXECUTE }, (_, e) => {
    seen = { operation: e.operation, variables: e.variables }
    return { result: { content: [], isError: false } }
  })
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  expect(seen).toEqual({ operation: OPERATION, variables: VARIABLES })
})

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })

// The regression this guards: enrichment started from inside tool.call waits
// behind its own pending next(e) and never lands while the dialog is up.
test('policy from dry_run reaches the pane while the call waits at its prompt', async ($, on) => {
  const clock = mock.clock(on)
  const tools: string[] = []
  on('tool.list', () => ({ value: GAS_TOOLS }))
  // The user's rules allow the read-only Agent Services tools.
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    tools.push(e.tool)
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') {
      return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [{ decision: 'mask', path: 'confluence_search.results.excerpt' }] }] })
    }
    return payload({ bundleDigest: 'd', types: [] })
  })
  let release!: () => void
  const isReleased = new Promise<void>(resolve => (release = resolve))
  on('tool.call', { tool: EXECUTE }, async () => {
    await isReleased
    return { result: { content: [], isError: false } }
  })

  // The pump is a clock started from session.start; the test stands in for the engine beneath.
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const running = $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await clock.advance(1_000)

  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
  expect(await pane.find({ text: /awaiting|approval/ })).toBeUndefined()
  expect(await pane.find({ text: /excerpt/ })).toBeDefined()
  expect(await pane.find({ text: /masked/ })).toBeDefined()
  expect(tools.every(tool => ['search', 'introspect', 'validate', 'dry_run'].includes(tool))).toBe(true)

  release()
  await running
})

for (const decision of ['ask', 'deny'] as const) {
  test(`enrichment makes no calls when tool permission is ${decision}`, async ($, on) => {
    const clock = mock.clock(on)
    const tools: string[] = []
    on('tool.list', () => ({ value: GAS_TOOLS }))
    on('tool.check', () => ({ decision }))
    on('mcp.call', (_, e) => { tools.push(e.tool); return payload({}) })
    on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))
    on('session.start', () => ({ cwd: '/tmp' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
    await clock.advance(1_000)
    expect(tools).toEqual([])
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
    expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
  })
}

// A hot reload may skip session.start (seen in other mods): the first Agent Services
// call must still start the pump.
test('a call enriches even when session.start never fired (as after some reloads)', async ($, on) => {
  const clock = mock.clock(on)
  const tools: string[] = []
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    tools.push(e.tool)
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))

  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await clock.advance(1_000)
  expect(tools).toContain('dry_run')
})

// The mod must never run a GraphQL operation itself: only the four read-only
// Agent Services tools ever reach mcp.call, whatever the enrichment asks for.
test('the mod only ever calls the read-only Agent Services tools', async ($, on) => {
  const clock = mock.clock(on)
  const tools: string[] = []
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    tools.push(e.tool)
    return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [], valid: true, types: [] })
  })
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await clock.advance(2_000)
  expect(tools.length).toBeGreaterThan(0)
  expect(tools.every(tool => ['search', 'introspect', 'validate', 'dry_run'].includes(tool))).toBe(true)
  expect(tools).not.toContain('execute')
})

test('the pane shows an older settled call when the cursor points back', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no pane host in a test' } }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text', text: '{"data":{}}' }], isError: false } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await $.tool.call({ tool: EXECUTE, operation: 'query Second { jira_issue(key: "A-1") { key } }' })

  // `/gas older` writes the cursor the way the view's older button will.
  const run = { command: 'gas', args: 'older', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
  await $.command.run(run)
  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
  expect(await pane.find({ text: /confluence_search/ })).toBeDefined()
  expect(await pane.find({ text: /jira_issue/ })).toBeUndefined()
})

test('r opens the raw pane with the operation, r again closes it; the main pane has no raw drawer', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  const opened:{ id: string; title?: string }[] = []
  const closed: string[] = []
  let isRawUp = false
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, ...(e.title !== undefined && { title: e.title }) })
    if (e.id === 'gas-raw') isRawUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    if (e.id === 'gas-raw') isRawUp = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: isRawUp ? [{ id: 'gas-raw', title: 'raw', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text', text: '{"data":{}}' }], isError: false } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })

  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: PANE_PROPS })
  expect(await pane.find({ type: 'Code' })).toBeUndefined()
  expect(await pane.find({ text: /raw ▸|‹ older/ })).toBeUndefined()
  await pane.press({ key: 'raw' })
  await clock.advance(50)
  expect(opened.some(one => one.id === 'gas-raw' && one.title === 'SearchQueryPlanPages')).toBe(true)

  const raw = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas-raw', props: PANE_PROPS })
  expect(await raw.find({ type: 'Code', text: /confluence_search\(cql/ })).toBeDefined()
  expect(await raw.find({ type: 'Code', text: /query plan/ })).toBeDefined()

  await pane.press({ key: 'raw' })
  await clock.advance(50)
  expect(closed).toContain('gas-raw')
})

// ---- Roots on several services: each scope is checked on its own and merged into the one pane

const GNARLY = `query Gnarly($jql: String!, $size: Int = 3) {
  open: jira_search(jql: $jql, maxResults: $size) { issues { key } }
  members: acme_customer_data_listMembers(orgId: "x") { id email }
}`
const SDL = {
  jira: { root: 'type Query { jira_search(jql: String, maxResults: Int): Jira_Results }', types: ['type Jira_Results { issues: [Jira_Issue] }', 'type Jira_Issue { key: String }'] },
  'acme-customer-data': { root: 'type Query { acme_customer_data_listMembers(orgId: String): [Acme_Member] }', types: ['type Acme_Member { id: ID email: String }'] },
}

test('roots across services get policy per root, every service in the header, and a summary', async ($, on) => {
  const clock = mock.clock(on)
  const scopesChecked = new Set<string>()
  let summaryReady!: () => void
  const isSummaryReady = new Promise<void>(resolve => (summaryReady = resolve))
  on('state.set', { plugin: 'graphos-agent-mods', key: 'calls' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet && [...e.value.queue, ...e.value.history].some(call => call.ir.summary !== undefined)) summaryReady()
    return answer
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('mcp.call', (_, e) => {
    const args = e.args as Record<string, unknown>
    if (e.tool === 'search') {
      const terms = args.terms as string[]
      if (terms.length === 0) return payload({ bundleDigest: 'd', scopes: Object.keys(SDL), results: [] })
      const scope = args.scope as keyof typeof SDL
      return payload({ bundleDigest: 'd', results: [{ operationName: terms[0], operationType: 'query', scope, types: [SDL[scope].root] }] })
    }
    if (e.tool === 'introspect') return payload({ bundleDigest: 'd', types: SDL[args.scope as keyof typeof SDL].types })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    const scope = (args.requests as { scope: string }[])[0]!.scope
    scopesChecked.add(scope)
    const fields = scope === 'jira' ? [['open', 'allow'], ['open.issues', 'allow'], ['open.issues.key', 'allow']] : [['members', 'allow'], ['members.id', 'allow'], ['members.email', 'mask']]
    return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: fields.map(([path, decision]) => ({ path, decision })) }] })
  })
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: '{"headline":"Reads Jira issues and organization members"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: EXECUTE, operation: GNARLY, variables: JSON.stringify({ jql: 'project = A' }) })
  await clock.advance(1_000)
  // WebCrypto and worker replies can finish after the mock clock's advance.
  await isSummaryReady

  expect([...scopesChecked].sort()).toEqual(['acme-customer-data', 'jira'])
  const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'Pane', requestId: 'gas', props: { ...PANE_PROPS, bodyColumns: 80 } })
  // The header names both services, each root shows its alias, the summary landed, policy is known.
  // Each service by the name the flags line uses, not its slug.
  expect(await pane.find({ text: /Jira · Acme customer data/i })).toBeDefined()
  expect(await pane.find({ text: /open: / })).toBeDefined()
  expect(await pane.find({ text: /members: / })).toBeDefined()
  expect(await pane.find({ text: /Reads Jira issues and organization members/ })).toBeDefined()
  expect(await pane.find({ text: /masked/ })).toBeDefined()
  expect(await pane.find({ text: /access not checked|calls span services|needs unknown/ })).toBeUndefined()
})

// ---- Snapshots (src/snapshot): a text file per distinct rendering

const snapshotRun = { command: 'gas', args: 'snapshot', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

// `/gas snapshots on` enables them (kept in the plugin store); the manifest declares no snapshot option.
const snapshotsOn = { command: 'gas', args: 'snapshots on', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

/** A plugin store that remembers, as the real one does between sessions. */
function remembering(on: On) {
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
}

test('after /gas snapshots on, a settling call writes files under snapshots/', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  remembering(on)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no pane host in a test' } }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text', text: '{"data":{}}' }], isError: false } }))
  await $.command.run(snapshotsOn)
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await clock.advance(50)

  expect(writes.length).toBeGreaterThan(0)
  expect(writes.every(write => /\/snapshots\/[^/]+\/\d\d-[a-z-]+-\d+\.txt$/.test(write.path))).toBe(true)
  expect(writes.some(write => /-arrive-50\.txt$/.test(write.path))).toBe(true)
  expect(writes.some(write => /-settled-84\.txt$/.test(write.path))).toBe(true)
  expect(writes[0]?.text).toMatch(/^# stage: arrive \| status: pending/)
  expect(writes.some(write => /confluence_search/.test(write.text))).toBe(true)
})

test('without snapshots on, a settling call writes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no pane host in a test' } }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })
  await clock.advance(50)
  expect(writes).toEqual([])
})

test('/gas snapshot writes the shown call at the default widths, snapshots on or not', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 5) })
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no pane host in a test' } }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [], isError: false } }))
  await $.tool.call({ tool: EXECUTE, operation: OPERATION, variables: VARIABLES })

  const answer = await $.command.run(snapshotRun)
  expect(JSON.stringify(answer)).toMatch(/snapshots\//)
  expect(writes.filter(path => /-manual-(50|64|84)\.txt$/.test(path))).toHaveLength(3)
})

// ---- links.toml: /gas links loads the shipped file and the person's override

test('/gas links reloads the override file under $HOME and counts its rules', async ($, on) => {
  const shipped = '[bases]\natlassian = "https://fixture.example"\n\n[[record]]\nservice = "fixture"\nfield = "id"\nurl = "{atlassian}/records/{value}"\n'
  const reads: string[] = []
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (e.path.endsWith('/.claude/graphos-agent-mods/links.toml')) return { value: '[[record]]\nservice = "x"\nfield = "id"\nurl = "{atlassian}/x/{value}"\n' }
    if (e.path.endsWith('/links.toml')) return { value: shipped }
    throw new Error('ENOENT')
  })
  const answer = await $.command.run({ command: 'gas', args: 'links', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
  expect(reads).toContain('/home/me/.claude/graphos-agent-mods/links.toml')
  expect(JSON.stringify(answer)).toMatch(/\/home\/me\/\.claude\/graphos-agent-mods\/links\.toml \(loaded\)/)
  expect(JSON.stringify(answer)).toContain('2 row rules, 0 search links')
})
