export interface EvidenceFocus {
  key: string
  materialId: string
  startOffset: number | null
  endOffset: number | null
  pageNumber: number | null
  heading: string | null
}

export interface EvidenceSnippet {
  before: string
  highlight: string
  after: string
  start: number
  end: number
  truncatedBefore: boolean
  truncatedAfter: boolean
}

const boundary = /[\s)\]}>,'"`;\uff0c\u3002\uff1b\uff1a]/

export function buildEvidenceSnippet(text: string, startOffset: number | null, endOffset: number | null, radius = 140): EvidenceSnippet {
  if (startOffset == null) {
    const after = text.slice(0, radius * 2)
    return { before: '', highlight: '', after, start: 0, end: 0, truncatedBefore: false, truncatedAfter: after.length < text.length }
  }
  const start = Math.max(0, Math.min(text.length, Math.trunc(startOffset ?? 0)))
  let end = endOffset == null ? start : Math.max(start, Math.min(text.length, Math.trunc(endOffset)))
  if (end === start && start < text.length) {
    end = start + 1
    while (end < text.length && !boundary.test(text[end])) end += 1
  }
  const contextStart = Math.max(0, start - radius)
  const contextEnd = Math.min(text.length, Math.max(end, start) + radius)
  return {
    before: text.slice(contextStart, start),
    highlight: text.slice(start, end),
    after: text.slice(end, contextEnd),
    start,
    end,
    truncatedBefore: contextStart > 0,
    truncatedAfter: contextEnd < text.length
  }
}
