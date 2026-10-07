// Shared tokenizer and line layout for CQL and JQL.
//
// Safety rules: every character of the (escaped) input reaches the output in
// order; only whitespace outside quotes is collapsed or added. Anything that
// does not parse cleanly (unbalanced quote or paren, newline inside a quote)
// returns the fallback.
import { escapeText } from '../escape.ts'
import { renderFallback } from './fallback.ts'
import { isTooLong, seg } from './types.ts'
import type { Rendered, Segment } from './types.ts'

type Tok = { kind: 'ws' | 'str' | 'open' | 'close' | 'word' | 'sym' | 'comma'; text: string }

const SYMBOLS = '=!~<>'
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t'

function tokenize(input: string): Tok[] | undefined {
  const toks: Tok[] = []
  let depth = 0
  let i = 0
  while (i < input.length) {
    const c = input.charAt(i)
    if (isSpace(c)) {
      let j = i
      while (j < input.length && isSpace(input.charAt(j))) j++
      toks.push({ kind: 'ws', text: input.slice(i, j) })
      i = j
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let closed = false
      while (j < input.length) {
        const d = input.charAt(j)
        if (d === '\n' || d === '\r') return undefined
        if (d === '\\') {
          j += 2
          continue
        }
        if (d === c) {
          closed = true
          break
        }
        j++
      }
      if (!closed) return undefined
      toks.push({ kind: 'str', text: input.slice(i, j + 1) })
      i = j + 1
    } else if (c === '(') {
      depth++
      toks.push({ kind: 'open', text: c })
      i++
    } else if (c === ')') {
      depth--
      if (depth < 0) return undefined
      toks.push({ kind: 'close', text: c })
      i++
    } else if (c === ',') {
      toks.push({ kind: 'comma', text: c })
      i++
    } else if (SYMBOLS.includes(c)) {
      let j = i
      while (j < input.length && SYMBOLS.includes(input.charAt(j))) j++
      toks.push({ kind: 'sym', text: input.slice(i, j) })
      i = j
    } else {
      let j = i
      while (j < input.length) {
        const d = input.charAt(j)
        if (isSpace(d) || d === '"' || d === "'" || d === '(' || d === ')' || d === ',' || SYMBOLS.includes(d)) break
        j++
      }
      toks.push({ kind: 'word', text: input.slice(i, j) })
      i = j
    }
  }
  return depth === 0 ? toks : undefined
}

/** Joins tokens, collapsing whitespace outside quotes to one space. */
const join = (toks: Tok[]): string =>
  toks
    .map(t => (t.kind === 'ws' ? ' ' : t.text))
    .join('')
    .trim()

type Clause = { connector: string; toks: Tok[] }

function splitClauses(toks: Tok[]): Clause[] {
  const clauses: Clause[] = []
  let current: Clause = { connector: '', toks: [] }
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === undefined) break
    if (t.kind === 'open') depth++
    if (t.kind === 'close') depth--
    if (depth === 0 && t.kind === 'word') {
      if (/^(and|or)$/i.test(t.text)) {
        clauses.push(current)
        current = { connector: t.text, toks: [] }
        continue
      }
      if (/^order$/i.test(t.text)) {
        let j = i + 1
        while (toks[j]?.kind === 'ws') j++
        const by = toks[j]
        if (by !== undefined && by.kind === 'word' && /^by$/i.test(by.text)) {
          clauses.push(current)
          // The rest of the input belongs to the ORDER BY clause.
          clauses.push({ connector: `${t.text} ${by.text}`, toks: toks.slice(j + 1) })
          return clauses.filter(isNotEmptyLeader)
        }
      }
    }
    current.toks.push(t)
  }
  clauses.push(current)
  return clauses.filter(isNotEmptyLeader)
}

// A blank first clause (input starting with a connector) carries no text.
const isNotEmptyLeader = (c: Clause, index: number) => !(index === 0 && c.connector === '' && c.toks.every(t => t.kind === 'ws'))

const OP_WORDS = /^(in|is|was|changed|not)$/i

/** Splits a clause into field / operator / value at the first top-level operator. */
function splitClause(toks: Tok[]): { field: string; op: string; value: string } | undefined {
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === undefined) break
    if (t.kind === 'open') depth++
    if (t.kind === 'close') depth--
    if (depth !== 0) continue
    let opEnd = -1 // exclusive index of the last operator token
    if (t.kind === 'sym') opEnd = i + 1
    else if (t.kind === 'word' && OP_WORDS.test(t.text)) {
      const word = t.text.toLowerCase()
      const next = (from: number) => {
        let j = from
        while (toks[j]?.kind === 'ws') j++
        return j
      }
      const wordAt = (j: number) => {
        const x = toks[j]
        return x !== undefined && x.kind === 'word' ? x.text.toLowerCase() : ''
      }
      if (word === 'in' || word === 'changed') opEnd = i + 1
      else if (word === 'not') {
        const j = next(i + 1)
        if (wordAt(j) === 'in' || wordAt(j) === 'changed') opEnd = j + 1
      } else if (word === 'is') {
        const j = next(i + 1)
        opEnd = wordAt(j) === 'not' ? j + 1 : i + 1
      } else if (word === 'was') {
        let end = i + 1
        let j = next(end)
        if (wordAt(j) === 'not') {
          end = j + 1
          j = next(end)
        }
        if (wordAt(j) === 'in') end = j + 1
        opEnd = end
      }
    }
    if (opEnd < 0) continue
    const field = join(toks.slice(0, i))
    if (field === '') return undefined
    return { field, op: join(toks.slice(i, opEnd)), value: join(toks.slice(opEnd)) }
  }
  return undefined
}

const pad = (n: number): Segment => seg(' '.repeat(Math.max(n, 0)), 'dim')

/** Renders a CQL/JQL string, one clause per line, operators aligned. */
export function renderQuery(value: unknown): Rendered {
  if (typeof value !== 'string' || isTooLong(value)) return renderFallback(value)
  const input = escapeText(value).text
  const toks = tokenize(input)
  if (toks === undefined) return renderFallback(value)

  const rows = splitClauses(toks).map(clause => ({
    connector: clause.connector.replace(/\s+/g, ' '),
    isOrder: /^order\s+by$/i.test(clause.connector),
    toks: clause.toks,
  }))
  const parsed = rows.map(row => {
    const split = row.isOrder ? undefined : splitClause(row.toks)
    return { ...row, split, rest: join(row.toks) }
  })
  if (parsed.every(p => p.connector === '' && p.rest === '')) return renderFallback(value)

  const connW = Math.max(0, ...parsed.map(p => p.connector.length))
  const fieldW = Math.max(0, ...parsed.map(p => p.split?.field.length ?? 0))
  const opW = Math.max(0, ...parsed.map(p => p.split?.op.length ?? 0))

  const lines = parsed.map(p => {
    const line: Segment[] = []
    if (connW > 0) {
      if (p.connector !== '') line.push(seg(p.connector, 'op'))
      line.push(pad(connW - p.connector.length + 1))
    }
    if (p.split !== undefined) {
      line.push(seg(p.split.field, 'key'), pad(fieldW - p.split.field.length + 2))
      line.push(seg(p.split.op, 'op'))
      if (p.split.value !== '') line.push(pad(opW - p.split.op.length + 2), seg(p.split.value, 'value'))
    } else if (p.rest !== '') {
      line.push(seg(p.rest, 'value'))
    }
    return line
  })
  return { lines, isFallback: false }
}
