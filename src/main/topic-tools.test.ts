import { describe, expect, it } from 'vitest'
import { topicToolContext, validateLayoutProposals, validateRelationProposals, validateWorkstreamProposals } from './topic-tools'
import type { TopicMap } from './types'

const map = { topic: { id: 'topic' }, materials: [{ id: 'a', title: 'A', extractedText: 'alpha', excerpt: null, sequence: null, canvasX: 0, canvasY: 0 }, { id: 'b', title: 'B', extractedText: 'beta', excerpt: null, sequence: null, canvasX: 10, canvasY: 10 }], relations: [{ id: 'manual', sourceMaterialId: 'a', targetMaterialId: 'b', label: 'manual', relationType: 'next', createdBy: 'manual' }] } as unknown as TopicMap

describe('topic tool contracts', () => {
  it('serializes only active topic context', () => { const context = topicToolContext(map); expect(context.topicId).toBe('topic'); expect(context.materials[0].id).toBe('a'); expect(context.relations[0].createdBy).toBe('manual') })
  it('rejects unsafe relation proposals and preserves manual edges', () => {
    expect(validateRelationProposals(map, [{ sourceMaterialId: 'a', targetMaterialId: 'a', relationType: 'next', label: 'self', evidence: 'x' }, { sourceMaterialId: 'a', targetMaterialId: 'b', relationType: 'next', label: 'manual', evidence: 'x' }, { sourceMaterialId: 'a', targetMaterialId: 'missing', relationType: 'next', label: 'x', evidence: 'x' }])).toEqual([])
  })
  it('validates layout and workstream proposals against material ids', () => {
    expect(validateLayoutProposals(map, [{ materialId: 'a', x: 40, y: 80, reason: 'sequence', evidence: 'chapter 1' }, { materialId: 'missing', x: 0, y: 0, reason: 'x', evidence: 'x' }])).toHaveLength(1)
    expect(validateWorkstreamProposals(map, [{ name: 'Basics', materialIds: ['a'], reason: 'same chapter', evidence: 'chapter 1' }])).toMatchObject([{ materialIds: ['a'] }])
  })
})
