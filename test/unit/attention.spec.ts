import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { attentionOf } from '../../src/attention.ts'
import type { CallIR, FieldIR, OpType } from '../../src/ir.ts'

function field(coordinate: string, extra: Partial<FieldIR> = {}): FieldIR {
  const name = coordinate.slice(coordinate.indexOf('.') + 1)
  return { name, coordinate, path: name, args: [], policy: 'allow', children: [], ...extra }
}

function call(opType: OpType, roots: FieldIR[]): CallIR {
  return { toolCallId: 't', opType, state: 'ready', roots }
}

describe('attentionOf', () => {
  test('a plain read marks nothing, whatever the field is called', () => {
    const ir = call('query', [field('Query.search', { children: [field('R.count'), field('R.title'), field('R.totalSize')] })])
    assert.deepEqual(attentionOf(ir), [])
  })

  test('personal-data field names are marked "personal data"', () => {
    const ir = call('query', [field('Query.users', { children: [field('User.emailAddress'), field('User.displayName'), field('User.id')] })])
    assert.deepEqual(attentionOf(ir), [
      { coordinate: 'User.emailAddress', reason: 'personal data' },
      { coordinate: 'User.displayName', reason: 'personal data' },
    ])
  })

  test('masked and denied fields are marked, and win over personal data', () => {
    const ir = call('query', [
      field('Query.q', {
        children: [field('R.excerpt', { policy: 'mask' }), field('R.body', { policy: 'deny' }), field('R.email', { policy: 'mask' }), field('R.url', { policy: 'unknown' })],
      }),
    ])
    assert.deepEqual(attentionOf(ir), [
      { coordinate: 'R.excerpt', reason: 'masked' },
      { coordinate: 'R.body', reason: 'denied' },
      { coordinate: 'R.email', reason: 'masked' },
    ])
  })

  test('a mutation root is marked with no words, since its CHANGES block says what it writes; a destructive name on a query says so', () => {
    assert.deepEqual(attentionOf(call('mutation', [field('Mutation.jira_createIssue')])), [{ coordinate: 'Mutation.jira_createIssue', reason: '' }])
    assert.deepEqual(attentionOf(call('mutation', [field('Mutation.jira_deleteIssue')])), [{ coordinate: 'Mutation.jira_deleteIssue', reason: '' }])
    assert.deepEqual(attentionOf(call('query', [field('Query.jira_deleteIssue')])), [{ coordinate: 'Query.jira_deleteIssue', reason: 'destructive name' }])
  })

  test('a subscription, a no-limit read and an unknown policy mark nothing; reasons stay short', () => {
    assert.deepEqual(attentionOf(call('subscription', [field('Subscription.events', { policy: 'unknown' })])), [])
    const ir = call('mutation', [field('Mutation.destroyEverything', { children: [field('X.phone', { policy: 'deny' })] })])
    for (const { reason } of attentionOf(ir)) assert.ok(reason.length <= 20, reason)
  })
})
