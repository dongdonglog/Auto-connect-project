import type { AnalysisSummary, ModelSettings, ProviderProfile, ProviderProfileInput, TopicMap } from './types'
import { WorkspaceService } from './workspace-service'
import { AppStore } from './app-store'
import connectionSkill from './ai-skills/topic-connection.md?raw'
import operationSkill from './ai-skills/topic-operation.md?raw'

interface TopicAnalysisResult {
  workstreams: Array<{ name: string; materialIds: string[] }>
  roots?: string[]
  relations: Array<{ sourceMaterialId: string; targetMaterialId: string; relationType?: string; label?: string; evidence: string; confidence?: number }>
}

const workflowRelations: Record<string, string> = { next: '下一步', depends_on: '依赖', explains: '解释', evidences: '佐证', implements: '实现', tests: '验证', blocks: '阻塞', improves: '改进', reviews: '复盘', references: '参考', related: '关联' }
export interface AiActionProposal { id: string; kind: 'create_relation' | 'delete_ai_relation' | 'rename_relation' | 'set_sequence' | 'set_card_style' | 'layout'; reason: string; evidence: string; materialId?: string; relationId?: string; payload?: Record<string, unknown> }

export class AiService {
  private readonly topicRuns = new Map<string, Promise<AnalysisSummary>>()
  constructor(private readonly workspace: WorkspaceService, private readonly appStore: AppStore) {}

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
    const run = this.runTopicAnalysis(topicId).finally(() => this.topicRuns.delete(topicId))
    this.topicRuns.set(topicId, run)
    return run
  }

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
      let streams = this.workspace.topicMap(topicId).workstreams
      for (const proposed of result.workstreams) {
        const name = proposed.name.trim()
        let stream = streams.find((item) => item.name === name)
        if (!stream) { stream = this.workspace.createWorkstream(topicId, name, 'ai'); summary.addedWorkstreams += 1; streams = this.workspace.topicMap(topicId).workstreams }
        for (const materialId of proposed.materialIds) this.workspace.moveMaterial(topicId, materialId, stream.id)
      }
      const materialIds = new Set(map.materials.map((material) => material.id))
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

  async ask(question: string): Promise<{ answer: string; citations: Array<{ id: string; title: string }> }> {
    const candidates = this.workspace.search(question).slice(0, 6)
    const citations = candidates.map((material) => ({ id: material.id, title: material.title }))
    const settings = this.workspace.getSettings()
    if (!settings.enabled || !settings.chatModel) return { answer: candidates.length ? `Found ${candidates.length} relevant local materials. Configure a model for cited answers.` : 'No local materials matched those keywords.', citations }
    if (settings.provider !== 'ollama' && !settings.allowCloud) throw new Error('Cloud question answering requires explicit consent in settings.')
    const context = candidates.map((material) => `[${material.id}] ${material.title}\n${(material.extractedText ?? material.excerpt ?? '').slice(0, 2500)}`).join('\n\n')
    const response = await this.chat(this.profileFor(settings), settings.chatModel, `Answer only from these local excerpts. Cite titles in square brackets.\n\nQuestion: ${question}\n\nMaterials:\n${context}`, false)
    if (!response.ok) throw new Error(`Question request returned HTTP ${response.status}.`)
    return { answer: this.responseText(await this.responseJson(response, 'Question')) || 'The model returned no usable answer.', citations }
  }

  async planTopicOperation(topicId: string, question: string): Promise<{ answer: string; proposedActions: AiActionProposal[] }> {
    const map = this.workspace.topicMap(topicId)
    if (!question.trim()) throw new Error('Describe the requested board change.')
    const settings = this.workspace.getSettings()
    if (!settings.enabled || !settings.chatModel) throw new Error('Enable a model before requesting board suggestions.')
    if (settings.provider !== 'ollama' && !settings.allowCloud) throw new Error('Cloud analysis requires explicit consent in settings.')
    const skill = this.readSkill('topic-operation.md')
    const materials = map.materials.map((item) => ({ id: item.id, title: item.title, sequence: item.sequence, color: item.cardColor }))
    const relations = map.relations.map((item) => ({ id: item.id, source: item.sourceMaterialId, target: item.targetMaterialId, label: item.label, createdBy: item.createdBy }))
    const prompt = `${skill}\nActive topic: ${topicId}\nUser request: ${question}\nMaterials: ${JSON.stringify(materials)}\nRelations: ${JSON.stringify(relations)}\nReturn JSON only: {"answer":"short answer","proposedActions":[{"id":"local-id","kind":"allowed kind","reason":"why","evidence":"support","materialId":"optional","relationId":"optional","payload":{}}]}.`
    const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true)
    if (!response.ok) throw new Error(`Board suggestion request returned HTTP ${response.status}.`)
    const result = JSON.parse(this.responseText(await this.responseJson(response, 'Board suggestion'))) as { answer?: string; proposedActions?: AiActionProposal[] }
    const actions = (result.proposedActions ?? []).filter((action) => this.validProposal(map, action)).slice(0, 8)
    return { answer: result.answer?.trim() || '已根据当前主题生成可审阅的建议。', proposedActions: actions }
  }

  private async requestTopic(settings: ModelSettings, map: TopicMap): Promise<TopicAnalysisResult> {
    const materials = map.materials.map((item) => ({ id: item.id, title: item.title, date: item.occurredAt ?? item.importedAt, text: (item.extractedText ?? item.excerpt ?? '').slice(0, 5000) }))
    const prompt = `${this.readSkill('topic-connection.md')}\nOrganize one private workspace topic. Return ONLY valid JSON, no markdown. Schema: {"workstreams":[{"name":"short workstream name","materialIds":["id"]}],"roots":["id"],"relations":[{"sourceMaterialId":"id","targetMaterialId":"id","relationType":"next|depends_on|explains|evidences|implements|tests|blocks|improves|reviews|references|related|custom","label":"only required for custom, concrete and short","evidence":"specific quoted or paraphrased supporting text","confidence":0.0}]}. Existing workstreams: ${JSON.stringify(map.workstreams.map((stream) => stream.name))}\nMaterials: ${JSON.stringify(materials)}`
    const response = await this.chat(this.profileFor(settings), settings.chatModel, prompt, true)
    if (!response.ok) throw new Error(`Analysis request returned HTTP ${response.status}.`)
    const content = this.responseText(await this.responseJson(response, 'Analysis'))
    try { return JSON.parse(content) as TopicAnalysisResult } catch { throw new Error('Model output failed JSON parsing. The topic map was not changed.') }
  }

  private validateTopicResult(map: TopicMap, result: TopicAnalysisResult): void {
    if (!Array.isArray(result.workstreams) || !result.workstreams.length) throw new Error('Model output contains no workstreams. The topic map was not changed.')
    const expected = new Set(map.materials.map((material) => material.id)); const assigned = new Set<string>()
    for (const stream of result.workstreams) {
      if (!stream || typeof stream.name !== 'string' || !stream.name.trim() || !Array.isArray(stream.materialIds)) throw new Error('Model output has an invalid workstream. The topic map was not changed.')
      for (const id of stream.materialIds) {
        if (!expected.has(id) || assigned.has(id)) throw new Error('Model output has an invalid or duplicate material assignment. The topic map was not changed.')
        assigned.add(id)
      }
    }
    if (assigned.size !== expected.size) throw new Error('Model did not assign every material to a workstream. The topic map was not changed.')
    if (!Array.isArray(result.relations)) result.relations = []
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
    if (!action || !['create_relation', 'delete_ai_relation', 'rename_relation', 'set_sequence', 'set_card_style', 'layout'].includes(action.kind) || !action.reason || !action.evidence) return false
    const materialIds = new Set(map.materials.map((item) => item.id)); const relation = action.relationId ? map.relations.find((item) => item.id === action.relationId) : undefined
    if (action.materialId && !materialIds.has(action.materialId)) return false
    if (action.kind === 'delete_ai_relation') return relation?.createdBy === 'ai'
    if (action.kind === 'rename_relation') return Boolean(relation)
    if (action.kind === 'create_relation') return typeof action.payload?.sourceMaterialId === 'string' && typeof action.payload?.targetMaterialId === 'string' && materialIds.has(String(action.payload.sourceMaterialId)) && materialIds.has(String(action.payload.targetMaterialId))
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
  private async chat(profile: ProviderProfile, model: string, prompt: string, json: boolean): Promise<Response> {
    const base = profile.baseUrl.replace(/\/$/, ''); const headers = { 'Content-Type': 'application/json', ...this.headers(profile) }
    if (profile.provider === 'ollama') return fetch(`${base}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ model, prompt, stream: false, ...(json ? { format: 'json' } : {}) }) })
    if (profile.provider === 'anthropic') return fetch(`${base}/messages`, { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 1600, messages: [{ role: 'user', content: prompt }] }) })
    if (profile.provider === 'gemini') return fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.appStore.getApiKey(profile.id) ?? '')}`, { method: 'POST', headers, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: json ? { responseMimeType: 'application/json' } : {} }) })
    if (profile.wireApi === 'responses') return fetch(`${base}/responses`, { method: 'POST', headers, body: JSON.stringify({ model, input: prompt, store: false, ...(json ? { text: { format: { type: 'json_object' } } } : {}) }) })
    return fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], ...(json ? { response_format: { type: 'json_object' } } : {}) }) })
  }
  private responseText(body: Record<string, unknown>): string {
    const direct = typeof body.output_text === 'string' ? body.output_text : undefined
    const output = (body.output as Array<{ content?: Array<{ text?: string }> }> | undefined)?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('')
    const openAi = (body.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content
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
