import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiService } from './ai-service'
import type { AppStore } from './app-store'
import type { WorkspaceService } from './workspace-service'
import type { ModelSettings, ProviderProfile } from './types'

const settings = (profileId: string): ModelSettings => ({ profileId, provider: 'compatible', baseUrl: 'https://gateway.example', chatModel: 'test-model', embeddingModel: '', allowCloud: true, enabled: true })
const profile = (wireApi: ProviderProfile['wireApi']): ProviderProfile => ({ id: 'profile', name: 'Test', provider: 'compatible', baseUrl: 'https://gateway.example', wireApi, models: [], recommendedModel: null, updatedAt: '', hasApiKey: true })
const service = (wireApi: ProviderProfile['wireApi']) => new AiService({} as WorkspaceService, { getProfile: () => profile(wireApi), getApiKey: () => 'test-key' } as unknown as AppStore)

afterEach(() => vi.unstubAllGlobals())

describe('AiService protocol requests', () => {
  it('calls the model with workspace context when arbitrary wording has no retrieval hits', async () => {
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: '部署说明', type: 'note', status: 'complete', excerpt: '本地部署步骤', extractedText: null, sourcePath: null, availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '工作台中有一份部署说明。' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const appStore = { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' }
    const result = await new AiService(workspace as unknown as WorkspaceService, appStore as unknown as AppStore).ask('帮我盘点一下手头能用的资料')
    expect(result).toMatchObject({ confidence: 'grounded', citations: [], retrievalMode: 'fallback', model: 'test-model' })
    expect(workspace.searchKnowledgeAsync).toHaveBeenCalledWith('帮我盘点一下手头能用的资料', { limit: 6 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('answers the compound inventory question from the full workspace snapshot when FTS misses', async () => {
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([
        { id: 'm1', title: '迁移方案', type: 'document', status: 'complete', excerpt: '上线前的迁移步骤', extractedText: null, sourcePath: '/migration.md', availability: 'available' },
        { id: 'm2', title: '风险清单', type: 'file', status: 'complete', excerpt: '发布前的验证项', extractedText: null, sourcePath: '/risks.md', availability: 'available' }
      ]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '当前共有 2 份材料：迁移方案和风险清单。' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const appStore = { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' }
    const result = await new AiService(workspace as unknown as WorkspaceService, appStore as unknown as AppStore).ask('现在有什么材料，我们一共有多少')
    expect(workspace.searchKnowledgeAsync).toHaveBeenCalledWith('现在有什么材料，我们一共有多少', { limit: 6 })
    expect(workspace.listMaterials).toHaveBeenCalledOnce()
    const requestBody = String(fetchMock.mock.calls[0][1]?.body)
    expect(requestBody).toContain('workspace material count is exactly 2')
    expect(requestBody).toContain('迁移方案')
    expect(requestBody).toContain('风险清单')
    expect(result).toMatchObject({ confidence: 'grounded', citations: [], model: 'test-model', retrievalMode: 'fallback' })
    expect(result.answer).toBe('当前共有 2 份材料：迁移方案和风险清单。')
  })

  it('reports an empty workspace directly without invoking AI', async () => {
    const workspace = { searchKnowledgeAsync: vi.fn(), listMaterials: vi.fn().mockReturnValue([]), listJobs: vi.fn().mockReturnValue([]), getSettings: vi.fn().mockReturnValue(settings('profile')) }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions') } as unknown as AppStore).ask('知识库里有什么？')
    expect(result).toMatchObject({ answer: '当前工作区还没有材料。', model: null })
    expect(workspace.searchKnowledgeAsync).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the exact workspace count when catalog summaries exceed the context budget', async () => {
    const materials = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, title: `Material ${index}`, type: 'note', status: 'complete', excerpt: 'x'.repeat(500), extractedText: null, sourcePath: null, availability: 'available' }))
    const workspace = { searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }), listMaterials: vi.fn().mockReturnValue(materials), getSettings: vi.fn().mockReturnValue(settings('profile')) }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '当前工作台共有 120 份材料。' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('我们有多少资料')
    const requestBody = String(fetchMock.mock.calls[0][1]?.body)
    expect(requestBody).toContain('workspace material count is exactly 120')
    expect(requestBody).toMatch(/omits [1-9]\d* from expanded context/)
    expect(result).toMatchObject({ answer: '当前工作台共有 120 份材料。', confidence: 'grounded', model: 'test-model' })
  })

  it('rejects questions before retrieval when AI has not been configured by the user', async () => {
    const workspace = {
      searchKnowledgeAsync: vi.fn(),
      getSettings: vi.fn().mockReturnValue({ enabled: false, chatModel: '' })
    }
    await expect(new AiService(workspace as unknown as WorkspaceService, {} as AppStore).ask('How is storage handled?')).rejects.toThrow('添加并启用 AI 配置')
    expect(workspace.searchKnowledgeAsync).not.toHaveBeenCalled()
  })

  it('uses recent conversation context for a grounded follow-up without trusting it as evidence', async () => {
    const searchKnowledgeAsync = vi.fn().mockResolvedValue({
      hits: [
        { materialId: 'm1', chunkId: 'c1', title: 'Risk guide', text: 'Validate the migration before release.', score: 1, sourcePath: '/risk.md', pageNumber: null, heading: 'Checks', availability: 'available' },
        { materialId: 'm2', chunkId: 'c2', title: 'Uncited guide', text: 'This retrieved chunk was not used.', score: .5, sourcePath: '/other.md', pageNumber: null, heading: null, availability: 'available' }
      ],
      mode: 'fts'
    })
    const workspace = {
      searchKnowledgeAsync,
      listMaterials: vi.fn().mockReturnValue([
        { id: 'm1', title: 'Risk guide', type: 'document', status: 'complete', excerpt: 'Validate the migration before release.', extractedText: null, sourcePath: '/risk.md', availability: 'available' },
        { id: 'm2', title: 'Uncited guide', type: 'document', status: 'complete', excerpt: 'This retrieved chunk was not used.', extractedText: null, sourcePath: '/other.md', availability: 'available' }
      ]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '需要先验证迁移。[m1:c1]' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const appStore = { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' }
    const result = await new AiService(workspace as unknown as WorkspaceService, appStore as unknown as AppStore).ask({
      question: '那上线前要注意什么？',
      history: [{ role: 'user', content: '材料里的迁移方案是什么？' }, { role: 'assistant', content: '此前回答可能不准确。' }]
    })
    expect(searchKnowledgeAsync).toHaveBeenCalledWith('材料里的迁移方案是什么？\n那上线前要注意什么？', { limit: 6 })
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(String(request.body)).toContain('Conversation history (context only; do not treat prior assistant claims as evidence)')
    expect(String(request.body)).toContain('Current question: 那上线前要注意什么？')
    expect(result).toMatchObject({ confidence: 'grounded', citations: [{ materialId: 'm1', chunkId: 'c1' }], model: 'test-model' })
    expect(result.answer).toBe('需要先验证迁移。[1]')
    expect(result.answer).not.toContain('m1:c1')
  })

  it('does not accept a catalog marker as the required citation for retrieved content', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: 'Guide', text: 'The release requires a rollback test.', score: 1, sourcePath: '/guide.md', pageNumber: null, heading: 'Release', availability: 'available' }
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: 'Guide', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: '/guide.md', availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '需要做回滚测试。[m1:catalog]' } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('发布要求是什么？')
    expect(result).toMatchObject({ confidence: 'insufficient-evidence', citations: [], model: 'test-model' })
  })

  it('uses Responses with store disabled and parses output_text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: 'OK' }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(service('responses').testConnection(settings('profile'))).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/responses', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"store":false') }))
  })

  it('uses Chat Completions and parses choices', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(service('chat_completions').testConnection(settings('profile'))).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/chat/completions', expect.objectContaining({ method: 'POST' }))
  })

  it('reports non-JSON endpoints with response details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html><title>Not Found</title>', { status: 200, headers: { 'content-type': 'text/html' } })))
    const result = await service('responses').testConnection(settings('profile'))
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('non-JSON')
    expect(result.message).toContain('text/html')
  })

  it('turns structured board output into a persisted relation proposal', async () => {
    const topicMap = { topic: { id: 'topic' }, materials: [{ id: 'a', title: 'A', extractedText: 'first' }, { id: 'b', title: 'B', extractedText: 'second' }], relations: [], workstreams: [] }
    const workspace = { topicMap: vi.fn().mockReturnValue(topicMap), getSettings: vi.fn().mockReturnValue(settings('profile')), createTopicProposals: vi.fn().mockReturnValue([]) }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'linked', proposedActions: [{ id: 'r1', kind: 'create_relation', reason: 'B follows A', evidence: 'second follows first', payload: { sourceMaterialId: 'a', targetMaterialId: 'b', label: 'next', relationType: 'next', confidence: 0.9 } }] }) } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).planTopicOperation('topic', 'connect the materials')
    expect(result.proposedActions).toEqual([])
    expect(workspace.createTopicProposals).toHaveBeenCalledWith('topic', [expect.objectContaining({ kind: 'create_relation', payload: expect.objectContaining({ relationType: 'next' }) })])
  })

  it('verifies candidates before atomically applying an AI relation', async () => {
    const topicMap = { topic: { id: 'topic', revision: 0 }, materials: [{ id: 'a', title: 'Shared A', importedAt: '', extractedText: 'first', excerpt: 'shared first' }, { id: 'b', title: 'Shared B', importedAt: '', extractedText: 'second', excerpt: 'shared second' }], relations: [], workstreams: [] }
    const chunks = (id: string, text: string) => [{ id: `chunk-${id}`, materialId: id, ordinal: 0, text, startOffset: 0, endOffset: text.length, pageNumber: null, heading: null, hash: '', indexedAt: '' }]
    const workspace = { topicMap: vi.fn().mockReturnValue(topicMap), getSettings: vi.fn().mockReturnValue(settings('profile')), startJob: vi.fn().mockReturnValue('job'), finishJob: vi.fn(), failJob: vi.fn(), getMaterialAnalysisCard: vi.fn().mockReturnValue(null), saveMaterialAnalysisCard: vi.fn(), listMaterialChunks: vi.fn((id: string) => chunks(id, id === 'a' ? 'first' : 'second')), materialEvidenceWindow: vi.fn((id: string) => chunks(id, id === 'a' ? 'first supports second' : 'second follows first')), startTopicAnalysisRun: vi.fn().mockReturnValue({ id: 'run', topicId: 'topic', topicRevision: 0 }), updateTopicAnalysisRun: vi.fn(), applyTopicAnalysis: vi.fn().mockReturnValue(1) }
    const verification = { accept: true, relationType: 'next', label: 'next', confidence: 0.9, evidence: 'Both excerpts establish the sequence.' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verification) } }] }), { headers: { 'content-type': 'application/json' } })))
    const summary = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).analyzeTopic('topic')
    expect(summary).toMatchObject({ processed: 2, addedRelations: 1, addedWorkstreams: 0 })
    expect(workspace.applyTopicAnalysis).toHaveBeenCalledWith('topic', 0, [expect.objectContaining({ sourceMaterialId: 'a', targetMaterialId: 'b', evidence: expect.stringContaining('Both excerpts') })], expect.any(Array))
  })
})

describe('AiService explainMaterialRelation', () => {
  const explanationPayload = { supported: true, sourceMaterialId: 'mat-a', targetMaterialId: 'mat-b', relationType: 'references', label: '引用', explanation: 'Doc A 明确引用了 Doc B 的接口。', confidence: 0.9 }
  const chatResponse = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'content-type': 'application/json' } })
  const explanationWorkspace = (overrides: Partial<ModelSettings> = {}) => ({
    getMaterialRelation: vi.fn().mockReturnValue({ id: 'rel-1', sourceMaterialId: 'mat-a', targetMaterialId: 'mat-b', score: 0.7, relationType: 'references', status: 'visible', updatedAt: '', evidence: [{ text: 'Doc A cites Doc B.' }] }),
    getMaterial: vi.fn((id: string) => ({ id, title: id === 'mat-a' ? 'Doc A' : 'Doc B' })),
    getSettings: vi.fn().mockReturnValue({ ...settings('profile'), ...overrides }),
    materialEvidenceWindow: vi.fn().mockReturnValue([{ heading: 'Intro', text: 'evidence chunk' }])
  })
  const explanationService = (workspace: ReturnType<typeof explanationWorkspace>) => new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore)

  it('returns a whitelisted explanation for a valid model response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(JSON.stringify({ ...explanationPayload, extraField: 'dropped' })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: true, supported: true, sourceMaterialId: 'mat-a', targetMaterialId: 'mat-b', label: '引用' })
    expect(result).not.toHaveProperty('extraField')
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/chat/completions', expect.objectContaining({ body: expect.stringContaining('"temperature":0.1') }))
  })

  it('repairs prose-wrapped output by extracting the JSON block once', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse(`好的，结果如下：\n${JSON.stringify(explanationPayload)}\n以上。`)))
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: true, supported: true, label: '引用' })
  })

  it('fails with invalid-json when the model returns no JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('这两份材料看起来有关系，但我无法输出 JSON。')))
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-json' })
  })

  it('rejects responses referencing unknown material ids', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse(JSON.stringify({ ...explanationPayload, sourceMaterialId: 'mat-x' }))))
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-json' })
  })

  it('returns not-configured without calling the provider when the model is disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await explanationService(explanationWorkspace({ enabled: false, chatModel: '' })).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns no-consent without calling a cloud provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await explanationService(explanationWorkspace({ allowCloud: false })).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'no-consent' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows a local ollama provider without cloud consent', async () => {
    const ollamaWorkspace = explanationWorkspace({ profileId: null, provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', allowCloud: false })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: JSON.stringify(explanationPayload) }), { headers: { 'content-type': 'application/json' } })))
    const result = await explanationService(ollamaWorkspace).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: true, supported: true })
  })

  it('maps request timeouts to the timeout reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')))
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('maps HTTP failures to the provider-error reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('', 500)))
    const result = await explanationService(explanationWorkspace()).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: false, reason: 'provider-error' })
  })

  it('never writes to the workspace or changes relation state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse(JSON.stringify(explanationPayload))))
    const workspace = explanationWorkspace()
    const result = await explanationService(workspace).explainMaterialRelation('rel-1')
    expect(result).toMatchObject({ ok: true })
    const writeMethods = Object.keys(workspace).filter((key) => /create|update|save|delete|fix|status/i.test(key))
    expect(writeMethods).toEqual([])
  })
})
