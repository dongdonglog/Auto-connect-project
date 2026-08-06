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
  it('repairs a non-JSON canvas response before creating proposals', async () => {
    const workspace = {
      topicMap: vi.fn().mockReturnValue({
        topic: { id: 'topic-1', revision: 2 },
        materials: [{ id: 'm1', title: 'First', excerpt: 'First material', extractedText: null }, { id: 'm2', title: 'Second', excerpt: 'Second material', extractedText: null }],
        workstreams: [],
        relations: []
      }),
      getSettings: vi.fn().mockReturnValue(settings('profile')),
      createTopicProposalRun: vi.fn(),
      createTopicProposals: vi.fn().mockReturnValue([{ id: 'proposal-1' }])
    }
    const validPlan = JSON.stringify({ summary: 'Connect the two materials.', actions: [{ id: 'local-1', kind: 'create_relation', reason: 'The materials are sequential.', evidence: 'The supplied summaries describe an ordered handoff.', payload: { sourceMaterialId: 'm1', targetMaterialId: 'm2', label: 'next', relationType: 'next', confidence: .8 } }], warnings: [] })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot produce that plan.' } }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: validPlan } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const ai = new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore)
    const plan = await ai.planCanvas({ topicId: 'topic-1', selectedMaterialIds: ['m1', 'm2'], instruction: 'Connect the materials.', baseRevision: 2, allowCloud: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(plan.actions[0].id).toBe('proposal-1')
    expect(workspace.createTopicProposalRun).toHaveBeenCalledOnce()
    expect(workspace.createTopicProposals).toHaveBeenCalledOnce()
  })

  it('allows a local OpenAI-compatible endpoint without cloud consent', async () => {
    const workspace = {
      topicMap: vi.fn().mockReturnValue({ topic: { id: 'topic-local', revision: 1 }, materials: [{ id: 'm1', title: 'First', excerpt: 'First', extractedText: null }], workstreams: [], relations: [] }),
      getSettings: vi.fn().mockReturnValue({ ...settings('profile'), baseUrl: 'http://127.0.0.1:1234/v1', allowCloud: false }),
      createTopicProposalRun: vi.fn(),
      createTopicProposals: vi.fn().mockReturnValue([])
    }
    const localProfile: ProviderProfile = { ...profile('chat_completions'), baseUrl: 'http://127.0.0.1:1234/v1' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'No changes', actions: [], warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } })))
    const ai = new AiService(workspace as unknown as WorkspaceService, { getProfile: () => localProfile, getApiKey: () => 'local-key' } as unknown as AppStore)
    await expect(ai.planCanvas({ topicId: 'topic-local', selectedMaterialIds: ['m1'], instruction: 'Review this material.', baseRevision: 1, allowCloud: false })).resolves.toMatchObject({ actions: [] })
  })

  it('keeps the two explicit consent checks for cloud canvas plans', async () => {
    const workspace = {
      topicMap: vi.fn().mockReturnValue({ topic: { id: 'topic-cloud', revision: 1 }, materials: [{ id: 'm1', title: 'First', excerpt: 'First', extractedText: null }], workstreams: [], relations: [] }),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ai = new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore)
    await expect(ai.planCanvas({ topicId: 'topic-cloud', selectedMaterialIds: ['m1'], instruction: 'Review this material.', baseRevision: 1, allowCloud: false })).rejects.toThrow(/workspace consent and the request checkbox/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

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

  it('accepts structured sources without requiring markers in the visible answer', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: '部署说明', text: '发布前需要执行回滚演练。', score: 1, sourcePath: '/deploy.md', pageNumber: null, heading: '发布检查', availability: 'available' }
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: '部署说明', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: '/deploy.md', availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '发布前先执行回滚演练。', sources: ['m1:c1'] }) } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('发布前需要做什么？')
    expect(result).toMatchObject({ confidence: 'grounded', citationMode: 'model', citations: [{ materialId: 'm1', chunkId: 'c1' }] })
    expect(result.answer).toBe('发布前先执行回滚演练。')
  })

  it('unwraps a double-encoded final response instead of rendering the JSON envelope', async () => {
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: 'Go 指南', type: 'document', status: 'complete', excerpt: '第 1 章介绍 Go。', extractedText: null, sourcePath: null, availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const payload = JSON.stringify({ type: 'final', scope: 'workspace', answer: '建议从第 1 章开始。', sources: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('Go 相关文档应该从哪里开始看？')
    expect(result.answer).toBe('建议从第 1 章开始。')
    expect(result.answer).not.toContain('"type"')
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

  it('uses the configured model for a general question even when the workspace is empty', async () => {
    const workspace = { searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }), listMaterials: vi.fn().mockReturnValue([]), getSettings: vi.fn().mockReturnValue(settings('profile')) }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'final', scope: 'general', answer: 'HTTP 是一种应用层协议。', sources: [] }) } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('HTTP 是什么？')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ answer: 'HTTP 是一种应用层协议。', answerScope: 'general', confidence: 'grounded', model: 'test-model', citations: [], retrievedChunks: 0 })
  })

  it('keeps the exact workspace count when catalog summaries exceed the context budget', async () => {
    const materials = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, title: `Material ${index}`, type: 'note', status: 'complete', excerpt: 'x'.repeat(500), extractedText: null, sourcePath: null, availability: 'available' }))
    const workspace = { searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }), listMaterials: vi.fn().mockReturnValue(materials), getSettings: vi.fn().mockReturnValue(settings('profile')) }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '当前工作台共有 120 份材料。' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('我们有多少资料')
    const requestBody = String(fetchMock.mock.calls[0][1]?.body)
    expect(requestBody).toContain('workspace material count is exactly 120')
    expect(requestBody).toMatch(/omits [1-9]\d* summaries from expanded context/)
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

  it('attaches the retrieved chunk when the model returns a catalog marker instead', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: 'Guide', text: 'The release requires a rollback test.', score: 1, sourcePath: '/guide.md', pageNumber: null, heading: 'Release', availability: 'available' }
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: 'Guide', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: '/guide.md', availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '需要做回滚测试。[m1:catalog]' } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('发布要求是什么？')
    expect(result).toMatchObject({ confidence: 'grounded', citationMode: 'inferred', citations: [{ materialId: 'm1', chunkId: 'c1' }], model: 'test-model' })
    expect(result.answer).toBe('需要做回滚测试。[1]')
  })

  it('retries an over-conservative model answer and keeps the local evidence citation', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: 'Go 基础', text: '第 1 章介绍变量、函数和接口。', score: 1, sourcePath: '/01-go.md', pageNumber: null, heading: '第 1 章', availability: 'available' }
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: 'Go 基础', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: '/01-go.md', availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '当前材料不足以回答这个问题。' } }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '第 1 章介绍变量、函数和接口。[m1:c1]' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('Go 基础有哪些内容？')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ confidence: 'grounded', answer: '第 1 章介绍变量、函数和接口。[1]', citations: [{ materialId: 'm1', chunkId: 'c1' }] })
  })

  it('returns a deterministic local answer when a provider returns an empty response', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: '部署说明', text: '发布前需要执行回滚演练。', score: 1, sourcePath: '/deploy.md', pageNumber: null, heading: '发布检查', availability: 'available' }
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' }),
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: '部署说明', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: '/deploy.md', availability: 'available' }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('发布前需要做什么？')
    expect(result).toMatchObject({ confidence: 'grounded', answerMode: 'local-fallback', citations: [{ materialId: 'm1', chunkId: 'c1' }] })
    expect(result.answer).toContain('部署说明')
  })

  it('answers model capability questions from runtime configuration when the model refuses local evidence', async () => {
    const workspace = { searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }), listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: 'Guide', type: 'note', status: 'complete', excerpt: 'Local guide', extractedText: null, sourcePath: null, availability: 'available' }]), getSettings: vi.fn().mockReturnValue(settings('profile')) }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '证据不足。' } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('你是什么模型，你能做到什么？')
    expect(result).toMatchObject({ confidence: 'grounded', answerMode: 'local-fallback', model: 'test-model' })
    expect(result.answer).toContain('test-model')
  })

  it('answers six representative knowledge questions without an evidence-error result', async () => {
    const hit = (materialId: string, title: string, text: string, heading: string) => ({ materialId, chunkId: `${materialId}-c1`, title, text, score: 1, sourcePath: `/${materialId}.md`, pageNumber: null, heading, availability: 'available' as const })
    const go = hit('go', '03-Go核心语法', 'Go 语言的变量、函数和接口基础。', '第 3 章 Go 核心语法')
    const goStart = hit('go-start', '01-Go为什么适合服务器开发', 'Go 入门概览和学习顺序。', '第 1 章')
    const iface = hit('iface', '06-Interface设计思想', '接口定义与隐式实现。', '接口定义')
    const deploy = hit('deploy', '发布检查', '上线前需要执行回滚演练。', '发布前检查')
    const materials = [goStart, go, iface, deploy, hit('web', 'Web 服务开发', 'HTTP 服务和路由。', 'Web'), hit('storage', '数据存储', 'SQLite 与 Redis。', '存储')].map((item) => ({ id: item.materialId, title: item.title, type: 'document', status: 'complete', excerpt: item.text, extractedText: null, sourcePath: item.sourcePath, availability: 'available' }))
    const searchKnowledgeAsync = vi.fn((query: string) => {
      if (/Go|学习|第\s*0|从零/u.test(query)) return Promise.resolve({ hits: [go, goStart], mode: 'fts' as const })
      if (/接口/u.test(query)) return Promise.resolve({ hits: [iface], mode: 'fts' as const })
      if (/发布|上线/u.test(query)) return Promise.resolve({ hits: [deploy], mode: 'fts' as const })
      return Promise.resolve({ hits: [], mode: 'fts' as const })
    })
    const workspace = { searchKnowledgeAsync, listMaterials: vi.fn().mockReturnValue(materials), getSettings: vi.fn().mockReturnValue(settings('profile')), listMaterialChunks: vi.fn((materialId: string) => [{ id: `${materialId}-c1`, materialId, text: materials.find((item) => item.id === materialId)?.excerpt ?? '', heading: null, pageNumber: null }]) }
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> }
      const prompt = body.messages?.[0]?.content ?? ''
      const question = (prompt.match(/(?:Current question|Question): ([^\n]+)/u)?.[1] ?? '').trim()
      const attempt = (attempts.get(question) ?? 0) + 1
      attempts.set(question, attempt)
      let content = '工作区材料已提供相关信息。'
      if (/多少材料/u.test(question)) content = '当前工作区共有 6 份材料。'
      else if (/从\s*0|第\s*0/u.test(question)) content = '{}'
      else if (/学习 Go|Go 语言.*哪几章/u.test(question)) content = attempt === 1 ? '当前材料不足以回答这个问题。' : '建议先看 01-Go，再看 03-Go。[go-start:go-start-c1]'
      else if (/接口/u.test(question)) content = '接口通过隐式实现降低耦合。'
      else if (/概括|总结/u.test(question)) content = '工作区覆盖 Go 基础、Web 服务和数据存储。'
      else if (/什么模型|能做到/u.test(question)) content = '证据不足。'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ai = new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore)
    const questions = ['我们一共有多少材料？', '我想学习 Go 语言的基础，可以看哪几章？', '我想学习 Go 语言，从第 0 章开始第一步是什么？', '接口是什么？', '请用三句话概括这个工作区的内容。', '你是什么模型，你能做到什么？']
    const results = []
    for (const question of questions) results.push(await ai.ask(question))
    expect(results).toHaveLength(questions.length)
    for (const result of results) {
      expect(result.confidence).toBe('grounded')
      expect(result.model).toBe('test-model')
      expect(result.answer.length).toBeGreaterThan(2)
      expect(result.answer).not.toMatch(/证据不足|材料不足以回答|模型没有返回可用回答/u)
    }
    expect(results[0].answer).toContain('6')
    expect(results[2].answer).toContain('Go')
    expect(results[3].citations).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('lets the model call a local Material Map tool before answering', async () => {
    const hit = { materialId: 'm1', chunkId: 'c1', title: '部署说明', text: '上线前执行回滚演练。', score: 1, sourcePath: '/deploy.md', pageNumber: null, heading: '发布检查', availability: 'available' as const }
    const searchKnowledgeAsync = vi.fn().mockResolvedValue({ hits: [hit], mode: 'fts' as const })
    const workspace = {
      searchKnowledgeAsync,
      listMaterials: vi.fn().mockReturnValue([{ id: 'm1', title: '部署说明', type: 'document', status: 'complete', excerpt: hit.text, extractedText: null, sourcePath: hit.sourcePath, availability: 'available' }]),
      getMaterial: vi.fn().mockReturnValue({ id: 'm1', title: '部署说明', type: 'document', status: 'complete', excerpt: hit.text, extractedText: hit.text, sourcePath: hit.sourcePath, availability: 'available' }),
      listMaterialChunks: vi.fn().mockReturnValue([{ id: 'c1', materialId: 'm1', ordinal: 0, text: hit.text, heading: hit.heading, pageNumber: null }]),
      getSettings: vi.fn().mockReturnValue(settings('profile'))
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'tool_call', name: 'search_materials', arguments: { query: '发布前需要做什么', limit: 4 } }) } }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'final', answer: '上线前执行回滚演练。[m1:c1]', sources: ['m1:c1'] }) } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('发布前需要做什么？')
    expect(searchKnowledgeAsync).toHaveBeenCalledWith('发布前需要做什么', { limit: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ answer: '上线前执行回滚演练。[1]', confidence: 'grounded', toolCalls: [{ name: 'search_materials' }], citations: [{ materialId: 'm1', chunkId: 'c1' }] })
  })

  it('runs a multi-tool board operation as a reviewable proposal instead of a direct mutation', async () => {
    const materials = [
      { id: 'm1', title: 'Go 基础', type: 'document', status: 'complete', excerpt: '基础语法', extractedText: '基础语法', sourcePath: null, availability: 'available' },
      { id: 'm2', title: 'Go 并发', type: 'document', status: 'complete', excerpt: '并发编程', extractedText: '并发编程', sourcePath: null, availability: 'available' }
    ]
    const topicMap = { topic: { id: 't1', name: '学习路径', description: '', revision: 0 }, materials, relations: [], workstreams: [] }
    const createTopicProposals = vi.fn().mockReturnValue([{ id: 'p1', topicId: 't1', kind: 'create_relation', status: 'pending' }])
    const workspace = {
      getSettings: vi.fn().mockReturnValue(settings('profile')),
      listMaterials: vi.fn().mockReturnValue(materials),
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }),
      listTopics: vi.fn().mockReturnValue([topicMap.topic]),
      topicMap: vi.fn().mockReturnValue(topicMap),
      createTopicProposals
    }
    const responses = [
      { type: 'tool_call', name: 'list_topics', arguments: {} },
      { type: 'tool_call', name: 'get_topic_context', arguments: { topicId: 't1' } },
      { type: 'tool_call', name: 'propose_topic_changes', arguments: { topicId: 't1', actions: [{ kind: 'create_relation', reason: '先基础后并发。', evidence: '两个标题体现学习顺序。', payload: { sourceMaterialId: 'm1', targetMaterialId: 'm2', relationType: 'next', label: '下一步' } }] } },
      { type: 'final', scope: 'action', answer: '已创建一条待审核的学习关系，请在主题画板中确认。', sources: [] }
    ]
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] }), { headers: { 'content-type': 'application/json' } })))
    const result = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).ask('把 Go 基础连接到 Go 并发，作为学习下一步。')
    expect(result).toMatchObject({ answerScope: 'action', toolCalls: [{ name: 'list_topics' }, { name: 'get_topic_context' }, { name: 'propose_topic_changes' }] })
    expect(createTopicProposals).toHaveBeenCalledOnce()
    expect(topicMap.relations).toHaveLength(0)
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
