import { Background, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Material, TopicMap } from '../../types'
import { layoutTopic } from '../../lib/topic-layout'
import { BoardToolbar, type BoardTool } from './BoardToolbar'
import { MaterialNode, type MaterialNodeData } from './MaterialNode'
import { RelationEdge } from './RelationEdge'
import { AiSuggestionPanel } from '../ai/AiSuggestionPanel'
import { ipc } from '../../lib/ipc'
import { useTopicConnections } from './useTopicConnections'
import { DemoChecklist } from './DemoChecklist'

type Menu = { x: number; y: number; position: { x: number; y: number }; nodeId?: string } | null
const nodeTypes = { material: MaterialNode }
const edgeTypes = { relation: RelationEdge }

const isSame = (left: { x: number; y: number }, right: { x: number; y: number }): boolean => left.x === right.x && left.y === right.y

/** React Flow container only: no page loading, dialogs, or unrelated application state. */
export function TopicCanvas({ map, materials, onRefresh, onSelect, onImportFiles }: { map: TopicMap; materials: Material[]; onRefresh(): Promise<void>; onSelect(material: Material): void; onImportFiles(paths: string[], position: { x: number; y: number }): Promise<void> }): React.ReactElement {
  const [tool, setTool] = useState<BoardTool>('select'); const [showAi, setShowAi] = useState(false); const [notice, setNotice] = useState(''); const [menu, setMenu] = useState<Menu>(null); const [pickerPosition, setPickerPosition] = useState<{ x: number; y: number } | null>(null); const [pickerQuery, setPickerQuery] = useState(''); const [pickedIds, setPickedIds] = useState<string[]>([]); const [undoPositions, setUndoPositions] = useState<Array<{ materialId: string; x: number; y: number }> | null>(null); const [redoPositions, setRedoPositions] = useState<Array<{ materialId: string; x: number; y: number }> | null>(null); const [flow, setFlow] = useState<ReactFlowInstance<Node<MaterialNodeData>, Edge> | null>(null)
  const didFit = useRef(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<MaterialNodeData>>([]); const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  // Sequence is an explicit user override only. Imported cards otherwise stay
  // deterministic by material date, then import date, then ID.
  const ordered = useMemo(() => [...map.materials].sort((a, b) => {
    const leftManual = a.sequenceSource === 'manual'; const rightManual = b.sequenceSource === 'manual'
    if (leftManual && rightManual) return (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
    if (leftManual !== rightManual) return leftManual ? -1 : 1
    return (a.occurredAt ?? a.importedAt).localeCompare(b.occurredAt ?? b.importedAt) || a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id)
  }), [map.materials])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3000); return () => window.clearTimeout(timer) }, [notice])

  // Merge server data by material id. Existing drag positions are authoritative
  // until the drag-end persistence call confirms them in the next map refresh.
  useEffect(() => {
    setNodes((current) => ordered.map((material, index) => {
      const old = current.find((node) => node.id === material.id); const stored = { x: material.canvasX ?? 120 + (index % 4) * 270, y: material.canvasY ?? 100 + Math.floor(index / 4) * 180 }
      const position = old && !isSame(old.position, stored) ? old.position : old?.position ?? stored
      return { id: material.id, type: 'material', position, data: { material, index, connecting: tool === 'connect' } }
    }))
  }, [ordered, tool, setNodes])

  useEffect(() => {
    const visible = map.relations.filter((relation) => !relation.archived && (relation.createdBy !== 'ai' || showAi))
    setEdges(visible.map((relation): Edge => ({ id: relation.id, source: relation.sourceMaterialId, target: relation.targetMaterialId, sourceHandle: 'out-right', targetHandle: 'in-left', type: 'relation', data: {
      relation,
      save: async (id: string, label: string) => { await ipc.relation.update(id, label); await onRefresh() },
      style: async (id: string, input: Record<string, unknown>) => { await ipc.topic.relationStyle(map.topic.id, id, input as never); await onRefresh() },
      remove: async (id: string) => { await ipc.relation.remove(id); await onRefresh() }
    } })))
  }, [map.relations, showAi, map.topic.id, onRefresh, setEdges])

  const { validate: validConnection, create: connect } = useTopicConnections(map.relations, onRefresh, setNotice)
  const addCard = async (position: { x: number; y: number }): Promise<void> => {
    const material = await ipc.material.createNote('未命名卡片', ''); await ipc.topic.addMaterial(map.topic.id, (material as Material).id); await ipc.topic.position(map.topic.id, (material as Material).id, position.x, position.y); await onRefresh(); onSelect(material as Material)
  }
  const pasteCard = async (position: { x: number; y: number }, supplied?: string): Promise<void> => {
    const text = supplied ?? await window.materialMap.clipboard.readText(); if (!text.trim()) { setNotice('剪贴板中没有可用文本。'); return }
    const title = text.trim().split(/\r?\n/, 1)[0].slice(0, 48) || '剪贴板笔记'
    const material = await ipc.material.createNote(title, text); await ipc.topic.addMaterial(map.topic.id, (material as Material).id); await ipc.topic.position(map.topic.id, (material as Material).id, position.x, position.y); await onRefresh(); setNotice('已从剪贴板创建卡片。')
  }
  const addExisting = async (): Promise<void> => {
    if (!pickerPosition || !pickedIds.length) return
    for (const [index, id] of pickedIds.entries()) { await ipc.topic.addMaterial(map.topic.id, id); await ipc.topic.position(map.topic.id, id, pickerPosition.x + (index % 3) * 32, pickerPosition.y + Math.floor(index / 3) * 32) }
    setPickerPosition(null); setPickedIds([]); setPickerQuery(''); await onRefresh(); setNotice(`已加入 ${pickedIds.length} 份工作台材料。`)
  }
  const positions = (): Array<{ materialId: string; x: number; y: number }> => nodes.map((node) => ({ materialId: node.id, x: node.position.x, y: node.position.y }))
  const autoLayout = async (): Promise<void> => { setUndoPositions(positions()); setRedoPositions(null); const next = layoutTopic(nodes, edges); await ipc.topic.layout(map.topic.id, next); await onRefresh(); requestAnimationFrame(() => flow?.fitView({ padding: .18 })); setNotice(`已自动整理 ${nodes.length} 张卡片。`) }
  const applyPositions = async (next: Array<{ materialId: string; x: number; y: number }>, destination: 'undo' | 'redo'): Promise<void> => { const current = positions(); await ipc.topic.layout(map.topic.id, next); if (destination === 'undo') { setRedoPositions(current); setUndoPositions(null) } else { setUndoPositions(current); setRedoPositions(null) }; await onRefresh() }
  const removeNode = async (materialId: string): Promise<void> => { await ipc.topic.removeMaterial(map.topic.id, materialId); setMenu(null); await onRefresh(); setNotice('已从当前主题移出材料，工作台中的原材料未删除。') }
  const available = materials.filter((material) => !map.materials.some((member) => member.id === material.id) && `${material.title} ${material.type}`.toLowerCase().includes(pickerQuery.toLowerCase()))

  return <section className="topic-view"><div className="topic-toolbar"><div><span className="view-pill">主题画板</span><p>拖动端口连续建立关联；AI 建议不会阻止你的正式连接。</p></div><AiSuggestionPanel map={map} visible={showAi} onToggle={() => setShowAi((value) => !value)} onRefresh={onRefresh} onMessage={setNotice} /></div><DemoChecklist map={map} onReset={() => { if (window.confirm('重置学习路径演示？演示中的卡片位置和关系会恢复为标准流程。')) void window.materialMap.demo.create().then(onRefresh) }} />
    {notice && <div className="canvas-notice">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}
    <div className="whiteboard"><BoardToolbar tool={tool} showAi={showAi} onTool={setTool} onAdd={() => void addCard({ x: 180, y: 140 })} onImport={() => void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, { x: 180, y: 140 }))} onLayout={() => void autoLayout()} onFit={() => flow?.fitView({ padding: .18 })} onToggleAi={() => setShowAi((value) => !value)} onUndoLayout={() => undoPositions && void applyPositions(undoPositions, 'undo')} onRedoLayout={() => redoPositions && void applyPositions(redoPositions, 'redo')} canUndo={Boolean(undoPositions)} canRedo={Boolean(redoPositions)} />
      <div className="whiteboard-stage" onPaste={(event) => { const target = event.target; if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return; const text = event.clipboardData.getData('text/plain'); if (!text) return; event.preventDefault(); void pasteCard({ x: 160, y: 120 }, text) }}><div className="flow-map"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => void connect(connection)} isValidConnection={(connection) => !validConnection(connection)} onNodeClick={(_event, node) => { const material = map.materials.find((item) => item.id === node.id); if (material) onSelect(material) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: node.position, nodeId: node.id }) }} onNodeDragStop={(_event, node) => void ipc.topic.position(map.topic.id, node.id, node.position.x, node.position.y)} onPaneContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160, y: 120 } }) }} onPaneClick={() => setMenu(null)} onInit={(instance) => { setFlow(instance); if (!didFit.current) { didFit.current = true; requestAnimationFrame(() => instance.fitView({ padding: .18 })) } }} panOnDrag={tool === 'pan'} nodesDraggable={tool === 'select'} connectOnClick={false}>
        <Background gap={20} /><MiniMap pannable zoomable /><Controls showInteractive={false} />
      </ReactFlow></div></div></div>
    {menu && <div className="canvas-menu" style={{ left: menu.x, top: menu.y }}>{menu.nodeId ? <><button onClick={() => { const material = map.materials.find((item) => item.id === menu.nodeId); if (material) onSelect(material); setMenu(null) }}>打开属性</button><button onClick={() => void removeNode(menu.nodeId!)}>移出当前主题</button></> : <><button onClick={() => { void addCard(menu.position); setMenu(null) }}>新建卡片</button><button onClick={() => { void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, menu.position)); setMenu(null) }}>导入文件到此处</button><button onClick={() => { setPickerPosition(menu.position); setMenu(null) }}>从工作台添加</button><button onClick={() => { void pasteCard(menu.position); setMenu(null) }}>粘贴文本为卡片</button></>}</div>}
    {pickerPosition && <div className="board-material-picker"><header><strong>从工作台添加</strong><button onClick={() => setPickerPosition(null)}>关闭</button></header><input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="搜索材料" /> <div>{available.map((material) => <label key={material.id}><input type="checkbox" checked={pickedIds.includes(material.id)} onChange={() => setPickedIds((ids) => ids.includes(material.id) ? ids.filter((id) => id !== material.id) : [...ids, material.id])} /><span className={`picker-type ${material.type}`}>{material.type}</span>{material.title}</label>)}</div><button className="primary-button" disabled={!pickedIds.length} onClick={() => void addExisting()}>加入 {pickedIds.length || ''} 份材料</button></div>}
  </section>
}
