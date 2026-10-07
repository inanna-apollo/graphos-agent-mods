import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isDestructiveName, wordsOf } from '../../src/risk.ts'

test('flags destructive verbs in any casing style', () => {
  for (const name of ['jira_deleteIssue', 'deleteAllPages', 'slack_archiveChannel', 'revokeToken', 'delete_issue', 'remove-member', 'DELETE_ALL']) {
    assert.equal(isDestructiveName(name), true, name)
  }
})

test('does not flag read-only names', () => {
  for (const name of ['confluence_search', 'getIssue', 'listChannels']) assert.equal(isDestructiveName(name), false, name)
})

test("'select' is not 'delete': matching is by whole word", () => {
  assert.equal(isDestructiveName('selectedItems'), false)
  assert.equal(isDestructiveName('dropdownOptions'), false)
})

// Decision: 'undelete' is one word, not in the destructive list, so it is not
// flagged. Restoring something is not destructive.
test('undelete is not flagged', () => {
  assert.equal(isDestructiveName('undeleteIssue'), false)
})

test('wordsOf splits camel, snake and kebab names', () => {
  assert.deepEqual(wordsOf('jira_deleteIssue'), ['jira', 'delete', 'issue'])
  assert.deepEqual(wordsOf('remove-member'), ['remove', 'member'])
  assert.deepEqual(wordsOf('getHTTPServer'), ['get', 'http', 'server'])
})
