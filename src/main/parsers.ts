import { extname, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

export interface ExtractedMaterial { title: string; text: string; mimeType: string | null; occurredAt: string | null; occurredAtSource: 'content' | 'metadata' | 'import'; pages?: Array<{ pageNumber: number; text: string }> }

const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml'])
const datePattern = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/

function dateFromText(text: string): string | null {
  const match = text.match(datePattern)
  if (!match) return null
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T00:00:00.000Z`
}

/** Strip Markdown/HTML syntax so excerpts read as plain prose. */
export function plainExcerpt(text: string, maxLength = 500): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')                    // code fences
    .replace(/`([^`]*)`/g, '$1')                        // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')           // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')            // links -> label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                 // headings
    .replace(/^\s{0,3}>\s?/gm, '')                      // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')                      // unordered lists
    .replace(/^\s*\d+\.\s+/gm, '')                      // ordered lists
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')                // hr
    .replace(/<[^>]+>/g, ' ')                           // html tags
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')    // emphasis
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, maxLength)
}

export async function extractFile(filePath: string, suppliedData?: Buffer): Promise<ExtractedMaterial> {
  const extension = extname(filePath).toLowerCase()
  const title = basename(filePath, extension)
  const data = suppliedData ?? await readFile(filePath)
  let text = ''
  let mimeType: string | null = null
  let pages: Array<{ pageNumber: number; text: string }> | undefined
  if (textExtensions.has(extension)) {
    text = data.toString('utf8')
    mimeType = 'text/plain'
  } else if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: data })
    text = result.value
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  } else if (extension === '.pdf') {
    const parser = new PDFParse({ data })
    const result = await parser.getText()
    text = result.text
    pages = result.pages.map((page) => ({ pageNumber: page.num, text: page.text }))
    await parser.destroy()
    mimeType = 'application/pdf'
  } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    mimeType = `image/${extension.slice(1).replace('jpg', 'jpeg')}`
    text = ''
  } else {
    text = `Imported ${extension || 'file'} material. Content extraction is not available in this first release.`
  }
  const date = dateFromText(text)
  return { title, text, mimeType, occurredAt: date, occurredAtSource: date ? 'content' : 'import', pages }
}

export async function fetchLinkMetadata(url: string): Promise<{ title: string; siteName: string | null; excerpt: string }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'MaterialMap/0.1' } })
  if (!response.ok) throw new Error(`Metadata request returned ${response.status}`)
  const html = await response.text()
  const match = (pattern: RegExp) => html.match(pattern)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  const title = match(/<title[^>]*>([\s\S]*?)<\/title>/i) || new URL(url).hostname
  const excerpt = match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i).slice(0, 500)
  const siteName = match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || new URL(url).hostname
  return { title, siteName, excerpt }
}
