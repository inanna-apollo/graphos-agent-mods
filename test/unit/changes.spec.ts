import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotate } from '../../src/annotate.ts'
import { buildIR } from '../../src/build.ts'
import type { CallIR } from '../../src/ir.ts'
import { normalize } from '../../src/normalize.ts'
import { DELETE_NOT_READ, MAX_BLOCKS, MAX_ROWS, NOT_READ, UNREAD, changePhrase, moreWrites, previewFlags, previewOf, shortValue, verbOf } from '../../src/preview/changes.ts'
import type { ChangeBlock } from '../../src/preview/changes.ts'
import { MAPPED } from '../../src/preview/table.ts'
import { indexSdl } from '../../src/schema.ts'
import { own } from '../../src/guards.ts'

const irOf = (operation: string, variables: Record<string, unknown> = {}): CallIR => buildIR('toolu_changes', normalize(operation, variables))

function blockOf(operation: string, variables: Record<string, unknown> = {}): ChangeBlock {
  const block = previewOf(irOf(operation, variables))?.blocks[0]
  assert.ok(block !== undefined, operation)
  return block
}

/** Rows as `sign label text`, the body's own lines left out. */
const rowsOf = (block: ChangeBlock) => block.rows.map(row => `${row.sign} ${row.label} ${row.text}`)
const flagsOf = (operation: string, variables: Record<string, unknown> = {}) => previewFlags(irOf(operation, variables)).map(flag => flag.text)

const ESC = '\u001b'
const ADF = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const ADF_LINES = (...lines: string[]) => ({ type: 'doc', version: 1, content: lines.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) })

// ---- Which calls get a preview

test('only a mutation gets a preview; a query, a subscription and an unparseable call get none', () => {
  assert.equal(previewOf(irOf('query Q { jira_getIssue(issueIdOrKey: "DEV-1") { key } }')), undefined)
  assert.equal(previewOf(irOf('subscription S { events { id } }')), undefined)
  assert.equal(previewOf(irOf('mutation {')), undefined)
  assert.equal(changePhrase(irOf('query Q { jira_getIssue(issueIdOrKey: "DEV-1") { key } }')), undefined)
})

test('one block per write root, each with its own target, at most MAX_BLOCKS', () => {
  const two = previewOf(irOf('mutation Two { a: jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "11" }) b: jira_doTransition(issueIdOrKey: "DEV-2", transition: { id: "21" }) }'))
  assert.deepEqual(two?.blocks.map(block => [block.path, block.target.words]), [['a', 'issue DEV-1'], ['b', 'issue DEV-2']])
  assert.equal(changePhrase(irOf('mutation Two { a: jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "11" }) b: jira_deleteIssue(issueIdOrKey: "DEV-2") }')), 'DEV-1 → transition 11 · deletes DEV-2')
  const many = Array.from({ length: MAX_BLOCKS + 4 }, (_, i) => `r${i}: jira_deleteIssue(issueIdOrKey: "DEV-${i}")`).join(' ')
  assert.equal(previewOf(irOf(`mutation Many { ${many} }`))?.blocks.length, MAX_BLOCKS)
})

test('roots past MAX_BLOCKS are not drawn, but the last block counts them and their flags are still raised', () => {
  const transitions = Array.from({ length: MAX_BLOCKS }, (_, i) => `r${i}: jira_doTransition(issueIdOrKey: "DEV-${i}", transition: { id: "1" })`).join(' ')
  const ir = irOf(`mutation M { ${transitions} last: slack_sendMessage(channel: "C1", text: "<!channel> hi") { ts } gone: jira_deleteIssue(issueIdOrKey: "DEV-99") }`)
  const preview = previewOf(ir)
  assert.equal(preview?.blocks.length, MAX_BLOCKS)
  assert.equal(preview?.all.length, MAX_BLOCKS + 2)
  assert.equal(preview?.blocks.at(-1)?.notes.at(-1), moreWrites(2))
  assert.equal(moreWrites(1), '1 more write not shown')
  // The ninth root's @channel and the tenth's delete are flags all the same.
  const flags = previewFlags(ir).map(flag => flag.text)
  assert.ok(flags.includes('@channel notifies the channel'), flags.join(' | '))
  assert.ok(flags.includes('cannot be undone'), flags.join(' | '))
  assert.match(changePhrase(ir) ?? '', / · \+2 more$/)
})

test('a value nested deeper than the words read says so; a root whose reading throws is a block that says it was not read, never nothing', () => {
  let deep: unknown = 'x'
  for (let i = 0; i < 3_000; i++) deep = [deep]
  const block = blockOf('mutation E($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", fields: $f) }', { f: { summary: deep } })
  assert.equal(block.source, 'mapped')
  assert.deepEqual(rowsOf(block), ['+ summary [nested list]'])
  assert.equal(shortValue([[['a', 'b']]]), 'a · b')
  // A stored IR whose root is malformed: the reading throws, and the block says so with a flag.
  const ir = irOf('mutation E { jira_editIssue(issueIdOrKey: "DEV-1", notifyUsers: false) }')
  const broken = { ...ir, roots: ir.roots.map(root => ({ ...root, args: null as never })) }
  const unread = previewOf(broken)
  assert.equal(unread?.blocks[0]?.source, 'unread')
  assert.deepEqual(unread?.blocks[0]?.notes, [UNREAD])
  assert.deepEqual(previewFlags(broken).map(flag => flag.text), ['change not read'])
  assert.equal(changePhrase(broken), 'change not read')
})

test('the preview is one model per IR: the pane, the flags line and the transcript read the same object', () => {
  const ir = irOf('mutation M { jira_deleteIssue(issueIdOrKey: "DEV-1") }')
  assert.equal(previewOf(ir), previewOf(ir))
})

// ---- Jira, hand-mapped

test('jira_doTransition: the transition leads, as an id; the screen fields and update operations follow; the phrase says it in a few words', () => {
  const block = blockOf('mutation Close($c: Jira_JSON) { jira_doTransition(issueIdOrKey: "DEV-634", transition: { id: "31", name: "Done" }, fields: { resolution: { name: "Done" } }, update: $c) }', { c: { comment: [{ add: { body: ADF('Shipped.') } }] } })
  assert.equal(block.kind, 'transition')
  assert.equal(block.section, 'CHANGES')
  assert.equal(block.source, 'mapped')
  assert.equal(block.target.words, 'issue DEV-634')
  assert.deepEqual(rowsOf(block), ['+ transition 31', '+ resolution Done', '+ comment Shipped.'])
  assert.equal(block.phrase, 'DEV-634 → transition 31')
  assert.deepEqual(block.notes, [NOT_READ])
  // The name the call gives the transition is the model's: said on the card as such, never as the target status.
  const card = block.rows[0]?.card
  assert.match(card?.meaning ?? '', /status it leads to is not read/)
  assert.match(card?.meaning ?? '', /names it "Done"; Jira acts on the id alone/)
  assert.equal(card?.isJson, true)
  assert.equal(block.current, 'not-read')
  assert.ok(block.read !== undefined)
})

test('jira_doTransition: a transition given as a bare id, or none at all, still reads', () => {
  assert.deepEqual(rowsOf(blockOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: "41") }')), ['+ transition 41'])
  assert.equal(blockOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: {}) }').rows[0]?.text, '(no id given)')
})

test("jira_editIssue: each field of `fields` is a row, a rich-text one a body; `update`'s add and remove are + and −, set +, edit ±", () => {
  const block = blockOf('mutation E($f: Jira_JSON, $u: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-634", fields: $f, update: $u, returnIssue: true, expand: "names") }', {
    f: { summary: 'New title', description: ADF_LINES('one', 'two', 'three'), priority: { id: '2' }, labels: ['a', 'b'], customfield_10020: 42, duedate: null },
    u: { labels: [{ add: 'backend' }, { remove: 'frontend' }], components: [{ set: [{ name: 'API' }] }], summary: [{ edit: 'Edited' }], odd: [{ copy: 'x' }] },
  })
  assert.equal(block.kind, 'update')
  assert.deepEqual(rowsOf(block), [
    '+ summary New title',
    '+ description 3\u00a0lines · rich\u00a0text',
    '+ priority id 2',
    '+ labels a · b',
    '+ customfield_10020 42',
    '+ duedate none',
    '+ labels backend',
    '- labels frontend',
    '+ components API',
    '± summary Edited',
    '+ odd x',
  ])
  const body = block.rows[1]?.body
  assert.deepEqual(body?.lines.map(line => line.text), ['one', 'two', 'three'])
  assert.equal(body?.format, 'adf')
  assert.match(block.rows[0]?.card.meaning ?? '', /one-line title/)
  assert.match(block.rows[4]?.card.meaning ?? '', /custom field/)
  assert.equal(block.phrase, 'edits DEV-634: summary, description, priority +5 more')
  // returnIssue and expand shape the response: not changes.
  assert.ok(!block.rows.some(row => row.label === 'returnIssue' || row.label === 'expand'))
})

test('jira_editIssue: fields that are not an object, or update that is not one, still read as one row each', () => {
  assert.deepEqual(rowsOf(blockOf('mutation E { jira_editIssue(issueIdOrKey: "DEV-1", fields: "nope", update: 7) }')), ['+ fields nope', '± update 7'])
})

test('jira_editIssue flags: watchers not told, and each admin override', () => {
  const flags = flagsOf('mutation E { jira_editIssue(issueIdOrKey: "DEV-1", notifyUsers: false, overrideScreenSecurity: true, overrideEditableFlag: true, fields: { summary: "x" }) }')
  assert.deepEqual(flags, ['watchers are not told', 'admin override: overrideScreenSecurity', 'admin override: overrideEditableFlag'])
  assert.deepEqual(flagsOf('mutation E { jira_editIssue(issueIdOrKey: "DEV-1", notifyUsers: true, overrideScreenSecurity: false, fields: { summary: "x" }) }'), [])
  // How the change is made is not a change: no rows for them.
  assert.deepEqual(rowsOf(blockOf('mutation E { jira_editIssue(issueIdOrKey: "DEV-1", notifyUsers: false, fields: { summary: "x" }) }')), ['+ summary x'])
})

test('jira_assignIssue: an account id whole, -1 as automatic, null as unassigned', () => {
  const to = (value: string) => blockOf(`mutation A { jira_assignIssue(issueIdOrKey: "DEV-634", accountId: ${value}) }`)
  assert.deepEqual(rowsOf(to('"5b10ac8d82e05b22cc7d4ef5"')), ['+ assignee 5b10ac8d82e05b22cc7d4ef5'])
  assert.equal(to('"5b10ac8d82e05b22cc7d4ef5"').phrase, 'assigns DEV-634 to 5b10ac8d82e05b22cc7d4ef5')
  assert.match(to('"5b10ac8d82e05b22cc7d4ef5"').rows[0]?.card.meaning ?? '', /name is not read/)
  assert.deepEqual(rowsOf(to('"-1"')), ['+ assignee automatic'])
  assert.deepEqual(rowsOf(to('null')), ['+ assignee unassigned'])
  assert.equal(to('null').kind, 'assign')
})

test('jira_addComment: a new comment on the issue, its ADF body as lines; visibility said', () => {
  const block = blockOf('mutation C($b: Jira_JSON) { jira_addComment(issueIdOrKey: "DEV-634", body: $b, visibility: { type: "role", value: "Administrators" }) { id } }', { b: ADF_LINES('Fixed in 2.4.', 'Thanks!') })
  assert.equal(block.kind, 'create')
  assert.equal(block.section, 'NEW COMMENT')
  assert.equal(block.target.words, 'on DEV-634')
  assert.deepEqual(rowsOf(block), ['+ body 2\u00a0lines · rich\u00a0text', '+ visible to Administrators'])
  assert.equal(block.phrase, 'comments on DEV-634')
  assert.deepEqual(block.notes, [])
  assert.equal(block.current, 'none')
})

test('jira_updateComment and jira_deleteComment: the comment by id on its issue; a delete shows it as −, and cannot be undone', () => {
  const edit = blockOf('mutation U($b: Jira_JSON) { jira_updateComment(issueIdOrKey: "DEV-634", id: "10042", body: $b) { id } }', { b: ADF('Edited.') })
  assert.equal(edit.target.words, 'comment 10042 · on DEV-634')
  assert.equal(edit.target.short, 'comment 10042 on DEV-634')
  assert.deepEqual(rowsOf(edit), ['+ body Edited.'])
  assert.equal(edit.phrase, 'edits comment 10042 on DEV-634')
  const drop = blockOf('mutation D { jira_deleteComment(issueIdOrKey: "DEV-634", id: "10042") }')
  assert.equal(drop.kind, 'delete')
  assert.deepEqual(rowsOf(drop), ['- comment 10042'])
  assert.deepEqual(drop.notes, [DELETE_NOT_READ])
  assert.deepEqual(drop.flags.map(flag => flag.text), ['cannot be undone'])
  assert.equal(drop.phrase, 'deletes comment 10042 on DEV-634')
})

test('jira_deleteIssue: the issue as −, cannot be undone, and its subtasks with it when asked', () => {
  const block = blockOf('mutation D { jira_deleteIssue(issueIdOrKey: "DEV-634", deleteSubtasks: "true") }')
  assert.deepEqual(rowsOf(block), ['- issue DEV-634'])
  assert.deepEqual(block.flags.map(flag => flag.text), ['cannot be undone', 'also deletes its subtasks'])
  assert.match(block.flags[0]?.detail ?? '', /no trash for issues/)
  assert.deepEqual(flagsOf('mutation D { jira_deleteIssue(issueIdOrKey: "DEV-634", deleteSubtasks: "false") }'), ['cannot be undone'])
  assert.equal(block.phrase, 'deletes DEV-634')
})

test('jira_createIssue: a new issue in its project, every field but the project a row', () => {
  const block = blockOf('mutation N { jira_createIssue(fields: { project: { key: "DEV" }, issuetype: { name: "Bug" }, summary: "Login loop", labels: ["auth"] }) { key } }')
  assert.equal(block.section, 'NEW ISSUE')
  assert.equal(block.target.words, 'in DEV')
  assert.deepEqual(rowsOf(block), ['+ issuetype Bug', '+ summary Login loop', '+ labels auth'])
  assert.equal(block.phrase, 'creates an issue in DEV')
  assert.equal(blockOf('mutation N { jira_createIssue(fields: { project: { id: "10001" }, summary: "x" }) { key } }').target.words, 'in project 10001')
})

// ---- Confluence, hand-mapped

const STORAGE = '<h2>Escalation</h2><p>Page the primary.</p><ul><li>one</li><li>two</li></ul>'

test('confluence_updatePage: title, body in the format the call names, version and its note; status current is restated, dim', () => {
  const block = blockOf('mutation P($b: String!) { confluence_updatePage(id: "123456789", status: "current", title: "On-call runbook", bodyRepresentation: "storage", bodyValue: $b, versionNumber: 13, versionMessage: "Escalation") { id } }', { b: STORAGE })
  assert.equal(block.target.words, 'page 123456789')
  assert.deepEqual(rowsOf(block), ['  status current', '+ title On-call runbook', '+ body 4\u00a0lines · page\u00a0markup', '+ version 13', '+ version note Escalation'])
  assert.equal(block.rows[0]?.isDim, true)
  assert.deepEqual(block.rows[2]?.body?.lines.map(line => line.text), ['## Escalation', 'Page the primary.', '• one', '• two'])
  assert.match(block.rows[3]?.card.meaning ?? '', /refuses the save unless/)
  // The phrase names what changes, not the restated status.
  assert.equal(block.phrase, 'edits page 123456789: title, body, version, version note')
  assert.deepEqual(block.read?.variables, { id: 'id', bodyFormat: { path: 'bodyRepresentation', map: { storage: 'storage', atlas_doc_format: 'atlas_doc_format', wiki: 'storage' } } })
})

test('confluence_updatePage: a draft status and a move are changes; an atlas_doc_format body is ADF, a wiki one its own lines', () => {
  const draft = blockOf('mutation P { confluence_updatePage(id: "1", status: "draft", title: "T", parentId: "77", bodyRepresentation: "atlas_doc_format", bodyValue: "{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"hi\\"}]}]}", versionNumber: 2) { id } }')
  assert.deepEqual(rowsOf(draft).slice(0, 3), ['+ status draft', '+ title T', '+ parent page 77'])
  assert.equal(draft.rows.find(row => row.label === 'body')?.text, 'hi')
  assert.equal(draft.rows.find(row => row.label === 'body')?.body?.format, 'adf')
  const wiki = blockOf('mutation P { confluence_updatePage(id: "1", status: "current", title: "T", bodyRepresentation: "wiki", bodyValue: "h1. Title\\n* item", versionNumber: 2) { id } }')
  assert.deepEqual(wiki.rows.find(row => row.label === 'body')?.body?.lines.map(line => line.text), ['h1. Title', '* item'])
})

test('confluence_createPage and confluence_createBlogPost: the new content where it goes', () => {
  const page = blockOf('mutation C { confluence_createPage(spaceId: "98765", parentId: "123", title: "Notes", bodyRepresentation: "storage", bodyValue: "<p>x</p>") { id } }')
  assert.equal(page.section, 'NEW PAGE')
  assert.equal(page.target.words, 'in space 98765 · under page 123')
  assert.deepEqual(rowsOf(page), ['+ title Notes', '+ body x'])
  assert.equal(page.phrase, 'creates a page in space 98765 under page 123')
  const post = blockOf('mutation C { confluence_createBlogPost(spaceId: "98765", title: "Release", status: "draft", bodyRepresentation: "storage", bodyValue: "<p>x</p>") { id } }')
  assert.equal(post.section, 'NEW BLOG POST')
  assert.deepEqual(rowsOf(post), ['+ title Release', '+ status draft', '+ body x'])
})

test('confluence_updateBlogPost: like a page', () => {
  const block = blockOf('mutation U { confluence_updateBlogPost(id: "55", status: "current", title: "Release", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 4) { id } }')
  assert.equal(block.target.words, 'blog post 55')
  assert.deepEqual(rowsOf(block), ['  status current', '+ title Release', '+ body x', '+ version 4'])
})

test('confluence_deletePage and confluence_deleteBlogPost go to the trash: said in the note, no cannot-be-undone flag', () => {
  for (const [root, noun] of [['confluence_deletePage', 'page'], ['confluence_deleteBlogPost', 'blog post']] as const) {
    const block = blockOf(`mutation D { ${root}(id: "123") }`)
    assert.deepEqual(rowsOf(block), [`- ${noun} 123`])
    assert.ok(block.notes.some(note => /trash, where it can be restored/.test(note)), root)
    assert.deepEqual(block.flags, [])
    assert.equal(block.phrase, `deletes ${noun} 123`)
  }
})

test('Confluence comments: a footer comment on a page, a reply, an inline one anchored to its passage; updates and deletes by id', () => {
  const footer = blockOf('mutation C { confluence_createFooterComment(pageId: "123", bodyRepresentation: "storage", bodyValue: "<p>LGTM</p>") { id } }')
  assert.equal(footer.section, 'NEW COMMENT')
  assert.equal(footer.target.words, 'on page 123')
  assert.deepEqual(rowsOf(footer), ['+ body LGTM'])
  assert.equal(footer.phrase, 'comments on page 123')
  assert.equal(blockOf('mutation C { confluence_createFooterComment(parentCommentId: "9", bodyRepresentation: "storage", bodyValue: "<p>yes</p>") { id } }').target.words, 'replying to comment 9')
  const inline = blockOf('mutation C { confluence_createInlineComment(pageId: "123", bodyRepresentation: "storage", bodyValue: "<p>typo</p>", inlineMarkerRef: "m1", inlineOriginalSelection: "teh") { id } }')
  assert.equal(inline.target.noun, 'inline comment')
  assert.deepEqual(rowsOf(inline), ['+ body typo', '+ anchored to teh'])
  const edit = blockOf('mutation U { confluence_updateInlineComment(id: "456", bodyRepresentation: "storage", bodyValue: "<p>fixed</p>", versionNumber: 2, resolved: true) { id } }')
  assert.deepEqual(rowsOf(edit), ['+ body fixed', '+ version 2', '+ resolved true'])
  assert.deepEqual(rowsOf(blockOf('mutation U { confluence_updateFooterComment(id: "456", bodyRepresentation: "storage", bodyValue: "<p>x</p>", versionNumber: 3) { id } }')), ['+ body x', '+ version 3'])
  for (const root of ['confluence_deleteFooterComment', 'confluence_deleteInlineComment']) {
    const drop = blockOf(`mutation D { ${root}(id: "456") }`)
    assert.equal(drop.kind, 'delete')
    assert.deepEqual(drop.flags.map(flag => flag.text), ['cannot be undone'])
    assert.match(drop.flags[0]?.detail ?? '', /does not go to the trash/)
  }
})

// ---- Slack, hand-mapped

test('slack_sendMessage: a new message in its channel, its mrkdwn as lines; @channel, @here and @everyone are flags', () => {
  const block = blockOf('mutation P($t: String) { slack_sendMessage(channel: "C0123456789", text: $t) { ts } }', { t: '<!channel> Release 2.4 is out\n• faster\n<!here> and <!everyone>' })
  assert.equal(block.section, 'NEW MESSAGE')
  assert.equal(block.target.words, 'in C0123456789')
  assert.deepEqual(block.rows[0]?.body?.lines.map(line => line.text), ['@channel Release 2.4 is out', '• faster', '@here and @everyone'])
  assert.deepEqual(block.flags.map(flag => flag.text), ['@channel notifies the channel', '@here notifies who is active', '@everyone notifies the workspace'])
  assert.match(block.flags[0]?.detail ?? '', /Slack notifies every member of the channel/)
  assert.equal(block.phrase, 'posts to C0123456789')
})

test('slack_sendMessage: a reply in a thread is a NEW REPLY; replyBroadcast only flags a reply; another name or icon is a flag', () => {
  const reply = blockOf('mutation R { slack_sendMessage(channel: "C1", threadTs: "1728000000.000100", replyBroadcast: true, text: "Done", username: "deploy-bot", iconEmoji: ":robot_face:") { ts } }')
  assert.equal(reply.section, 'NEW REPLY')
  assert.equal(reply.target.words, 'in C1 · in thread 1728000000.000100')
  assert.equal(reply.phrase, 'replies in a thread in C1')
  assert.deepEqual(reply.flags.map(flag => flag.text), ['also posts to the channel', 'posts under another name or icon'])
  assert.deepEqual(rowsOf(reply), ['+ text Done', '+ posts as deploy-bot', '+ icon :robot_face:'])
  assert.deepEqual(flagsOf('mutation P { slack_sendMessage(channel: "C1", replyBroadcast: true, text: "x") { ts } }'), [])
  assert.equal(reply.read?.query.includes('parent: slack_threadReplies'), true)
})

test('slack_sendMessage: blocks and attachments are bodies, a broadcast in blocks a flag; mrkdwn false reads as plain text', () => {
  const blocks = encodeURIComponent(JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text: '<!here> go' } }, { type: 'divider' }]))
  const block = blockOf(`mutation P { slack_sendMessage(channel: "C1", blocks: "${blocks}", attachments: "[{\\"text\\":\\"att\\"}]") { ts } }`)
  assert.deepEqual(rowsOf(block), ['+ blocks 2\u00a0lines · Slack\u00a0layout', '+ attachments att'])
  assert.deepEqual(block.flags.map(flag => flag.text), ['@here notifies who is active'])
  const plain = blockOf('mutation P { slack_sendMessage(channel: "C1", mrkdwn: false, text: "a <@U1>") { ts } }')
  assert.equal(plain.rows[0]?.text, 'a <@U1>')
  assert.equal(plain.rows[0]?.body?.format, 'text')
})

test('slack_updateMessage and slack_deleteMessage: the message by its ts in its channel; an edit keeps what it leaves out; a delete cannot be undone', () => {
  const edit = blockOf('mutation U { slack_updateMessage(channel: "C1", ts: "1728.0001", text: "<!channel> fixed") { ts } }')
  assert.equal(edit.target.words, 'message 1728.0001 · in C1')
  assert.deepEqual(rowsOf(edit), ['+ text @channel fixed'])
  assert.ok(edit.notes.includes('blocks and attachments it leaves out stay as they are'))
  assert.match(edit.flags[0]?.detail ?? '', /new text holds <!channel>/)
  assert.equal(edit.phrase, 'edits message 1728.0001 in C1')
  const drop = blockOf('mutation D { slack_deleteMessage(channel: "C1", ts: "1728.0001") { ts } }')
  assert.deepEqual(rowsOf(drop), ['- message 1728.0001'])
  assert.deepEqual(drop.flags.map(flag => flag.text), ['cannot be undone'])
})

test('Slack reactions: + and − with the emoji and its name', () => {
  const add = blockOf('mutation R { slack_addReaction(channel: "C1", name: "eyes", timestamp: "1728.0001") }')
  assert.equal(add.kind, 'react')
  assert.deepEqual(rowsOf(add), ['+ reaction 👀 :eyes:'])
  assert.equal(add.phrase, 'reacts 👀 :eyes: to message 1728.0001 in C1')
  const remove = blockOf('mutation R { slack_removeReaction(name: ":custom-thing:", channel: "C1", timestamp: "1728.0001") }')
  assert.deepEqual(rowsOf(remove), ['- reaction :custom-thing:'])
})

test('every hand-mapped root reads as mapped, with a target noun, a kind, a phrase and no row for an argument it skips', () => {
  for (const mapping of MAPPED) {
    const args = Object.entries(mapping.args).map(([name]) => `${name}: "1"`).join(', ')
    const block = blockOf(`mutation M { ${mapping.root}(${args}) }`)
    assert.equal(block.source, 'mapped', mapping.root)
    assert.equal(block.kind, mapping.kind, mapping.root)
    assert.ok(block.phrase !== '' && !block.phrase.includes('{'), `${mapping.root}: ${block.phrase}`)
    assert.ok(block.target.noun !== '', mapping.root)
    const skipped = Object.entries(mapping.args).filter(([, reading]) => reading.as === 'skip' || reading.as === 'target').map(([name]) => name)
    for (const row of block.rows) if (row.sign !== '-') assert.ok(!skipped.includes(row.card.arg), `${mapping.root} drew ${row.card.arg}`)
  }
})

// ---- Any other mutation: the generic reading

test("verbs: the first verb word, past modifiers, after nouns for a noun-first name; its kind by what it does", () => {
  assert.deepEqual(verbOf('incidentio_editIncident'), { verb: 'edit', noun: 'incident', kind: 'update' })
  assert.deepEqual(verbOf('ashby_openingUpdate'), { verb: 'update', noun: 'opening', kind: 'update' })
  assert.deepEqual(verbOf('jira_submitBulkDelete'), { verb: 'delete', noun: 'record', kind: 'delete' })
  assert.deepEqual(verbOf('pagerduty_createIncidentNote'), { verb: 'create', noun: 'incident note', kind: 'create' })
  assert.deepEqual(verbOf('slack_archiveConversation'), { verb: 'archive', noun: 'conversation', kind: 'delete' })
  assert.deepEqual(verbOf('omni_thing'), { verb: 'change', noun: 'thing', kind: 'update' })
})

test('generic: the required id-like argument names the record; every other set argument is a new value; a multi-line string a body', () => {
  const block = blockOf('mutation E { incidentio_editIncident(id: "01HX", notifyIncidentChannel: false, name: "DB failover", summary: "line one\\nline two", idempotencyKey: "k-1") { id } }')
  assert.equal(block.source, 'schema')
  assert.equal(block.target.words, 'incident 01HX')
  // The notify switch steers the write: a flag, not a new value.
  assert.deepEqual(rowsOf(block), ['+ name DB failover', '+ summary 2\u00a0lines · plain\u00a0text'])
  assert.deepEqual(block.flags.map(flag => flag.text), ['notifyIncidentChannel false: the incident channel is not told'])
  assert.equal(block.phrase, 'edits incident 01HX')
  assert.equal(block.how, "Read from the call and the schema: id names the incident; every other argument the call sets is a new value, and each row's card says what the schema says of it.")
  assert.deepEqual(block.notes, [NOT_READ])
  assert.equal(block.read, undefined)
})

test('generic: an input object reads as its fields, one level in and the next, the wrapper name dropped', () => {
  const block = blockOf('mutation C($in: Pagerduty_CreateIncidentInput) { pagerduty_createIncident(input: $in) { incident { id } } }', { in: { incident: { title: 'DB down', urgency: 'high', service: { id: 'PSVC1', type: 'service_reference' } } } })
  assert.equal(block.section, 'NEW INCIDENT')
  assert.deepEqual(rowsOf(block), ['+ incident.title DB down', '+ incident.urgency high', '+ incident.service id PSVC1'])
  assert.equal(block.rows[0]?.card.path, 'input.incident.title')
})

test('generic: a create goes on what its ids name; a delete shows its target as −; ids by type once the schema is read', () => {
  const note = blockOf('mutation N { pagerduty_createIncidentNote(id: "PINC1", input: { note: { content: "Paged" } }) { note { id } } }')
  assert.equal(note.target.words, 'on incident PINC1')
  assert.deepEqual(rowsOf(note), ['+ note.content Paged'])
  assert.equal(note.phrase, 'creates incident note on incident PINC1')
  const drop = blockOf('mutation D { zoom_deleteMeeting(meetingId: 123) }')
  assert.deepEqual(rowsOf(drop), ['- meeting 123'])
  assert.equal(drop.phrase, 'deletes meeting 123')
  // Typed: a `key` that is an input object is no id.
  const typed = annotate(irOf('mutation S { thing_setThing(key: "k1", value: "v") { id } }'), { schema: indexSdl(['type Mutation { thing_setThing(key: ID!, value: String): Thing }', 'type Thing { id: ID }']), isIncomplete: false })
  assert.equal(previewOf(typed)?.blocks[0]?.target.words, 'thing k1')
})

test('generic flags: notify… false and override… true; an unmapped Slack write still flags a broadcast', () => {
  assert.deepEqual(flagsOf('mutation O { x_updateThing(id: "1", overrideLock: true, notifyWatchers: false) { id } }'), ['admin override: overrideLock', 'notifyWatchers false: the watchers are not told'])
  assert.deepEqual(flagsOf('mutation O { x_updateThing(id: "1", notify: false) { id } }'), ['notify false: no notification is sent'])
  // Steering switches are no rows, whatever they are set to; anything else named so is.
  assert.deepEqual(rowsOf(blockOf('mutation O { x_updateThing(id: "1", notifyWatchers: true, overrideLock: "false", notifyText: "hi", name: "n") { id } }')), ['+ notifyText hi', '+ name n'])
  assert.deepEqual(flagsOf('mutation S { slack_scheduleMessage(channel: "C1", postAt: "1", text: "<!here> soon") { id } }'), ['@here notifies who is active'])
})

// ---- Escaping and bounds

test('every string the model sent is escaped: values, targets, bodies and the phrase', () => {
  const evil = `x${ESC}[31m\u202eY`
  const block = blockOf('mutation E($k: String!, $f: Jira_JSON) { jira_editIssue(issueIdOrKey: $k, fields: $f) }', { k: evil, f: { summary: evil, description: ADF(evil), [evil]: 1 } })
  // `back` is the one raw part: what RESULT compares the response with, never drawn.
  const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])
  const all = strings({ ...block, rows: block.rows.map(({ back: _raw, ...row }) => row) })
  assert.ok(all.length > 10)
  for (const one of all) assert.ok(!one.includes(ESC) && !one.includes('\u202e'), one)
  assert.match(block.target.words, /\\x1b\[31m/)
  assert.match(block.phrase, /\\x1b/)
})

test('rows past MAX_ROWS are counted, not kept; a list value says how many more', () => {
  const fields = Object.fromEntries(Array.from({ length: MAX_ROWS + 10 }, (_, i) => [`f${i}`, i]))
  const block = blockOf('mutation E($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", fields: $f) }', { f: fields })
  assert.equal(block.rows.length, MAX_ROWS)
  assert.equal(block.more, 10)
  assert.match(shortValue(Array.from({ length: 30 }, (_, i) => `l${i}`)), /· \+10 more$/)
})

test('a short value: named objects by name, null as none, an empty string said, whitespace laid flat, JSON strings parsed', () => {
  assert.equal(shortValue({ name: 'Done', id: '3' }), 'Done')
  assert.equal(shortValue({ accountId: 'acc' }), 'acc')
  assert.equal(shortValue({ id: 7 }), 'id 7')
  assert.equal(shortValue({ other: true }), '{"other":true}')
  assert.equal(shortValue(null), 'none')
  assert.equal(shortValue([]), 'none')
  assert.equal(shortValue(''), '(empty)')
  assert.equal(shortValue('a\n\n  b'), 'a b')
  assert.equal(shortValue('["x","y"]'), 'x · y')
})

test('a huge body is flattened under its bounds and never throws; the row says how many lines', () => {
  const huge = '<p>x</p>'.repeat(20_000)
  const block = blockOf('mutation P($b: String!) { confluence_updatePage(id: "1", status: "current", title: "T", bodyRepresentation: "storage", bodyValue: $b, versionNumber: 2) { id } }', { b: huge })
  const body = block.rows.find(row => row.label === 'body')
  assert.equal(body?.body?.total, 20_000)
  assert.ok((body?.body?.lines.length ?? 0) <= 5_000)
  assert.match(body?.text ?? '', /^20,000\u00a0lines/)
})

test('previewOf never throws on odd arguments', () => {
  for (const op of [
    'mutation A { jira_doTransition(issueIdOrKey: null, transition: null, fields: null, update: [1, null, {}]) }',
    'mutation A { slack_sendMessage(channel: 123, text: null, blocks: 5) { ts } }',
    'mutation A { confluence_updatePage(id: "1", bodyRepresentation: 7, bodyValue: { a: 1 }) { id } }',
    'mutation A { x_doThing(input: { a: { b: { c: { d: 1 } } } }) { id } }',
    'mutation A { jira_editIssue(issueIdOrKey: "D-1", update: { labels: "notalist", comment: [{ add: { body: 7 } }] }) }',
  ]) {
    assert.doesNotThrow(() => previewOf(irOf(op)), op)
    assert.ok(previewOf(irOf(op)) !== undefined, op)
  }
})

test('a row label is laid flat: a key the model wrote with a newline or a tab in it is one line, as the planner counts it', () => {
  const edit = blockOf('mutation E($f: Jira_JSON, $u: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", fields: $f, update: $u) }', { f: { 'summary\nDEV-9 closed': 'x', ok: 'y' }, u: { 'labels\n\tx': [{ add: 'z' }] } })
  assert.deepEqual(edit.rows.map(row => row.label), ['summary DEV-9 closed', 'ok', 'labels x'])
  const generic = blockOf('mutation E($i: X_Input) { foo_updateThing(id: "1", input: $i) }', { i: { 'a\nb': 'x', c: { 'd\ne': 1 } } })
  assert.deepEqual(generic.rows.map(row => row.label), ['a b', 'c.d e'])
  for (const block of [edit, generic]) for (const row of block.rows) assert.doesNotMatch(`${row.label}${row.card.path ?? ''}`, /[\n\r\t]/)
})

test('a block says how it was read in the reader\'s words, with no internals; a list set through fields replaces the whole list, one changed through update does not', () => {
  assert.equal(blockOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "31" }) }').how, "Read with a built-in mapping for jira_doTransition: issueIdOrKey names the issue; each row's card says what its argument means.")
  assert.equal(blockOf('mutation C { jira_addComment(issueIdOrKey: "DEV-1", body: "hi") }').how, "Read with a built-in mapping for jira_addComment: issueIdOrKey says where it goes; each row's card says what its argument means.")
  for (const block of [blockOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: "31" }) }'), blockOf('mutation E { x_updateThing(id: "1", name: "n") { id } }')]) assert.doesNotMatch(block.how, /hand-mapped|table/)
  const edit = blockOf('mutation E($f: Jira_JSON, $u: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", fields: $f, update: $u) }', { f: { labels: ['a'] }, u: { labels: [{ add: 'b' }] } })
  const [set, added] = edit.rows
  assert.match(set?.card.meaning ?? '', /^sets labels: free-form tags on the issue; setting it here replaces the whole list$/)
  assert.doesNotMatch(added?.card.meaning ?? '', /replaces the whole list/)
  assert.match(added?.card.meaning ?? '', /free-form tags on the issue/)
})

test('a transition the call names by a bare id says it in the phrase, as an object id does', () => {
  assert.equal(changePhrase(irOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: "41") }')), 'DEV-1 → transition 41')
  assert.equal(changePhrase(irOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1", transition: { id: 41 }) }')), 'DEV-1 → transition 41')
  assert.equal(changePhrase(irOf('mutation T($t: Jira_JSON) { jira_doTransition(issueIdOrKey: "DEV-1", transition: $t) }', { t: '31' })), 'DEV-1 → transition 31')
  assert.equal(changePhrase(irOf('mutation T { jira_doTransition(issueIdOrKey: "DEV-1") }')), 'DEV-1 → transition ?')
})

// ---- Keys the model writes that an object inherits: never looked up as the object's own

const PROTO_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
/** What a lookup that found Object.prototype's member would leave in the words. */
const INHERITED = /native code|\[object|undefined|function /

test("Jira's update operations named like an object's own members read as unknown operations, each with a sign and words", () => {
  for (const key of PROTO_KEYS) {
    const update = JSON.parse(`{"labels":[{${JSON.stringify(key)}:"x"}],${JSON.stringify(key)}:[{"add":"y"}]}`)
    const block = blockOf('mutation M($u: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", update: $u) }', { u: update })
    assert.ok(block.rows.length >= 2, key)
    for (const row of block.rows) {
      assert.ok(['+', '-', '±', ' '].includes(row.sign), `${key}: ${String(row.sign)}`)
      assert.equal(typeof row.card.meaning, 'string', key)
      assert.doesNotMatch(row.card.meaning, INHERITED, key)
    }
  }
})

test("Jira's fields and a mapped root's arguments named like an object's own members read as plain fields and values", () => {
  const fields = JSON.parse(`{${PROTO_KEYS.map(key => `${JSON.stringify(key)}:"v"`).join(',')}}`)
  const block = blockOf('mutation M($f: Jira_JSON) { jira_editIssue(issueIdOrKey: "DEV-1", fields: $f) }', { f: fields })
  assert.deepEqual(block.rows.map(row => row.label).sort(), [...PROTO_KEYS].sort())
  for (const row of block.rows) assert.doesNotMatch(row.card.meaning, INHERITED, row.label)
  // An argument the table does not list, named `constructor`, is a value it sets, not a reading the table inherits.
  const comment = blockOf('mutation M { jira_addComment(issueIdOrKey: "DEV-1", constructor: "x", toString: "y", body: "hi") }')
  assert.deepEqual(rowsOf(comment), ['+ constructor x', '+ toString y', '+ body hi'])
})

test("a target whose noun is an object's own member's name gets the plain lesson, and paging and flags read such names as plain fields", () => {
  const block = blockOf('mutation M { foo_deleteConstructor(constructorId: "1") }')
  assert.equal(block.target.noun, 'constructor')
  assert.equal(own({ issue: 'x' }, 'constructor'), undefined)
  assert.equal(own({ issue: 'x' }, '__proto__'), undefined)
  assert.equal(own({ issue: 'x' }, 'issue'), 'x')
})
