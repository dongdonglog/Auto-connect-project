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
    const topicMap = { topic: { id: 'topic', revision: 0 }, materials: [{ id: 'a', title: 'A', importedAt: '', extractedText: 'first', excerpt: 'first' }, { id: 'b', title: 'B', importedAt: '', extractedText: 'second', excerpt: 'second' }], relations: [], workstreams: [] }
    const chunks = (id: string, text: string) => [{ id: `chunk-${id}`, materialId: id, ordinal: 0, text, startOffset: 0, endOffset: text.length, pageNumber: null, heading: null, hash: '', indexedAt: '' }]
    const workspace = { topicMap: vi.fn().mockReturnValue(topicMap), getSettings: vi.fn().mockReturnValue(settings('profile')), startJob: vi.fn().mockReturnValue('job'), finishJob: vi.fn(), failJob: vi.fn(), getMaterialAnalysisCard: vi.fn().mockReturnValue(null), saveMaterialAnalysisCard: vi.fn(), listMaterialChunks: vi.fn((id: string) => chunks(id, id === 'a' ? 'first' : 'second')), materialEvidenceWindow: vi.fn((id: string) => chunks(id, id === 'a' ? 'first supports second' : 'second follows first')), startTopicAnalysisRun: vi.fn().mockReturnValue({ id: 'run', topicId: 'topic', topicRevision: 0 }), updateTopicAnalysisRun: vi.fn(), applyTopicAnalysis: vi.fn().mockReturnValue(1) }
    const candidate = { relations: [{ sourceMaterialId: 'a', targetMaterialId: 'b', relationType: 'next', label: 'next', confidence: 0.9 }] }
    const verification = { accept: true, relationType: 'next', label: 'next', confidence: 0.9, evidence: 'Both excerpts establish the sequence.' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) } }] }), { headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verification) } }] }), { headers: { 'content-type': 'application/json' } })))
    const summary = await new AiService(workspace as unknown as WorkspaceService, { getProfile: () => profile('chat_completions'), getApiKey: () => 'test-key' } as unknown as AppStore).analyzeTopic('topic')
    expect(summary).toMatchObject({ processed: 2, addedRelations: 1, addedWorkstreams: 0 })
    expect(workspace.applyTopicAnalysis).toHaveBeenCalledWith('topic', 0, [expect.objectContaining({ sourceMaterialId: 'a', targetMaterialId: 'b', evidence: expect.stringContaining('Both excerpts') })], expect.any(Array))
  })
})
