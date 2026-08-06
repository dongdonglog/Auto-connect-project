import { createHash } from 'node:crypto'

export interface TextChunkInput {
  ordinal: number
  text: string
  startOffset: number
  endOffset: number
  heading: string | null
}

const MAX_CHUNK_LENGTH = 1200

export function chunkText(input: string, maxLength = MAX_CHUNK_LENGTH): TextChunkInput[] {
  const text = input.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const chunks: TextChunkInput[] = []
  let cursor = 0
  let heading: string | null = null
  for (const block of text.split(/\n\s*\n/)) {
    const start = text.indexOf(block, cursor)
    cursor = start + block.length
    const headingMatch = block.match(/^#{1,6}\s+(.+)$/m)
    if (headingMatch) heading = headingMatch[1].trim().slice(0, 200)
    const paragraphs = block.length <= maxLength ? [block] : block.match(new RegExp(`.{1,${maxLength}}(?:\\s|$)`, 'g')) ?? [block]
    let offset = start
    for (const paragraph of paragraphs) {
      const value = paragraph.trim()
      if (!value) continue
      const localStart = text.indexOf(value, offset)
      const localEnd = localStart + value.length
      chunks.push({ ordinal: chunks.length, text: value, startOffset: localStart, endOffset: localEnd, heading })
      offset = localEnd
    }
  }
  return chunks
}

export function chunkHash(text: string): string { return createHash('sha256').update(text).digest('hex') }

export function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((token) => token.trim()).filter((token) => token.length > 1)
}

/**
 * Search terms keep the original word-like tokens for FTS, then add small
 * CJK/Latin fragments used by the LIKE fallback. SQLite's default unicode61
 * tokenizer does not reliably split mixed strings such as "Go核心语法" or a
 * natural Chinese question into independently searchable words.
 */
export function searchTerms(value: string): string[] {
  const terms = new Set(tokenize(value))
  for (const token of [...terms]) {
    for (const latin of token.match(/[a-z0-9][a-z0-9_+#.-]*/gi) ?? []) if (latin.length > 1) terms.add(latin.toLocaleLowerCase())
    for (const han of token.match(/[\u3400-\u9fff]+/gu) ?? []) {
      for (let index = 0; index < han.length - 1; index += 1) terms.add(han.slice(index, index + 2))
    }
  }
  return [...terms].filter((term) => term.length > 1)
}
