import assert from 'node:assert/strict'
import { test } from 'node:test'

import { accessOf, payloadOf, scopeFor, sdlOf, validationOf } from '../../src/gas.ts'

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError,
})

// Shapes as Agent Services returns them (trimmed).
const VALIDATE_BAD = {
  bundleDigest: 'a1b2c3d4',
  errors: [
    'Error: expected value of type String!, found an integer\n     ╭─[ operation.graphql:1:36 ]\n─────╯\nError: type `Confluence_SearchResultItem` does not have a field `nosuchfield`\n      ╭─[ operation.graphql:1:57 ]\n──────╯\n',
  ],
  requestId: '01HZZZZZZZZZZZZZZZZZZZZREQ',
  scope: 'confluence',
  valid: false,
}
const DRY_RUN = {
  bundleDigest: 'e5f6a7b8',
  results: [
    {
      denyOperation: false,
      fields: [
        { decision: 'allow', path: 'confluence_search' },
        { decision: 'mask', path: 'confluence_search.results.excerpt' },
        { decision: 'deny', path: 'confluence_search.results.url', denialContext: 'tok_123' },
        { decision: 'shrug', path: 'confluence_search.results.title' },
      ],
    },
  ],
}
const AUTH_REQUIRED = {
  data: null,
  errors: [
    { extensions: { code: 'SUBREQUEST_HTTP_ERROR', service: 'confluence' }, message: '401' },
    {
      extensions: {
        code: 'UPSTREAM_AUTH_REQUIRED',
        service: 'confluence',
        sources: [{ authorizationUrl: 'https://gas.example.com/auth/confluence/link', name: 'confluence' }],
      },
      message: 'Authorization required',
    },
  ],
}
const SCOPES = ['acme-customer-data', 'confluence', 'google-docs', 'google-drive', 'jira', 'slack']

test('payloadOf reads the JSON text block and its bundleDigest', () => {
  const payload = payloadOf(text(VALIDATE_BAD))
  assert.equal(payload.ok, true)
  assert.equal(payload.ok && payload.bundleDigest, 'a1b2c3d4')
})

test('payloadOf reports content it cannot read', () => {
  assert.deepEqual(payloadOf({ content: [], isError: false }), { ok: false, error: 'no text content' })
  assert.deepEqual(payloadOf(text('not json')), { ok: false, error: 'content is not JSON' })
  assert.deepEqual(payloadOf(text('[1,2]')), { ok: false, error: 'content is not a JSON object' })
  assert.deepEqual(payloadOf(text('upstream exploded', true)), { ok: false, error: 'upstream exploded' })
})

test('validationOf splits one errors string into one diagnostic per Error block', () => {
  const validation = validationOf(VALIDATE_BAD)
  assert.equal(validation.valid, false)
  assert.equal(validation.diagnostics.length, 2)
  assert.match(validation.diagnostics[0]!, /^Error: expected value of type String!/)
  assert.match(validation.diagnostics[1]!, /does not have a field `nosuchfield`/)
})

test('validationOf of a valid operation has no diagnostics', () => {
  assert.deepEqual(validationOf({ valid: true, scope: 'confluence' }), { valid: true, diagnostics: [] })
})

test('validationOf treats a missing valid flag as invalid', () => {
  assert.equal(validationOf({}).valid, false)
})

test('accessOf maps paths to decisions and drops unknown decisions', () => {
  const access = accessOf(DRY_RUN.results[0])!
  assert.equal(access.denyOperation, false)
  assert.deepEqual(access.fields.get('confluence_search'), { decision: 'allow' })
  assert.deepEqual(access.fields.get('confluence_search.results.excerpt'), { decision: 'mask' })
  assert.deepEqual(access.fields.get('confluence_search.results.url'), { decision: 'deny', denialContext: 'tok_123' })
  assert.equal(access.fields.has('confluence_search.results.title'), false)
})

test('accessOf of a malformed result is undefined', () => {
  assert.equal(accessOf(null), undefined)
  assert.equal(accessOf({ denyOperation: true }), undefined)
})

test('sdlOf keeps only strings', () => {
  assert.deepEqual(sdlOf({ types: ['type A { a: Int }', 3, null] }), ['type A { a: Int }'])
  assert.deepEqual(sdlOf({}), [])
})

test('scopeFor maps the root-field prefix to a scope', () => {
  assert.equal(scopeFor('confluence_search', SCOPES), 'confluence')
  assert.equal(scopeFor('jira_searchIssues', SCOPES), 'jira')
})

test('scopeFor reads hyphens in scopes as underscores', () => {
  assert.equal(scopeFor('acme_customer_data_lookup', SCOPES), 'acme-customer-data')
  assert.equal(scopeFor('google_docs_get', SCOPES), 'google-docs')
})

test('scopeFor needs the whole prefix plus an underscore', () => {
  assert.equal(scopeFor('confluencesearch', SCOPES), undefined)
  assert.equal(scopeFor('google_get', SCOPES), undefined)
  assert.equal(scopeFor('__typename', SCOPES), undefined)
})

test('scopeFor prefers the longest matching scope', () => {
  assert.equal(scopeFor('google_docs_get', ['google', 'google-docs']), 'google-docs')
})
