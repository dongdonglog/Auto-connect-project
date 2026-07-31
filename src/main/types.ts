export type MaterialType = 'file' | 'note' | 'document' | 'link'
export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused'

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
}

export interface Topic { id: string; name: string; description: string | null; createdAt: string; archivedAt: string | null; color: string }
export interface Workstream { id: string; topicId: string; name: string; position: number; source: 'ai' | 'manual' }
export interface Relation {
  id: string; sourceMaterialId: string; targetMaterialId: string; label: string; relationType: string
  evidenceText: string | null; evidenceMaterialId: string | null; confidence: number | null
  createdBy: 'ai' | 'manual'; createdAt: string; lineColor?: string | null; sourceArrow?: boolean; sourceArrowStyle?: ArrowStyle; targetArrowStyle?: ArrowStyle; animated?: boolean; archived?: boolean; branchIndex?: number; lineKind?: 'auto' | 'straight' | 'bezier' | 'orthogonal'
}
export type ArrowStyle = 'none' | 'triangle' | 'open-triangle' | 'diamond'
export interface Job { id: string; materialId: string; kind: string; status: JobStatus; error: string | null; updatedAt: string }
export interface AnalysisSummary {
  topicId: string
  processed: number
  addedWorkstreams: number
  addedRelations: number
  failures: Array<{ materialId: string; error: string }>
}
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
  materials: Array<Material & { workstreamId: string | null; canvasX: number | null; canvasY: number | null; cardColor: string | null; cardTags: string[]; cardNote: string | null; sequence: number | null; sequenceSource: string }>
  workstreams: Workstream[]
  relations: Relation[]
}
