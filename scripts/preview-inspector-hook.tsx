// Developer-only host preview hook. preview-inspector.mjs copies this file to
// the temporary plugin's hooks/register.tsx beside the production src tree.
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import type { InspectedCall, ResolvedCall, ResolvedInspectorCalls } from '../types/index.d.ts'
import { annotate } from '../src/annotate.ts'
import { buildIR } from '../src/build.ts'
import type { FieldDecision } from '../src/gas.ts'
import { outcomeOf } from '../src/result.ts'
import { indexSdl } from '../src/schema.ts'
import { normalize } from '../src/normalize.ts'
import { configOf } from '../src/links.ts'
import { CLOSED, RawView, viewOf } from '../src/view.tsx'
import type { Act, Kit, PaneChange, PaneUi } from '../src/view/kit.ts'
import type { ResolvedNav } from '../src/queue.ts'
import { navResolvedOf, selectionNewer, selectionOlder } from '../src/queue.ts'
import { polishFixtures } from '../test/fixtures/polish.ts'
import {
  enumFour,
  enumSixtyOne,
  jiraThreeRows,
  largeInputOver9000Chars,
  longRootDescription,
  objectFortyOneFields,
  partialResultsMaskedDenied,
  proposedWriteSyntheticOnly,
  searchFiveOperations,
  unicodeAndTerminalStrings,
} from '../test/fixtures/hardening.ts'

const PANE = 'gas-preview'
const RAW_PANE = 'gas-preview-raw'
const SERVER = 'claude_ai_GraphOS_Agent_Services'
const LINKS = configOf({ user: '[bases]\natlassian = "https://example.atlassian.net"\n' })
const EXEC_SDL = [
  `type Query {
    jira_searchIssues(jql: String!, maxResults: Int, fields: [String!]): Jira_SearchPage
    jira_countIssues(jql: String!): Jira_Count
  }`,
  'type Jira_SearchPage { issues: [Jira_Issue!]! isLast: Boolean total: Int }',
  'type Jira_Issue { key: String! fields: JSON summary: String maskedNote: String deniedNote: String }',
  'type Jira_Count { count: Int! }',
  'scalar JSON',
  `type Mutation { jira_createIssue(fields: JSON!): Jira_Issue }`,
]
const SCHEMA = indexSdl(EXEC_SDL)

type RawExecute = { operation: string; variables: Record<string, unknown> }

function executeCall(id: string, raw: RawExecute, response: unknown, status: 'pending' | 'ran' = 'ran', policies?: Map<string, FieldDecision>): InspectedCall {
  const ir = annotate(buildIR(id, normalize(raw.operation, raw.variables)), {
    schema: SCHEMA,
    scope: 'jira',
    ...(policies !== undefined && { access: { denyOperation: false, fields: policies } }),
    validation: { valid: true, diagnostics: [] },
    isIncomplete: false,
  })
  return {
    id,
    server: SERVER,
    operation: raw.operation,
    variables: JSON.stringify(raw.variables, null, 2),
    status,
    arrivedAt: Date.UTC(2026, 9, 9),
    ir,
    ...(status === 'ran' && { outcome: outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify(response) }] }, LINKS) }),
  }
}

const partialOperation = `query SyntheticPolicyResult {
  jira_searchIssues(jql: "project = SYN", maxResults: 2) {
    issues { key summary maskedNote deniedNote }
    total
  }
}`
const partialResponse = {
  data: { jira_searchIssues: { issues: [
    { key: 'SYN-301', summary: 'Visible synthetic title', maskedNote: null, deniedNote: null },
    { key: 'SYN-302', summary: 'Another visible title', maskedNote: null, deniedNote: null },
  ], total: 2 } },
  errors: [{
    message: 'A synthetic field was denied.',
    path: ['jira_searchIssues', 'issues', 1, 'deniedNote'],
    extensions: { code: 'CONSTELLATION_ACCESS_DENIED', visibility: 'requestable' },
  }],
}
const partialPolicies = new Map([
  ['jira_searchIssues.issues.maskedNote', { decision: 'mask' as const }],
  ['jira_searchIssues.issues.deniedNote', { decision: 'deny' as const }],
])

const unicodeOperation = `query SyntheticUnicode {
  jira_searchIssues(jql: "project = SYN", maxResults: 1) { issues { key fields } }
}`
const unicodeResponse = {
  data: { jira_searchIssues: { issues: [{ key: 'SYN-401', fields: {
    summary: `${unicodeAndTerminalStrings.combining} 東京 ${unicodeAndTerminalStrings.flag} ${unicodeAndTerminalStrings.zwj} ${unicodeAndTerminalStrings.terminalEscape}`,
  } }] } },
}

const FIXTURES: Record<string, ResolvedCall> = {
  ...polishFixtures,
  jira: executeCall('preview-jira', jiraThreeRows, jiraThreeRows.response),
  search: searchFiveOperations,
  enum: enumFour,
  enum61: enumSixtyOne,
  object: objectFortyOneFields,
  long: longRootDescription,
  partial: executeCall('preview-partial', { operation: partialOperation, variables: {} }, partialResponse, 'ran', partialPolicies),
  write: executeCall('preview-write', proposedWriteSyntheticOnly, {}, 'pending'),
  large: executeCall('preview-large-input', largeInputOver9000Chars, { data: { jira_countIssues: { count: 7 } } }),
  unicode: executeCall('preview-unicode', { operation: unicodeOperation, variables: {} }, unicodeResponse),
  unicodeTerminal: executeCall('preview-terminal-control', { operation: unicodeOperation, variables: {} }, {
    data: { jira_searchIssues: { issues: [{ key: 'SYN-402', fields: { summary: unicodeAndTerminalStrings.terminalEscape } }] } },
  }),
}
const VALID_FIXTURES = new Set(Object.keys(FIXTURES))

let fixtureName = 'jira'
let paneWidth = 64
let ui: PaneUi = { ...CLOSED }
let rawOpen = false
let viewport = 'not rendered'

function historyState(): ResolvedInspectorCalls {
  const first = FIXTURES[fixtureName]!
  const history = [first, ...Object.entries(FIXTURES).filter(([name]) => name !== fixtureName).map(([, call]) => call)]
  return { queue: [], last: first, history } as unknown as ResolvedInspectorCalls
}

function selectedCall(): ResolvedCall {
  const selection = ui.selection
  if (selection.kind === 'live') return FIXTURES[fixtureName]!
  return Object.values(FIXTURES).find(call => call.id === selection.id) ?? FIXTURES[fixtureName]!
}

function navForHistory(): ResolvedNav | undefined {
  const state = historyState()
  return navResolvedOf(state, ui.selection)
}

type PaneRender = Extract<RenderInput, { component: 'Pane' }>

function kitOf($: EngineInterface, e: PaneRender): Kit {
  const elements = $.ui.resolve(e)
  const { Box, Text, Code, Button } = elements
  const Link = 'Link' in elements ? elements.Link : undefined
  const Markdown = 'Markdown' in elements ? elements.Markdown : undefined
  return { Box, Text, Code, Button, ...(Link !== undefined && { Link }), ...(Markdown !== undefined && { Markdown }) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'inspector-preview',
      description: 'Open a synthetic GraphOS Inspector native pane fixture',
      argumentHint: '[fixture|older|newer|live|raw] [32|50|64|84|100]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'inspector-preview' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const widthArg = args.find(arg => /^(?:32|50|64|84|100)$/.test(arg))
    if (widthArg !== undefined) paneWidth = Number(widthArg)
    const arg = args.find(one => !/^(?:32|50|64|84|100)$/.test(one)) ?? ''
    const state = historyState()
    if (arg === 'metrics') return { text: `Native pane viewport: ${viewport}.` }
    if (arg === 'focus') {
      // Immediate commands still own the composer during their hook. Request
      // focus after that command has returned, over the now-empty composer.
      void $.clock.sleep(150).then(() => $.ui.open({ id: PANE, focus: true, columns: paneWidth, rows: 40 })).catch(() => undefined)
      return { text: 'Requesting preview keyboard focus.' }
    }
    if (VALID_FIXTURES.has(arg)) {
      fixtureName = arg
      ui = { ...CLOSED, selection: { kind: 'live' } }
    } else if (arg === 'older') {
      ui = { ...ui, selection: selectionOlder(ui.selection, state) }
    } else if (arg === 'newer') {
      ui = { ...ui, selection: selectionNewer(ui.selection, state) }
    } else if (arg === 'live' || arg === '') {
      ui = { ...ui, selection: { kind: 'live' } }
    } else if (arg === 'raw') {
      rawOpen = true
      await $.ui.open({ id: RAW_PANE, title: 'Inspector Preview Raw', focus: true, closeOnEscape: true, columns: paneWidth, rows: 40 })
      void $.clock.sleep(150).then(() => $.ui.open({ id: RAW_PANE, title: 'Inspector Preview Raw', focus: true, closeOnEscape: true, columns: paneWidth, rows: 40 })).catch(() => undefined)
      return { text: 'Synthetic Inspector raw input preview.' }
    }
    const opened = await $.ui.open({ id: PANE, title: `Inspector Preview · ${fixtureName} · ${paneWidth}`, focus: true, columns: paneWidth, rows: 40 })
    return { text: opened.isPlaced ? `Synthetic Inspector preview: ${fixtureName}.` : 'The Inspector preview pane is not placed at this width.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    viewport = `${e.props.bodyColumns}×${e.props.scroll.bodyRows}`
    const kit = kitOf($, e)
    const act: Act = (change: PaneChange) => {
      if (change.expectedCallId !== undefined && change.expectedCallId !== selectedCall().id) return
      const { toggleRaw, openUrl, draftPrompt: _draftPrompt, expectedCallId: _expectedCallId, ...state } = change
      if (toggleRaw === true) {
        rawOpen = !rawOpen
        if (rawOpen) void $.ui.open({ id: RAW_PANE, title: 'Inspector Preview Raw', focus: true, closeOnEscape: true, columns: paneWidth, rows: 40 }).catch(() => undefined)
        else void $.ui.close({ id: RAW_PANE }).catch(() => undefined)
      }
      if (openUrl !== undefined) $.ui.log(`Preview link selected: ${openUrl}`)
      ui = { ...ui, ...state }
      $.ui.invalidate('ui.render')
    }
    const shownCall = selectedCall()
    return viewOf(
      kit,
      { call: shownCall, waiting: 0 },
      e.props.bodyColumns,
      ui,
      act,
      { surface: e.surface, isFocused: e.props.isFocused, bodyRows: e.props.scroll.bodyRows, scrollOffset: e.props.scroll.offset, links: LINKS, ...(navForHistory() !== undefined && { nav: navForHistory() }) },
    )
  })

  on('ui.render', { component: 'Pane', requestId: RAW_PANE }, async ($, e) => {
    const kit = kitOf($, e)
    const change: Act = update => {
      if (update.expectedCallId !== undefined && update.expectedCallId !== selectedCall().id) return
      const { expectedCallId: _expectedCallId, ...state } = update
      ui = { ...ui, ...state }
      $.ui.invalidate('ui.render')
    }
    return <RawView kit={kit} call={selectedCall()} ui={ui} onChange={change} bodyRows={e.props.scroll.bodyRows} onClose={() => { rawOpen = false; void $.ui.close({ id: RAW_PANE }).catch(() => undefined) }} />
  })
}
