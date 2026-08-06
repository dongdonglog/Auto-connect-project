import type { AnalysisSummary, GroundedAnswer, KnowledgeChatTurn, KnowledgeQuestion, Material, MaterialAnalysisCard, ModelSettings, ProviderProfile, ProviderProfileInput, RelationAiExplanationFailureReason, RelationAiExplanationResult, SearchHit, TopicMap, TopicProposal, TopicRelationCandidate } from './types'
import { WorkspaceService } from './workspace-service'
import { AppStore } from './app-store'
import connectionSkill from './ai-skills/topic-connection.md?raw'
import operationSkill from './ai-skills/topic-operation.md?raw'
import { topicToolContext } from './topic-tools'
import { chunkHash, tokenize } from './indexer'
import { MaterialMapMcpServer } from './material-mcp'

interface TopicAnalysisResult {
  workstreams?: Array<{ name: string; materialIds: string[] }>
  roots?: string[]
  relations: Array<{ sourceMaterialId: string; targetMaterialId: string; relationType?: string; label?: string; evidence: string; confidence?: number }>
}

const workflowRelations: Record<string, string> = { next: '下一步', depends_on: '依赖', explains: '解释', evidences: '佐证', implements: '实现', tests: '验证', blocks: '阻塞', improves: '改进', reviews: '复盘', references: '参考', related: '关联' }
export interface AiActionProposal { id: string; kind: 'create_relation' | 'create_workstream' | 'delete_ai_relation' | 'rename_relation' | 'set_sequence' | 'set_card_style' | 'layout'; reason: string; evidence: string; materialId?: string; relationId?: string; payload?: Record<string, unknown> }

const workspaceCatalogBudget = 24_000

function workspaceCatalog(materials: Material[]): { hits: SearchHit[]; omitted: number } {
  const hits: SearchHit[] = []
  let used = 0
  let omitted = 0
  for (const material of materials) {
    const summary = String(material.extractedText || material.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 420)
    const expandedText = `Type: ${material.type}; Status: ${material.status}; Summary: ${summary || '(no extracted summary)'}`
    const compactText = `Type: ${material.type}; Status: ${material.status}; Summary: (summary omitted from expanded context)`
    const expandedCost = material.id.length + material.title.length + expandedText.length + 20
    const compactCost = material.id.length + material.title.length + compactText.length + 20
    const expand = !hits.length || used + expandedCost <= workspaceCatalogBudget
    const text = expand ? expandedText : compactText
    if (!expand) omitted += 1
    hits.push({ materialId: material.id, chunkId: 'catalog', title: material.title.slice(0, 240), text, score: 1, sourcePath: material.sourcePath, pageNumber: null, heading: null, availability: material.availability })
    used += expand ? expandedCost : compactCost
  }
  return { hits, omitted }
}

type KnowledgeAnswerScope = 'workspace' | 'general' | 'action'
interface ParsedKnowledgeResponse { answer: string; markers: string[]; scope?: KnowledgeAnswerScope }
interface AgentToolCall { name: string; arguments: Record<string, unknown> }

function sourceMarker(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = value.match(/\[?([^:\]\s]+):([^\]\s]+)\]?/)
    return match ? `${match[1]}:${match[2]}` : null
  }
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    const materialId = String(row.materialId ?? row.material_id ?? '')
    const chunkId = String(row.chunkId ?? row.chunk_id ?? '')
    return materialId && chunkId ? `${materialId}:${chunkId}` : null
  }
  return null
}

function parseKnowledgeResponse(text: string): ParsedKnowledgeResponse {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (cleaned.startsWith('{') || cleaned.startsWith('"')) {
    try {
      const parsed = parseJsonObject(cleaned)
      const answer = String(parsed.answer ?? parsed.response ?? parsed.content ?? '').trim()
      const values = Array.isArray(parsed.sources) ? parsed.sources : Array.isArray(parsed.citations) ? parsed.citations : []
      const markers = values.map(sourceMarker).filter((marker): marker is string => Boolean(marker))
      const scope = ['workspace', 'general', 'action'].includes(String(parsed.scope)) ? String(parsed.scope) as KnowledgeAnswerScope : undefined
      // A valid but empty JSON answer is still an empty model response. Keep
      // it empty so the retry/local-evidence path can recover instead of
      // rendering the raw `{}` object as if it were an answer.
      return { answer, markers, scope }
    } catch { /* Older providers often ignore the JSON instruction; plain text remains supported. */ }
  }
  return { answer: text.trim(), markers: [] }
}

function parseAgentInstruction(text: string): { kind: 'tool'; call: AgentToolCall } | { kind: 'final' } | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!cleaned.startsWith('{') && !cleaned.startsWith('"')) return null
  try {
    const parsed = parseJsonObject(cleaned)
    const type = String(parsed.type ?? parsed.kind ?? '').toLocaleLowerCase()
    const name = String(parsed.name ?? parsed.tool ?? '').trim()
    const rawArguments = parsed.arguments ?? parsed.args ?? parsed.input ?? {}
    if ((type === 'tool_call' || type === 'tool' || (name && !('answer' in parsed))) && name) {
      const argumentsValue = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments) ? rawArguments as Record<string, unknown> : {}
      return { kind: 'tool', call: { name, arguments: argumentsValue } }
    }
    if (type === 'final' || 'answer' in parsed || 'response' in parsed || 'content' in parsed) return { kind: 'final' }
  } catch { /* Providers may return ordinary prose despite the agent protocol. */ }
  return null
}

function sourceKey(hit: SearchHit): string { return `${hit.materialId}:${hit.chunkId}` }

function isEvidenceInsufficient(answer: string): boolean {
  const normalized = answer.replace(/\s+/gu, ' ').trim()
  return /evidence\s+is\s+insufficient/i.test(normalized)
    || /(?:当前|现有|提供的|本地)?材料.{0,36}(?:没有|未找到|找不到|不足|缺少).{0,30}(?:证据|信息|回答|支持)/u.test(normalized)
    || /(?:证据|信息).{0,16}(?:不足|不够|缺少)/u.test(normalized)
    || /(?:抱歉|对不起)?\s*(?:我)?(?:无法|不能|没法).{0,24}(?:回答|确定|提供|判断)/u.test(normalized)
    || /(?:无法|不能|没法).{0,24}(?:回答|确定|提供|判断)/u.test(normalized)
    || /(?:我)?(?:不确定|不清楚|不太清楚|无法确认)/u.test(normalized)
}

function isUsableKnowledgeAnswer(answer: string, question?: string): boolean {
  const normalized = answer.replace(/\s+/gu, ' ').replace(/^根据(?:当前)?本地材料回答\s*[:：]?/u, '').replace(/\[[^:\]\s]+:[^\]\s]+\]/gu, '').trim()
  const comparable = normalized.replace(/[？?。！!，,：:]/gu, '')
  const questionComparable = (question ?? '').replace(/[？?。！!，,：:]/gu, '')
  return normalized.length >= 2 && comparable !== questionComparable && !/^(?:好的|好的。|明白|收到)[。！!]?$/u.test(normalized)
}

function isInventoryQuestion(question: string): boolean {
  return /(?:多少|几份|共有|总共|一共).{0,12}(?:材料|资料|文档)|(?:材料|资料|文档).{0,12}(?:多少|几份|有哪些|列表|清单)/u.test(question)
}

function isWorkspaceQuestionWithNoMaterials(question: string): boolean {
  return isInventoryQuestion(question) || /(?:当前|这个|本地)?(?:工作区|知识库).{0,20}(?:材料|资料|文档|内容|有什么)|(?:材料|资料|文档).{0,20}(?:工作区|知识库|导入|本地)/u.test(question)
}

function isModelCapabilityQuestion(question: string): boolean {
  return /(?:你是(?:什么|哪个)模型|什么模型|能做(?:什么|哪些)|你的能力|你是谁)/u.test(question)
}

function isLearningPathQuestion(question: string): boolean {
  return /(?:从\s*(?:第?\s*)?0\s*章|从零|从头|第一步|入门|学习).{0,24}(?:开始|学|看|章节|章)|(?:学习|入门).{0,24}(?:哪(?:几|些)章|从)/u.test(question)
}

function citationFromHit(hit: SearchHit): GroundedAnswer['citations'][number] {
  return { id: hit.materialId, materialId: hit.materialId, chunkId: hit.chunkId, title: hit.title, excerpt: hit.text.slice(0, 360), sourcePath: hit.sourcePath, pageNumber: hit.pageNumber, heading: hit.heading }
}

function localEvidenceText(text: string, limit = 180): string {
  return text.replace(/```[\s\S]*?```/gu, '').replace(/^#{1,6}\s+/gmu, '').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

function parseJsonObject(text: string): Record<string, unknown> {
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  // Some compatible gateways JSON-encode message.content once more. Decode
  // that wrapper before looking for the structured response object.
  for (let depth = 0; depth < 2 && cleaned.startsWith('"'); depth += 1) {
    try {
      const decoded = JSON.parse(cleaned)
      if (typeof decoded !== 'string') break
      cleaned = decoded.trim()
    } catch { break }
  }
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model output did not contain a JSON object.')
  let parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) parsed = JSON.parse(parsed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Model output was not a JSON object.')
  return parsed as Record<string, unknown>
}

export class AiService {
  private readonly topicRuns = new Map<string, Promise<AnalysisSummary>>()
  private readonly topicControllers = new Map<string, AbortController>()
  private readonly materialTools: MaterialMapMcpServer
  constructor(private readonly workspace: WorkspaceService, private readonly appStore: AppStore) {
    this.materialTools = new MaterialMapMcpServer(workspace)
    const target = this.workspace as unknown as { setEmbeddingProvider?: (provider: (texts: string[]) => Promise<number[][] | null>) => void }
    target.setEmbeddingProvider?.((texts) => this.embed(texts))
  }

  async testConnection(settings: ModelSettings): Promise<{ ok: boolean; message: string }> {
    try {
      const profile = this.profileFor(settings)
      const response = await this.chat(profile, settings.chatModel, 'Reply with OK.', false)
      if (!response.ok) throw new Error(`${profile.wireApi === 'responses' ? 'Responses' : 'Chat Completions'} API returned HTTP ${response.status}.`)
      const text = this.responseText(await this.responseJson(response, 'Connection test'))
      if (!text.trim()) throw new Error('The API returned JSON but no output text.')
      return { ok: true, message: `${profile.wireApi === 'responses' ? 'Responses' : 'Chat Completions'} connection succeeded.` }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Unable to connect.' } }
  }

  async validate(settings: ModelSettings, topicId?: string): Promise<Array<{ id: string; ok: boolean; detail: string; status?: number; durationMs: number }>> {
    const profile = this.profileFor(settings)
    if (!settings.enabled || !settings.chatModel) return [{ id: 'configuration', ok: false, detail: 'Enable analysis and select a chat model before validation.', durationMs: 0 }]
    if (settings.provider !== 'ollama' && !settings.allowCloud) return [{ id: 'configuration', ok: false, detail: 'Enable cloud consent before validation.', durationMs: 0 }]
    if (topicId) {
      const map = this.workspace.topicMap(topicId)
      if (map.materials.length < 2) return [{ id: 'configuration', ok: false, detail: 'The AI demonstration topic needs at least two materials.', durationMs: 0 }]
    }
    const run = async (id: string, action: () => Promise<void>): Promise<{ id: string; ok: boolean; detail: string; status?: number; durationMs: number }> => {
      const started = Date.now()
      try { await action(); return { id, ok: true, detail: `${profile.wireApi === 'responses' ? 'POST /responses' : 'POST /chat/completions'} succeeded.`, durationMs: Date.now() - started } }
      catch (error) { return { id, ok: false, detail: error instanceof Error ? error.message : 'Unknown failure.', durationMs: Date.now() - started } }
    }
    const connection = await run('connection', async () => { const result = await this.testConnection(settings); if (!result.ok) throw new Error(result.message) })
    const chat = await run('chat', async () => { const response = await this.chat(profile, settings.chatModel, 'Reply with exactly: Material Map ready.', false); if (!response.ok) throw new Error(`Chat request returned HTTP ${response.status}.`); if (!this.responseText(await this.responseJson(response, 'Chat validation')).trim()) throw new Error('Chat response contained no text.') })
    const steps = [connection, chat]
    if (topicId) steps.push(await run('analysis', async () => { await this.analyzeTopic(topicId) }))
    return steps
  }

  async refreshModels(profileId: string): Promise<ProviderProfile> {
    const profile = this.appStore.getProfile(profileId); if (!profile) throw new Error('Model profile not found.')
    const result = await this.readModels(profile, 12000)
    const activeProfile = result.baseUrl === profile.baseUrl ? profile : this.appStore.saveProfile({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: result.baseUrl, wireApi: profile.wireApi })
    const models = result.models
    const recommended = models.find((model) => /latest|gpt|claude|gemini|deepseek|grok|qwen|kimi|minimax|glm/i.test(model)) ?? models[0] ?? null
    return this.appStore.updateModels(activeProfile.id, models, recommended)
  }

  async saveProfileWithModels(input: ProviderProfileInput): Promise<ProviderProfile> {
    const existing = input.id ? this.appStore.getProfile(input.id) : null
    const profile = this.appStore.saveProfile(input)
    try {
      const discovered = await this.refreshModels(profile.id)
      if (!discovered.recommendedModel) throw new Error('服务未返回可用的聊天模型。')
      return discovered
    } catch (error) {
      if (!existing) this.appStore.deleteProfile(profile.id)
      throw error
    }
  }

  async analyze(topicId: string, materialId: string): Promise<AnalysisSummary> {
    const map = this.workspace.topicMap(topicId)
    if (!map.materials.some((material) => material.id === materialId)) throw new Error('Material is not part of this topic.')
    return this.analyzeTopic(topicId)
  }

  analyzeTopic(topicId: string): Promise<AnalysisSummary> {
    const active = this.topicRuns.get(topicId)
    if (active) return active
    const controller = new AbortController()
    const run = this.runTopicAnalysisV2(topicId, controller.signal).finally(() => { this.topicRuns.delete(topicId); this.topicControllers.delete(topicId) })
    this.topicRuns.set(topicId, run)
    this.topicControllers.set(topicId, controller)
    return run
  }
  cancelTopicAnalysis(topicId: string): boolean { const controller = this.topicControllers.get(topicId); if (!controller) return false; controller.abort(); return true }

  private async runTopicAnalysis(topicId: string): Promise<AnalysisSummary> {
    const map = this.workspace.topicMap(topicId)
    const summary: AnalysisSummary = { topicId, processed: 0, addedWorkstreams: 0, addedRelations: 0, failures: [] }
    const settings = this.workspace.getSettings()
    if (!map.materials.length) throw new Error('Add materials to this topic before analysis.')
    if (!settings.enabled || !settings.chatModel) throw new Error('Enable analysis and select a chat model in workspace settings first.')
    if (settings.provider !== 'ollama' && !settings.allowCloud) throw new Error('Cloud analysis requires explicit consent in settings.')
    const jobs = map.materials.map((material) => ({ materialId: material.id, jobId: this.workspace.startJob(material.id, 'ai-analysis') }))
    try {
      const result = await this.requestTopic(settings, map)
      this.validateTopicResult(map, result)
      // The built-in connection analysis creates reversible AI-layer relations so
      // the board changes immediately. Conversational operations remain proposals.
      const proposedWorkstreams = (result.workstreams ?? []).filter((stream) => stream.name.trim())
      summary.addedWorkstreams = proposedWorkstreams.length
      const materialIds = new Set(map.materials.map((material) => material.id))
      for (const stream of proposedWorkstreams) {
        const ids = stream.materialIds.filter((materialId) => materialIds.has(materialId))
        if (ids.length) { const workstream = this.workspace.createWorkstream(topicId, stream.name.trim().slice(0, 80), 'ai'); ids.forEach((materialId) => this.workspace.moveMaterial(topicId, materialId, workstream.id)) }
      }
      const aiParents = new Set<string>()
      for (const relation of result.relations) {
        if (!materialIds.has(relation.sourceMaterialId) || !materialIds.has(relation.targetMaterialId) || relation.sourceMaterialId === relation.targetMaterialId) continue
        if (aiParents.has(relation.targetMaterialId)) continue
        const relationType = relation.relationType && relation.relationType in workflowRelations ? relation.relationType : 'related'
        const label = relationType === 'related' && relation.relationType === 'custom' && relation.label?.trim() ? relation.label.trim().slice(0, 32) : workflowRelations[relationType]
        const evidence = relation.evidence.trim()
        if (!label || !evidence || this.workspace.hasRelation(relation.sourceMaterialId, relation.targetMaterialId, label)) continue
        this.workspace.createRelation({ sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, label, relationType, evidenceText: evidence, evidenceMaterialId: relation.sourceMaterialId, confidence: Number.isFinite(relation.confidence) ? relation.confidence ?? null : null, createdBy: 'ai' })
        aiParents.add(relation.targetMaterialId)
        summary.addedRelations += 1
      }
      summary.processed = map.materials.length
      jobs.forEach((job) => this.workspace.finishJob(job.jobId))
      return summary
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analysis failed.'
      jobs.forEach((job) => this.workspace.failJob(job.jobId, message))
      summary.failures = jobs.map((job) => ({ materialId: job.materialId, error: message }))
      throw error
    }
  }

  private localKnowledgeFallback(question: string, settings: ModelSettings, materials: Material[], catalog: SearchHit[], hits: SearchHit[], retrievalMode: GroundedAnswer['retrievalMode'], toolCalls: AgentToolCall[] = [], toolResults: unknown[] = []): GroundedAnswer | null {
    const usedTools = toolCalls.map((call) => ({ name: call.name, arguments: call.arguments }))
    const answerScope: KnowledgeAnswerScope = toolCalls.some((call) => call.name === 'propose_topic_changes') ? 'action' : 'workspace'
    let proposalIndex = -1
    for (let index = toolCalls.length - 1; index >= 0; index -= 1) { if (toolCalls[index].name === 'propose_topic_changes') { proposalIndex = index; break } }
    const proposalResult = proposalIndex >= 0 && toolResults[proposalIndex] && typeof toolResults[proposalIndex] === 'object' ? toolResults[proposalIndex] as Record<string, unknown> : null
    const proposalCount = proposalResult && Array.isArray(proposalResult.proposals) ? proposalResult.proposals.length : 0
    if (proposalCount > 0) return { answer: `已生成 **${proposalCount}** 条待审核操作。请进入对应主题画板，在“待审核操作”中逐条应用或忽略；应用后仍可撤销。`, citations: [], confidence: 'grounded', retrievalMode: 'fallback', model: settings.chatModel, retrievedChunks: hits.length, citationMode: 'catalog', answerMode: 'local-fallback', answerScope: 'action', toolCalls: usedTools }
    if (isModelCapabilityQuestion(question)) {
      return { answer: `当前配置的模型是 **${settings.chatModel}**。我既可以回答通用问题，也可以调用 Material Map 工具检索材料、查关系和读取主题画板；涉及画板修改时只生成待审核提案。`, citations: [], confidence: 'grounded', retrievalMode, model: settings.chatModel, retrievedChunks: 0, citationMode: 'catalog', answerMode: 'local-fallback', answerScope: 'general', toolCalls: usedTools }
    }
    if (isInventoryQuestion(question)) {
      const showTitles = /(?:有哪些|什么材料|列出|清单|列表)/u.test(question)
      const titles = materials.slice(0, 12).map((material) => material.title).filter(Boolean)
      const suffix = showTitles ? `\n前 ${titles.length} 份材料：${titles.join('、')}${materials.length > titles.length ? `（其余 ${materials.length - titles.length} 份未展开）` : ''}` : ''
      return { answer: `当前工作区共有 **${materials.length}** 份材料。${suffix}`, citations: catalog.slice(0, 3).map(citationFromHit), confidence: 'grounded', retrievalMode, model: settings.chatModel, retrievedChunks: hits.length, citationMode: 'catalog', answerMode: 'local-fallback', answerScope, toolCalls: usedTools }
    }
    if (hits.length) {
      const unique = [...new Map(hits.map((hit) => [hit.materialId, hit])).values()]
        .sort((left, right) => {
          if (!isLearningPathQuestion(question)) return 0
          const leftNumber = Number(left.title.match(/^(\d{1,3})[-_、.]/u)?.[1] ?? 999)
          const rightNumber = Number(right.title.match(/^(\d{1,3})[-_、.]/u)?.[1] ?? 999)
          return leftNumber - rightNumber
        })
        .slice(0, 3)
      if (isLearningPathQuestion(question)) {
        if (unique.length) {
          const path = unique.slice(0, 3).map((hit) => `- **${hit.title}**${hit.heading ? ` · ${hit.heading}` : ''}：${localEvidenceText(hit.text, 140)}`).join('\n')
          return { answer: `建议按章节顺序学习：\n${path}`, citations: unique.map(citationFromHit), confidence: 'grounded', retrievalMode, model: settings.chatModel, retrievedChunks: hits.length, citationMode: 'inferred', answerMode: 'local-fallback', answerScope, toolCalls: usedTools }
        }
      }
      return { answer: `我在当前材料中找到这些相关内容：\n${unique.map((hit) => `- **${hit.title}**${hit.heading ? ` · ${hit.heading}` : ''}：${localEvidenceText(hit.text)}`).join('\n')}`, citations: unique.map(citationFromHit), confidence: 'grounded', retrievalMode, model: settings.chatModel, retrievedChunks: hits.length, citationMode: 'inferred', answerMode: 'local-fallback', answerScope, toolCalls: usedTools }
    }
    if (/(?:概括|总结|整体|内容)/u.test(question) && materials.length) {
      const titles = materials.slice(0, 8).map((material) => material.title).filter(Boolean)
      return { answer: `当前工作区共有 ${materials.length} 份材料，主要包括：${titles.join('、')}${materials.length > titles.length ? '等。' : '。'} `, citations: catalog.slice(0, 3).map(citationFromHit), confidence: 'grounded', retrievalMode, model: settings.chatModel, retrievedChunks: hits.length, citationMode: 'catalog', answerMode: 'local-fallback', answerScope, toolCalls: usedTools }
    }
    return null
  }

  private async askWithMaterialTools(profile: ProviderProfile, settings: ModelSettings, prompt: string): Promise<{ text: string; toolCalls: AgentToolCall[]; toolResults: unknown[] }> {
    const trace: Array<{ call: AgentToolCall; result: unknown }> = []
    let nextPrompt = `${prompt}\n\nAgent tool protocol: You are the decision-maker for this user question. The local capabilities are separate MCP modules; choose the smallest relevant set from the question, and use zero tools for a purely general question that needs no workspace facts. Do not call every module in sequence. Use material tools for directory/search/read, relation tools for directed links and evidence, topic tools for the active canvas, and the canonical propose_topic_changes tool only when the user explicitly asks to change or organize the board. The legacy topic.propose_* tools are validation-only helpers; never present their result as an applied operation. On a tool turn return ONLY JSON {"type":"tool_call","name":"tool_name","arguments":{...}}. After the tool results are supplied, return ONLY JSON {"type":"final","scope":"workspace|general|action","answer":"...","sources":["materialId:chunkId"]} or concise plain text. Never invent an ID, never expose internal tool names or IDs in the visible answer, and do not claim a board change happened until a reviewable proposal was created.\n${JSON.stringify(this.materialTools.listTools())}`
    let lastText = ''
    for (let turn = 0; turn < 6; turn += 1) {
      const response = await this.chat(profile, settings.chatModel, nextPrompt, false)
      if (!response.ok) throw new Error(`Question request returned HTTP ${response.status}.`)
      lastText = this.responseText(await this.responseJson(response, `Question${turn ? ' tool follow-up' : ''}`))
      const instruction = parseAgentInstruction(lastText)
      if (!instruction || instruction.kind === 'final') return { text: lastText, toolCalls: trace.map((item) => item.call), toolResults: trace.map((item) => item.result) }
      let result: unknown
      try { result = await this.materialTools.call(instruction.call.name, instruction.call.arguments) }
      catch (error) { result = { error: error instanceof Error ? error.message : 'Tool call failed.' } }
      trace.push({ call: instruction.call, result })
      const serializedTrace = trace.map((item, index) => `Tool call ${index + 1}: ${JSON.stringify(item.call)}\nTool result ${index + 1}: ${JSON.stringify(item.result).slice(0, 12_000)}`).join('\n\n')
      nextPrompt = `${prompt}\n\nAgent tool protocol: Continue reasoning from the tool results below. Call another module only when the question still needs a missing fact; otherwise answer now. Return ONLY JSON {"type":"tool_call","name":"tool_name","arguments":{...}} for another necessary read, or {"type":"final","scope":"workspace|general|action","answer":"...","sources":["materialId:chunkId"]} when ready. Never invent facts or IDs, never expose internal tool names or IDs, and keep board changes as reviewable proposals.\n\n${serializedTrace}`
    }
    return { text: lastText, toolCalls: trace.map((item) => item.call), toolResults: trace.map((item) => item.result) }
  }

  async ask(input: string | KnowledgeQuestion): Promise<GroundedAnswer> {
    const question = (typeof input === 'string' ? input : input?.question ?? '').trim().slice(0, 2000)
    if (!question) throw new Error('请输入要查询的问题。')
    const settings = this.workspace.getSettings()
    if (!settings.enabled || !settings.profileId || !settings.chatModel) throw new Error('请先在“模型与隐私”中添加并启用 AI 配置后再提问。')
    const profile = this.appStore.getProfile(settings.profileId)
    if (!profile || (profile.provider !== 'ollama' && !profile.hasApiKey)) throw new Error('当前 AI 配置不完整，请在“模型与隐私”中重新配置。')
    if (profile.provider !== 'ollama' && !settings.allowCloud) throw new Error('请先在“模型与隐私”中确认允许将材料发送到外部 AI 服务。')
    const history: KnowledgeChatTurn[] = (typeof input === 'string' || !Array.isArray(input.history) ? [] : input.history)
      .filter((turn): turn is KnowledgeChatTurn => Boolean(turn) && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
      .slice(-8)
      .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, 1200) }))
      .filter((turn) => turn.content.length > 0)
    const workspaceMaterials = this.workspace.listMaterials()
    if (!workspaceMaterials.length && isWorkspaceQuestionWithNoMaterials(question)) return { answer: '当前工作区还没有材料。', citations: [], confidence: 'insufficient-evidence', retrievalMode: 'fallback', model: null, answerScope: 'workspace' }
    const previousQuestion = [...history].reverse().find((turn) => turn.role === 'user')?.content
    const retrievalQuestion = previousQuestion ? `${previousQuestion}\n${question}` : question
    const retrieval = await this.workspace.searchKnowledgeAsync(retrievalQuestion, { limit: 6 })
    const retrievalHits = this.expandKnowledgeHits(retrieval.hits)
    const catalog = workspaceCatalog(workspaceMaterials)
    const catalogContext = catalog.hits.map((hit) => `[${hit.materialId}:${hit.chunkId}] ${hit.title}\n${hit.text}`).join('\n\n')
    const retrievalContext = retrievalHits.map((hit) => `[${hit.materialId}:${hit.chunkId}] ${hit.title}${hit.heading ? ` · ${hit.heading}` : ''}\n${hit.text}`).join('\n\n')
    const retrievalMode = retrievalHits.length ? retrieval.mode : 'fallback' as const
    const conversation = history.length
      ? `Conversation history (context only; do not treat prior assistant claims as evidence):\n${history.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n')}\n\n`
      : ''
    const prompt = `You are the DeepSeek-powered assistant inside Material Map. Answer the current question in concise, natural Chinese. For questions about the workspace, its materials, relations, or topic canvas, use ONLY the supplied local context and Material Map tools, and return scope "workspace". For an unrelated general question, you may answer from the model's general knowledge and return scope "general"; do not attach workspace citations or pretend the answer came from local materials. For an explicitly requested Material Map operation, inspect the relevant topic first, create only reviewable proposals through the proposal tool, and return scope "action". The catalog is authoritative evidence for inventory, directory, overview, and learning-path questions: use it to answer material counts, names, chapter order, and short summaries even when the keyword retrieval section is empty. Never say evidence is insufficient for those questions when the catalog contains the requested fact. For other workspace facts, decide whether the supplied local excerpts support the answer. For a supported answer, explain the conclusion directly and use Markdown bullets or a short table when that makes the answer clearer. For a follow-up, resolve pronouns from the conversation history but verify every workspace claim against the supplied context.

The configured model is ${settings.chatModel}. If the question asks what model you are or what you can do, answer from this runtime metadata. The workspace material count is exactly ${workspaceMaterials.length}; treat that count and the catalog as authoritative for inventory questions. The catalog includes ${catalog.hits.length} materials${catalog.omitted ? ` and omits ${catalog.omitted} summaries from expanded context because of the context budget` : ''}. Relevant local excerpts are the primary evidence for workspace content questions. Prefer JSON in this shape: {"type":"final","scope":"workspace|general|action","answer":"...","sources":["materialId:chunkId"]}. When returning workspace sources, use only the supplied markers, at most three, and never expose internal IDs in the visible answer. The application validates and attaches sources, so do not refuse a supported workspace answer merely because a source marker is inconvenient. If the local context does not support a workspace factual answer, say exactly that the current materials do not contain enough evidence. Do not say the workspace is empty unless the authoritative count is zero.

${conversation}Current question: ${question}

Workspace material catalog:
${catalogContext || '(empty catalog)'}

Relevant local excerpts:
${retrievalContext || '(none found; answer only from the catalog and summaries above)'}`
    let agentResult: { text: string; toolCalls: AgentToolCall[]; toolResults: unknown[] }
    try { agentResult = await this.askWithMaterialTools(profile, settings, prompt) } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/safeStorage|decrypt/i.test(message)) throw new Error('AI 密钥无法读取，请在“模型与隐私”中重新保存 API Key。')
      throw error
    }
    let toolCalls = agentResult.toolCalls
    let toolResults = agentResult.toolResults
    let parsed = parseKnowledgeResponse(agentResult.text)
    let answer = parsed.answer
    // Some models are overly conservative when the context contains several
    // adjacent chunks. Give them one focused retry before falling back to a
    // deterministic answer from the same local evidence.
    if ((!isUsableKnowledgeAnswer(answer, question) || isEvidenceInsufficient(answer)) && retrievalHits.length && parsed.scope !== 'general') {
      const retryPrompt = `The previous answer was empty or too conservative. Answer the question directly from the local excerpts below. Do not say evidence is insufficient when the excerpts contain the requested fact. Use concise Chinese Markdown. Return plain text or {"answer":"...","sources":["materialId:chunkId"]}; never invent facts.\n\nQuestion: ${question}\n\nLocal excerpts:\n${retrievalHits.slice(0, 6).map((hit) => `[${hit.materialId}:${hit.chunkId}] ${hit.title}${hit.heading ? ` · ${hit.heading}` : ''}\n${hit.text}`).join('\n\n')}`
      try {
        const retry = await this.askWithMaterialTools(profile, settings, retryPrompt)
        toolCalls = [...toolCalls, ...retry.toolCalls]
        toolResults = [...toolResults, ...retry.toolResults]
        const retryParsed = parseKnowledgeResponse(retry.text)
        if (isUsableKnowledgeAnswer(retryParsed.answer, question) && !isEvidenceInsufficient(retryParsed.answer)) { parsed = retryParsed; answer = retryParsed.answer }
      } catch { /* The local evidence fallback below remains available. */ }
    }
    if (!isUsableKnowledgeAnswer(answer, question) || isEvidenceInsufficient(answer)) {
      const fallback = this.localKnowledgeFallback(question, settings, workspaceMaterials, catalog.hits, retrievalHits, retrievalMode, toolCalls, toolResults)
      if (fallback) return fallback
      return { answer: answer ? '当前材料不足以回答这个问题。' : '模型没有返回可用回答。', citations: [], confidence: 'insufficient-evidence', retrievalMode, model: settings.chatModel, retrievedChunks: retrievalHits.length, toolCalls }
    }
    const answerScope: KnowledgeAnswerScope = toolCalls.some((call) => call.name === 'propose_topic_changes') ? 'action' : parsed.scope ?? (isModelCapabilityQuestion(question) ? 'general' : 'workspace')
    const evidenceHits = [...retrievalHits, ...catalog.hits]
    const valid = new Map(evidenceHits.map((hit) => [`${hit.materialId}:${hit.chunkId}`, { id: hit.materialId, materialId: hit.materialId, chunkId: hit.chunkId, title: hit.title, excerpt: hit.text.slice(0, 360), sourcePath: hit.sourcePath, pageNumber: hit.pageNumber, heading: hit.heading }]))
    const retrievalMarkers = new Set(retrievalHits.map(sourceKey))
    const citationNumbers = new Map<string, number>()
    const usedCitations: GroundedAnswer['citations'] = []
    let hasRetrievalCitation = false
    let modelProvidedRetrievalCitation = false
    const addCitation = (marker: string, retrievalCitation: boolean, modelCitation = false): void => {
      const citation = valid.get(marker)
      if (!citation) return
      const existing = citationNumbers.get(citation.materialId)
      if (existing) {
        if (retrievalCitation) { hasRetrievalCitation = true; if (modelCitation) modelProvidedRetrievalCitation = true; usedCitations[existing - 1] = citation }
        return
      }
      if (usedCitations.length >= 3) return
      const number = usedCitations.length + 1
      citationNumbers.set(citation.materialId, number)
      usedCitations.push(citation)
      if (retrievalCitation) { hasRetrievalCitation = true; if (modelCitation) modelProvidedRetrievalCitation = true }
    }
    if (answerScope !== 'general') for (const marker of parsed.markers) addCitation(marker, retrievalMarkers.has(marker), true)
    const normalizedAnswer = answer.replace(/\[([^:\]\s]+):([^\]\s]+)\]/g, (_marker, materialId: string, chunkId: string) => {
      const marker = `${materialId}:${chunkId}`
      const before = usedCitations.length
      addCitation(marker, retrievalMarkers.has(marker), true)
      const citation = valid.get(marker)
      if (!citation) return ''
      return `[${citationNumbers.get(citation.materialId) ?? (before + 1)}]`
    }).replace(/\]\s*\[/g, '] [').replace(/[ \t]+([，。；：！？])/g, '$1').trim()
    // Source attribution is a product responsibility, not a formatting test
    // for the model. If a provider returns a useful plain-text answer without
    // markers, attach the strongest retrieved chunks and show them in the UI.
    if (answerScope !== 'general' && !hasRetrievalCitation && retrievalHits.length > 0) {
      const answerTerms = new Set(tokenize(normalizedAnswer))
      const inferred = retrievalHits.map((hit, index) => ({ hit, score: tokenize(`${hit.title} ${hit.heading ?? ''} ${hit.text}`).reduce((score, term) => score + (answerTerms.has(term) ? 1 : 0), 0) + (1 / (index + 1)) })).sort((left, right) => right.score - left.score)
      for (const { hit } of inferred.slice(0, 3)) addCitation(sourceKey(hit), true)
    }
    const insufficient = isEvidenceInsufficient(normalizedAnswer)
    if (insufficient) return { answer: '当前材料不足以回答这个问题。', citations: [], confidence: 'insufficient-evidence', retrievalMode, model: settings.chatModel, retrievedChunks: retrievalHits.length, answerScope, toolCalls }
    return { answer: normalizedAnswer, citations: answerScope === 'general' ? [] : usedCitations, confidence: 'grounded', retrievalMode: answerScope === 'general' ? 'fallback' : retrievalMode, model: settings.chatModel, retrievedChunks: answerScope === 'general' ? 0 : retrievalHits.length, citationMode: answerScope === 'general' ? 'catalog' : modelProvidedRetrievalCitation ? 'model' : usedCitations.length ? 'inferred' : 'catalog', answerMode: 'model', answerScope, toolCalls }
  }

  private expandKnowledgeHits(hits: SearchHit[]): SearchHit[] {
    if (!hits.length) return []
    const listChunks = (this.workspace as unknown as { listMaterialChunks?: (materialId: string) => Array<{ id: string; materialId: string; text: string; heading: string | null; pageNumber: number | null }> }).listMaterialChunks
    if (!listChunks) return hits.slice(0, 8)
    const expanded: SearchHit[] = []
    const seen = new Set<string>()
    for (const hit of hits.slice(0, 6)) {
      const chunks = listChunks.call(this.workspace, hit.materialId)
      const ordinal = chunks.findIndex((chunk) => chunk.id === hit.chunkId)
      const neighbors = ordinal < 0 ? [] : chunks.slice(Math.max(0, ordinal - 1), ordinal + 2)
      for (const chunk of neighbors) {
        if (seen.has(chunk.id)) continue
        seen.add(chunk.id)
        expanded.push({ ...hit, chunkId: chunk.id, text: chunk.text, heading: chunk.heading, pageNumber: chunk.pageNumber, score: hit.score })
        if (expanded.length >= 10) return expanded
      }
      if (!neighbors.length && hit.chunkId && !seen.has(hit.chunkId)) { seen.add(hit.chunkId); expanded.push(hit) }
    }
    return expanded.length ? expanded : hits.slice(0, 8)
  }

  // Explains exactly one discovered relation. The result is never persisted
  // and never changes relation status or direction chosen by a human.
  async explainMaterialRelation(relationId: string): Promise<RelationAiExplanationResult> {
    const failure = (reason: RelationAiExplanationFailureReason, message: string): RelationAiExplanationResult => ({ ok: false, reason, message })
    const relation = this.workspace.getMaterialRelation(relationId)
    if (!relation) throw new Error('Material relationship not found.')
    const source = this.workspace.getMaterial(relation.sourceMaterialId); const target = this.workspace.getMaterial(relation.targetMaterialId)
    if (!source || !target) throw new Error('Relationship material is unavailable.')
    const settings = this.workspace.getSettings()
    if (!settings.enabled || !settings.chatModel) return failure('not-configured', '请先在设置中启用 AI 并选择聊天模型。')
    if (settings.provider !== 'ollama' && !settings.allowCloud) return failure('no-consent', '使用云端模型解释关系前，请在设置中明确同意云端处理。')
    // Context window: at most 2 chunks per side, 500 characters each.
    const windows = (materialId: string) => this.workspace.materialEvidenceWindow(materialId, `${source.title} ${target.title}`, 1).slice(0, 2).map((chunk) => ({ heading: chunk.heading, text: chunk.text.slice(0, 500) }))
    const prompt = `Explain or reject exactly one locally discovered relationship. Use only the supplied evidence. Return ONLY JSON: {"supported":true,"sourceMaterialId":"${source.id}","targetMaterialId":"${target.id}","relationType":"references|depends_on|evidences|implements|tests|related","label":"short Chinese label","explanation":"one concise Chinese explanation","confidence":0.0}. Keep the supplied direction unless evidence clearly supports reversing it. Local evidence: ${JSON.stringify(relation.evidence.map((item) => item.text))}. Source: ${JSON.stringify({ id: source.id, title: source.title, excerpts: windows(source.id) })}. Target: ${JSON.stringify({ id: target.id, title: target.title, excerpts: windows(target.id) })}`
    let response: Response
    try { response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true) } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return failure('timeout', 'AI 解释请求超时，请稍后重试。')
      return failure('provider-error', 'AI 服务配置不完整或暂时无法连接。')
    }
    if (!response.ok) return failure('provider-error', `AI 服务返回错误（HTTP ${response.status}），请稍后重试。`)
    let parsed: Record<string, unknown>
    try { parsed = this.parseExplanationJson(this.responseText(await this.responseJson(response, 'AI explanation'))) } catch { return failure('invalid-json', 'AI 返回的结果无法解析，本地证据仍可查看。') }
    const sourceMaterialId = String(parsed.sourceMaterialId ?? relation.sourceMaterialId); const targetMaterialId = String(parsed.targetMaterialId ?? relation.targetMaterialId)
    const allowed = new Set([relation.sourceMaterialId, relation.targetMaterialId])
    if (!allowed.has(sourceMaterialId) || !allowed.has(targetMaterialId) || sourceMaterialId === targetMaterialId) return failure('invalid-json', 'AI 返回了无法校验的材料标识，已忽略本次解释。')
    const relationTypes = new Set(['references', 'depends_on', 'evidences', 'implements', 'tests', 'related'])
    return { ok: true, supported: Boolean(parsed.supported), sourceMaterialId, targetMaterialId, relationType: typeof parsed.relationType === 'string' && relationTypes.has(parsed.relationType) ? parsed.relationType : relation.relationType, label: String(parsed.label ?? '关联').slice(0, 48), explanation: String(parsed.explanation ?? '本地证据不足以补充说明。').slice(0, 600), confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || relation.score)) }
  }

  // Strict parse first; one repair attempt extracts the outermost {...} block.
  private parseExplanationJson(text: string): Record<string, unknown> {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try { return JSON.parse(cleaned) as Record<string, unknown> } catch { return parseJsonObject(cleaned) }
  }

  /** The board is changed only after every candidate has been evidence-checked. */
  private async runTopicAnalysisV2(topicId: string, signal: AbortSignal): Promise<AnalysisSummary> {
    const map = this.workspace.topicMap(topicId); const settings = this.workspace.getSettings()
    if (!map.materials.length) throw new Error('Add materials to this topic before analysis.')
    if (!settings.enabled || !settings.chatModel) throw new Error('Enable analysis and select a chat model in workspace settings first.')
    if (settings.provider !== 'ollama' && !settings.allowCloud) throw new Error('Cloud analysis requires explicit consent in settings.')
    const summary: AnalysisSummary = { topicId, processed: 0, addedWorkstreams: 0, addedRelations: 0, failures: [] }
    const run = this.workspace.startTopicAnalysisRun(topicId, map.topic.revision, map.materials.length); summary.runId = run.id
    const jobs = map.materials.map((material) => ({ materialId: material.id, jobId: this.workspace.startJob(material.id, 'ai-analysis') }))
    try {
      const cards = this.materialCards(map, settings.chatModel)
      this.workspace.updateTopicAnalysisRun(run.id, { stage: 'candidates', completed: 0, total: cards.length, summary: `Scanning local material index: ${cards.length} cards.` })
      const candidateStore = (this.workspace as unknown as { listTopicCandidates?: (id: string) => Array<{ sourceMaterialId: string; targetMaterialId: string; sharedTags: string[]; score: number; status: string }> }).listTopicCandidates
      const persisted = candidateStore?.(topicId)
      const candidates = persisted ? persisted.filter((candidate) => candidate.status === 'visible').slice(0, 8).map((candidate) => ({ sourceMaterialId: candidate.sourceMaterialId, targetMaterialId: candidate.targetMaterialId, relationType: 'related', label: candidate.sharedTags[0] ?? '关联', confidence: Math.min(.9, candidate.score), evidence: '', sourceChunkIds: [], targetChunkIds: [] })) : this.localTopicCandidates(map, cards)
      this.workspace.updateTopicAnalysisRun(run.id, { completed: cards.length, total: cards.length, summary: `Selected ${candidates.length} local relationship candidates.` })
      this.workspace.updateTopicAnalysisRun(run.id, { stage: 'verifying', completed: 0, total: candidates.length })
      const verified: TopicRelationCandidate[] = []; let rejected = 0
      // A small pool keeps cloud/local providers responsive without turning a
      // large topic into thirty serialized network round trips.
      for (let offset = 0; offset < candidates.length; offset += 6) {
        if (signal.aborted) throw new DOMException('Analysis cancelled by user.', 'AbortError')
        const batch = await Promise.all(candidates.slice(offset, offset + 6).map((candidate) => this.verifyTopicCandidate(settings, map, candidate, signal)))
        for (const result of batch) { if (result) verified.push(result); else rejected += 1 }
        this.workspace.updateTopicAnalysisRun(run.id, { completed: Math.min(offset + batch.length, candidates.length), rejectedCandidates: rejected })
      }
      this.workspace.updateTopicAnalysisRun(run.id, { stage: 'applying', completed: verified.length, total: verified.length, rejectedCandidates: rejected })
      summary.addedRelations = this.workspace.applyTopicAnalysis(topicId, map.topic.revision, verified, this.topicPositions(map, verified)); summary.processed = map.materials.length
      jobs.forEach((job) => this.workspace.finishJob(job.jobId))
      this.workspace.updateTopicAnalysisRun(run.id, { stage: 'complete', completed: summary.processed, total: summary.processed, addedRelations: summary.addedRelations, rejectedCandidates: rejected, summary: summary.addedRelations ? `Created ${summary.addedRelations} evidence-backed AI relationships.` : 'No sufficiently supported relationships were found.' })
      return summary
    } catch (error) { const cancelled = signal.aborted || (error instanceof DOMException && error.name === 'AbortError'); const message = cancelled ? 'Analysis cancelled by user.' : error instanceof Error ? error.message : 'Analysis failed.'; jobs.forEach((job) => this.workspace.failJob(job.jobId, message)); this.workspace.updateTopicAnalysisRun(run.id, { stage: cancelled ? 'cancelled' : 'failed', error: message, summary: cancelled ? 'Analysis was cancelled before changes were applied.' : undefined }); throw error }
  }

  private async embed(texts: string[]): Promise<number[][] | null> {
    const settings = this.workspace.getSettings(); if (!settings.embeddingModel) return null
    if (settings.provider !== 'ollama' && !settings.allowCloud) return null
    const profile = this.profileFor(settings); const base = profile.baseUrl.replace(/\/$/, ''); const headers = { 'Content-Type': 'application/json', ...this.headers(profile) }
    if (profile.provider === 'ollama') {
      const response = await fetch(`${base}/api/embed`, { method: 'POST', headers, body: JSON.stringify({ model: settings.embeddingModel, input: texts }) })
      if (!response.ok) return null
      const body = await response.json() as { embeddings?: number[][]; embedding?: number[] }
      return body.embeddings ?? (body.embedding ? [body.embedding] : null)
    }
    if (profile.provider !== 'compatible') return null
    const response = await fetch(`${base}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: settings.embeddingModel, input: texts }) })
    if (!response.ok) return null
    const body = await response.json() as { data?: Array<{ embedding?: number[] }> }
    return body.data?.map((item) => item.embedding ?? []).filter((item) => item.length > 0) ?? null
  }

  async planTopicOperation(topicId: string, question: string): Promise<{ answer: string; proposedActions: TopicProposal[] }> {
    const map = this.workspace.topicMap(topicId)
    if (!question.trim()) throw new Error('Describe the requested board change.')
    const settings = this.workspace.getSettings()
    if (!settings.enabled || !settings.chatModel) throw new Error('Enable a model before requesting board suggestions.')
    if (settings.provider !== 'ollama' && !settings.allowCloud) throw new Error('Cloud analysis requires explicit consent in settings.')
    const skill = this.readSkill('topic-operation.md')
    const context = topicToolContext(map)
    const prompt = `${skill}\nYou are calling the local topic tools. First inspect this context, then return ONLY JSON matching this schema: {"answer":"short answer","proposedActions":[{"id":"local-id","kind":"create_relation|create_workstream|delete_ai_relation|rename_relation|set_sequence|set_card_style|layout","reason":"why","evidence":"supporting text from context","materialId":"optional","relationId":"optional","payload":{}}]}. For a connection, payload MUST contain sourceMaterialId, targetMaterialId, label, relationType, confidence. Never return prose outside JSON.\nActive topic context: ${JSON.stringify(context)}\nUser request: ${question}`
    const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true)
    if (!response.ok) throw new Error(`Board suggestion request returned HTTP ${response.status}.`)
    let result: { answer?: string; proposedActions?: AiActionProposal[] }
    try { result = parseJsonObject(this.responseText(await this.responseJson(response, 'Board suggestion'))) as typeof result } catch {
      const repair = await this.chat(this.profileFor(settings), settings.chatModel, `Repair the previous board suggestion into ONLY valid JSON using this schema: {"answer":"short answer","proposedActions":[]}. User request: ${question}. Do not include markdown or explanation.`, true)
      if (!repair.ok) throw new Error(`Board suggestion returned invalid JSON (HTTP ${repair.status}).`)
      result = parseJsonObject(this.responseText(await this.responseJson(repair, 'Board suggestion repair'))) as typeof result
    }
    if (!Array.isArray(result.proposedActions)) {
      const repair = await this.chat(this.profileFor(settings), settings.chatModel, `The previous response did not contain proposedActions. Return ONLY JSON with at least one actionable proposal when evidence supports it. Schema: {"answer":"short answer","proposedActions":[{"id":"local-id","kind":"create_relation","reason":"why","evidence":"support","payload":{"sourceMaterialId":"id","targetMaterialId":"id","label":"short label","relationType":"next","confidence":0.8}}]}. User request: ${question}. Context: ${JSON.stringify(context)}`, true)
      if (repair.ok) result = parseJsonObject(this.responseText(await this.responseJson(repair, 'Board suggestion repair'))) as typeof result
    }
    const validated = (result.proposedActions ?? []).filter((action) => this.validProposal(map, action)).slice(0, 8)
    const actions = this.workspace.createTopicProposals(topicId, validated.map((action) => ({ kind: action.kind, reason: action.reason, evidence: action.evidence, materialId: action.materialId ?? null, relationId: action.relationId ?? null, payload: action.payload ?? {} })))
    return { answer: result.answer?.trim() || '已根据当前主题生成可审阅的建议。', proposedActions: actions }
  }

  private materialCards(map: TopicMap, modelId: string): MaterialAnalysisCard[] {
    return map.materials.map((material) => {
      const cached = this.workspace.getMaterialAnalysisCard(material.id, modelId); if (cached) return cached
      const chunks = this.workspace.listMaterialChunks(material.id); const headings = [...new Set(chunks.map((chunk) => chunk.heading).filter((heading): heading is string => Boolean(heading)))].slice(0, 6)
      const keyChunks = chunks.slice(0, 3); const keywords = [...new Set(`${material.title} ${headings.join(' ')} ${keyChunks.map((chunk) => chunk.text.slice(0, 180)).join(' ')}`.match(/[\\p{L}\\p{N}_-]{2,}/gu) ?? [])].slice(0, 12)
      const card: MaterialAnalysisCard = { materialId: material.id, contentHash: material.hash ?? chunkHash(material.extractedText ?? material.excerpt ?? material.title), modelId, title: material.title, date: material.occurredAt ?? material.importedAt, headings, keywords, evidenceChunkIds: keyChunks.map((chunk) => chunk.id), summary: [material.excerpt, headings.length ? `Sections: ${headings.join(' / ')}` : '', keywords.length ? `Keywords: ${keywords.join(', ')}` : ''].filter(Boolean).join('\\n').slice(0, 480), generatedAt: new Date().toISOString() }
      this.workspace.saveMaterialAnalysisCard(card); return card
    })
  }
  private localTopicCandidates(map: TopicMap, cards: MaterialAnalysisCard[]): TopicRelationCandidate[] {
    const documentTerms = cards.map((card) => new Set(this.localTerms(`${card.title} ${card.headings.join(' ')} ${card.keywords.join(' ')} ${card.summary}`)))
    const frequency = new Map<string, number>(); documentTerms.forEach((terms) => terms.forEach((term) => frequency.set(term, (frequency.get(term) ?? 0) + 1)))
    const pairs: Array<{ left: number; right: number; score: number }> = []
    for (let left = 0; left < cards.length; left += 1) for (let right = left + 1; right < cards.length; right += 1) {
      const shared = [...documentTerms[left]].filter((term) => documentTerms[right].has(term) && (frequency.get(term) ?? 0) < cards.length * .7)
      const score = shared.reduce((total, term) => total + Math.log((cards.length + 1) / ((frequency.get(term) ?? 0) + 1)), 0)
      if (score >= .9) pairs.push({ left, right, score })
    }
    if (!pairs.length && map.materials.length === 2) pairs.push({ left: 0, right: 1, score: .25 })
    return pairs.sort((left, right) => right.score - left.score).slice(0, 8).map((pair) => ({ sourceMaterialId: cards[pair.left].materialId, targetMaterialId: cards[pair.right].materialId, relationType: 'related', label: '关联', confidence: Math.min(.75, .25 + pair.score / 8), evidence: '', sourceChunkIds: [], targetChunkIds: [] }))
  }
  private localTerms(value: string): string[] {
    const words = value.toLocaleLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []
    const cjk = [...value.replace(/[^\u4e00-\u9fff]/g, '')].flatMap((_char, index, chars) => index < chars.length - 1 ? [`${chars[index]}${chars[index + 1]}`] : [])
    return [...new Set([...words, ...cjk])]
  }
  private async requestTopicCandidates(settings: ModelSettings, map: TopicMap, batches: MaterialAnalysisCard[][], onBatchComplete: (completed: number) => void, signal?: AbortSignal): Promise<TopicRelationCandidate[]> {
    const raw: Array<Partial<TopicRelationCandidate>> = []
    let completed = 0
    await Promise.all(batches.map(async (cards, index) => {
      const prompt = `${this.readSkill('topic-connection.md')}\\nCandidate batch ${index + 1}/${batches.length}: propose at most ${Math.min(8, Math.max(3, cards.length))} directed candidates from compact material cards. Do not force every material into a tree. Return ONLY JSON: {\"relations\":[{\"sourceMaterialId\":\"id\",\"targetMaterialId\":\"id\",\"relationType\":\"next|depends_on|explains|evidences|implements|tests|blocks|improves|reviews|references|related\",\"label\":\"short\",\"confidence\":0.0}]}. Cards: ${JSON.stringify(cards.map(({ materialId, title, date, headings, keywords, summary }) => ({ materialId, title, date, headings, keywords, summary })))} `
      const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true, signal)
      if (!response.ok) throw new Error(`Candidate batch ${index + 1}/${batches.length} returned HTTP ${response.status}.`)
      const parsed = parseJsonObject(this.responseText(await this.responseJson(response, `Candidate batch ${index + 1}`))) as { relations?: Array<Partial<TopicRelationCandidate>> }
      raw.push(...(parsed.relations ?? [])); completed += 1; onBatchComplete(completed)
    }))
    const ids = new Set(map.materials.map((material) => material.id)); const seen = new Set<string>()
    return raw.flatMap((relation) => { const source = String(relation.sourceMaterialId ?? ''); const target = String(relation.targetMaterialId ?? ''); const key = `${source}:${target}`; if (!ids.has(source) || !ids.has(target) || source === target || seen.has(key)) return []; seen.add(key); return [{ sourceMaterialId: source, targetMaterialId: target, relationType: typeof relation.relationType === 'string' && relation.relationType in workflowRelations ? relation.relationType : 'related', label: String(relation.label ?? '').slice(0, 48), confidence: Math.max(0, Math.min(1, Number(relation.confidence) || 0)), evidence: '', sourceChunkIds: [], targetChunkIds: [] }] }).sort((left, right) => right.confidence - left.confidence).slice(0, 8)
  }
  private async verifyTopicCandidate(settings: ModelSettings, map: TopicMap, candidate: TopicRelationCandidate, signal?: AbortSignal): Promise<TopicRelationCandidate | null> {
    const source = map.materials.find((material) => material.id === candidate.sourceMaterialId); const target = map.materials.find((material) => material.id === candidate.targetMaterialId); if (!source || !target) return null
    const query = `${source.title} ${target.title}`; const compact = (materialId: string) => this.workspace.materialEvidenceWindow(materialId, query, 1).slice(0, 2).map((chunk) => ({ ...chunk, text: chunk.text.slice(0, 500) })); const left = compact(source.id); const right = compact(target.id); if (!left.length || !right.length) return null
    const prompt = `Verify whether these two materials have a meaningful relationship using only the evidence excerpts. Decide the supported direction; it may be either material A -> B or B -> A. Return ONLY JSON: {\"accept\":true,\"sourceMaterialId\":\"one supplied id\",\"targetMaterialId\":\"the other supplied id\",\"relationType\":\"next|depends_on|explains|evidences|implements|tests|blocks|improves|reviews|references|related\",\"label\":\"short Chinese relation label\",\"confidence\":0.0,\"evidence\":\"specific support from both excerpts\"}. Or return {\"accept\":false}. Material A: ${JSON.stringify({ id: source.id, excerpts: left })}. Material B: ${JSON.stringify({ id: target.id, excerpts: right })}`
    const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true, signal); if (!response.ok) return null
    try { const result = parseJsonObject(this.responseText(await this.responseJson(response, 'Relation verification'))) as { accept?: boolean; sourceMaterialId?: string; targetMaterialId?: string; relationType?: string; label?: string; confidence?: number; evidence?: string }; const allowed = new Set([source.id, target.id]); const nextSource = String(result.sourceMaterialId ?? candidate.sourceMaterialId); const nextTarget = String(result.targetMaterialId ?? candidate.targetMaterialId); if (!result.accept || !result.evidence?.trim() || !allowed.has(nextSource) || !allowed.has(nextTarget) || nextSource === nextTarget) return null; return { ...candidate, sourceMaterialId: nextSource, targetMaterialId: nextTarget, relationType: result.relationType && result.relationType in workflowRelations ? result.relationType : candidate.relationType, label: String(result.label ?? candidate.label ?? '').slice(0, 48), confidence: Math.max(0, Math.min(1, Number(result.confidence) || candidate.confidence)), evidence: result.evidence.trim().slice(0, 1600), sourceChunkIds: left.map((chunk) => chunk.id), targetChunkIds: right.map((chunk) => chunk.id) } } catch { return null }
  }
  private topicPositions(map: TopicMap, relations: TopicRelationCandidate[]): Array<{ materialId: string; x: number; y: number }> {
    const depth = new Map(map.materials.map((material) => [material.id, 0])); for (let pass = 0; pass < map.materials.length; pass += 1) for (const relation of relations) depth.set(relation.targetMaterialId, Math.max(depth.get(relation.targetMaterialId) ?? 0, (depth.get(relation.sourceMaterialId) ?? 0) + 1))
    const rows = new Map<number, number>(); return map.materials.map((material) => { if (material.canvasX !== null && material.canvasY !== null) return { materialId: material.id, x: material.canvasX, y: material.canvasY }; const column = depth.get(material.id) ?? 0; const row = rows.get(column) ?? 0; rows.set(column, row + 1); return { materialId: material.id, x: 120 + column * 300, y: 100 + row * 180 } })
  }
  private async requestTopic(settings: ModelSettings, map: TopicMap): Promise<TopicAnalysisResult> {
    // Compatibility path: it uses the same cached cards as the primary
    // orchestrator, never a fixed-length prefix of every original document.
    const materials = this.materialCards(map, settings.chatModel).map((card) => ({ id: card.materialId, title: card.title, date: card.date, headings: card.headings, keywords: card.keywords, summary: card.summary }))
    const prompt = `${this.readSkill('topic-connection.md')}\nConnect one private workspace topic. Return ONLY valid JSON, no markdown. Schema: {"relations":[{"sourceMaterialId":"id","targetMaterialId":"id","relationType":"next|depends_on|explains|evidences|implements|tests|blocks|improves|reviews|references|related|custom","label":"only required for custom, concrete and short","evidence":"specific quoted or paraphrased supporting text","confidence":0.0}],"workstreams":[{"name":"optional short group","materialIds":["id"]}]}. Workstreams are optional. Return only well-supported relations; do not assign every material. Existing workstreams: ${JSON.stringify(map.workstreams.map((stream) => stream.name))}\nMaterials: ${JSON.stringify(materials)}`
    const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true)
    if (!response.ok) throw new Error(`Analysis request returned HTTP ${response.status}.`)
    const content = this.responseText(await this.responseJson(response, 'Analysis'))
    try { return parseJsonObject(content) as unknown as TopicAnalysisResult } catch { throw new Error('Model output failed JSON parsing. The topic map was not changed.') }
  }

  private validateTopicResult(map: TopicMap, result: TopicAnalysisResult): void {
    if (!Array.isArray(result.relations)) result.relations = []
    if (result.workstreams !== undefined && !Array.isArray(result.workstreams)) throw new Error('Model output has invalid workstreams.')
    const expected = new Set(map.materials.map((material) => material.id)); const assigned = new Set<string>()
    for (const stream of result.workstreams ?? []) {
      if (!stream || typeof stream.name !== 'string' || !stream.name.trim() || !Array.isArray(stream.materialIds)) throw new Error('Model output has an invalid workstream. The topic map was not changed.')
      for (const id of stream.materialIds) {
        if (!expected.has(id) || assigned.has(id)) throw new Error('Model output has an invalid or duplicate material assignment. The topic map was not changed.')
        assigned.add(id)
      }
    }
    if (result.roots !== undefined && (!Array.isArray(result.roots) || result.roots.some((id) => !expected.has(id)))) throw new Error('Model output has invalid roots. The topic map was not changed.')
    const parents = new Set<string>()
    for (const relation of result.relations) {
      if (!relation || !expected.has(relation.sourceMaterialId) || !expected.has(relation.targetMaterialId) || relation.sourceMaterialId === relation.targetMaterialId || typeof relation.evidence !== 'string') throw new Error('Model output has an invalid relation. The topic map was not changed.')
      if (relation.relationType !== undefined && relation.relationType !== 'custom' && !(relation.relationType in workflowRelations)) relation.relationType = 'related'
      if (parents.has(relation.targetMaterialId)) throw new Error('Model output assigns multiple parents. The topic map was not changed.')
      parents.add(relation.targetMaterialId)
    }
  }
  private readSkill(name: string): string { return name === 'topic-connection.md' ? connectionSkill : operationSkill }
  private validProposal(map: TopicMap, action: AiActionProposal): boolean {
    if (!action || !['create_relation', 'create_workstream', 'delete_ai_relation', 'rename_relation', 'set_sequence', 'set_card_style', 'layout'].includes(action.kind) || !action.reason || !action.evidence) return false
    const materialIds = new Set(map.materials.map((item) => item.id)); const relation = action.relationId ? map.relations.find((item) => item.id === action.relationId) : undefined
    if (action.materialId && !materialIds.has(action.materialId)) return false
    if (action.kind === 'delete_ai_relation') return relation?.createdBy === 'ai'
    if (action.kind === 'rename_relation') return Boolean(relation)
    if (action.kind === 'create_relation') { const source = String(action.payload?.sourceMaterialId ?? ''); const target = String(action.payload?.targetMaterialId ?? ''); return materialIds.has(source) && materialIds.has(target) && source !== target && typeof action.payload?.label === 'string' && typeof action.payload?.relationType === 'string' && !map.relations.some((item) => item.sourceMaterialId === source && item.targetMaterialId === target) }
    if (action.kind === 'create_workstream') return typeof action.payload?.name === 'string' && Array.isArray(action.payload?.materialIds) && (action.payload.materialIds as unknown[]).every((id) => materialIds.has(String(id)))
    if (action.kind === 'layout') return Array.isArray(action.payload?.positions) && (action.payload.positions as unknown[]).every((position) => Boolean(position && typeof position === 'object' && materialIds.has(String((position as Record<string, unknown>).materialId)) && Number.isFinite(Number((position as Record<string, unknown>).x)) && Number.isFinite(Number((position as Record<string, unknown>).y))))
    return true
  }

  private profileFor(settings: ModelSettings): ProviderProfile {
    if (settings.profileId) { const profile = this.appStore.getProfile(settings.profileId); if (profile) return profile }
    return { id: '', name: 'Local Ollama', provider: 'ollama', baseUrl: settings.baseUrl, wireApi: 'chat_completions', models: [], recommendedModel: null, updatedAt: '', hasApiKey: false }
  }
  private headers(profile: ProviderProfile): Record<string, string> {
    const key = profile.id ? this.appStore.getApiKey(profile.id) : null
    if (profile.provider === 'ollama') return {}
    if (!key) throw new Error('Add an API Key to this model profile first.')
    if (profile.provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    if (profile.provider === 'gemini') return {}
    return { Authorization: `Bearer ${key}` }
  }
  private modelUrl(profile: ProviderProfile): string {
    const base = profile.baseUrl.replace(/\/$/, '')
    if (profile.provider === 'ollama') return `${base}/api/tags`
    if (profile.provider === 'gemini') return `${base}/v1beta/models?key=${encodeURIComponent(this.appStore.getApiKey(profile.id) ?? '')}`
    return `${base}/models`
  }
  private async readModels(profile: ProviderProfile, timeout: number): Promise<{ models: string[]; baseUrl: string }> {
    const base = profile.baseUrl.replace(/\/$/, ''); const bases = profile.provider === 'compatible' && !/\/v1$/i.test(base) ? [base, `${base}/v1`] : [base]
    let lastError = 'Model endpoint did not return a JSON model list.'
    for (const candidate of bases) try {
      const candidateProfile = { ...profile, baseUrl: candidate }; const response = await fetch(this.modelUrl(candidateProfile), { signal: AbortSignal.timeout(timeout), headers: this.headers(profile) })
      if (!response.ok) { lastError = `Model list returned HTTP ${response.status}.`; continue }
      const body = await response.json() as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> }
      const models = (body.data ?? body.models ?? []).map((model) => model.id ?? model.name ?? '').filter(Boolean).sort()
      if (models.length) return { models, baseUrl: candidate }; lastError = 'Model endpoint returned no usable models.'
    } catch (error) { lastError = error instanceof Error ? error.message : lastError }
    throw new Error(lastError)
  }
  private async chat(profile: ProviderProfile, model: string, prompt: string, json: boolean, parentSignal?: AbortSignal): Promise<Response> {
    const base = profile.baseUrl.replace(/\/$/, ''); const headers = { 'Content-Type': 'application/json', ...this.headers(profile) }
    const timeout = AbortSignal.timeout(90_000); const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout
    const maxTokens = json ? 450 : 1000
    if (profile.provider === 'ollama') return fetch(`${base}/api/generate`, { method: 'POST', headers, signal, body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: maxTokens, temperature: json ? 0.1 : 0.3 }, ...(json ? { format: 'json' } : {}) }) })
    if (profile.provider === 'anthropic') return fetch(`${base}/messages`, { method: 'POST', headers, signal, body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(json ? { temperature: 0.1 } : {}) }) })
    if (profile.provider === 'gemini') return fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.appStore.getApiKey(profile.id) ?? '')}`, { method: 'POST', headers, signal, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, ...(json ? { temperature: 0.1, responseMimeType: 'application/json' } : {}) } }) })
    if (profile.wireApi === 'responses') return fetch(`${base}/responses`, { method: 'POST', headers, signal, body: JSON.stringify({ model, input: prompt, store: false, max_output_tokens: maxTokens, ...(json ? { temperature: 0.1, text: { format: { type: 'json_object' } } } : {}) }) })
    return fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, ...(json ? { temperature: 0.1, response_format: { type: 'json_object' } } : {}) }) })
  }
  private responseText(body: Record<string, unknown>): string {
    const direct = typeof body.output_text === 'string' ? body.output_text : undefined
    const output = (body.output as Array<{ content?: Array<{ text?: string }> }> | undefined)?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('')
    const firstChoice = (body.choices as Array<{ message?: { content?: string | Array<{ text?: string }>; reasoning_content?: string }; text?: string; delta?: { content?: string } }> | undefined)?.[0]
    const messageContent = firstChoice?.message?.content
    const openAi = typeof messageContent === 'string' ? messageContent : Array.isArray(messageContent) ? messageContent.map((item) => item.text ?? '').join('') : firstChoice?.text ?? firstChoice?.delta?.content ?? firstChoice?.message?.reasoning_content
    const anthropic = (body.content as Array<{ text?: string }> | undefined)?.map((item) => item.text ?? '').join('')
    const gemini = (body.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')
    return String(direct ?? output ?? body.response ?? openAi ?? anthropic ?? gemini ?? '')
  }
  private async responseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      const preview = (await response.text()).replace(/\s+/g, ' ').slice(0, 180)
      throw new Error(`${operation} returned non-JSON from ${response.url || 'the configured endpoint'} (HTTP ${response.status}, ${contentType || 'unknown content type'}). ${preview}`)
    }
    return response.json() as Promise<Record<string, unknown>>
  }
}
