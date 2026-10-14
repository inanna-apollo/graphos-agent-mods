import { escapeText } from '../escape.ts'

export const RAW_PAGE_SIZE = 32_000

/** Escape once, then split without losing content or bisecting a surrogate pair. */
export function rawPages(source: string, size = RAW_PAGE_SIZE): string[] {
  const text = escapeText(source, Infinity).text
  const limit = Math.max(2, Math.floor(size))
  const pages: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length && /[\ud800-\udbff]/.test(text.charAt(end - 1))) end--
    pages.push(text.slice(start, end))
    start = end
  }
  return pages.length === 0 ? [''] : pages
}
