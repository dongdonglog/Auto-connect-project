export type MaterialType = 'file' | 'note' | 'document' | 'link'
export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused'
export type MaterialAvailability = 'available' | 'unavailable'

export interface WorkspaceSummary {
  id: string
  name: string
  root: string
  encrypted: boolean
}

export interface Material {
  id: string
  type: MaterialType
  title: string
  mimeType: string | null
  sourcePath: string | null
  storedPath: string | null
  url: string | null
  siteName: string | null
  excerpt: string | null
  extractedText: string | null
  importedAt: string
  occurredAt: string | null
  occurredAtSource: 'content' | 'metadata' | 'import' | 'manual'
  status: JobStatus
  error: string | null
  hash: string | null
  availability: MaterialAvailability
  lastIndexedAt: string | null
}
export interface FolderSource {
  id: string
  rootPath: string
  enabled: boolean
  includePatterns: string[]
  excludePatterns: string[]
  watchEnabled: boolean
  createdAt: string
  updatedAt: string
}
export interface MaterialChunk {
  id: string
  materialId: string
  ordinal: number
  text: string
  startOffset: number
  endOffset: number
  pageNumber: number | null
  heading: string | null
  hash: string
  indexedAt: string
}
export interface MaterialTag { materialId: string; tag: string; source: 'title' | 'heading' | 'phrase'; weight: number }
export type EntityType = 'file_reference' | 'technology' | 'project'
export type EntityMentionSource = 'filename' | 'title' | 'heading' | 'body' | 'link' | 'import'
export interface Entity { id: string; text: string; normalized: string; type: EntityType; weight: number }
export interface EntityMention { id: string; entityId: string; materialId: string; source: EntityMentionSource; startOffset: number | null; endOffset: number | null; excerpt: string }
export type MaterialRelationStatus = 'visible' | 'hidden' | 'fixed'
export interface RelationshipEvidence { id: string; relationId: string; type: 'explicit_reference' | 'entity_overlap' | 'structural'; score: number; sourceMaterialId: string; targetMaterialId: string; sourceEntityId: string | null; targetEntityId: string | null; sourceOffset: number | null; targetOffset: number | null; sourceEndOffset?: number | null; targetEndOffset?: number | null; sourcePageNumber?: number | null; targetPageNumber?: number | null; sourceHeading?: string | null; targetHeading?: string | null; text: string; createdAt: string }
export interface MaterialRelation { id: string; sourceMaterialId: string; targetMaterialId: string; score: number; relationType: 'references' | 'shares_entities' | 'nearby'; status: MaterialRelationStatus; updatedAt: string; target: Material; evidence: RelationshipEvidence[] }
export interface RelationAiExplanation { supported: boolean; sourceMaterialId: string; targetMaterialId: string; relationType: string; label: string; explanation: string; confidence: number }
export type RelationAiExplanationFailureReason = 'not-configured' | 'no-consent' | 'timeout' | 'invalid-json' | 'provider-error'
// Single-relation explanation never writes to the workspace and never changes
// relation state; failures are structured so the UI can distinguish causes.
export type RelationAiExplanationResult = (RelationAiExplanation & { ok: true }) | { ok: false; reason: RelationAiExplanationFailureReason; message: string }
export type TopicCandidateStatus = 'visible' | 'hidden' | 'accepted'
export interface TopicRelationCandidateRecord { id: string; topicId: string; sourceMaterialId: string; targetMaterialId: string; sharedTags: string[]; score: number; status: TopicCandidateStatus; createdAt: string; updatedAt: string }
export interface SearchHit {
  materialId: string
  chunkId: string | null
  title: string
  text: string
  score: number
  sourcePath: string | null
  pageNumber: number | null
  heading: string | null
  availability: MaterialAvailability
}
export interface GroundedCitation {
  id: string
  materialId: string
  chunkId: string | null
  title: string
  excerpt: string
  sourcePath: string | null
  pageNumber: number | null
  heading: string | null
}
export interface GroundedAnswer {
  answer: string
  citations: GroundedCitation[]
  confidence: 'grounded' | 'insufficient-evidence'
  retrievalMode: 'fts' | 'hybrid' | 'fallback'
  model: string | null
}
export interface KnowledgeChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface KnowledgeQuestion {
  question: string
  history?: KnowledgeChatTurn[]
}
export interface SearchOptions { limit?: number; sourceId?: string }
export interface AnswerOptions extends SearchOptions { allowCloud?: boolean }
export type ProposalStatus = 'pending' | 'accepted' | 'archived'
export interface TopicProposal { id: string; topicId: string; kind: string; reason: string; evidence: string; materialId: string | null; relationId: string | null; payload: Record<string, unknown>; status: ProposalStatus; createdAt: string; updatedAt: string }

export interface Topic { id: string; name: string; description: string | null; createdAt: string; archivedAt: string | null; color: string; revision: number }
export interface Workstream { id: string; topicId: string; name: string; position: number; source: 'ai' | 'manual' }
export type RelationWaypoint = { x: number; y: number }
export type LineDash = 'auto' | 'solid' | 'dashed' | 'dotted'
export interface Relation {
  id: string; sourceMaterialId: string; targetMaterialId: string; label: string; relationType: string
  evidenceText: string | null; evidenceMaterialId: string | null; confidence: number | null
  createdBy: 'system' | 'ai' | 'manual' | 'local'; createdAt: string; lineColor?: string | null; sourceArrow?: boolean; sourceArrowStyle?: ArrowStyle | null; targetArrowStyle?: ArrowStyle; animated?: boolean; archived?: boolean; branchIndex?: number; lineKind?: 'auto' | 'straight' | 'bezier' | 'orthogonal'; sourceHandle?: string | null; targetHandle?: string | null; lineWidth?: number; lineDash?: LineDash; routePoints?: RelationWaypoint[]; labelAnchor?: number
}
export type ArrowStyle = 'none' | 'triangle' | 'open-triangle' | 'diamond'
export interface TopicCardPresentation {
  displayTitle: string | null
  displayExcerpt: string | null
  cardWidth: number | null
  cardHeight: number | null
  cardTextColor: string | null
  cardFontSize: number | null
  cardCollapsed: boolean
  cardZIndex: number
}
export interface TopicHistoryStatus { undo: boolean; redo: boolean; cursor: number }
export type TopicEditorCommand = { kind: string; payload: Record<string, unknown> }
export interface Job { id: string; materialId: string; kind: string; status: JobStatus; error: string | null; updatedAt: string }
export interface AnalysisSummary {
  topicId: string
  runId?: string
  processed: number
  addedWorkstreams: number
  addedRelations: number
  failures: Array<{ materialId: string; error: string }>
}
export type TopicAnalysisStage = 'preparing' | 'candidates' | 'verifying' | 'applying' | 'complete' | 'failed' | 'cancelled'
export interface MaterialAnalysisCard { materialId: string; contentHash: string; modelId: string; title: string; date: string | null; headings: string[]; keywords: string[]; evidenceChunkIds: string[]; summary: string; generatedAt: string }
export interface TopicAnalysisRun { id: string; topicId: string; topicRevision: number; stage: TopicAnalysisStage; completed: number; total: number; addedRelations: number; rejectedCandidates: number; error: string | null; summary: string | null; createdAt: string; updatedAt: string }
export interface TopicRelationCandidate { sourceMaterialId: string; targetMaterialId: string; relationType: string; label?: string; confidence: number; evidence: string; sourceChunkIds: string[]; targetChunkIds: string[] }
export interface AnalysisStatus { running: number; complete: number; failed: number; latestError: string | null }
export interface ModelSettings {
  profileId: string | null
  provider: 'ollama' | 'compatible' | 'anthropic' | 'gemini'
  baseUrl: string
  chatModel: string
  embeddingModel: string
  allowCloud: boolean
  enabled: boolean
}

export type ProviderKind = 'ollama' | 'compatible' | 'anthropic' | 'gemini'
export type WireApi = 'chat_completions' | 'responses'
export interface ProviderProfile {
  id: string
  name: string
  provider: ProviderKind
  baseUrl: string
  wireApi: WireApi
  models: string[]
  recommendedModel: string | null
  updatedAt: string
  hasApiKey: boolean
}
export interface ProviderProfileInput {
  id?: string
  name: string
  provider: ProviderKind
  baseUrl: string
  wireApi?: WireApi
  apiKey?: string
}

export interface TopicMap {
  topic: Topic
  materials: Array<Material & { workstreamId: string | null; canvasX: number | null; canvasY: number | null; positionSource: 'auto' | 'manual'; cardColor: string | null; cardTags: string[]; cardNote: string | null; sequence: number | null; sequenceSource: string; addedAt: string | null } & TopicCardPresentation>
  workstreams: Workstream[]
  relations: Relation[]
  candidates: TopicRelationCandidateRecord[]
  history: TopicHistoryStatus
}
