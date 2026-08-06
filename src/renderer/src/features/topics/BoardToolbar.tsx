import { ClipboardCheck, Eye, LayoutDashboard, Maximize2, Network, Plus, Redo2, Sparkles, Undo2, Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'

/** 免模式工具栏：左键框选，拖动卡片移动，Space+左键/中键平移，拖端口连线。 */
export function BoardToolbar({ onAdd, onImport, onLayout, onFit, onUndo, onRedo, onProposals, onAi, onToggleConfirmedOnly, viewMode = 'map', confirmedOnly = false, proposalCount, proposalsOpen, canUndo, canRedo }: { onAdd(): void; onImport(): void; onLayout(): void; onFit(): void; onUndo(): void; onRedo(): void; onProposals(): void; onAi?(): void; onToggleConfirmedOnly?(): void; viewMode?: 'map' | 'flow'; confirmedOnly?: boolean; proposalCount: number; proposalsOpen: boolean; canUndo: boolean; canRedo: boolean }): React.ReactElement {
  const [activeMode, setActiveMode] = useState(viewMode)
  const [activeConfirmedOnly, setActiveConfirmedOnly] = useState(confirmedOnly)
  const { t } = useI18n()
  const views: Array<{ mode: 'map' | 'flow'; label: string; detail: string; icon: ReactNode }> = [
    { mode: 'map', label: t('toolbar.map'), detail: t('toolbar.mapDetail'), icon: <LayoutDashboard size={19} /> },
    { mode: 'flow', label: t('toolbar.flow'), detail: t('toolbar.flowDetail'), icon: <Network size={19} /> }
  ]
  useEffect(() => {
    const onMode = (event: Event): void => setActiveMode((event as CustomEvent<'map' | 'flow'>).detail)
    const onConfirmed = (): void => setActiveConfirmedOnly((current) => !current)
    window.addEventListener('material-map:view-mode', onMode)
    window.addEventListener('material-map:confirmed-only', onConfirmed)
    return () => { window.removeEventListener('material-map:view-mode', onMode); window.removeEventListener('material-map:confirmed-only', onConfirmed) }
  }, [])
  const setViewMode = (mode: 'map' | 'flow'): void => { setActiveMode(mode); window.dispatchEvent(new CustomEvent('material-map:view-mode', { detail: mode })) }
  return <aside className="whiteboard-tools" aria-label={t('toolbar.topicCanvas')}>
    {views.map((view) => <button key={view.mode} className={activeMode === view.mode ? 'active' : ''} aria-label={view.label} data-tooltip={`${view.label}: ${view.detail}`} onClick={() => setViewMode(view.mode)}>{view.icon}</button>)}
    <hr />
    <button aria-label={t('toolbar.newCard')} data-tooltip={t('toolbar.newCard')} onClick={onAdd}><Plus size={19} /></button>
    <button aria-label={t('toolbar.importMaterial')} data-tooltip={t('toolbar.importMaterial')} onClick={onImport}><Upload size={19} /></button>
    <button aria-label={t('toolbar.autoLayout')} data-tooltip={t('toolbar.autoLayout')} onClick={onLayout}><LayoutDashboard size={19} /></button>
    <button aria-label={t('toolbar.fitView')} data-tooltip={t('toolbar.fitView')} onClick={onFit}><Maximize2 size={19} /></button>
    <button className={activeConfirmedOnly ? 'active' : ''} aria-label={t('toolbar.confirmedOnly')} data-tooltip={t('toolbar.confirmedOnly')} onClick={() => { if (onToggleConfirmedOnly) { setActiveConfirmedOnly((current) => !current); onToggleConfirmedOnly() } else window.dispatchEvent(new CustomEvent('material-map:confirmed-only')) }}><Eye size={19} /></button>
    <button className="ai-tool" aria-label={t('toolbar.aiDraft')} data-tooltip={t('toolbar.aiDraft')} onClick={() => { if (onAi) onAi(); else window.dispatchEvent(new CustomEvent('material-map:ai')) }}><Sparkles size={19} /></button>
    <button className={proposalsOpen ? 'active proposal-tool' : 'proposal-tool'} aria-label={t('toolbar.proposals')} data-tooltip={`${t('toolbar.proposals')}${proposalCount ? ` (${proposalCount})` : ''}`} onClick={onProposals}><ClipboardCheck size={19} />{proposalCount > 0 && <span>{proposalCount > 9 ? '9+' : proposalCount}</span>}</button>
    <hr />
    <button aria-label={t('toolbar.undo')} data-tooltip={t('toolbar.undo')} disabled={!canUndo} onClick={onUndo}><Undo2 size={19} /></button>
    <button aria-label={t('toolbar.redo')} data-tooltip={t('toolbar.redo')} disabled={!canRedo} onClick={onRedo}><Redo2 size={19} /></button>
  </aside>
}
