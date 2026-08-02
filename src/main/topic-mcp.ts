import type { TopicMap } from './types'
import { topicToolContext, validateLayoutProposals, validateRelationProposals, validateWorkstreamProposals } from './topic-tools'

export const topicMcpTools = [
  { name: 'topic.get_context', description: 'Read the active topic materials and relations.', inputSchema: { type: 'object', properties: { topicId: { type: 'string' } }, required: ['topicId'] } },
  { name: 'topic.propose_relations', description: 'Validate relation proposals without writing formal relations.', inputSchema: { type: 'object', properties: { topicId: { type: 'string' }, relations: { type: 'array' } }, required: ['topicId', 'relations'] } },
  { name: 'topic.propose_layout', description: 'Validate card position proposals without changing positions.', inputSchema: { type: 'object', properties: { topicId: { type: 'string' }, positions: { type: 'array' } }, required: ['topicId', 'positions'] } },
  { name: 'topic.propose_workstreams', description: 'Validate workstream grouping proposals without writing workstreams.', inputSchema: { type: 'object', properties: { topicId: { type: 'string' }, workstreams: { type: 'array' } }, required: ['topicId', 'workstreams'] } }
] as const

export class TopicMcpServer {
  constructor(private readonly getTopic: (topicId: string) => TopicMap) {}
  listTools(): typeof topicMcpTools { return topicMcpTools }
  call(name: string, args: { topicId?: string; relations?: unknown; positions?: unknown; workstreams?: unknown }): unknown {
    const topicId = String(args.topicId ?? ''); if (!topicId) throw new Error('topicId is required.')
    const map = this.getTopic(topicId)
    if (name === 'topic.get_context') return topicToolContext(map)
    if (name === 'topic.propose_relations') return { proposals: validateRelationProposals(map, args.relations) }
    if (name === 'topic.propose_layout') return { proposals: validateLayoutProposals(map, args.positions) }
    if (name === 'topic.propose_workstreams') return { proposals: validateWorkstreamProposals(map, args.workstreams) }
    throw new Error(`Unknown topic tool: ${name}`)
  }
}
