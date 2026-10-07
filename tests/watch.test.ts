// The person's two config files, watched through the engine: both are named to
// its file watcher by absolute path, a saved links.toml is read again at once,
// and a saved trust.graphql is only reported: the rules in memory stand until
// the person runs /gas trust, so a rule written into the file mid-session
// (by an agent, say) cannot take effect on its own. Behaviour only.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true }))
const LINKS_FILE = '/home/me/.claude/graphos-agent-mods/links.toml'
const TRUST_FILE = '/home/me/.claude/graphos-agent-mods/trust.graphql'

const NARROW = 'query DocsLookup { confluence_search(cql: "type = page*", limit: 25) { results { title } } }'
// What an agent might write mid-session: the widest read of the same root.
const WIDE = 'query Everything { confluence_search }'
const OUTSIDE = { operation: 'query Q { confluence_search(cql: "space = HR", limit: 5) { results { title body } } }', variables: {} }

const USER_LINKS = `[bases]
wiki = "https://wiki.example.com"

[[record]]
service = "jira"
field = "key"
url = "{wiki}/browse/{value}"

[[record]]
service = "*"
field = "id"
url = "{wiki}/id/{value}"

[[record]]
service = "broken"
`

const payload = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Files = { links?: string; trust?: string }

/** Agent Services beneath the plugin, $HOME at /home/me, the two files as `files` stands (changed by the test as a person's editor would), and every log line, status line and file read recorded. */
function world(on: On, files: Files) {
  const seen = { logs: [] as string[], statuses: [] as (string | undefined)[], reads: [] as string[] }
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: GAS_TOOLS }))
  on('tool.check', (_, e) => ({ decision: e.tool === EXECUTE ? ('ask' as const) : ('allow' as const) }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'search') return payload({ bundleDigest: 'd', scopes: ['confluence'], results: [] })
    if (e.tool === 'validate') return payload({ bundleDigest: 'd', valid: true })
    if (e.tool === 'dry_run') return payload({ bundleDigest: 'd', results: [{ denyOperation: false, fields: [] }] })
    return payload({ bundleDigest: 'd', types: [] })
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"headline":"Finds pages"}', usage: USAGE } }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    seen.reads.push(e.path)
    const text = e.path === LINKS_FILE ? files.links : e.path === TRUST_FILE ? files.trust : undefined
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return seen
}

const pause = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

async function settle(clock: MockClock) {
  for (let step = 0; step < 10; step++) {
    await clock.advance(100)
    await pause(5)
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) => $.command.run({ command: 'gas', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })
const saved = ($: Engine, file_path: string, event: 'change' | 'add' | 'unlink' = 'change') => $.classic.FileChanged({ file_path, event })

/**
 * A call as the model makes one, held in its tool: the permission verdict for
 * it is asked as the engine asks before its dialog, the call being recorded
 * first. The engine's tool beneath is registered before the test first calls $.
 */
function caller(on: On) {
  let id: string | undefined
  let release = () => {}
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await new Promise<void>(resolve => (release = resolve))
    return { result: { content: [{ type: 'text' as const, text: '{"data":{}}' }], isError: false } }
  })
  return async ($: Engine, clock: MockClock, input: { operation: string; variables: Record<string, unknown> }) => {
    id = undefined
    const running = $.tool.call({ tool: EXECUTE, ...input })
    for (let passed = 0; passed < 2_000 && id === undefined; passed += 100) {
      await clock.advance(100)
      if (id === undefined) await pause(5)
    }
    const verdict = await $.tool.check({ tool: EXECUTE, input, tool_use_id: id })
    release()
    await running
    return verdict
  }
}

test('both config files are named to the engine’s watcher, by absolute path', async ($, on) => {
  mock.clock(on)
  world(on, {})
  const result = await $.classic.SessionStart({ source: 'startup' })
  expect(result.watchPaths).toContain(LINKS_FILE)
  expect(result.watchPaths).toContain(TRUST_FILE)
})

test('a saved links.toml is read again at once, and the person is told how many row rules and what was skipped', async ($, on) => {
  const clock = mock.clock(on)
  const files: Files = {}
  const seen = world(on, files)
  await start($)
  const before = Number(/(\d+) row rules/.exec(JSON.stringify(await command($, 'links')))?.[1])
  expect(before).toBeGreaterThan(0)

  files.links = USER_LINKS
  await saved($, LINKS_FILE)
  await settle(clock)
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toMatch(new RegExp(`links\\.toml reloaded: ${before + 2} row rules, 1 skipped`))
  // A save can widen where a click opens: the new host is named.
  expect(seen.logs[0]).toContain('wiki.example.com')
  // And it took: the command reads the same mappings.
  expect(JSON.stringify(await command($, 'links'))).toContain(`${before + 2} row rules`)
})

test('a removed links.toml leaves the shipped mappings, and says so', async ($, on) => {
  const clock = mock.clock(on)
  const files: Files = { links: USER_LINKS }
  const seen = world(on, files)
  await start($)
  files.links = undefined
  await saved($, LINKS_FILE, 'unlink')
  await settle(clock)
  expect(seen.logs.join('\n')).toMatch(/links\.toml removed/)
})

test('an editor’s atomic save, an unlink and an add together, reloads once and says so once', async ($, on) => {
  const clock = mock.clock(on)
  const files: Files = { links: USER_LINKS }
  const seen = world(on, files)
  await start($)
  await saved($, LINKS_FILE, 'unlink')
  await saved($, LINKS_FILE, 'add')
  await settle(clock)
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toMatch(/links\.toml reloaded/)
})

test('a saved trust.graphql is only reported: it is not read, a rule written into it takes no effect, and /gas trust is what applies it', async ($, on) => {
  const clock = mock.clock(on)
  const files: Files = { trust: NARROW }
  const seen = world(on, files)
  const verdictOf = caller(on)
  await start($)
  await settle(clock)
  expect((await verdictOf($, clock, OUTSIDE)).decision).toBe('ask')

  // An agent widens the file mid-session, and the engine's watcher says it was saved.
  files.trust = WIDE
  const readsBefore = seen.reads.filter(path => path === TRUST_FILE).length
  await saved($, TRUST_FILE)
  await settle(clock)
  expect(seen.reads.filter(path => path === TRUST_FILE)).toHaveLength(readsBefore)
  expect(seen.logs.join('\n')).toMatch(/trust\.graphql changed/)
  expect(seen.logs.join('\n')).toMatch(/\/gas trust/)
  expect(seen.statuses.filter(line => line !== undefined).at(-1)).toMatch(/run \/gas trust to reload/)
  // Still asking: the widened rule is not loaded.
  expect((await verdictOf($, clock, OUTSIDE)).decision).toBe('ask')

  // The person applies it, and only then does it count.
  await command($, 'trust')
  await settle(clock)
  expect((await verdictOf($, clock, OUTSIDE)).decision).toBe('allow')
  expect(seen.statuses.filter(line => line !== undefined).at(-1)).not.toMatch(/run \/gas trust to reload/)
})

test('a module reloaded mid-session, which never read the rules, does not read the trust file on a save either', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { trust: WIDE })
  // No session.start: a hot reload can skip it, and nothing has asked for the rules yet.
  await saved($, TRUST_FILE)
  await settle(clock)
  expect(seen.reads.filter(path => path === TRUST_FILE)).toHaveLength(0)
  expect(seen.logs.join('\n')).toMatch(/trust\.graphql changed/)
  expect(seen.statuses.filter(line => line !== undefined).at(-1)).toMatch(/run \/gas trust to reload/)
})

test('saving the trust file twice before applying it says so once in the transcript', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { trust: NARROW })
  await start($)
  await saved($, TRUST_FILE)
  await saved($, TRUST_FILE)
  await settle(clock)
  expect(seen.logs.filter(line => /trust\.graphql changed/.test(line))).toHaveLength(1)
})

test('a change to any other file is none of its business', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { trust: NARROW })
  await start($)
  await saved($, '/home/me/project/.envrc')
  await saved($, '/home/me/.claude/graphos-agent-mods/notes.txt')
  await settle(clock)
  expect(seen.logs).toEqual([])
  expect(seen.statuses.filter(line => /changed/.test(line ?? ''))).toEqual([])
})
