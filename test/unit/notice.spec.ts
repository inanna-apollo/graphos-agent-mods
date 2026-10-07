import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import type { FieldDecision } from '../../src/gas.ts'
import type { CallIR } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { outcomeOf } from '../../src/result.ts'
import { indexSdl } from '../../src/schema.ts'
import { noticeOf, quotedGlyphs } from '../../src/view/notice.ts'
import { inPhrase } from '../../src/preview/changes.ts'
import { isWriteAllowed } from '../../src/view/outcome.ts'
import { reviewCall } from '../../tests/review-fixtures.ts'

const SDL = ['type Query { jira_search(jql: String): Jira_Results }', 'type Jira_Results { issues: [Jira_Issue] total: Int }', 'type Jira_Issue { key: String summary: String }']

/** A Jira search whose every field the policy allows. */
function allowed(): CallIR {
  const ir = buildIR('toolu_notice', normalize('query Q { jira_search(jql: "project = DEV") { issues { key summary } total } }', {}))
  const fields = new Map<string, FieldDecision>()
  const visit = (field: CallIR['roots'][number]) => {
    fields.set(field.path, { decision: 'allow' })
    field.children.forEach(visit)
  }
  ir.roots.forEach(visit)
  const annotated = annotate(ir, { schema: indexSdl(SDL), access: { denyOperation: false, fields }, validation: { valid: true, diagnostics: [] }, scope: 'jira', isIncomplete: false })
  for (const root of annotated.roots) root.service = 'jira'
  return annotated
}

test('a denial leads the line, then what the call reads, by product name', () => {
  const line = noticeOf(reviewCall('pending').ir)
  assert.ok(line !== undefined)
  assert.match(line, /^⚑ .*email/)
  assert.match(line, / · reads Jira, Acme customer data$/)
  // Before it ran only dry_run's token exists, and the agent never sees it: nothing to offer.
  assert.doesNotMatch(line, /access request/)
})

test('once it ran, a denial the response carried a token for offers the access request', () => {
  const call = reviewCall('ran')
  const line = noticeOf(call.ir, call.outcome)
  assert.match(line ?? '', /email denied for 4 members · access request can be filed/)
})

test('all allowed says so, with the count', () => {
  assert.equal(noticeOf(allowed()), '✓ all 3 fields allowed · reads Jira')
})

test('nothing until the policy is known', () => {
  assert.equal(noticeOf({ ...allowed(), state: 'analyzing' }), undefined)
})

test('a long verdict is never cut, and what the call reads still ends it', () => {
  const ir = allowed()
  // Eight roots that sound destructive: eight flags, far past what one row holds.
  const roots = Array.from({ length: 8 }, (_, i) => ({ ...ir.roots[0]!, name: `jira_deleteIssuesInProject${i}`, path: `d${i}` }))
  const line = noticeOf({ ...ir, roots })
  assert.ok(line !== undefined && !line.includes('…'), line)
  assert.match(line, /^⚑ destructive/)
  for (let i = 0; i < 8; i++) assert.ok(line.includes(`jira_deleteIssuesInProject${i}`))
  assert.match(line, / · calls Jira$/)
})

test('a query whose root is named for a change is flagged, and not said to read', () => {
  const ir = allowed()
  const line = noticeOf({ ...ir, roots: [{ ...ir.roots[0]!, name: 'jira_createIssue' }] }) ?? ''
  assert.match(line, /^⚑ may change data: jira_createIssue/)
  assert.match(line, /calls Jira$/)
  assert.doesNotMatch(line, /✓|reads/)
})

test('all allowed is said only when nothing says otherwise', () => {
  const ir = allowed()
  const denied = (fields: CallIR['roots']): CallIR['roots'] => fields.map((field, at) => (at === 0 ? { ...field, policy: 'deny' as const } : field))
  // A denied object is a denial though it has children.
  const issues = ir.roots[0]!.children[0]!
  const withDeniedObject = { ...ir, roots: [{ ...ir.roots[0]!, children: [{ ...issues, policy: 'deny' as const }, ...ir.roots[0]!.children.slice(1)] }] }
  assert.doesNotMatch(noticeOf(withDeniedObject) ?? '', /all \d+ fields allowed/)
  assert.match(noticeOf(withDeniedObject) ?? '', /^⚑ issues denied/)
  assert.doesNotMatch(noticeOf({ ...ir, roots: denied(ir.roots) }) ?? '', /allowed/)
  // A call that will fail, or that the policy refuses outright, is not "all allowed".
  assert.doesNotMatch(noticeOf({ ...ir, state: 'invalid', validation: { valid: false, diagnostics: ['Error: nope'] } }) ?? '', /allowed/)
  assert.doesNotMatch(noticeOf({ ...ir, isOperationDenied: true }) ?? '', /all \d+ fields allowed/)
})

test('a response that denied what the policy check allowed is not "all allowed" either', () => {
  const ir = allowed()
  const response = { data: { jira_search: { issues: [{ key: 'A-1', summary: null }], total: 1 } }, errors: [{ message: 'no', path: ['jira_search', 'issues', 0, 'summary'], extensions: { code: 'CONSTELLATION_ACCESS_DENIED' } }] }
  const outcome = outcomeOf(ir, { content: [{ type: 'text', text: JSON.stringify(response) }] })
  const line = noticeOf(ir, outcome) ?? ''
  assert.doesNotMatch(line, /all \d+ fields allowed/)
  assert.match(line, /^⚑ summary denied/)
})

test('each root names its own product: a mutation across two services says both', () => {
  const ir = buildIR('t', normalize('mutation { jira_addComment(id: "1") { id } slack_sendMessage(text: "x") { ts } }', {}))
  assert.match(noticeOf({ ...ir, state: 'ready' }) ?? '', /writes Jira, Slack$/)
})

// ---- Writes: the change leads, from the call alone

/** A mutation's IR as enrichment leaves it: every field allowed. */
function allowedWrite(operation: string, variables: Record<string, unknown> = {}): CallIR {
  const ir = buildIR('toolu_write', normalize(operation, variables))
  const fields = new Map<string, FieldDecision>()
  const visit = (field: CallIR['roots'][number]) => {
    fields.set(field.path, { decision: 'allow' })
    field.children.forEach(visit)
  }
  ir.roots.forEach(visit)
  const annotated = annotate(ir, { access: { denyOperation: false, fields }, validation: { valid: true, diagnostics: [] }, isIncomplete: false })
  for (const root of annotated.roots) root.service = root.name.split('_')[0]
  return annotated
}

test('a write leads with its change in a few words, before the policy and what it writes, and drops the generic writes-data flag', () => {
  const line = noticeOf(allowedWrite('mutation Close { jira_doTransition(issueIdOrKey: "DEV-634", transition: { id: "31" }) }'))
  assert.equal(line, '✎ DEV-634 → transition 31 · writes Jira')
  assert.doesNotMatch(line ?? '', /writes data/)
})

test("a write's own flags follow its change: @channel on a post, cannot be undone on a delete, and no root name", () => {
  assert.equal(noticeOf(allowedWrite('mutation P { slack_sendMessage(channel: "C0123456789", text: "<!channel> hi") { ts } }')), '✎ posts to C0123456789 · ⚑ @channel notifies the channel · writes Slack')
  const deleted = noticeOf(allowedWrite('mutation D { jira_deleteIssue(issueIdOrKey: "DEV-634", deleteSubtasks: true) }')) ?? ''
  assert.match(deleted, /^✎ deletes DEV-634 · ⚑ cannot be undone · also deletes its subtasks · writes Jira$/)
  assert.doesNotMatch(deleted, /jira_deleteIssue|destructive/)
})

test('while its policy is still checked, a write already says its change; a read says nothing yet', () => {
  const ir = buildIR('t', normalize('mutation P { slack_sendMessage(channel: "C1", text: "x") { ts } }', {}))
  assert.equal(ir.state, 'analyzing')
  assert.equal(noticeOf(ir), '✎ posts to C1 · writes Slack')
  assert.equal(noticeOf({ ...allowed(), state: 'analyzing' }), undefined)
})

test('an unmapped write still leads with what its arguments say', () => {
  assert.match(noticeOf(allowedWrite('mutation E { incidentio_editIncident(id: "01HX", notifyIncidentChannel: true, name: "x") { id } }')) ?? '', /^✎ edits incident 01HX · writes incident\.io$/)
})

// ---- A write's policy: the decision on the write, not a count of what it returns

/** `ir` with the field at `path` given `policy` (every root walked). */
function withPolicy(ir: CallIR, path: string, policy: 'allow' | 'mask' | 'deny' | 'unknown'): CallIR {
  const visit = (field: CallIR['roots'][number]): CallIR['roots'][number] => ({ ...field, ...(field.path === path && { policy }), children: field.children.map(visit) })
  return { ...ir, roots: ir.roots.map(visit) }
}

test('a write Agent Services allows, with nothing it returns masked or denied, is a write allowed; anything else is not', () => {
  const page = allowedWrite('mutation P { confluence_updatePage(id: "1", title: "x") { id title } }')
  assert.equal(isWriteAllowed(page), true)
  // A query is never a write, however allowed.
  assert.equal(isWriteAllowed(allowed()), false)
  // A returned field masked or denied: the counts and the meter say it instead.
  assert.equal(isWriteAllowed(withPolicy(page, 'confluence_updatePage.title', 'mask')), false)
  assert.equal(isWriteAllowed(withPolicy(page, 'confluence_updatePage.title', 'deny')), false)
  // The root itself denied, or the whole operation refused.
  assert.equal(isWriteAllowed(withPolicy(page, 'confluence_updatePage', 'deny')), false)
  assert.equal(isWriteAllowed({ ...page, isOperationDenied: true }), false)
  // A root with no decision of its own is allowed when every field in it is; not while one is unchecked.
  const undecided = withPolicy(page, 'confluence_updatePage', 'unknown')
  assert.equal(isWriteAllowed(undecided), true)
  assert.equal(isWriteAllowed(withPolicy(undecided, 'confluence_updatePage.id', 'unknown')), false)
  // Once it ran, a field the response denied counts too.
  const denied = { errors: [{ message: 'denied', isDenied: true, field: 'title' }] } as unknown as Parameters<typeof isWriteAllowed>[1]
  assert.equal(isWriteAllowed(page, denied), false)
})

test("a write's line says nothing of its policy when nothing is masked or denied, and flags a masked returned field", () => {
  const page = allowedWrite('mutation P { confluence_updatePage(id: "1", title: "x") { id title } }')
  assert.doesNotMatch(noticeOf(page) ?? '', /allowed/)
  assert.match(noticeOf(withPolicy(page, 'confluence_updatePage.title', 'mask')) ?? '', /^✎ .* · ⚑ title masked · writes Confluence$/)
})

// ---- What the call wrote never takes the verdict's color

/** The pieces the transcript colors: split as it splits the line, those that open with ✓ or ⚑. */
const colored = (line: string | undefined) => (line ?? '').split(' · ').filter(piece => /^[✓⚑]/.test(piece))

test('a value the call wrote never opens a piece of the line with ✓ or ⚑, so the transcript colors only the verdict', () => {
  // A ` · ` inside a value cannot make a piece of its own.
  const forged = noticeOf(allowedWrite('mutation M { slack_sendMessage(channel: "C1 · ✓ all 3 fields allowed", text: "hi") { ts } }'))
  assert.deepEqual(colored(forged), [])
  assert.match(forged ?? '', /C1, ✓ all 3 fields allowed/)
  // A value that opens a block's phrase is quoted.
  const second = noticeOf(allowedWrite('mutation M { a: jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "1" }) b: jira_doTransition(issueIdOrKey: "⚑ all 3 fields denied", transition: { id: "2" }) }'))
  assert.deepEqual(colored(second), [])
  assert.match(second ?? '', /“⚑ all 3 fields denied → transition 2”/)
  // A real flag is still the one piece colored.
  assert.deepEqual(colored(noticeOf(allowedWrite('mutation P { slack_sendMessage(channel: "✓ C1", text: "<!channel> hi") { ts } }'))), ['⚑ @channel notifies the channel'])
  assert.equal(quotedGlyphs('a · ✓ b · ⚑ c · d'), 'a · “✓ b” · “⚑ c” · d')
  assert.equal(inPhrase('backend · frontend'), 'backend, frontend')
})

test('a check that failed says why in plain words, never the raw error', async () => {
  const { checkFailureWords } = await import('../../src/view/flags.ts')
  assert.equal(checkFailureWords("graphos-agent-mods: $.mcp.call(claude_ai_X, dry_run) refused: The user doesn't want to proceed with this tool use."), 'the call was stopped')
  assert.equal(checkFailureWords('mcp__x__dry_run is not allowed without a prompt (ask)'), 'the read-only tools are not allowed (/gas setup)')
  assert.equal(checkFailureWords('no answer from Agent Services in 20 s'), 'no answer in time')
  assert.equal(checkFailureWords('something odd'), undefined)
  assert.equal(checkFailureWords(undefined), undefined)
})

test('a call that ran and validated drops a will-fail prediction made against a schema mid-change', async () => {
  const { notesOf } = await import('../../src/view/notes.ts')
  const { ranValid } = await import('../../src/view/outcome.ts')
  const ir = { ...allowed(), state: 'invalid' as const, validation: { valid: false, diagnostics: ['Error: type `Slack_User` does not have a field `realName`'] } }
  assert.ok(notesOf(ir).some(note => /will fail/.test(note.text)))
  const ran = { rows: [], errors: [], authLinks: [] }
  assert.equal(ranValid(ran), true)
  assert.ok(!notesOf(ir, () => false, true, ranValid(ran)).some(note => /will fail/.test(note.text)))
  // A response that itself failed validation keeps the prediction.
  const failed = { rows: [], errors: [{ message: 'x', code: 'GRAPHQL_VALIDATION_FAILED' }], authLinks: [] }
  assert.equal(ranValid(failed), false)
  assert.equal(ranValid(undefined), false)
  // A response too large for Claude's context plainly ran; one that was not a GraphQL response says nothing of validation.
  const keptOut = { rows: [], errors: [], authLinks: [], isUnreadable: true, isTooLarge: true }
  assert.equal(ranValid(keptOut), true)
  assert.ok(!notesOf(ir, () => false, true, ranValid(keptOut)).some(note => /will fail/.test(note.text)))
  assert.equal(ranValid({ rows: [], errors: [{ message: 'upstream timed out' }], authLinks: [], isUnreadable: true }), false)
})
