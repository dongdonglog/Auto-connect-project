import { LayoutDashboard, Maximize2, Network, Plus, Redo2, Undo2, Upload } from 'lucide-react'
import type { ReactNode } from 'react'

const views: Array<{ mode: 'map' | 'flow'; label: string; detail: string; icon: ReactNode }> = [
  { mode: 'map', label: '自由画板', detail: '自由摆放卡片与关系', icon: <LayoutDashboard size={19} /> },
  { mode: 'flow', label: '流程视图', detail: '按依赖关系从左到右排列', icon: <Network size={19} /> }
]

/** 免模式工具栏：左键框选，拖动卡片移动，Space+左键/中键平移，拖端口连线。 */
export function BoardToolbar({ onAdd, onImport, onLayout, onFit, onUndo, onRedo, canUndo, canRedo }: { onAdd(): void; onImport(): void; onLayout(): void; onFit(): void; onUndo(): void; onRedo(): void; canUndo: boolean; canRedo: boolean }): React.ReactElement {
  const setViewMode = (mode: 'map' | 'flow'): void => { window.dispatchEvent(new CustomEvent('material-map:view-mode', { detail: mode })) }
  return <aside className="whiteboard-tools" aria-label="Topic canvas tools">
    {views.map((view) => <button key={view.mode} aria-label={view.label} data-tooltip={`${view.label}: ${view.detail}`} onClick={() => setViewMode(view.mode)}>{view.icon}</button>)}
    <hr />
    <button aria-label="新建卡片" data-tooltip="新建卡片" onClick={onAdd}><Plus size={19} /></button>
    <button aria-label="导入材料" data-tooltip="导入材料到画板" onClick={onImport}><Upload size={19} /></button>
    <button aria-label="自动排版" data-tooltip="按当前关系自动排版" onClick={onLayout}><LayoutDashboard size={19} /></button>
    <button aria-label="适配视图" data-tooltip="缩放至显示全部卡片" onClick={onFit}><Maximize2 size={19} /></button>
    <hr />
    <button aria-label="撤销" data-tooltip="撤销" disabled={!canUndo} onClick={onUndo}><Undo2 size={19} /></button>
    <button aria-label="重做" data-tooltip="重做" disabled={!canRedo} onClick={onRedo}><Redo2 size={19} /></button>
  </aside>
}
