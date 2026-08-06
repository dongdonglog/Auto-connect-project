import { useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { ModelSettings, ProviderProfile } from '../types'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

export interface WorkspaceDialogProps {
  root: string
  onClose(): void
  onSave(name: string, password?: string): void
}

export function WorkspaceDialog({ root, onClose, onSave }: WorkspaceDialogProps): React.ReactElement {
  const { t } = useI18n()
  const [name, setName] = useState('我的材料')
  const [encrypt, setEncrypt] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const validPassword = !encrypt || (password.length >= 8 && password === confirm)
  return (
    <Modal title={t('dialog.createWorkspace')} onClose={onClose}>
      <p className="dialog-note">{t('dialog.workspaceNote')}</p>
      <input value={root} readOnly/>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t('dialog.workspaceName')}/>
      <label className="dialog-checkbox"><input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)}/>{t('dialog.encryptWorkspace')}</label>
      {encrypt && <><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t('dialog.passwordMin')}/><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={t('dialog.passwordConfirm')}/>{confirm && password !== confirm && <p className="dialog-error">{t('dialog.passwordMismatch')}</p>}</>}
      <button className="primary-button" disabled={!name.trim() || !validPassword} onClick={() => onSave(name.trim(), encrypt ? password : undefined)}>{t('dialog.create')}</button>
    </Modal>
  )
}

export function WorkspacePasswordDialog({ title, name, onClose, onSubmit }: { title: string; name: string; onClose(): void; onSubmit(password: string): Promise<void> }): React.ReactElement {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!password || busy) return
    setBusy(true); setError('')
    try { await onSubmit(password) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to open encrypted workspace.') } finally { setBusy(false) }
  }
  return <Modal title={title} onClose={onClose}><p className="dialog-note">{t('dialog.encryptedNote', { name })}</p><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} placeholder={t('dialog.password')}/>{error && <p className="dialog-error">{error}</p>}<button className="primary-button" disabled={!password || busy} onClick={() => void submit()}>{busy ? t('dialog.opening') : t('dialog.continue')}</button></Modal>
}

export type NoteFormat = 'note' | 'md' | 'txt' | 'csv' | 'json' | 'html'

export interface NoteDialogProps {
  onClose(): void
  onSave(title: string, text: string, format: NoteFormat): void
}

export function NoteDialog({ onClose, onSave }: NoteDialogProps): React.ReactElement {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [format, setFormat] = useState<NoteFormat>('note')
  return (
    <Modal title={t('dialog.createMaterial')} onClose={onClose}>
      <label>{t('dialog.materialType')}
        <select value={format} onChange={(event) => setFormat(event.target.value as NoteFormat)}>
          <option value="note">{t('dialog.note')}</option>
          <option value="md">{t('dialog.markdown')}</option>
          <option value="txt">{t('dialog.textFile')}</option>
          <option value="csv">CSV 文件</option>
          <option value="json">JSON 文件</option>
          <option value="html">HTML 文件</option>
        </select>
      </label>
      <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('dialog.materialTitle')}/>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={t('dialog.contentPlaceholder')}/>
      <button className="primary-button" disabled={!title.trim()} onClick={() => onSave(title, text, format)}>{t('dialog.createSave')}</button>
    </Modal>
  )
}

export interface LinkDialogProps {
  onClose(): void
  onSave(url: string): void
}

export function LinkDialog({ onClose, onSave }: LinkDialogProps): React.ReactElement {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  return (
    <Modal title={t('dialog.addLink')} onClose={onClose}>
      <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com"/>
      <button className="primary-button" disabled={!/^https?:\/\//.test(url)} onClick={() => onSave(url)}>{t('dialog.addParse')}</button>
    </Modal>
  )
}

export interface TopicDialogProps {
  onClose(): void
  onSave(name: string, description: string): void
}

export function TopicDialog({ onClose, onSave }: TopicDialogProps): React.ReactElement {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return (
    <Modal title={t('dialog.createTopic')} onClose={onClose}>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t('dialog.topicName')}/>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('dialog.topicDescription')}/>
      <button className="primary-button" disabled={!name.trim()} onClick={() => onSave(name, description)}>{t('dialog.createTopic')}</button>
    </Modal>
  )
}

export interface SettingsDialogProps {
  onClose(): void
  topicId?: string
}

export function SettingsDialog({ onClose, topicId }: SettingsDialogProps): React.ReactElement {
  const { t, locale, setLocale } = useI18n()
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
  const updateAndSave = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]): void => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    void window.materialMap.settings.save(next)
  }
  const apply = async (profile: ProviderProfile) => {
    const next = { ...settings, profileId: profile.id, provider: profile.provider, baseUrl: profile.baseUrl, chatModel: profile.recommendedModel ?? '', enabled: true }
    await window.materialMap.settings.save(next)
    setSettings(next)
    setResult(t('dialog.appliedProfile', { name: profile.name, model: profile.recommendedModel ?? t('dialog.availableModel') }))
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
    <Modal title={t('dialog.modelPrivacy')} onClose={onClose}>
      <label className="settings-language">{t('language')}
        <select value={locale} onChange={(event) => setLocale(event.target.value as 'zh-CN' | 'en-US')}>
          <option value="zh-CN">{t('language.zh')}</option>
          <option value="en-US">{t('language.en')}</option>
        </select>
      </label>
      <section className="profile-list">
        <h3>{t('dialog.savedAiProfiles')}</h3>
        {profiles.length ? profiles.map((profile) => (
          <div key={profile.id} className={profile.id === settings.profileId ? 'active' : ''}>
            <button onClick={() => void apply(profile)}>
              <strong>{profile.name}</strong>
              <small>{profile.recommendedModel ?? t('dialog.availableModel')}</small>
            </button>
            <button className="icon-button" title={t('dialog.editProfile')} aria-label={t('dialog.editProfile')} onClick={() => edit(profile)}><Pencil size={14}/></button>
            <button className="icon-button" title={t('dialog.deleteProfile')} aria-label={t('dialog.deleteProfile')} onClick={() => void window.materialMap.profiles.delete(profile.id).then(refreshProfiles)}><Trash2 size={14}/></button>
          </div>
        )) : <p>{t('dialog.noAiProfiles')}</p>}
      </section>
      <section className="profile-create">
        <h3>{draft.id ? t('dialog.editAiProfile') : t('dialog.createAiProfile')}</h3>
        <label>{t('dialog.profileName')}<input value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder={t('dialog.profileNamePlaceholder')}/></label>
        <label>{t('dialog.serviceProtocol')}
          <select value={draft.provider} onChange={(event) => setDraft((old) => ({ ...old, provider: event.target.value as ModelSettings['provider'] }))}>
            <option value="compatible">{t('dialog.openaiCompatible')}</option>
            <option value="ollama">{t('dialog.localOllama')}</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label>{t('dialog.serviceAddress')}<input value={draft.baseUrl} onChange={(event) => setDraft((old) => ({ ...old, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1"/></label>
        {draft.provider !== 'ollama' && (
          <label>{t('dialog.apiKey')}<input type="password" value={draft.apiKey} onChange={(event) => setDraft((old) => ({ ...old, apiKey: event.target.value }))} placeholder={draft.id ? t('dialog.keepApiKey') : t('dialog.pasteApiKey')}/></label>
        )}
        <p className="dialog-note">{t('dialog.profileNote')}</p>
        <button className="primary-button" disabled={!draft.name.trim() || !draft.baseUrl.trim() || (draft.provider !== 'ollama' && !draft.id && !draft.apiKey.trim())} onClick={() => void save()}>{draft.id ? t('dialog.updateAndSave') : t('dialog.discoverAndSave')}</button>
      </section>
      {draft.provider !== 'ollama' && (
        <label className="checkbox">
          <input type="checkbox" checked={settings.allowCloud} onChange={(event) => updateAndSave('allowCloud', event.target.checked)}/>{t('dialog.allowCloud')}
        </label>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={settings.enabled} onChange={(event) => updateAndSave('enabled', event.target.checked)}/>{t('dialog.enableAi')}
      </label>
      <div className="dialog-actions">
        <button className="secondary-button" disabled={!settings.profileId} onClick={async () => {
          const steps = await window.materialMap.settings.validate(settings, topicId)
          setResult(steps.map((step: { ok: boolean; id: string; detail: string }) => `${step.ok ? '通过' : '失败'} ${step.id}：${step.detail}`).join('\n'))
        }}>{t('dialog.validateAi')}</button>
      </div>
      {result && <p className="result-text">{result}</p>}
    </Modal>
  )
}
