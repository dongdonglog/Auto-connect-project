import type { WorkspaceService } from './workspace-service'
import { TopicMcpServer, topicMcpTools } from './topic-mcp'

type ToolArguments = Record<string, unknown>

const materialMapCoreTools = [
  {
    name: 'list_topics',
    description: 'List active topics so the agent can inspect the correct canvas before proposing a board operation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_materials',
    description: 'List materials in the current Material Map workspace. Use this for counts, names, types, statuses, and an overview.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }
  },
  {
    name: 'search_materials',
    description: 'Search the current workspace using keyword or hybrid retrieval. Returns source-backed chunks with material and heading metadata.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['query'], additionalProperties: false }
  },
  {
    name: 'read_material',
    description: 'Read a material and a bounded set of local source chunks. Use the returned text as the evidence for factual answers.',
    inputSchema: { type: 'object', properties: { materialId: { type: 'string' }, chunkId: { type: 'string' } }, required: ['materialId'], additionalProperties: false }
  },
  {
    name: 'list_material_relations',
    description: 'List explainable relations connected to one material, including directed source and target titles.',
    inputSchema: { type: 'object', properties: { materialId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, includeHidden: { type: 'boolean' } }, required: ['materialId'], additionalProperties: false }
  },
  {
    name: 'get_relation_evidence',
    description: 'Read the local evidence supporting one material relation.',
    inputSchema: { type: 'object', properties: { relationId: { type: 'string' } }, required: ['relationId'], additionalProperties: false }
  },
  {
    name: 'get_topic_context',
    description: 'Read the current topic canvas materials, positions, and formal directed relations.',
    inputSchema: { type: 'object', properties: { topicId: { type: 'string' } }, required: ['topicId'], additionalProperties: false }
  },
  {
    name: 'propose_topic_changes',
    description: 'Create reviewable topic proposals for an explicitly requested board change. This never changes formal relations, cards, or positions directly; the user must review and accept each proposal.',
    inputSchema: { type: 'object', properties: { topicId: { type: 'string' }, actions: { type: 'array', description: 'Validated create_relation, rename_relation, set_sequence, set_card_style, layout, or create_workstream actions.' } }, required: ['topicId', 'actions'], additionalProperties: false }
  }
] as const

/** All internal modules exposed to the in-app agent and the stdio MCP adapter. */
export const materialMapMcpTools = [...materialMapCoreTools, ...topicMcpTools] as const

function stringArgument(args: ToolArguments, name: string): string {
  const value = String(args[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value.slice(0, 240)
}

function boundedInteger(args: ToolArguments, name: string, fallback: number, maximum: number): number {
  const value = args[name] === undefined ? fallback : Number(args[name])
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`)
  return Math.max(1, Math.min(maximum, Math.floor(value)))
}

function compactText(value: unknown, limit = 500): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

const proposalRelationTypes = new Set(['next', 'depends_on', 'blocks', 'implements', 'tests', 'explains', 'evidences', 'improves', 'reviews', 'references', 'related', 'custom'])

function proposalText(value: unknown, limit: number): string {
  return String(value ?? '').trim().slice(0, limit)
}

/**
 * Local, bounded tools shared by the in-app agent and a future stdio MCP
 * adapter. The server never exposes database handles or unbounded documents.
 */
export class MaterialMapMcpServer {
  private readonly topicTools: TopicMcpServer
  constructor(private readonly workspace: WorkspaceService) { this.topicTools = new TopicMcpServer((topicId) => this.workspace.topicMap(topicId)) }

  listTools(): typeof materialMapMcpTools { return materialMapMcpTools }

  async call(name: string, args: ToolArguments = {}): Promise<unknown> {
    if (name.startsWith('topic.')) return this.topicTools.call(name, args)
    switch (name) {
      case 'list_topics':
        return this.workspace.listTopics().map((topic) => ({ id: topic.id, name: topic.name, description: compactText(topic.description, 300), revision: topic.revision }))
      case 'list_materials': {
        const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : ''
        const limit = boundedInteger(args, 'limit', 100, 100)
        return this.workspace.listMaterials()
          .filter((material) => !query || `${material.title} ${material.excerpt ?? ''}`.toLocaleLowerCase().includes(query))
          .slice(0, limit)
          .map((material) => ({ id: material.id, title: material.title, type: material.type, status: material.status, availability: material.availability, summary: compactText(material.extractedText || material.excerpt, 420) }))
      }
      case 'search_materials': {
        const query = stringArgument(args, 'query')
        const limit = boundedInteger(args, 'limit', 8, 12)
        const result = await this.workspace.searchKnowledgeAsync(query, { limit })
        return { mode: result.mode, hits: result.hits.slice(0, limit).map((hit) => ({ materialId: hit.materialId, chunkId: hit.chunkId, title: hit.title, heading: hit.heading, text: compactText(hit.text, 900), pageNumber: hit.pageNumber, sourcePath: hit.sourcePath })) }
      }
      case 'read_material': {
        const materialId = stringArgument(args, 'materialId')
        const material = this.workspace.getMaterial(materialId)
        if (!material) throw new Error('Material not found.')
        const chunks = this.workspace.listMaterialChunks(materialId)
        const requestedChunk = typeof args.chunkId === 'string' && args.chunkId.trim() ? chunks.find((chunk) => chunk.id === args.chunkId) : undefined
        return { material: { id: material.id, title: material.title, type: material.type, status: material.status, availability: material.availability, excerpt: compactText(material.excerpt, 600) }, chunks: (requestedChunk ? [requestedChunk] : chunks.slice(0, 3)).map((chunk) => ({ id: chunk.id, ordinal: chunk.ordinal, heading: chunk.heading, pageNumber: chunk.pageNumber, text: compactText(chunk.text, 1400) })) }
      }
      case 'list_material_relations': {
        const materialId = stringArgument(args, 'materialId')
        const limit = boundedInteger(args, 'limit', 8, 20)
        const includeHidden = args.includeHidden === true
        return this.workspace.listMaterialRelations(materialId, limit, includeHidden).map((relation) => ({ id: relation.id, sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, sourceTitle: relation.sourceMaterialId === materialId ? this.workspace.getMaterial(materialId)?.title ?? '' : relation.target.title, targetTitle: relation.target.title, relationType: relation.relationType, score: relation.score, status: relation.status, evidenceCount: relation.evidence.length }))
      }
      case 'get_relation_evidence': {
        const relationId = stringArgument(args, 'relationId')
        return this.workspace.listRelationshipEvidence(relationId).slice(0, 12).map((evidence) => ({ id: evidence.id, type: evidence.type, text: compactText(evidence.text, 900), sourceMaterialId: evidence.sourceMaterialId, targetMaterialId: evidence.targetMaterialId, sourceHeading: evidence.sourceHeading, targetHeading: evidence.targetHeading, sourcePageNumber: evidence.sourcePageNumber, targetPageNumber: evidence.targetPageNumber }))
      }
      case 'get_topic_context': {
        const topicId = stringArgument(args, 'topicId')
        const map = this.workspace.topicMap(topicId)
        return { topic: { id: map.topic.id, name: map.topic.name, description: map.topic.description }, materials: map.materials.slice(0, 100).map((material) => ({ id: material.id, title: material.title, excerpt: compactText(material.excerpt, 420), sequence: material.sequence, position: { x: material.canvasX, y: material.canvasY } })), relations: map.relations.slice(0, 100).map((relation) => ({ id: relation.id, sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, label: relation.label, relationType: relation.relationType, createdBy: relation.createdBy })) }
      }
      case 'propose_topic_changes': {
        const topicId = stringArgument(args, 'topicId')
        const map = this.workspace.topicMap(topicId)
        if (!Array.isArray(args.actions)) throw new Error('actions must be an array.')
        const materialIds = new Set(map.materials.map((material) => material.id))
        const proposals = args.actions.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const action = value as Record<string, unknown>
          const kind = proposalText(action.kind, 48); const reason = proposalText(action.reason, 500); const evidence = proposalText(action.evidence, 1200)
          const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload) ? action.payload as Record<string, unknown> : {}
          if (!reason || !evidence || !['create_relation', 'rename_relation', 'set_sequence', 'set_card_style', 'layout', 'create_workstream'].includes(kind)) return []
          if (kind === 'create_relation') {
            const source = String(payload.sourceMaterialId ?? ''); const target = String(payload.targetMaterialId ?? ''); const relationType = String(payload.relationType ?? 'related'); const label = proposalText(payload.label, 48)
            const confidence = payload.confidence === undefined || payload.confidence === null ? null : Number(payload.confidence)
            if (!materialIds.has(source) || !materialIds.has(target) || source === target || !proposalRelationTypes.has(relationType) || !label || (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) || map.relations.some((relation) => relation.sourceMaterialId === source && relation.targetMaterialId === target)) return []
          } else if (kind === 'rename_relation') {
            if (!map.relations.some((relation) => relation.id === String(action.relationId ?? payload.relationId ?? '')) || !proposalText(payload.label, 64)) return []
          } else if (kind === 'set_sequence') {
            if (!materialIds.has(String(action.materialId ?? payload.materialId ?? '')) || !Number.isInteger(Number(payload.sequence)) || Number(payload.sequence) < 1) return []
          } else if (kind === 'set_card_style') {
            const styleKeys = ['displayTitle', 'displayExcerpt', 'width', 'height', 'color', 'textColor', 'fontSize', 'collapsed', 'zIndex', 'tags', 'note']
            if (!materialIds.has(String(action.materialId ?? payload.materialId ?? '')) || !styleKeys.some((key) => key in payload)) return []
          } else if (kind === 'layout') {
            if (!Array.isArray(payload.positions) || !payload.positions.length || payload.positions.length > 500 || payload.positions.some((position) => !position || typeof position !== 'object' || !materialIds.has(String((position as Record<string, unknown>).materialId)) || !Number.isFinite(Number((position as Record<string, unknown>).x)) || Math.abs(Number((position as Record<string, unknown>).x)) > 1_000_000 || !Number.isFinite(Number((position as Record<string, unknown>).y)) || Math.abs(Number((position as Record<string, unknown>).y)) > 1_000_000)) return []
          } else if (kind === 'create_workstream') {
            const ids = Array.isArray(payload.materialIds) ? payload.materialIds.map(String) : []
            if (!proposalText(payload.name, 80) || !ids.length || ids.length > 500 || ids.some((id) => !materialIds.has(id))) return []
          }
          return [{ kind, reason, evidence, materialId: typeof action.materialId === 'string' ? action.materialId : null, relationId: typeof action.relationId === 'string' ? action.relationId : null, payload }]
        }).slice(0, 8)
        return { requiresUserReview: true, proposals: proposals.length ? this.workspace.createTopicProposals(topicId, proposals) : [] }
      }
      default:
        throw new Error(`Unknown Material Map tool: ${name}`)
    }
  }
}
