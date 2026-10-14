import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyCache, enrichSchema } from '../../src/enrich.ts'
import { accessFromIR, adaptLookup, settledLookup } from '../../src/lookup.ts'

const answer = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false })

test('a mixed dry run preserves each request’s schema kind and policy, including repeated roots', async () => {
  const adapted = adaptLookup('dry_run', { requests: [
    { scope: 'acme', operation: 'query Read { acme_item { id } }' },
    { scope: 'acme', operation: 'mutation Write { acme_item { id } }' },
    { scope: 'acme', operation: 'query Again { acme_item { id } }' },
  ] })
  const { ir } = settledLookup('batch', 'dry_run', adapted, { results: [
    { fields: [{ path: 'acme_item.id', decision: 'allow' }] },
    { fields: [{ path: 'acme_item.id', decision: 'deny' }] },
    { fields: [{ path: 'acme_item.id', decision: 'mask' }] },
  ] }, 100)
  const searches: unknown[] = []
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'search') {
      searches.push(args.operationType)
      const owner = args.operationType === 'query' ? 'Query' : 'Mutation'
      const type = args.operationType === 'query' ? 'ReadItem' : 'WrittenItem'
      return answer({ results: [{ operationName: 'acme_item', types: [`type ${owner} { acme_item: ${type} }`] }] })
    }
    assert.equal(tool, 'introspect')
    return answer({ types: [`type ${String(args.type)} { id: ID! }`] })
  }
  const done = await enrichSchema(call, emptyCache(), ir, {
    access: accessFromIR(ir), checks: { policy: 'ok', validation: 'skipped', schema: 'skipped' },
  })
  assert.deepEqual(new Set(searches), new Set(['query', 'mutation']))
  assert.deepEqual(done.roots.map(root => ({
    request: root.request,
    coordinate: root.coordinate,
    type: root.schema?.type,
    child: root.children.map(child => [child.path, child.coordinate, child.policy]),
  })), [
    { request: { index: 0, opType: 'query' }, coordinate: 'Query.acme_item', type: 'ReadItem', child: [['acme_item.id', 'ReadItem.id', 'allow']] },
    { request: { index: 1, opType: 'mutation' }, coordinate: 'Mutation.acme_item', type: 'WrittenItem', child: [['r2:acme_item.id', 'WrittenItem.id', 'deny']] },
    { request: { index: 2, opType: 'query' }, coordinate: 'Query.acme_item', type: 'ReadItem', child: [['r3:acme_item.id', 'ReadItem.id', 'mask']] },
  ])
})

test('older stored lookups without request metadata still enrich using their operation kind', async () => {
  const adapted = adaptLookup('dry_run', { requests: [{ scope: 'acme', operation: 'query Read { acme_item }' }] })
  const { ir } = settledLookup('old', 'dry_run', adapted, { results: [{ fields: [{ path: 'acme_item', decision: 'allow' }] }] }, 10)
  ir.roots = ir.roots.map(({ request: _old, ...root }) => root)
  const call = async (tool: string, args: Record<string, unknown>) => {
    assert.equal(tool, 'search')
    assert.equal(args.operationType, 'query')
    return answer({ results: [{ operationName: 'acme_item', types: ['type Query { acme_item: ID! }'] }] })
  }
  const done = await enrichSchema(call, emptyCache(), ir, {
    access: accessFromIR(ir), checks: { policy: 'ok', validation: 'skipped', schema: 'skipped' },
  })
  assert.equal(done.roots[0]?.coordinate, 'Query.acme_item')
  assert.equal(done.roots[0]?.schema?.type, 'ID!')
  assert.equal(done.roots[0]?.policy, 'allow')
})
