import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalize } from '../../src/normalize.ts'
import { isDestructiveName, isWriteName } from '../../src/risk.ts'
import { MAPPED, mappingOf } from '../../src/preview/table.ts'
import type { Mapping, ReadSpec } from '../../src/preview/table.ts'
import { Kind, parse } from '../../src/vendor/graphql.js'
import type { OperationDefinitionNode } from '../../src/vendor/graphql.js'

/** Every argument each hand-mapped root takes, as the Agent Services schema has it (as read on Oct 7 2026). */
const SIGNATURES: Record<string, string[]> = {
  jira_doTransition: ['issueIdOrKey', 'transition', 'fields', 'update', 'historyMetadata', 'properties'],
  jira_editIssue: ['issueIdOrKey', 'notifyUsers', 'overrideScreenSecurity', 'overrideEditableFlag', 'returnIssue', 'expand', 'fields', 'historyMetadata', 'properties', 'transition', 'update'],
  jira_assignIssue: ['issueIdOrKey', 'accountId', 'key', 'name'],
  jira_addComment: ['issueIdOrKey', 'expand', 'body', 'properties', 'visibility'],
  jira_updateComment: ['issueIdOrKey', 'id', 'notifyUsers', 'overrideEditableFlag', 'expand', 'body', 'properties', 'visibility'],
  jira_deleteComment: ['issueIdOrKey', 'id'],
  jira_deleteIssue: ['issueIdOrKey', 'deleteSubtasks'],
  jira_createIssue: ['updateHistory', 'fields', 'historyMetadata', 'properties', 'transition', 'update'],
  confluence_createPage: ['spaceId', 'title', 'status', 'parentId', 'bodyRepresentation', 'bodyValue'],
  confluence_updatePage: ['id', 'status', 'title', 'spaceId', 'parentId', 'bodyRepresentation', 'bodyValue', 'versionNumber', 'versionMessage'],
  confluence_deletePage: ['id'],
  confluence_createBlogPost: ['spaceId', 'title', 'status', 'bodyRepresentation', 'bodyValue'],
  confluence_updateBlogPost: ['id', 'status', 'title', 'bodyRepresentation', 'bodyValue', 'versionNumber', 'spaceId', 'versionMessage'],
  confluence_deleteBlogPost: ['id'],
  confluence_createFooterComment: ['pageId', 'blogPostId', 'parentCommentId', 'bodyRepresentation', 'bodyValue'],
  confluence_createInlineComment: ['bodyRepresentation', 'bodyValue', 'pageId', 'blogPostId', 'parentCommentId', 'inlineMarkerRef', 'inlineOriginalSelection'],
  confluence_updateFooterComment: ['id', 'bodyRepresentation', 'bodyValue', 'versionNumber', 'versionMessage'],
  confluence_updateInlineComment: ['id', 'bodyRepresentation', 'bodyValue', 'versionNumber', 'versionMessage', 'resolved'],
  confluence_deleteFooterComment: ['id'],
  confluence_deleteInlineComment: ['id'],
  slack_sendMessage: ['channel', 'text', 'threadTs', 'blocks', 'attachments', 'replyBroadcast', 'mrkdwn', 'unfurlLinks', 'unfurlMedia', 'username', 'iconEmoji', 'iconUrl'],
  slack_updateMessage: ['channel', 'ts', 'text', 'blocks', 'attachments'],
  slack_deleteMessage: ['channel', 'ts'],
  slack_addReaction: ['channel', 'name', 'timestamp'],
  slack_removeReaction: ['name', 'channel', 'timestamp', 'file', 'fileComment'],
}

const readsOf = (mapping: Mapping): ReadSpec[] => [...(mapping.read === undefined ? [] : [mapping.read]), ...(mapping.readWhen === undefined ? [] : [mapping.readWhen.read])]

test('the table maps the common Jira, Confluence and Slack writes, each once, by its real root name', () => {
  assert.equal(MAPPED.length, Object.keys(SIGNATURES).length)
  assert.equal(new Set(MAPPED.map(mapping => mapping.root)).size, MAPPED.length)
  for (const root of Object.keys(SIGNATURES)) assert.equal(mappingOf(root)?.root, root)
  assert.equal(mappingOf('jira_getIssue'), undefined)
  assert.equal(mappingOf('__proto__'), undefined)
})

test('every mapping reads exactly the arguments its root takes, names its target by them, and says its change in a phrase over them', () => {
  for (const mapping of MAPPED) {
    const args = SIGNATURES[mapping.root] ?? []
    assert.deepEqual(Object.keys(mapping.args).sort(), [...args].sort(), mapping.root)
    for (const name of [...(mapping.target.id ?? []), ...(mapping.target.where ?? []).map(where => where.arg)]) assert.ok(args.includes(name.split('.')[0] ?? ''), `${mapping.root}: target ${name}`)
    for (const template of [mapping.phrase, mapping.phraseWhen?.phrase ?? '']) {
      for (const [, token] of template.matchAll(/\{([^{}]+)\}/g)) {
        if (token === 'target' || token === 'labels' || token?.startsWith('row:')) continue
        assert.ok(args.includes(token?.split('.')[0] ?? ''), `${mapping.root}: phrase token ${token}`)
      }
    }
    if (mapping.sectionWhen !== undefined) assert.ok(args.includes(mapping.sectionWhen.arg), mapping.root)
    if (mapping.kind === 'delete') assert.ok(mapping.removal !== undefined, `${mapping.root} says what a delete leaves`)
  }
})

test('every stored read (v2, never run here) passes the read-only floor: one named query, no directive, no root named for a change, no updateHistory', () => {
  let reads = 0
  for (const mapping of MAPPED) {
    for (const read of readsOf(mapping)) {
      reads += 1
      const doc = parse(read.query, { noLocation: true })
      assert.equal(doc.definitions.length, 1, mapping.root)
      const op = doc.definitions[0] as OperationDefinitionNode
      assert.equal(op.kind, Kind.OPERATION_DEFINITION, mapping.root)
      assert.equal(op.operation, 'query', mapping.root)
      assert.ok(op.name !== undefined, `${mapping.root}: the gateway rejects anonymous operations`)
      assert.doesNotMatch(read.query, /@\w/, `${mapping.root}: a directive`)
      assert.doesNotMatch(read.query, /updateHistory/, `${mapping.root}: Jira's recently viewed`)
      const normalized = normalize(read.query, {})
      assert.ok(normalized.ok, mapping.root)
      if (!normalized.ok) continue
      assert.ok(normalized.roots.length > 0, mapping.root)
      for (const root of normalized.roots) {
        assert.ok(!isWriteName(root.name) && !isDestructiveName(root.name), `${mapping.root}: ${root.name} is named for a change`)
        assert.ok(root.children.length > 0, `${mapping.root}: ${root.name} selects something`)
      }
    }
  }
  assert.ok(reads >= 20)
})

test("a stored read takes the call's values only as variables: each one it declares is mapped to an argument of the mutation, and each mapped one is declared", () => {
  for (const mapping of MAPPED) {
    const args = SIGNATURES[mapping.root] ?? []
    for (const read of readsOf(mapping)) {
      const op = parse(read.query, { noLocation: true }).definitions[0] as OperationDefinitionNode
      const declared = (op.variableDefinitions ?? []).map(one => one.variable.name.value).sort()
      assert.deepEqual(declared, Object.keys(read.variables).sort(), mapping.root)
      for (const [name, source] of Object.entries(read.variables)) {
        const paths = typeof source === 'string' ? [source] : 'path' in source ? [source.path] : source.keysOf
        for (const path of paths) assert.ok(args.includes(path.split('.')[0] ?? ''), `${mapping.root}: $${name} takes ${path}`)
      }
      // No value of the call is spliced into the text: only string literals the table wrote itself.
      for (const arg of args) assert.doesNotMatch(read.query, new RegExp(`\\{${arg}\\}`), mapping.root)
      for (const pair of read.pairs ?? []) {
        assert.match(pair.before, /^read:/, mapping.root)
        assert.match(pair.after, /^(read|arg):/, mapping.root)
        if (pair.after.startsWith('arg:')) assert.ok(args.includes(pair.after.slice(4).split('.')[0] ?? ''), mapping.root)
      }
    }
  }
})

test('stored-read checks identify mutations, write fields and directives', () => {
  // Apply the stored-read checks to queries containing these unsupported operations.
  assert.equal(parse('mutation X { jira_deleteIssue(issueIdOrKey: "D-1") }', { noLocation: true }).definitions.length, 1)
  const mutation = normalize('mutation X { jira_deleteIssue(issueIdOrKey: "D-1") }', {})
  assert.ok(mutation.ok && mutation.opType === 'mutation')
  const disguised = normalize('query X { jira_deleteIssue(issueIdOrKey: "D-1") }', {})
  assert.ok(disguised.ok && disguised.roots.some(root => isDestructiveName(root.name)))
  const changed = normalize('query X { jira_editIssue(issueIdOrKey: "D-1") }', {})
  assert.ok(changed.ok && changed.roots.some(root => isWriteName(root.name)))
  assert.match('query X @live { a }', /@\w/)
})
