import { FolderOpen, Pause, Play, RefreshCw, Settings2, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FolderSource } from '../../types'
import { useI18n } from '../../i18n'
import './source.css'

const patterns = (value: string): string[] => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)

export function SourcePanel({ onClose, onChanged }: { onClose(): void; onChanged(): Promise<void> }): React.ReactElement {
  const { t } = useI18n()
  const [sources, setSources] = useState<FolderSource[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<FolderSource | null>(null)
  const load = async (): Promise<void> => setSources(await window.materialMap.sources.list())
  useEffect(() => { void load() }, [])
  const add = async (): Promise<void> => {
    const rootPath = await window.materialMap.chooseDirectory(); if (!rootPath) return
    setBusy(true); setMessage(t('source.scanning'))
    try { await window.materialMap.sources.add({ rootPath, enabled: true, includePatterns: [], excludePatterns: ['node_modules', '.git', 'dist', 'build'], watchEnabled: true }); await load(); await onChanged(); setMessage(t('source.added')) }
    catch (error) { setMessage(error instanceof Error ? error.message : t('source.addFailed')) } finally { setBusy(false) }
  }
  const rescan = async (source: FolderSource): Promise<void> => { setBusy(true); setMessage(t('source.rescanning')); try { const result = await window.materialMap.sources.rescan(source.id); await load(); await onChanged(); setMessage(t('source.scanResult', result)) } catch (error) { setMessage(error instanceof Error ? error.message : t('source.scanFailed')) } finally { setBusy(false) } }
  const toggle = async (source: FolderSource): Promise<void> => { await window.materialMap.sources.update(source.id, { enabled: !source.enabled }); await load(); setMessage(source.enabled ? t('source.pausedMessage') : t('source.resumedMessage')) }
  const remove = async (source: FolderSource): Promise<void> => { if (!window.confirm(t('source.removeConfirm', { path: source.rootPath }))) return; await window.materialMap.sources.remove(source.id); await load(); await onChanged(); setMessage(t('source.removed')) }
  const saveRules = async (): Promise<void> => { if (!editing) return; await window.materialMap.sources.update(editing.id, { includePatterns: editing.includePatterns, excludePatterns: editing.excludePatterns, watchEnabled: editing.watchEnabled }); setEditing(null); await load(); setMessage(t('source.rulesSaved')) }
  return <div className="source-panel-backdrop"><section className="source-panel"><header><div><h2>{t('source.title')}</h2><p>{t('source.copy')}</p></div><button className="icon-button" onClick={onClose} aria-label={t('source.close')}><X size={17} /></button></header><div className="source-actions"><button className="primary-button" disabled={busy} onClick={() => void add()}><FolderOpen size={15} />{t('source.add')}</button></div><div className="source-list">{sources.length === 0 && <p className="source-empty">{t('source.empty')}</p>}{sources.map((source) => <article key={source.id} className={!source.enabled ? 'source-item paused' : 'source-item'}><div className="source-path"><FolderOpen size={16} /><span title={source.rootPath}>{source.rootPath}</span></div><div className="source-meta"><span>{source.enabled ? t('source.watching') : t('source.paused')}</span><div><button title={t('source.editRules')} aria-label={t('source.editRules')} onClick={() => setEditing(source)}><Settings2 size={14} /></button><button title={t('source.rescan')} aria-label={t('source.rescan')} disabled={busy} onClick={() => void rescan(source)}><RefreshCw size={14} /></button><button title={source.enabled ? t('source.pause') : t('source.resume')} aria-label={source.enabled ? t('source.pause') : t('source.resume')} onClick={() => void toggle(source)}>{source.enabled ? <Pause size={14} /> : <Play size={14} />}</button><button title={t('source.remove')} aria-label={t('source.remove')} onClick={() => void remove(source)}><Trash2 size={14} /></button></div></div></article>)}</div>{editing && <section className="source-rule-editor"><h3>{t('source.rules')}</h3><label>{t('source.include')}<textarea value={editing.includePatterns.join('\n')} placeholder="例如：**/*.md" onChange={(event) => setEditing((old) => old ? { ...old, includePatterns: patterns(event.target.value) } : old)} /></label><label>{t('source.exclude')}<textarea value={editing.excludePatterns.join('\n')} placeholder="例如：node_modules/**" onChange={(event) => setEditing((old) => old ? { ...old, excludePatterns: patterns(event.target.value) } : old)} /></label><label className="checkbox"><input type="checkbox" checked={editing.watchEnabled} onChange={(event) => setEditing((old) => old ? { ...old, watchEnabled: event.target.checked } : old)} />{t('source.watchChanges')}</label><div><button className="secondary-button" onClick={() => setEditing(null)}>{t('source.cancel')}</button><button className="primary-button" onClick={() => void saveRules()}>{t('source.saveRules')}</button></div></section>}{message && <p className="source-message">{message}</p>}</section></div>
}
