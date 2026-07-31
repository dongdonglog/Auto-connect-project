import { Eye, EyeOff, Hand, LayoutDashboard, Maximize2, MousePointer2, Network, Plus, Redo2, Undo2, Upload } from 'lucide-react'
import type { ReactNode } from 'react'

export type BoardTool = 'select' | 'pan' | 'connect'
const items: Array<{ tool?: BoardTool; label: string; detail: string; icon: ReactNode }> = [
  { tool: 'select', label: '选择与拖动', detail: '拖动卡片并选择关系', icon: <MousePointer2 size={19} /> },
  { tool: 'pan', label: '平移画布', detail: '拖动空白区域浏览画布', icon: <Hand size={19} /> },
  { tool: 'connect', label: '连续连线', detail: '从输出端口拖到输入端口，Esc 退出', icon: <Network size={19} /> }
]

export function BoardToolbar({ tool, showAi, onTool, onAdd, onImport, onLayout, onFit, onToggleAi, onUndoLayout, onRedoLayout, canUndo, canRedo }: { tool: BoardTool; showAi: boolean; onTool(tool: BoardTool): void; onAdd(): void; onImport(): void; onLayout(): void; onFit(): void; onToggleAi(): void; onUndoLayout(): void; onRedoLayout(): void; canUndo: boolean; canRedo: boolean }): React.ReactElement {
  return <aside className="whiteboard-tools" aria-label="主题画板工具">
    {items.map((item) => <button key={item.label} aria-label={item.label} data-tooltip={`${item.label}：${item.detail}`} className={tool === item.tool ? 'active' : ''} onClick={() => item.tool && onTool(item.tool)}>{item.icon}</button>)}
    <hr />
    <button aria-label="新建卡片" data-tooltip="新建卡片：在画板中增加一张笔记" onClick={onAdd}><Plus size={19} /></button>
    <button aria-label="导入材料" data-tooltip="导入材料：选择文件后直接放入主题" onClick={onImport}><Upload size={19} /></button>
    <button aria-label="自动排版" data-tooltip="自动排版：按关系整理为从左至右层级" onClick={onLayout}><LayoutDashboard size={19} /></button>
    <button aria-label="适配视图" data-tooltip="适配视图：显示全部卡片和关系" onClick={onFit}><Maximize2 size={19} /></button>
    <button aria-label="撤销排版" data-tooltip="撤销排版：恢复自动排版前的位置" disabled={!canUndo} onClick={onUndoLayout}><Undo2 size={19} /></button>
    <button aria-label="重做排版" data-tooltip="重做排版：恢复刚才的自动排版" disabled={!canRedo} onClick={onRedoLayout}><Redo2 size={19} /></button>
    <button aria-label={showAi ? '隐藏 AI 建议' : '显示 AI 建议'} data-tooltip="AI 建议：仅显示或隐藏待审阅关系" onClick={onToggleAi}>{showAi ? <EyeOff size={19} /> : <Eye size={19} />}</button>
  </aside>
}
