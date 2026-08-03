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
  it('returns explicit insufficient evidence without calling a model', async () => {
    const workspace = { searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [], mode: 'fts' }), getSettings: vi.fn().mockReturnValue({ enabled: true, chatModel: 'test-model' }) }
    const result = await new AiService(workspace as unknown as WorkspaceService, {} as AppStore).ask('What is missing?')
    expect(result).toMatchObject({ confidence: 'insufficient-evidence', citations: [], retrievalMode: 'fallback' })
    expect(workspace.searchKnowledgeAsync).toHaveBeenCalledWith('What is missing?', { limit: 8 })
  })

  it('maps paragraph hits into grounded citations when model generation is disabled', async () => {
    const workspace = {
      searchKnowledgeAsync: vi.fn().mockResolvedValue({ hits: [{ materialId: 'm1', chunkId: 'c1', title: 'Guide', text: 'Use local SQLite.', score: 1, sourcePath: 'C:/guide.md', pageNumber: null, heading: 'Storage', availability: 'available' }], mode: 'fts' }),
      getSettings: vi.fn().mockReturnValue({ enabled: false, chatModel: '' })
    }
    const result = await new AiService(workspace as unknown as WorkspaceService, {} as AppStore).ask('How is storage handled?')
    expect(result).toMatchObject({ confidence: 'grounded', retrievalMode: 'fts', citations: [{ materialId: 'm1', chunkId: 'c1', title: 'Guide', heading: 'Storage', excerpt: 'Use local SQLite.' }] })
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
