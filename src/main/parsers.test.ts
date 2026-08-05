import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractFile } from './parsers'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(name: string, content: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'material-map-parsers-')); roots.push(root)
  const filePath = join(root, name)
  writeFileSync(filePath, content)
  return filePath
}

describe('extractFile', () => {
  it('reads plain text files and derives the title from the file name', async () => {
    const result = await extractFile(fixture('Meeting Notes.md', '# Agenda\nSome content without a date.'))
    expect(result.title).toBe('Meeting Notes')
    expect(result.mimeType).toBe('text/plain')
    expect(result.text).toContain('Agenda')
    expect(result.occurredAt).toBeNull()
    expect(result.occurredAtSource).toBe('import')
  })

  it.each(['.txt', '.csv', '.json', '.html', '.yaml', '.xml'])('treats %s as a text extension', async (extension) => {
    const result = await extractFile(fixture(`sample${extension}`, 'plain body'))
    expect(result.mimeType).toBe('text/plain')
    expect(result.text).toBe('plain body')
  })

  it('extracts an ISO date from the content and marks the source as content', async () => {
    const result = await extractFile(fixture('report.txt', 'Draft finalized on 2024-3-5 for review.'))
    expect(result.occurredAt).toBe('2024-03-05T00:00:00.000Z')
    expect(result.occurredAtSource).toBe('content')
  })

  it('supports slash and dot date separators and pads single digits', async () => {
    const slash = await extractFile(fixture('a.txt', 'event on 2023/11/09'))
    expect(slash.occurredAt).toBe('2023-11-09T00:00:00.000Z')
    const dot = await extractFile(fixture('b.txt', 'event on 2023.1.2'))
    expect(dot.occurredAt).toBe('2023-01-02T00:00:00.000Z')
  })

  it('ignores invalid or out-of-range dates', async () => {
    const result = await extractFile(fixture('nodate.txt', 'release 2024-13-40 and 1999-01-01 are not matches'))
    expect(result.occurredAt).toBeNull()
    expect(result.occurredAtSource).toBe('import')
  })

  it('returns empty text with an image mime type for image files', async () => {
    const png = await extractFile(fixture('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    expect(png.mimeType).toBe('image/png')
    expect(png.text).toBe('')
    const jpg = await extractFile(fixture('photo.jpg', Buffer.from([0xff, 0xd8])))
    expect(jpg.mimeType).toBe('image/jpeg')
  })

  it('falls back to a placeholder message for unsupported extensions', async () => {
    const result = await extractFile(fixture('archive.zip', Buffer.from([0x50, 0x4b])))
    expect(result.mimeType).toBeNull()
    expect(result.text).toContain('not available')
  })

  it('accepts supplied buffer data instead of reading from disk', async () => {
    const result = await extractFile('virtual/note.md', Buffer.from('buffer content'))
    expect(result.title).toBe('note')
    expect(result.text).toBe('buffer content')
  })

  it('does not produce pages for non-PDF formats', async () => {
    const result = await extractFile(fixture('plain.txt', 'no pages here'))
    expect(result.pages).toBeUndefined()
  })
})

describe('plainExcerpt', () => {
  it('strips markdown syntax and collapses whitespace', async () => {
    const { plainExcerpt } = await import('./parsers')
    const md = '# 架构总览\n\n系统采用 [SQLite](存储设计.md) 作为**本地存储**。\n\n- 第一项\n- 第二项\n\n```ts\nconst x = 1\n```\n\n详见 [实现方案](实现方案.md)。'
    const excerpt = plainExcerpt(md)
    expect(excerpt).not.toContain('#')
    expect(excerpt).not.toContain('[')
    expect(excerpt).not.toContain('](')
    expect(excerpt).not.toContain('```')
    expect(excerpt).not.toContain('**')
    expect(excerpt).toContain('SQLite')
    expect(excerpt).toContain('本地存储')
    expect(excerpt).toContain('实现方案')
  })

  it('respects the max length', async () => {
    const { plainExcerpt } = await import('./parsers')
    expect(plainExcerpt('a'.repeat(1000), 100).length).toBe(100)
  })

  it('strips html tags', async () => {
    const { plainExcerpt } = await import('./parsers')
    expect(plainExcerpt('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })
})
