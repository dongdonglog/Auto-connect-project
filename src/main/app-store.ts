import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import type { ProviderKind, ProviderProfile, ProviderProfileInput, WireApi } from './types'

interface StoredProfile extends Omit<ProviderProfile, 'hasApiKey'> { encryptedApiKey?: string }
interface StoreData { profiles: StoredProfile[]; recentWorkspaces: RecentWorkspace[] }
export interface RecentWorkspace { root: string; name: string; openedAt: string }

const presets: Array<{ name: string; provider: ProviderKind; baseUrl: string; wireApi?: WireApi }> = [
  { name: 'OpenAI', provider: 'compatible', baseUrl: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', provider: 'compatible', baseUrl: 'https://api.deepseek.com' },
  { name: 'Grok', provider: 'compatible', baseUrl: 'https://api.x.ai/v1' },
  { name: 'Claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Gemini', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { name: 'Qwen', provider: 'compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'Kimi', provider: 'compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '智谱', provider: 'compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: 'MiniMax', provider: 'compatible', baseUrl: 'https://api.minimax.io/v1' },
  { name: '硅基流动', provider: 'compatible', baseUrl: 'https://api.siliconflow.cn/v1' },
  { name: '本机 Ollama', provider: 'ollama', baseUrl: 'http://localhost:11434' }
]

export class AppStore {
  private readonly path: string
  constructor(dir: string, private readonly safeStorage: SafeStorage) { this.path = join(dir, 'app-settings.json') }
  listPresets(): Array<{ name: string; provider: ProviderKind; baseUrl: string; wireApi?: WireApi }> { return presets }
  private data(): StoreData { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as StoreData : { profiles: [], recentWorkspaces: [] } }
  private save(data: StoreData): void { writeFileSync(this.path, JSON.stringify(data, null, 2)) }
  listProfiles(): ProviderProfile[] {
    return this.data().profiles.map(({ encryptedApiKey, ...profile }) => ({ ...profile, wireApi: profile.wireApi ?? 'chat_completions', hasApiKey: Boolean(encryptedApiKey) }))
  }
  getActiveConfig(): ProviderProfile | null {
    return this.getProfile('active') ?? this.listProfiles()[0] ?? null
  }
  saveActiveConfig(input: Omit<ProviderProfileInput, 'id' | 'name'>): ProviderProfile {
    return this.saveProfile({ ...input, id: 'active', name: 'Current AI configuration' })
  }
  clearLegacyConfigs(): void {
    // Legacy callers remain safe; named profiles are now intentionally retained.
  }
  saveProfile(input: ProviderProfileInput): ProviderProfile {
    const data = this.data(); const existing = input.id ? data.profiles.find((profile) => profile.id === input.id) : undefined
    const name = input.name.trim()
    if (!name) throw new Error('Model profile name is required.')
    if (data.profiles.some((profile) => profile.id !== existing?.id && profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error(`A model profile named “${name}” already exists.`)
    if (name === 'test2' && input.wireApi !== 'responses') throw new Error('test2 is the code.heihuzi.ai relay and must use OpenAI Responses.')
    const encryptedApiKey = input.apiKey === undefined ? existing?.encryptedApiKey : input.apiKey ? this.safeStorage.encryptString(input.apiKey).toString('base64') : undefined
    const profile: StoredProfile = { id: existing?.id ?? randomUUID(), name, provider: input.provider, baseUrl: input.baseUrl.replace(/\/$/, ''), wireApi: input.wireApi ?? existing?.wireApi ?? 'chat_completions', models: existing?.models ?? [], recommendedModel: existing?.recommendedModel ?? null, updatedAt: new Date().toISOString(), encryptedApiKey }
    data.profiles = [...data.profiles.filter((item) => item.id !== profile.id), profile]; this.save(data)
    const { encryptedApiKey: _secret, ...publicProfile } = profile; return { ...publicProfile, wireApi: publicProfile.wireApi ?? 'chat_completions', hasApiKey: Boolean(encryptedApiKey) }
  }
  deleteProfile(id: string): void { const data = this.data(); data.profiles = data.profiles.filter((profile) => profile.id !== id); this.save(data) }
  getProfile(id: string): ProviderProfile | null { return this.listProfiles().find((profile) => profile.id === id) ?? null }
  getApiKey(id: string): string | null { const secret = this.data().profiles.find((profile) => profile.id === id)?.encryptedApiKey; return secret ? this.safeStorage.decryptString(Buffer.from(secret, 'base64')) : null }
  updateModels(id: string, models: string[], recommendedModel: string | null): ProviderProfile {
    const data = this.data(); const profile = data.profiles.find((item) => item.id === id); if (!profile) throw new Error('Model profile not found.')
    profile.models = models; profile.recommendedModel = recommendedModel; profile.updatedAt = new Date().toISOString(); this.save(data)
    const { encryptedApiKey, ...publicProfile } = profile; return { ...publicProfile, wireApi: publicProfile.wireApi ?? 'chat_completions', hasApiKey: Boolean(encryptedApiKey) }
  }
  listRecent(): RecentWorkspace[] { return this.data().recentWorkspaces }
  rememberWorkspace(root: string, name: string): void { const data = this.data(); data.recentWorkspaces = [{ root, name, openedAt: new Date().toISOString() }, ...data.recentWorkspaces.filter((item) => item.root !== root)].slice(0, 6); this.save(data) }
  forgetWorkspace(root: string): void { const data = this.data(); data.recentWorkspaces = data.recentWorkspaces.filter((item) => item.root !== root); this.save(data) }
}
