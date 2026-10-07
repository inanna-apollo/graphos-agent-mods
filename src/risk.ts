// Risk signals the header derives from real field names. Pure: no $.
//
// The verb badge comes from the operation type, but a query can still write
// (GraphQL does not stop a query field's resolver from writing), so a
// destructive-sounding root name is flagged whatever the operation type.

const DESTRUCTIVE = new Set(['delete', 'remove', 'archive', 'revoke', 'destroy', 'purge', 'drop', 'wipe', 'erase', 'truncate'])

/** Words of a camelCase / snake_case / kebab-case name, lowercased. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())
}

export function isDestructiveName(name: string): boolean {
  return wordsOf(name).some(word => DESTRUCTIVE.has(word))
}

/** Verbs a name opens with when the field changes data: what Agent Services can expose as a query field. */
const WRITES = new Set(['create', 'update', 'add', 'set', 'post', 'send', 'transition', 'assign', 'edit', 'modify', 'move', 'close', 'merge', 'publish', 'invite', 'submit', 'approve', 'reject', 'upsert', 'insert', 'patch', 'put', 'cancel', 'resolve', 'reopen', 'trigger', 'enable', 'disable'])

/**
 * The field's own name (after its service prefix: `createIssue` in
 * `jira_createIssue`) opens with a verb that changes data. Only the opening
 * verb counts, so `issueComments` or `closedIssues` never do.
 */
export function isWriteName(name: string): boolean {
  const first = wordsOf(name.slice(name.lastIndexOf('_') + 1))[0]
  return first !== undefined && WRITES.has(first)
}
