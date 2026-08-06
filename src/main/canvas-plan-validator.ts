import type { CanvasAction, CanvasActionKind, CanvasAiPlan } from './types'

export interface CanvasPlanValidationContext {
  topicId: string
  baseRevision: number
  materialIds: ReadonlySet<string>
  relationIds: ReadonlySet<string>
  provider?: string
  model?: string
  runId?: string
  maxActions?: number
}

const actionKinds: ReadonlySet<string> = new Set<CanvasActionKind>([
  'create_relation', 'create_workstream', 'rename_relation', 'set_sequence', 'set_card_style', 'layout'
])
const relationTypes: ReadonlySet<string> = new Set(['next', 'depends_on', 'explains', 'evidences', 'implements', 'tests', 'blocks', 'improves', 'reviews', 'references', 'related'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, limit: number, required = true): string {
  const output = typeof value === 'string' ? value.trim() : ''
  if (required && !output) throw new Error(`${label} is required.`)
  if (output.length > limit) throw new Error(`${label} is too long.`)
  return output
}

function idValue(value: unknown, label: string, ids: ReadonlySet<string>): string {
  const output = text(value, label, 240)
  if (!ids.has(output)) throw new Error(`${label} does not belong to the current topic.`)
  return output
}

function numberValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const output = Number(value)
  if (!Number.isFinite(output) || output < minimum || output > maximum) throw new Error(`${label} is invalid.`)
  return output
}

function normalizePayload(kind: CanvasActionKind, raw: Record<string, unknown>, context: CanvasPlanValidationContext): Record<string, unknown> {
  if (kind === 'create_relation') {
    const sourceMaterialId = idValue(raw.sourceMaterialId, 'Source material', context.materialIds)
    const targetMaterialId = idValue(raw.targetMaterialId, 'Target material', context.materialIds)
    if (sourceMaterialId === targetMaterialId) throw new Error('A material cannot be related to itself.')
    const relationType = text(raw.relationType ?? 'related', 'Relation type', 48)
    if (!relationTypes.has(relationType)) throw new Error('Relation type is not supported.')
    return {
      sourceMaterialId,
      targetMaterialId,
      label: text(raw.label, 'Relation label', 64),
      relationType,
      confidence: raw.confidence === undefined || raw.confidence === null ? null : numberValue(raw.confidence, 'Confidence', 0, 1)
    }
  }
  if (kind === 'create_workstream') {
    const values = raw.materialIds
    if (!Array.isArray(values) || !values.length || values.length > 500) throw new Error('Workstream materials are invalid.')
    const materialIds = [...new Set(values.map((value) => idValue(value, 'Workstream material', context.materialIds)))]
    return { name: text(raw.name, 'Workstream name', 80), materialIds }
  }
  if (kind === 'rename_relation') {
    return { relationId: idValue(raw.relationId, 'Relation', context.relationIds), label: text(raw.label, 'Relation label', 64) }
  }
  if (kind === 'set_sequence') {
    const sequence = numberValue(raw.sequence, 'Sequence', 1, 100000)
    if (!Number.isInteger(sequence)) throw new Error('Sequence must be an integer.')
    return { materialId: idValue(raw.materialId, 'Material', context.materialIds), sequence }
  }
  if (kind === 'set_card_style') {
    const materialId = idValue(raw.materialId, 'Material', context.materialIds)
    const patch = record(raw.patch ?? raw, 'Card style')
    const output: Record<string, unknown> = { materialId }
    if ('color' in patch) {
      const color = patch.color === null ? null : text(patch.color, 'Card color', 16)
      if (color !== null && !/^#[0-9a-f]{6}$/iu.test(color)) throw new Error('Card color must be a six-digit hexadecimal value.')
      output.color = color
    }
    if ('tags' in patch) {
      if (!Array.isArray(patch.tags) || patch.tags.length > 12) throw new Error('Card tags are invalid.')
      output.tags = [...new Set(patch.tags.map((tag) => text(tag, 'Card tag', 32)))]
    }
    if ('note' in patch) output.note = patch.note === null ? null : text(patch.note, 'Card note', 1200)
    if (!('color' in output) && !('tags' in output) && !('note' in output)) throw new Error('Card style has no supported fields.')
    return output
  }
  if (kind === 'layout') {
    const values = raw.positions
    if (!Array.isArray(values) || !values.length || values.length > 500) throw new Error('Layout positions are invalid.')
    const positions = values.map((value) => {
      const position = record(value, 'Layout position')
      return { materialId: idValue(position.materialId, 'Layout material', context.materialIds), x: numberValue(position.x, 'X coordinate', -100000, 100000), y: numberValue(position.y, 'Y coordinate', -100000, 100000) }
    })
    return { positions }
  }
  throw new Error(`Unsupported canvas action: ${kind}`)
}

function parseObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null) return record(input, 'Canvas plan')
  if (typeof input !== 'string') throw new Error('Canvas plan must be JSON.')
  const cleaned = input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model output did not contain a JSON object.')
  return record(JSON.parse(cleaned.slice(start, end + 1)), 'Canvas plan')
}

export function parseCanvasAiPlan(input: unknown, context: CanvasPlanValidationContext): CanvasAiPlan {
  const root = parseObject(input)
  const actionsValue = root.actions ?? root.proposedActions
  if (!Array.isArray(actionsValue)) throw new Error('Canvas plan actions are missing.')
  const maxActions = Math.max(1, Math.min(context.maxActions ?? 32, 64))
  if (actionsValue.length > maxActions) throw new Error(`Canvas plan contains more than ${maxActions} actions.`)
  const actions: CanvasAction[] = actionsValue.map((value, index) => {
    const item = record(value, `Canvas action ${index + 1}`)
    const kind = text(item.kind, `Canvas action ${index + 1} kind`, 48)
    if (!actionKinds.has(kind)) throw new Error(`Canvas action ${index + 1} has an unsupported kind.`)
    const action = { id: text(item.id ?? `action-${index + 1}`, `Canvas action ${index + 1} id`, 80), kind: kind as CanvasActionKind, reason: text(item.reason, `Canvas action ${index + 1} reason`, 600), evidence: text(item.evidence, `Canvas action ${index + 1} evidence`, 1600), materialId: item.materialId === undefined || item.materialId === null ? null : idValue(item.materialId, 'Material', context.materialIds), relationId: item.relationId === undefined || item.relationId === null ? null : idValue(item.relationId, 'Relation', context.relationIds), payload: normalizePayload(kind as CanvasActionKind, record(item.payload ?? {}, `Canvas action ${index + 1} payload`), context) }
    return action
  })
  const runId = context.runId ?? text(root.runId ?? `run-${Date.now()}`, 'Run id', 120)
  return { runId, topicId: context.topicId, baseRevision: context.baseRevision, summary: text(root.summary ?? root.answer ?? '已生成可审核的画板建议。', 'Canvas plan summary', 1000), actions, warnings: Array.isArray(root.warnings) ? root.warnings.map((warning) => text(warning, 'Plan warning', 400)).slice(0, 12) : [], model: { provider: context.provider ?? 'unknown', model: context.model ?? 'unknown' } }
}
