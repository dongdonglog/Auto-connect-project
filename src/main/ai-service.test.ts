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
})
