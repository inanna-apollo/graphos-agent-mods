import { expect, mock, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { InspectedCall } from '../types'
import { untilCache } from './cache-observer.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const impatient: Plugin = {
  name: 'impatient-late-result', tier: 'prepend',
  register(on) {
    on('tool.call', { tool: /__execute$/ }, async ($, e, next) => {
      void next(e).catch(() => undefined)
      await $.clock.sleep(1_000)
      return { result: { content: [{ type: 'text', text: 'answered above' }], isError: true } }
    })
  },
}

// The prepend hook cuts its wait, while the underlying tool can still return.
test('a real result arriving after an aborted wait replaces the provisional interrupted record', { plugins: [impatient] }, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.check', () => ({ decision: 'deny' as const }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text', props: {}, children: ['engine result'] }))
  on('model.complete', () => { throw new Error('No headline needed') })
  let id = ''
  let release!: () => void
  const held = new Promise<void>(resolve => release = resolve)
  on('tool.call', { tool: EXECUTE }, async (_, e) => {
    id = e.tool_use_id
    await held
    return { result: { content: [{ type: 'text' as const, text: '{"data":{"jira_searchIssues":{"issues":[{"key":"LATE-42","fields":{"summary":"Late result"}}]}}}' }], isError: false } }
  })
  let latest: InspectedCall | undefined
  on('state.set', { plugin: 'graphos-agent-mods', key: 'callDetails' }, async (_, e, next) => {
    const answer = await next(e)
    if (answer.value?.isSet && e.value?.id === id && e.value?.json != null) latest = JSON.parse(e.value.json) as InspectedCall
    return answer
  })
  const running = $.tool.call({ tool: EXECUTE, operation: 'query LateResult { jira_searchIssues(jql: "project = LATE") { issues { key fields } } }' })
  await untilCache(clock, () => id !== '')
  await untilCache(clock, () => latest?.status === 'interrupted')
  await running
  expect(latest?.status).toBe('interrupted')
  release()
  await untilCache(clock, () => latest?.status === 'ran' && latest.outcome !== undefined)
  expect(latest?.outcome?.preview?.[0]?.items[0]?.label).toBe('LATE-42')
  const row = await $.ui.mount({ plugin: 'graphos-agent-mods', surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool: EXECUTE, tool_use_id: id, output: {}, isErrored: false } })
  expect(await row.find({ text: /LATE-42/ })).toBeDefined()
})
