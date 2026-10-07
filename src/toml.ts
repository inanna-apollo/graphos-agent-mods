// A small, strict TOML subset: comments, `[table]`, `[[array of tables]]` (one
// bare name each, no dots), and `key = value` with a basic or literal string,
// a boolean, an integer, or a one-line array of those. Anything else throws a
// TomlError naming the line. Pure; no dependencies.

export class TomlError extends Error {
  readonly line: number
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`)
    this.name = 'TomlError'
    this.line = line
  }
}

export type TomlValue = string | boolean | number | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

const MAX_TEXT = 64 * 1024
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

type Cursor = { text: string; at: number; line: number }

const skipSpace = (c: Cursor) => {
  while (c.at < c.text.length && (c.text[c.at] === ' ' || c.text[c.at] === '\t')) c.at++
}

function readString(c: Cursor): string {
  const quote = c.text[c.at]
  c.at++
  let out = ''
  for (;;) {
    const ch = c.text[c.at]
    if (ch === undefined) throw new TomlError(c.line, 'unterminated string')
    c.at++
    if (ch === quote) return out
    if (quote === "'" || ch !== '\\') {
      out += ch
      continue
    }
    const next = c.text[c.at]
    c.at++
    if (next !== undefined && Object.hasOwn(ESCAPES, next)) out += ESCAPES[next]
    else if (next === 'u') {
      const hex = c.text.slice(c.at, c.at + 4)
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new TomlError(c.line, 'bad \\u escape')
      out += String.fromCharCode(Number.parseInt(hex, 16))
      c.at += 4
    } else throw new TomlError(c.line, `bad escape \\${next ?? ''}`)
  }
}

function readValue(c: Cursor): TomlValue {
  skipSpace(c)
  const ch = c.text[c.at]
  if (ch === '"' || ch === "'") {
    if (c.text.startsWith(ch.repeat(3), c.at)) throw new TomlError(c.line, 'multi-line strings are not supported')
    return readString(c)
  }
  if (ch === '[') {
    c.at++
    const items: TomlValue[] = []
    for (;;) {
      skipSpace(c)
      if (c.text[c.at] === ']') {
        c.at++
        return items
      }
      items.push(readValue(c))
      skipSpace(c)
      if (c.text[c.at] === ',') c.at++
      else if (c.text[c.at] !== ']') throw new TomlError(c.line, 'expected , or ] in array')
    }
  }
  const word = /^[^\s,\]#]+/.exec(c.text.slice(c.at))?.[0] ?? ''
  c.at += word.length
  if (word === 'true') return true
  if (word === 'false') return false
  if (/^[+-]?\d+$/.test(word)) return Number(word)
  throw new TomlError(c.line, word === '' ? 'missing value' : `unsupported value ${JSON.stringify(word)}`)
}

function readKey(c: Cursor): string {
  skipSpace(c)
  const ch = c.text[c.at]
  if (ch === '"' || ch === "'") return readString(c)
  const key = /^[A-Za-z0-9_-]+/.exec(c.text.slice(c.at))?.[0] ?? ''
  if (key === '') throw new TomlError(c.line, 'expected a key')
  c.at += key.length
  return key
}

function endOfLine(c: Cursor) {
  skipSpace(c)
  const ch = c.text[c.at]
  if (ch !== undefined && ch !== '#' && ch !== '\r') throw new TomlError(c.line, `unexpected ${JSON.stringify(ch)}`)
}

const isTable = (x: unknown): x is TomlTable => typeof x === 'object' && x !== null && !Array.isArray(x)
const fresh = (): TomlTable => Object.create(null) as TomlTable

/** Parses the subset; throws TomlError on anything outside it, a duplicate key or a redefined table. */
export function parseToml(text: string): TomlTable {
  if (text.length > MAX_TEXT) throw new TomlError(1, 'file too large')
  const root = fresh()
  let current = root
  const lines = text.replace(/^﻿/, '').split('\n')
  for (const [index, raw] of lines.entries()) {
    const c: Cursor = { text: raw, at: 0, line: index + 1 }
    skipSpace(c)
    const first = raw[c.at]
    if (first === undefined || first === '#' || first === '\r') continue
    if (first === '[') {
      const isArray = raw[c.at + 1] === '['
      c.at += isArray ? 2 : 1
      const name = /^[A-Za-z0-9_-]+/.exec(raw.slice(c.at))?.[0] ?? ''
      if (name === '') throw new TomlError(c.line, 'expected a simple table name')
      c.at += name.length
      const close = isArray ? ']]' : ']'
      if (raw.slice(c.at, c.at + close.length) !== close) throw new TomlError(c.line, 'expected a closing bracket')
      c.at += close.length
      endOfLine(c)
      const table = fresh()
      if (isArray) {
        const list = root[name]
        if (list === undefined) root[name] = [table]
        else if (Array.isArray(list) && list.every(isTable)) list.push(table)
        else throw new TomlError(c.line, `${name} is not an array of tables`)
      } else {
        if (name in root) throw new TomlError(c.line, `table ${name} defined twice`)
        root[name] = table
      }
      current = table
      continue
    }
    const key = readKey(c)
    skipSpace(c)
    if (raw[c.at] !== '=') throw new TomlError(c.line, 'expected =')
    c.at++
    const value = readValue(c)
    endOfLine(c)
    if (key in current) throw new TomlError(c.line, `duplicate key ${key}`)
    current[key] = value
  }
  return root
}

/** parseToml without the throw: the table, or the error text. */
export function tryParseToml(text: string): { ok: true; value: TomlTable } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseToml(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
