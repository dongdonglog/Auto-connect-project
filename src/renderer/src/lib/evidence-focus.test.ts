import { describe, expect, it } from 'vitest'
import { buildEvidenceSnippet } from './evidence-focus'

describe('buildEvidenceSnippet', () => {
  it('highlights the supplied source range with bounded context', () => {
    const text = `${'a'.repeat(180)}details.md${'b'.repeat(180)}`
    const start = text.indexOf('details.md')
    expect(buildEvidenceSnippet(text, start, start + 'details.md'.length, 20)).toEqual({
      before: 'a'.repeat(20), highlight: 'details.md', after: 'b'.repeat(20), start, end: start + 10,
      truncatedBefore: true, truncatedAfter: true
    })
  })

  it('expands a missing end offset to the next token boundary', () => {
    const text = 'Read ./docs/details.md before implementation.'
    const start = text.indexOf('./docs/details.md')
    expect(buildEvidenceSnippet(text, start, null).highlight).toBe('./docs/details.md')
  })

  it('clamps malformed legacy offsets instead of throwing', () => {
    expect(buildEvidenceSnippet('short', 999, -5)).toMatchObject({ before: 'short', highlight: '', after: '', start: 5, end: 5 })
  })

  it('shows context without inventing a highlight when no offset exists', () => {
    expect(buildEvidenceSnippet('structural evidence', null, null, 4)).toMatchObject({ before: '', highlight: '', after: 'structur', start: 0, end: 0, truncatedAfter: true })
  })
})
