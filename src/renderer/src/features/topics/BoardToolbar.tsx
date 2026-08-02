import { Eye, EyeOff, Hand, LayoutDashboard, Maximize2, MousePointer2, Network, Plus, Redo2, Undo2, Upload } from 'lucide-react'
import type { ReactNode } from 'react'

export type BoardTool = 'select' | 'pan' | 'connect'
const items: Array<{ tool?: BoardTool; view?: 'map' | 'flow'; label: string; detail: string; icon: ReactNode }> = [
  { view: 'map', label: 'Map view', detail: 'Free-form knowledge map', icon: <LayoutDashboard size={19} /> },
  { view: 'flow', label: 'Flow view', detail: 'Left-to-right dependency flow', icon: <Network size={19} /> },
  { tool: 'select', label: 'Select and drag', detail: 'Move cards and inspect relationships', icon: <MousePointer2 size={19} /> },
  { tool: 'pan', label: 'Pan canvas', detail: 'Browse the canvas', icon: <Hand size={19} /> },
  { tool: 'connect', label: 'Connect cards', detail: 'Create a relationship between cards', icon: <Network size={19} /> }
]

export function BoardToolbar({ tool, showAi, onTool, onAdd, onImport, onLayout, onFit, onToggleAi, onUndoLayout, onRedoLayout, canUndo, canRedo }: { tool: BoardTool; showAi: boolean; onTool(tool: BoardTool): void; onAdd(): void; onImport(): void; onLayout(): void; onFit(): void; onToggleAi(): void; onUndoLayout(): void; onRedoLayout(): void; canUndo: boolean; canRedo: boolean }): React.ReactElement {
  const setViewMode = (mode: 'map' | 'flow'): void => { window.dispatchEvent(new CustomEvent('material-map:view-mode', { detail: mode })) }
  return <aside className="whiteboard-tools" aria-label="Topic canvas tools">
    {items.map((item) => <button key={item.label} aria-label={item.label} data-tooltip={`${item.label}: ${item.detail}`} className={tool === item.tool ? 'active' : ''} onClick={() => item.view ? setViewMode(item.view) : item.tool && onTool(item.tool)}>{item.icon}</button>)}
    <hr />
    <button aria-label="New card" onClick={onAdd}><Plus size={19} /></button>
    <button aria-label="Import material" onClick={onImport}><Upload size={19} /></button>
    <button aria-label="Auto layout" onClick={onLayout}><LayoutDashboard size={19} /></button>
    <button aria-label="Fit view" onClick={onFit}><Maximize2 size={19} /></button>
    <button aria-label="Undo layout" disabled={!canUndo} onClick={onUndoLayout}><Undo2 size={19} /></button>
    <button aria-label="Redo layout" disabled={!canRedo} onClick={onRedoLayout}><Redo2 size={19} /></button>
    <button aria-label={showAi ? 'Hide AI suggestions' : 'Show AI suggestions'} onClick={onToggleAi}>{showAi ? <EyeOff size={19} /> : <Eye size={19} />}</button>
  </aside>
}
