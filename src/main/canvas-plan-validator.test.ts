import { describe, expect, it } from 'vitest'
import { parseCanvasAiPlan } from './canvas-plan-validator'

const context = { topicId: 'topic', baseRevision: 3, materialIds: new Set(['a', 'b']), relationIds: new Set(['r1']), provider: 'compatible', model: 'model-a' }

describe('parseCanvasAiPlan', () => {
  it('normalizes a valid relation and layout plan', () => {
    const plan = parseCanvasAiPlan({ summary: '整理流程', actions: [{ id: 'r', kind: 'create_relation', reason: 'A precedes B', evidence: 'The source states the order.', payload: { sourceMaterialId: 'a', targetMaterialId: 'b', label: '下一步', relationType: 'next', confidence: .9 } }, { id: 'l', kind: 'layout', reason: 'Keep the flow readable.', evidence: 'The relation is directed.', payload: { positions: [{ materialId: 'a', x: 10, y: 20 }, { materialId: 'b', x: 300, y: 20 }] } }] }, context)
    expect(plan).toMatchObject({ topicId: 'topic', baseRevision: 3, model: { provider: 'compatible', model: 'model-a' } })
    expect(plan.actions[0].payload).toMatchObject({ sourceMaterialId: 'a', targetMaterialId: 'b', confidence: .9 })
  })

  it('rejects unknown materials and self relations', () => {
    expect(() => parseCanvasAiPlan({ actions: [{ kind: 'create_relation', reason: 'x', evidence: 'y', payload: { sourceMaterialId: 'a', targetMaterialId: 'missing', label: 'x', relationType: 'related' } }] }, context)).toThrow(/does not belong/)
    expect(() => parseCanvasAiPlan({ actions: [{ kind: 'create_relation', reason: 'x', evidence: 'y', payload: { sourceMaterialId: 'a', targetMaterialId: 'a', label: 'x', relationType: 'related' } }] }, context)).toThrow(/itself/)
  })

  it('requires evidence and rejects unsupported actions', () => {
    expect(() => parseCanvasAiPlan({ actions: [{ kind: 'create_relation', reason: 'x', evidence: '', payload: { sourceMaterialId: 'a', targetMaterialId: 'b', label: 'x', relationType: 'related' } }] }, context)).toThrow(/evidence/i)
    expect(() => parseCanvasAiPlan({ actions: [{ kind: 'delete_material', reason: 'x', evidence: 'y', payload: {} }] }, context)).toThrow(/unsupported kind/i)
    expect(() => parseCanvasAiPlan({ actions: [{ kind: 'create_relation', reason: 'x', evidence: 'y', payload: { sourceMaterialId: 'a', targetMaterialId: 'b', label: 'x', relationType: 'invented' } }] }, context)).toThrow(/relation type/i)
  })
})
