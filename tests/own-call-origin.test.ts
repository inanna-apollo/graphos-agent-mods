import { expect, mock, test } from 'claude-code/testing'

import { observeCache, untilCache } from './cache-observer.ts'

const SERVER = 'claude_ai_GraphOS_Agent_Services'
const EXECUTE = `mcp__${SERVER}__execute`
const SEARCH = `mcp__${SERVER}__search`
const OPERATION = 'query Issues { jira_searchIssues(jql: "project = SYN") { issues { key } } }'
const answer = (value: unknown) => ({ result: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })

test('an engine search identical to an in-flight Inspector read is still inspected', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  on('tool.list', () => ({ value: ['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })) }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: EXECUTE }, () => answer({ data: { jira_searchIssues: { issues: [] } } }))

  let releaseRead!: () => void
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve })
  let readStarted = false
  let inspectorReads = 0
  on('mcp.call', async (_, e) => {
    if (e.tool === 'search' && JSON.stringify(e.args) === '{"terms":[]}') {
      inspectorReads += 1
      readStarted = true
      await readHeld
    }
    return { value: { content: [{ type: 'text' as const, text: JSON.stringify({ bundleDigest: 'd', scopes: ['jira'], results: [] }) }], isError: false } }
  })

  let modelSearchId = ''
  let modelOrigin = ''
  let modelSearches = 0
  on('tool.call', { tool: SEARCH }, (_, e, next) => {
    modelSearchId = e.tool_use_id
    modelOrigin = next.origin.plugin
    modelSearches += 1
    return answer({ bundleDigest: 'd', scopes: ['jira'], results: [] })
  })

  expect(await $.tool.call({ tool: EXECUTE, operation: OPERATION })).toEqual(answer({ data: { jira_searchIssues: { issues: [] } } }))
  await untilCache(clock, () => readStarted)
  const modelAnswer = await $.tool.call({ tool: SEARCH, terms: [] })
  expect(modelAnswer).toEqual(answer({ bundleDigest: 'd', scopes: ['jira'], results: [] }))
  expect(modelOrigin).toBe('engine')
  expect(modelSearches).toBe(1)
  expect(inspectorReads).toBe(1)

  await untilCache(clock, () => observed.calls?.history.some(call => call.id === modelSearchId && call.status === 'ran') === true)
  const observedSearchIds = [...(observed.calls?.queue ?? []), ...(observed.calls?.history ?? [])]
    .filter(call => call.tool === 'search').map(call => call.id)
  releaseRead()
  expect(observedSearchIds).toEqual([modelSearchId])
  expect(observed.models.some(call => call.id === modelSearchId && call.tool === 'search' && call.status === 'ran')).toBe(true)
})
