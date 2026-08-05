import { FolderOpen, Pause, Play, RefreshCw, Settings2, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FolderSource } from '../../types'
import './source.css'

const patterns = (value: string): string[] => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)

export function SourcePanel({ onClose, onChanged }: { onClose(): void; onChanged(): Promise<void> }): React.ReactElement {
  const [sources, setSources] = useState<FolderSource[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<FolderSource | null>(null)
  const load = async (): Promise<void> => setSources(await window.materialMap.sources.list())
  useEffect(() => { void load() }, [])
  const add = async (): Promise<void> => {
    const rootPath = await window.materialMap.chooseDirectory(); if (!rootPath) return
    setBusy(true); setMessage('正在扫描文件夹…')
    try { await window.materialMap.sources.add({ rootPath, enabled: true, includePatterns: [], excludePatterns: ['node_modules', '.git', 'dist', 'build'], watchEnabled: true }); await load(); await onChanged(); setMessage('文件夹已加入并开始索引。') }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法加入文件夹。') } finally { setBusy(false) }
  }
  const rescan = async (source: FolderSource): Promise<void> => { setBusy(true); setMessage('正在重新扫描…'); try { const result = await window.materialMap.sources.rescan(source.id); await load(); await onChanged(); setMessage(`扫描 ${result.scanned} 个文件，更新 ${result.indexed} 个材料，失联 ${result.unavailable} 个。`) } catch (error) { setMessage(error instanceof Error ? error.message : '扫描失败。') } finally { setBusy(false) } }
  const toggle = async (source: FolderSource): Promise<void> => { await window.materialMap.sources.update(source.id, { enabled: !source.enabled }); await load(); setMessage(source.enabled ? '已暂停文件夹监听。' : '已恢复文件夹监听。') }
  const remove = async (source: FolderSource): Promise<void> => { if (!window.confirm(`移除“${source.rootPath}”？材料记录不会被删除。`)) return; await window.materialMap.sources.remove(source.id); await load(); await onChanged(); setMessage('文件夹来源已移除，材料记录已保留。') }
  const saveRules = async (): Promise<void> => { if (!editing) return; await window.materialMap.sources.update(editing.id, { includePatterns: editing.includePatterns, excludePatterns: editing.excludePatterns, watchEnabled: editing.watchEnabled }); setEditing(null); await load(); setMessage('文件夹规则已保存。') }
  return <div className="source-panel-backdrop"><section className="source-panel"><header><div><h2>文件夹来源</h2><p>持续索引本地文件，原始文件不会被移动。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header><div className="source-actions"><button className="primary-button" disabled={busy} onClick={() => void add()}><FolderOpen size={15} />添加文件夹</button></div><div className="source-list">{sources.length === 0 && <p className="source-empty">还没有添加文件夹。</p>}{sources.map((source) => <article key={source.id} className={!source.enabled ? 'source-item paused' : 'source-item'}><div className="source-path"><FolderOpen size={16} /><span title={source.rootPath}>{source.rootPath}</span></div><div className="source-meta"><span>{source.enabled ? '监听中' : '已暂停'}</span><div><button title="编辑规则" onClick={() => setEditing(source)}><Settings2 size={14} /></button><button title="重新扫描" disabled={busy} onClick={() => void rescan(source)}><RefreshCw size={14} /></button><button title={source.enabled ? '暂停' : '恢复'} onClick={() => void toggle(source)}>{source.enabled ? <Pause size={14} /> : <Play size={14} />}</button><button title="移除来源" onClick={() => void remove(source)}><Trash2 size={14} /></button></div></div></article>)}</div>{editing && <section className="source-rule-editor"><h3>扫描规则</h3><label>包含规则<textarea value={editing.includePatterns.join('\n')} placeholder="例如：**/*.md" onChange={(event) => setEditing((old) => old ? { ...old, includePatterns: patterns(event.target.value) } : old)} /></label><label>排除规则<textarea value={editing.excludePatterns.join('\n')} placeholder="例如：node_modules/**" onChange={(event) => setEditing((old) => old ? { ...old, excludePatterns: patterns(event.target.value) } : old)} /></label><label className="checkbox"><input type="checkbox" checked={editing.watchEnabled} onChange={(event) => setEditing((old) => old ? { ...old, watchEnabled: event.target.checked } : old)} />监控文件变化</label><div><button className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" onClick={() => void saveRules()}>保存规则</button></div></section>}{message && <p className="source-message">{message}</p>}</section></div>
}
