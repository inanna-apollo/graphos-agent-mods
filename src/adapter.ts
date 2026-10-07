// Agent Services execute input → { operation, variables }. Pure: no $.
//
// `variables` arrives as an object or as a JSON-encoded string (the
// apollo-mcp-server contract). Anything we cannot read is reported, not
// guessed at, so the pane can show the raw input instead.

export type ExecuteInput = {
  operation: string
  variables: Record<string, unknown>
}

export type Adapted =
  | { ok: true; input: ExecuteInput }
  | { ok: false; error: string; operation: string; variables: string }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const show = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function adaptExecute(raw: { operation?: unknown; variables?: unknown }): Adapted {
  const { operation, variables } = raw
  const fail = (error: string): Adapted => ({
    ok: false,
    error,
    operation: typeof operation === 'string' ? operation : show(operation),
    variables: variables === undefined ? '' : show(variables),
  })

  if (typeof operation !== 'string') return fail('operation is not a string')
  if (variables === undefined || variables === null) return { ok: true, input: { operation, variables: {} } }

  if (typeof variables === 'string') {
    if (variables.trim() === '') return { ok: true, input: { operation, variables: {} } }
    let parsed: unknown
    try {
      parsed = JSON.parse(variables)
    } catch {
      return fail('variables is a string that is not valid JSON')
    }
    if (!isPlainObject(parsed)) return fail('variables is not a JSON object')
    return { ok: true, input: { operation, variables: parsed } }
  }

  if (!isPlainObject(variables)) return fail('variables is not an object')
  return { ok: true, input: { operation, variables } }
}
