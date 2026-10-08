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
 * A write verb opens the field name or an underscore-delimited suffix.
 * Services may have underscores in their names, so every suffix is checked.
 * This conservative heuristic may also flag read names containing a write
 * word, such as `get_issue_update_history`. Match exact verb words so
 * `issueComments` and `closedIssues` remain unflagged.
 */
export function isWriteName(name: string): boolean {
  return name.split('_').some(part => {
    const verb = wordsOf(part)[0]
    return verb !== undefined && WRITES.has(verb)
  })
}
