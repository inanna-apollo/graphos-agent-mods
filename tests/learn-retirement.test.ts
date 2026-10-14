import { expect, mock, test } from 'claude-code/testing'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const OPERATION = '{ jira_searchIssues { issues { key self } } }'
const SITE = 'https://retired.atlassian.net'
const reply = JSON.stringify({ data: { jira_searchIssues: { issues: [{ key: 'DEV-1', self: `${SITE}/rest/api/3/issue/1` }] } } })

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('a learned-site read resumed after session retirement cannot store or announce the old response', async ($, on) => {
  const clock = mock.clock(on)
  const started = gate()
  const restarted = gate()
  const reachedLearning = gate()
  const releaseLearning = gate()
  const writes: unknown[] = []
  const logs: string[] = []
  let commands = 0
  let holdLearning = false
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    if (++commands === 1) started.release()
    else restarted.release()
    return { value: { command: e.name } }
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/links.toml') && !e.path.includes('/.claude/')) return { value: '[bases]\natlassian = ""\n' }
    throw new Error('ENOENT')
  })
  on('store.get', async (_, e) => {
    if (e.key === 'learnedSites' && holdLearning) {
      holdLearning = false
      reachedLearning.release()
      await releaseLearning.promise
    }
    return { value: undefined }
  })
  on('store.set', (_, e) => {
    if (e.key === 'learnedSites') writes.push(e.value)
    return { value: undefined }
  })
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('tool.list', () => ({ value: ['execute', 'introspect', 'validate', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  // Enrichment has no bearing on verified response metadata; avoid unrelated analysis work.
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('tool.call', { tool: EXECUTE }, () => ({ result: { content: [{ type: 'text', text: reply }], isError: false } }))

  const start = () => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await start()
  await clock.advance(1)
  await started.promise
  holdLearning = true
  await $.tool.call({ tool: EXECUTE, operation: OPERATION })
  await clock.advance(1)
  await reachedLearning.promise
  // The learning read is demonstrably in flight before either lifecycle boundary.
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as Parameters<typeof $.session.end>[0])
  await start()
  releaseLearning.release()
  await clock.advance(1)
  await restarted.promise
  expect(writes).toEqual([])
  expect(logs.filter(line => /record links now open on/.test(line))).toEqual([])
})
