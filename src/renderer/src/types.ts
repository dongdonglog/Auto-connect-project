export type MaterialType = 'file' | 'note' | 'document' | 'link'
export interface Material { id:string; type:MaterialType; title:string; mimeType?:string|null; sourcePath?:string|null; storedPath?:string|null; url?:string|null; siteName?:string|null; excerpt?:string|null; extractedText?:string|null; importedAt:string; occurredAt?:string|null; occurredAtSource:string; status:string; error?:string|null; hash?:string|null }
export interface Topic { id:string; name:string; description?:string|null; createdAt:string; archivedAt?:string|null; color?:string }
export interface Workstream { id:string; topicId:string; name:string; position:number; source:string }
export type ArrowStyle = 'none' | 'triangle' | 'open-triangle' | 'diamond'
export interface Relation { id:string; sourceMaterialId:string; targetMaterialId:string; label:string; relationType:string; evidenceText?:string|null; evidenceMaterialId?:string|null; confidence?:number|null; createdBy:string; createdAt:string; lineColor?:string|null; sourceArrow?:boolean; sourceArrowStyle?:ArrowStyle; targetArrowStyle?:ArrowStyle; animated?:boolean; archived?:boolean; branchIndex?:number; lineKind?:'auto'|'straight'|'bezier'|'orthogonal' }
export interface TopicMap { topic:Topic; materials:Array<Material & {workstreamId?:string|null;canvasX?:number|null;canvasY?:number|null;cardColor?:string|null;cardTags?:string[];cardNote?:string|null;sequence?:number|null;sequenceSource?:string}>; workstreams:Workstream[]; relations:Relation[] }
export interface AnalysisSummary { topicId:string; processed:number; addedWorkstreams:number; addedRelations:number; failures:Array<{materialId:string;error:string}> }
export interface AnalysisStatus { running:number; complete:number; failed:number; latestError:string|null }
export interface Workspace { id:string; name:string; root:string; encrypted:boolean }
export interface ModelSettings { profileId:string|null; provider:'ollama'|'compatible'|'anthropic'|'gemini'; baseUrl:string; chatModel:string; embeddingModel:string; allowCloud:boolean; enabled:boolean }
export interface ProviderProfile { id:string; name:string; provider:ModelSettings['provider']; baseUrl:string; wireApi:'chat_completions'|'responses'; models:string[]; recommendedModel:string|null; updatedAt:string; hasApiKey:boolean }
