import { useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { ModelSettings, ProviderProfile } from '../types'
import { Modal } from './Modal'

export interface WorkspaceDialogProps {
  root: string
  onClose(): void
  onSave(name: string): void
}

export function WorkspaceDialog({ root, onClose, onSave }: WorkspaceDialogProps): React.ReactElement {
  const [name, setName] = useState('我的材料')
  return (
    <Modal title="创建工作区" onClose={onClose}>
      <p className="dialog-note">将在此文件夹中保存材料副本、索引和地图数据。</p>
      <input value={root} readOnly/>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="工作区名称"/>
      <button className="primary-button" disabled={!name.trim()} onClick={() => onSave(name.trim())}>创建工作区</button>
    </Modal>
  )
}

export type NoteFormat = 'note' | 'md' | 'txt' | 'csv' | 'json' | 'html'

export interface NoteDialogProps {
  onClose(): void
  onSave(title: string, text: string, format: NoteFormat): void
}

export function NoteDialog({ onClose, onSave }: NoteDialogProps): React.ReactElement {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [format, setFormat] = useState<NoteFormat>('note')
  return (
    <Modal title="新建材料" onClose={onClose}>
      <label>材料类型
        <select value={format} onChange={(event) => setFormat(event.target.value as NoteFormat)}>
          <option value="note">笔记</option>
          <option value="md">Markdown 文档</option>
          <option value="txt">纯文本文件</option>
          <option value="csv">CSV 文件</option>
          <option value="json">JSON 文件</option>
          <option value="html">HTML 文件</option>
        </select>
      </label>
      <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="材料标题"/>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入或粘贴内容…"/>
      <button className="primary-button" disabled={!title.trim()} onClick={() => onSave(title, text, format)}>创建并保存</button>
    </Modal>
  )
}

export interface LinkDialogProps {
  onClose(): void
  onSave(url: string): void
}

export function LinkDialog({ onClose, onSave }: LinkDialogProps): React.ReactElement {
  const [url, setUrl] = useState('')
  return (
    <Modal title="添加链接" onClose={onClose}>
      <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com"/>
      <button className="primary-button" disabled={!/^https?:\/\//.test(url)} onClick={() => onSave(url)}>添加并解析</button>
    </Modal>
  )
}

export interface TopicDialogProps {
  onClose(): void
  onSave(name: string, description: string): void
}

export function TopicDialog({ onClose, onSave }: TopicDialogProps): React.ReactElement {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return (
    <Modal title="新建主题" onClose={onClose}>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="主题名称"/>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个主题想梳理什么？"/>
      <button className="primary-button" disabled={!name.trim()} onClick={() => onSave(name, description)}>创建主题</button>
    </Modal>
  )
}

export interface SettingsDialogProps {
  onClose(): void
  topicId?: string
}

export function SettingsDialog({ onClose, topicId }: SettingsDialogProps): React.ReactElement {
  const [settings, setSettings] = useState<ModelSettings>({ profileId: null, provider: 'compatible', baseUrl: '', chatModel: '', embeddingModel: '', allowCloud: false, enabled: false })
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [draft, setDraft] = useState({ id: undefined as string | undefined, name: '', provider: 'compatible' as ModelSettings['provider'], wireApi: 'chat_completions' as 'chat_completions' | 'responses', baseUrl: '', apiKey: '' })
  const [result, setResult] = useState('')
  const refreshProfiles = async () => setProfiles(await window.materialMap.profiles.list())
  useEffect(() => {
    void Promise.all([window.materialMap.settings.get(), window.materialMap.profiles.list()]).then(([next, list]) => {
      setSettings(next)
      setProfiles(list)
    })
  }, [])
  const update = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => setSettings((old) => ({ ...old, [key]: value }))
  const apply = async (profile: ProviderProfile) => {
    const next = { ...settings, profileId: profile.id, provider: profile.provider, baseUrl: profile.baseUrl, chatModel: profile.recommendedModel ?? '', enabled: true }
    await window.materialMap.settings.save(next)
    setSettings(next)
    setResult(`已应用“${profile.name}”，系统自动选择 ${profile.recommendedModel ?? '可用模型'}。`)
  }
  const edit = (profile: ProviderProfile) => setDraft({ id: profile.id, name: profile.name, provider: profile.provider, wireApi: profile.wireApi, baseUrl: profile.baseUrl, apiKey: '' })
  const save = async () => {
    try {
      const profile = await window.materialMap.profiles.save({ ...draft, apiKey: draft.apiKey || undefined }) as ProviderProfile
      await apply(profile)
      setDraft({ id: undefined, name: '', provider: 'compatible', wireApi: 'chat_completions', baseUrl: '', apiKey: '' })
      await refreshProfiles()
    } catch (error) {
      setResult(error instanceof Error ? error.message : '无法发现可用模型，配置未保存。')
    }
  }
  return (
    <Modal title="模型与隐私" onClose={onClose}>
      <section className="profile-list">
        <h3>已保存的 AI 配置</h3>
        {profiles.length ? profiles.map((profile) => (
          <div key={profile.id} className={profile.id === settings.profileId ? 'active' : ''}>
            <button onClick={() => void apply(profile)}>
              <strong>{profile.name}</strong>
              <small>{profile.recommendedModel ?? '尚未发现模型'}</small>
            </button>
            <button className="icon-button" title="编辑配置" onClick={() => edit(profile)}><Pencil size={14}/></button>
            <button className="icon-button" title="删除配置" onClick={() => void window.materialMap.profiles.delete(profile.id).then(refreshProfiles)}><Trash2 size={14}/></button>
          </div>
        )) : <p>还没有可用的 AI 配置。</p>}
      </section>
      <section className="profile-create">
        <h3>{draft.id ? '编辑 AI 配置' : '创建 AI 配置'}</h3>
        <label>配置名称<input value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="例如：公司 OpenAI 网关"/></label>
        <label>服务协议
          <select value={draft.provider} onChange={(event) => setDraft((old) => ({ ...old, provider: event.target.value as ModelSettings['provider'] }))}>
            <option value="compatible">OpenAI 兼容</option>
            <option value="ollama">本机 Ollama</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label>服务地址<input value={draft.baseUrl} onChange={(event) => setDraft((old) => ({ ...old, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1"/></label>
        {draft.provider !== 'ollama' && (
          <label>API Key<input type="password" value={draft.apiKey} onChange={(event) => setDraft((old) => ({ ...old, apiKey: event.target.value }))} placeholder={draft.id ? '留空以保留当前 API Key' : '粘贴 API Key'}/></label>
        )}
        <p className="dialog-note">保存时会自动发现服务商可用模型并选择推荐的最新模型。</p>
        <button className="primary-button" disabled={!draft.name.trim() || !draft.baseUrl.trim() || (draft.provider !== 'ollama' && !draft.id && !draft.apiKey.trim())} onClick={() => void save()}>{draft.id ? '更新并保存' : '发现模型并保存'}</button>
      </section>
      {draft.provider !== 'ollama' && (
        <label className="checkbox">
          <input type="checkbox" checked={settings.allowCloud} onChange={(event) => update('allowCloud', event.target.checked)}/>我理解分析文本会发送到外部服务
        </label>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)}/>开启自动分析
      </label>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={!settings.profileId} onClick={async () => {
          const steps = await window.materialMap.settings.validate(settings, topicId)
          setResult(steps.map((step: { ok: boolean; id: string; detail: string }) => `${step.ok ? '通过' : '失败'} ${step.id}：${step.detail}`).join('\n'))
        }}>验证当前 AI</button>
      </div>
      {result && <p className="result-text">{result}</p>}
    </Modal>
  )
}
