import type { Relation, TopicMap } from './types'

export type TopicToolName = 'topic.get_context' | 'topic.propose_relations' | 'topic.propose_layout' | 'topic.propose_workstreams'

export interface TopicToolContext {
  topicId: string
  materials: Array<{ id: string; title: string; text: string; sequence: number | null; position: { x: number | null; y: number | null } }>
  relations: Array<{ id: string; sourceMaterialId: string; targetMaterialId: string; label: string; relationType: string; createdBy: Relation['createdBy'] }>
}

export interface TopicToolRelationProposal {
  sourceMaterialId: string
  targetMaterialId: string
  relationType: string
  label: string
  evidence: string
  confidence: number | null
}

export interface TopicToolLayoutProposal { materialId: string; x: number; y: number; reason: string; evidence: string }
export interface TopicToolWorkstreamProposal { name: string; materialIds: string[]; reason: string; evidence: string }

const allowedRelationTypes = new Set(['next', 'depends_on', 'blocks', 'implements', 'tests', 'explains', 'evidences', 'improves', 'reviews', 'references', 'related', 'custom'])

export function topicToolContext(map: TopicMap): TopicToolContext {
  return {
    topicId: map.topic.id,
    materials: map.materials.map((material) => ({ id: material.id, title: material.title, text: material.excerpt ?? '', sequence: material.sequence, position: { x: material.canvasX, y: material.canvasY } })),
    relations: map.relations.map((relation) => ({ id: relation.id, sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, label: relation.label, relationType: relation.relationType, createdBy: relation.createdBy }))
  }
}

export function validateRelationProposals(map: TopicMap, proposals: unknown): TopicToolRelationProposal[] {
  if (!Array.isArray(proposals)) return []
  const materialIds = new Set(map.materials.map((material) => material.id)); const existing = new Set(map.relations.map((relation) => `${relation.sourceMaterialId}:${relation.targetMaterialId}:${relation.label}`)); const targets = new Set<string>()
  return proposals.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Partial<TopicToolRelationProposal>; const source = String(item.sourceMaterialId ?? ''); const target = String(item.targetMaterialId ?? ''); const relationType = String(item.relationType ?? 'related'); const label = String(item.label ?? '').trim().slice(0, 48); const evidence = String(item.evidence ?? '').trim().slice(0, 1000)
    if (!materialIds.has(source) || !materialIds.has(target) || source === target || !allowedRelationTypes.has(relationType) || !label || !evidence || targets.has(target)) return []
    const key = `${source}:${target}:${label}`; if (existing.has(key)) return []
    targets.add(target); const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null
    return [{ sourceMaterialId: source, targetMaterialId: target, relationType, label, evidence, confidence }]
  }).slice(0, Math.max(0, map.materials.length - 1))
}

export function validateLayoutProposals(map: TopicMap, proposals: unknown): TopicToolLayoutProposal[] {
  if (!Array.isArray(proposals)) return []
  const materialIds = new Set(map.materials.map((material) => material.id))
  return proposals.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Partial<TopicToolLayoutProposal>; const materialId = String(item.materialId ?? ''); const x = Number(item.x); const y = Number(item.y); const reason = String(item.reason ?? '').trim(); const evidence = String(item.evidence ?? '').trim()
    return materialIds.has(materialId) && Number.isFinite(x) && Number.isFinite(y) && reason && evidence ? [{ materialId, x: Math.max(-10000, Math.min(10000, x)), y: Math.max(-10000, Math.min(10000, y)), reason, evidence }] : []
  }).slice(0, map.materials.length)
}

export function validateWorkstreamProposals(map: TopicMap, proposals: unknown): TopicToolWorkstreamProposal[] {
  if (!Array.isArray(proposals)) return []
  const materialIds = new Set(map.materials.map((material) => material.id)); const assigned = new Set<string>()
  return proposals.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Partial<TopicToolWorkstreamProposal>; const name = String(item.name ?? '').trim().slice(0, 80); const reason = String(item.reason ?? '').trim(); const evidence = String(item.evidence ?? '').trim(); const ids = Array.isArray(item.materialIds) ? item.materialIds.map(String).filter((id) => materialIds.has(id) && !assigned.has(id)) : []
    if (!name || !reason || !evidence || !ids.length) return []
    ids.forEach((id) => assigned.add(id)); return [{ name, materialIds: ids, reason, evidence }]
  }).slice(0, 20)
}
