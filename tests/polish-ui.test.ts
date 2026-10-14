import { expect, mock, test } from 'claude-code/testing'
import type { InspectedCall } from '../types'
import type { FieldIR } from '../src/ir.ts'
import { jiraThreeRows } from '../test/fixtures/hardening.ts'
import { polishFixtures } from '../test/fixtures/polish.ts'
import { CLOSED, planFor, viewOf } from '../src/view.tsx'
import type { PaneUi } from '../src/view/kit.ts'
import { renderText, stubKit } from '../src/snapshot/text.ts'
import { detailOf } from '../src/view/details.ts'
import { callStatusOf, headlineOf } from '../src/view/kinds.ts'
import { lookupNoticeOf } from '../src/view/notice.ts'
import { checkPreview } from '../src/view/checks.ts'

function full(name: string): InspectedCall {
  const call = polishFixtures[name]
  if (call === undefined || !('ir' in call)) throw new Error(`Expected full fixture ${name}`)
  return call
}

function shown(node: unknown): string {
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(shown).join(' ')
  const element = node as { props?: { display?: string; label?: string; text?: string }; children?: unknown[] }
  if (element.props?.display === 'none') return ''
  return [element.props?.text, element.props?.label, ...(element.children ?? []).map(one => typeof one === 'string' ? one : shown(one))].filter(one => typeof one === 'string').join(' ')
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Checks opens complete retained context beside its trigger and closes (${surface})`, async ($, on) => {
    const server = 'claude_ai_GraphOS_Agent_Services'
    const execute = `mcp__${server}__execute`
    const clock = mock.clock(on)
    on('tool.list', () => ({ value: ['execute', 'search', 'introspect', 'validate', 'dry_run'].map(tool => ({ name: `mcp__${server}__${tool}`, description: '', mcp: true })) }))
    on('tool.check', (_, e) => ({ decision: e.tool === execute ? 'allow' : 'ask' }))
    on('tool.call', { tool: execute }, () => ({ result: { content: [{ type: 'text', text: JSON.stringify(jiraThreeRows.response) }], isError: false } }))
    on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Darwin\n' : e.argv[0] === 'printenv' ? '/home/me\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('fs.read', () => { throw new Error('ENOENT') })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('session.start', () => ({ cwd: '/tmp' }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    const settle = async () => { for (let step = 0; step < 15; step++) await clock.advance(100) }
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    await $.tool.call({ tool: execute, operation: jiraThreeRows.operation, variables: {} })
    await settle()
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'gas', props: { title: 'GraphOS Inspector', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 16 }, view: {} } })
    expect(await pane.find({ type: 'Button', key: 'checks' })).toBeDefined()
    expect(shown(await pane.drawn()).includes('needed approval')).toBe(false)
    await pane.press({ key: 'checks' })
    await settle()
    const opened = shown(await pane.drawn())
    expect(opened).toMatch(/needed approval/)
    expect(opened.indexOf('Inspection checks')).toBeLessThan(opened.indexOf('RESULT'))
    expect(opened).toMatch(/separate from permission to execute/)
    await pane.press({ key: 'checks' })
    await settle()
    expect(shown(await pane.drawn()).includes('needed approval')).toBe(false)
  })

  test(`pending inspection keeps approval facts inline without buttons (${surface})`, async ($, on) => {
    const call = full('pendingchecks')
    on('ui.render', { component: 'Pane', requestId: 'polish-pending' }, async ($, e) => {
      const { Box, Text, Code, Button } = $.ui.resolve(e)
      return viewOf({ Box, Text, Code, Button }, { call, waiting: 1 }, e.props.bodyColumns, CLOSED, () => undefined, { surface: e.surface, bodyRows: 16 })
    })
    const pane = await $.ui.mount({ plugin: 'graphos-agent-mods', surface, component: 'Pane', requestId: 'polish-pending', props: { title: 'GraphOS Inspector', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 16 }, view: {} } })
    expect(await pane.findAll({ type: 'Button' })).toHaveLength(0)
    const text = shown(await pane.drawn())
    expect(text).toMatch(/access not checked|access check permission unavailable/)
    expect(text).not.toMatch(/all .*allowed|ran without asking/)
  })
}

test('unknown lookup evidence stays unknown in header, headline, and transcript', () => {
  for (const name of ['searchunknown', 'typeunknown', 'validationmissing', 'drymissing']) {
    const call = full(name)
    expect(callStatusOf(call, 0)?.word).toBe('unavailable')
    const text = `${headlineOf(call)} ${lookupNoticeOf(call)}`
    expect(text).not.toMatch(/no such type|no operations matched|will fail|✓ valid|all .*allowed/)
    expect(text).toMatch(/unavailable|unknown|incomplete/)
  }
  expect(lookupNoticeOf(full('searchzero'))).toMatch(/no operations matched/)
  expect(lookupNoticeOf(full('invalid'))).toMatch(/will fail.*Cannot query/)
  expect(callStatusOf(full('drymixed'), 0)?.word).toMatch(/refused/)
})

test('inspection preview explains a permission gap without advice to override an organization ceiling', () => {
  const call = full('checks')
  const preview = checkPreview(call).join(' ')
  expect(preview).toMatch(/service discovery.*needed approval/)
  expect(preview).toMatch(/does not change the original call/)
  const blocked: InspectedCall = { ...call, ir: { ...call.ir, checks: { schema: 'not-allowed', validation: 'skipped', policy: 'skipped', context: [{ check: 'schema', target: { kind: 'call' }, source: 'enrichment', tool: 'search', outcome: 'not-allowed', decision: 'ask', ceiling: 'deny' }] } } }
  expect(detailOf(blocked, 'checks')?.lines.join(' ')).toMatch(/organization.*block/)
  expect(detailOf(blocked, 'checks')?.lines.join(' ')).not.toMatch(/allow .*check|turn.*permission|ceiling.*deny/)
})

test('dedicated details retain row accounting, useful rows, links, and model attribution in short panes', () => {
  const call = full('restored')
  for (const detailId of ['checks', 'trust', 'all']) {
    const ui = { ...CLOSED, detail: { callId: call.id, detailId } }
    const plan = planFor(stubKit(), call, 64, ui, () => undefined, { bodyRows: 16 })
    const text = renderText(viewOf(stubKit(), { call, waiting: 0 }, 64, ui, () => undefined, { bodyRows: 16 }), 64)
    expect(text.split('\n')).toHaveLength(plan.total)
    expect(text).toMatch(/SYN-104|SYN-118|SYN-123/)
    expect(text).toContain('Haiku')
  }
  expect(detailOf(full('trusted'), 'all')?.lines.join(' ')).not.toMatch(/isAllowed|"fits"|"reasons"/)
})

test('settled execute does not turn preflight restrictions into claims about successful values', () => {
  const call = full('restored')
  const restricted = (field: FieldIR): FieldIR => ({ ...field, policy: field.children.length === 0 ? 'deny' : field.policy, children: field.children.map(restricted) })
  const prior = { ...call, ir: { ...call.ir, roots: call.ir.roots.map(restricted) } }
  const settled = renderText(viewOf(stubKit(), { call: prior, waiting: 0 }, 64, CLOSED, () => undefined, { bodyRows: 16 }), 64)
  expect(settled).not.toMatch(/denied|DENIED|masked|▰/)
  expect(settled).toMatch(/SYN-104/)
  const pending = renderText(viewOf(stubKit(), { call: { ...prior, status: 'pending' }, waiting: 1 }, 64, CLOSED, () => undefined, { bodyRows: 16 }), 64)
  expect(pending).toMatch(/DENIED|denied/)
  expect(detailOf(prior, 'all')?.lines.join(' ')).toMatch(/dry_run: denial reported/)
})

test('overview retention preserves known model attribution without guessing the source of legacy prose', () => {
  for (const name of ['expired', 'oversize']) {
    const call = polishFixtures[name]!
    const text = renderText(viewOf(stubKit(), { call, waiting: 0 }, 64), 64)
    expect(text).toMatch(/Haiku summary/)
    expect(text).not.toMatch(/\((expired|oversize|available)\)/)
    if ('overview' in call) {
      const { headlineSource: _source, ...overview } = call.overview
      const legacy = renderText(viewOf(stubKit(), { call: { ...call, overview }, waiting: 0 }, 64), 64)
      expect(legacy).not.toMatch(/Haiku|AI summary/)
    }
  }
})
