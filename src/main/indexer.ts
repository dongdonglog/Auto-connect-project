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
