import { describe, expect, it } from 'vitest'
import { chunkHash, chunkText, searchTerms, tokenize } from './indexer'

describe('chunkText', () => {
  it('returns an empty list for blank input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('splits paragraphs into ordered chunks with offsets', () => {
    const chunks = chunkText('First paragraph.\n\nSecond paragraph.')
    expect(chunks).toHaveLength(2)
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1])
    expect(chunks[0].text).toBe('First paragraph.')
    expect(chunks[1].text).toBe('Second paragraph.')
    expect(chunks[1].startOffset).toBeGreaterThan(chunks[0].endOffset)
  })

  it('normalizes CRLF line endings before chunking', () => {
    const chunks = chunkText('Alpha\r\n\r\nBeta')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe('Alpha')
    expect(chunks[1].text).toBe('Beta')
  })

  it('tracks the nearest markdown heading for following chunks', () => {
    const chunks = chunkText('# Overview\n\nBody text.\n\n## Details\n\nMore text.')
    expect(chunks.find((chunk) => chunk.text === 'Body text.')?.heading).toBe('Overview')
    expect(chunks.find((chunk) => chunk.text === 'More text.')?.heading).toBe('Details')
  })

  it('splits oversized blocks into max-length segments', () => {
    const long = Array.from({ length: 100 }, (_, index) => `word${index} filler text`).join(' ')
    const chunks = chunkText(long, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(100)
  })

  it('records accurate offsets into the original text', () => {
    const text = 'Intro block.\n\nMiddle block with content.\n\nFinal block.'
    for (const chunk of chunkText(text)) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text)
    }
  })
})

describe('chunkHash', () => {
  it('produces a stable sha256 hex digest', () => {
    const hash = chunkHash('hello material map')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(chunkHash('hello material map')).toBe(hash)
    expect(chunkHash('other text')).not.toBe(hash)
  })
})

describe('tokenize', () => {
  it('lowercases, splits on non-word characters and drops short tokens', () => {
    expect(tokenize('Hello, WORLD! a ok_2 x-y')).toEqual(['hello', 'world', 'ok_2', 'x-y'])
  })

  it('keeps unicode letters and numbers', () => {
    expect(tokenize('材料 Material 2026')).toEqual(['材料', 'material', '2026'])
  })

  it('returns an empty list for punctuation-only input', () => {
    expect(tokenize('!@#$%^&*()')).toEqual([])
  })
})

describe('searchTerms', () => {
  it('extracts searchable mixed-language fragments without changing tokenize semantics', () => {
    expect(searchTerms('我想学习 Go 语言的基础')).toEqual(expect.arrayContaining(['go', '语言', '基础']))
  })
})
