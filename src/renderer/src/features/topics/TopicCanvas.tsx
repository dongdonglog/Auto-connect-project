import { Background, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Material, Relation, TopicMap } from '../../types'
import { layoutTopic } from '../../lib/topic-layout'
import { BoardToolbar } from './BoardToolbar'
import { MaterialNode, type MaterialNodeData } from './MaterialNode'
import { RelationEdge } from './RelationEdge'
import { ipc } from '../../lib/ipc'
import { useTopicConnections } from './useTopicConnections'
import { DemoChecklist } from './DemoChecklist'
import { stableTopicOrder } from '../../../../shared/topic-topology'
import './topic-canvas.css'

type Menu = { x: number; y: number; position: { x: number; y: number }; nodeId?: string } | null
const nodeTypes = { material: MaterialNode }
const edgeTypes = { relation: RelationEdge }

const isSame = (left: { x: number; y: number }, right: { x: number; y: number }): boolean => left.x === right.x && left.y === right.y

/** React Flow container only: no page loading, dialogs, or unrelated application state. */
export function TopicCanvas({ map, materials, onRefresh, onSelect, onImportFiles }: { map: TopicMap; materials: Material[]; onRefresh(): Promise<void>; onSelect(material: Material): void; onImportFiles(paths: string[], position: { x: number; y: number }): Promise<void> }): React.ReactElement {
  const [viewMode, setViewMode] = useState<'map' | 'flow'>('map'); const [notice, setNotice] = useState(''); const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null); const [menu, setMenu] = useState<Menu>(null); const [pickerPosition, setPickerPosition] = useState<{ x: number; y: number } | null>(null); const [pickerQuery, setPickerQuery] = useState(''); const [pickedIds, setPickedIds] = useState<string[]>([]); const [undoPositions, setUndoPositions] = useState<Array<{ materialId: string; x: number; y: number }> | null>(null); const [redoPositions, setRedoPositions] = useState<Array<{ materialId: string; x: number; y: number }> | null>(null); const [flow, setFlow] = useState<ReactFlowInstance<Node<MaterialNodeData>, Edge> | null>(null)
  const didFit = useRef(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<MaterialNodeData>>([]); const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const ordered = useMemo(() => stableTopicOrder(map.materials.map((material) => ({ ...material, occurredAt: material.occurredAt ?? null, importedAt: material.importedAt ?? '', sequence: material.sequence ?? null, sequenceSource: material.sequenceSource ?? 'time', addedAt: material.addedAt ?? null }))), [map.materials])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3000); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => { const handler = (event: Event) => setViewMode((event as CustomEvent<'map' | 'flow'>).detail); window.addEventListener('material-map:view-mode', handler); return () => window.removeEventListener('material-map:view-mode', handler) }, [])

  // Merge server data by material id. Existing drag positions are authoritative
  // until the drag-end persistence call confirms them in the next map refresh.
  useEffect(() => {
    setNodes((current) => ordered.map((material, index) => {
      const old = current.find((node) => node.id === material.id); const stored = { x: material.canvasX ?? 120 + (index % 4) * 270, y: material.canvasY ?? 100 + Math.floor(index / 4) * 180 }
      const position = old && !isSame(old.position, stored) ? old.position : old?.position ?? stored
      return { id: material.id, type: 'material', position, data: { material, index, connecting: true } }
    }))
  }, [ordered, setNodes])

  useEffect(() => {
    const visible = map.relations.filter((relation) => !relation.archived && (viewMode === 'map' || ['next', 'depends_on', 'blocks', 'implements', 'tests'].includes(relation.relationType)))
    // 同一对材料（不分方向）之间的多条连线需要岔开：按创建时间稳定排序后分配平行序号。
    const pairGroups = new Map<string, Relation[]>()
    for (const relation of visible) {
      const key = [relation.sourceMaterialId, relation.targetMaterialId].sort().join('::')
      pairGroups.set(key, [...(pairGroups.get(key) ?? []), relation])
    }
    const parallelOf = new Map<string, { index: number; count: number }>()
    for (const group of pairGroups.values()) {
      const sorted = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      sorted.forEach((relation, index) => parallelOf.set(relation.id, { index, count: sorted.length }))
    }
    setEdges(visible.map((relation): Edge => ({ id: relation.id, source: relation.sourceMaterialId, target: relation.targetMaterialId, sourceHandle: relation.sourceHandle ?? 'out-right', targetHandle: relation.targetHandle ?? 'in-left', type: 'relation', data: {
      relation,
      parallel: parallelOf.get(relation.id) ?? { index: 0, count: 1 },
      select: setSelectedRelationId,
      remove: async (id: string) => { await ipc.relation.remove(id); await onRefresh() }
    } })))
  }, [map.relations, viewMode, onRefresh, setEdges])

  useEffect(() => {
    if (viewMode !== 'flow') return
    const flowEdges = edges.filter((edge) => map.relations.some((relation) => relation.id === edge.id && ['next', 'depends_on', 'blocks', 'implements', 'tests'].includes(relation.relationType)))
    const positions = layoutTopic(nodes, flowEdges)
    setNodes((current) => current.map((node) => { const next = positions.find((position) => position.materialId === node.id); return next ? { ...node, position: { x: next.x, y: next.y } } : node }))
  }, [viewMode])

  const { validate: validConnection, create: connect } = useTopicConnections(map.topic.id, map.relations, onRefresh, setNotice)
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
    await window.materialMap.topics.addMaterials(map.topic.id, pickedIds)
    setPickerPosition(null); setPickedIds([]); setPickerQuery(''); await onRefresh(); setNotice(`已加入 ${pickedIds.length} 份工作台材料。`)
  }
  const positions = (): Array<{ materialId: string; x: number; y: number }> => nodes.map((node) => ({ materialId: node.id, x: node.position.x, y: node.position.y }))
  const autoLayout = async (): Promise<void> => { setUndoPositions(positions()); setRedoPositions(null); const next = layoutTopic(nodes, edges); await ipc.topic.layout(map.topic.id, next); await onRefresh(); requestAnimationFrame(() => flow?.fitView({ padding: .18 })); setNotice(`已按当前关系整理 ${nodes.length} 张卡片。`) }
  const applyPositions = async (next: Array<{ materialId: string; x: number; y: number }>, destination: 'undo' | 'redo'): Promise<void> => { const current = positions(); await ipc.topic.layout(map.topic.id, next); if (destination === 'undo') { setRedoPositions(current); setUndoPositions(null) } else { setUndoPositions(current); setRedoPositions(null) }; await onRefresh() }
  const removeNode = async (materialId: string): Promise<void> => { await ipc.topic.removeMaterial(map.topic.id, materialId); setMenu(null); await onRefresh(); setNotice('已从当前主题移出材料，工作台中的原材料未删除。') }
  const available = materials.filter((material) => !map.materials.some((member) => member.id === material.id) && `${material.title} ${material.type}`.toLowerCase().includes(pickerQuery.toLowerCase()))
  const selectedRelation = map.relations.find((relation) => relation.id === selectedRelationId) ?? null
  const updateRelation = async (input: Record<string, unknown>): Promise<void> => { if (!selectedRelation) return; await ipc.topic.relationStyle(map.topic.id, selectedRelation.id, input as never); await onRefresh() }

  return <section className="topic-view"><div className="topic-toolbar"><div><span className="view-pill">主题画板</span><p>直接拖动卡片、拖空白平移、从卡片边缘端口拉线即可连线（Shift+拖拽框选）；本地发现的关联请先在“探索”中查看证据并固定。</p></div></div><DemoChecklist map={map} onReset={() => { if (window.confirm('重置学习路径演示？演示中的卡片位置和关系会恢复为标准流程。')) void window.materialMap.demo.create().then(onRefresh) }} />
    {notice && <div className="canvas-notice">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}
    <div className="whiteboard"><BoardToolbar onAdd={() => void addCard({ x: 180, y: 140 })} onImport={() => void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, { x: 180, y: 140 }))} onLayout={() => void autoLayout()} onFit={() => flow?.fitView({ padding: .18 })} onUndoLayout={() => undoPositions && void applyPositions(undoPositions, 'undo')} onRedoLayout={() => redoPositions && void applyPositions(redoPositions, 'redo')} canUndo={Boolean(undoPositions)} canRedo={Boolean(redoPositions)} />
      <div className="whiteboard-stage" onPaste={(event) => { const target = event.target; if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return; const text = event.clipboardData.getData('text/plain'); if (!text) return; event.preventDefault(); void pasteCard({ x: 160, y: 120 }, text) }}><div className="flow-map"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => void connect(connection)} isValidConnection={(connection) => !validConnection(connection)} onNodeClick={(_event, node) => { const material = map.materials.find((item) => item.id === node.id); if (material) onSelect(material) }} onNodeContextMenu={(event, node) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: node.position, nodeId: node.id }) }} onNodeDragStop={(_event, node) => void ipc.topic.position(map.topic.id, node.id, node.position.x, node.position.y)} onPaneContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160, y: 120 } }) }} onPaneClick={() => setMenu(null)} onInit={(instance) => { setFlow(instance); if (!didFit.current) { didFit.current = true; requestAnimationFrame(() => instance.fitView({ padding: .18 })) } }} panOnDrag nodesDraggable selectionKeyCode="Shift" multiSelectionKeyCode="Meta" connectOnClick={false}>
        <Background gap={20} /><MiniMap pannable zoomable /><Controls showInteractive={false} />
      </ReactFlow></div></div><RelationInspector relation={selectedRelation} materials={map.materials} onClose={() => setSelectedRelationId(null)} onUpdate={updateRelation} onRename={async (label) => { if (selectedRelation) { await ipc.relation.update(selectedRelation.id, label); await onRefresh() } }} onDelete={async () => { if (selectedRelation) { await ipc.relation.remove(selectedRelation.id); setSelectedRelationId(null); await onRefresh() } }} /></div>
    {menu && <div className="canvas-menu" style={{ left: menu.x, top: menu.y }}>{menu.nodeId ? <><button onClick={() => { const material = map.materials.find((item) => item.id === menu.nodeId); if (material) onSelect(material); setMenu(null) }}>打开属性</button><button onClick={() => void removeNode(menu.nodeId!)}>移出当前主题</button></> : <><button onClick={() => { void addCard(menu.position); setMenu(null) }}>新建卡片</button><button onClick={() => { void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, menu.position)); setMenu(null) }}>导入文件到此处</button><button onClick={() => { setPickerPosition(menu.position); setMenu(null) }}>从工作台添加</button><button onClick={() => { void pasteCard(menu.position); setMenu(null) }}>粘贴文本为卡片</button></>}</div>}
    {pickerPosition && <div className="board-material-picker"><header><strong>从工作台添加</strong><button onClick={() => setPickerPosition(null)}>关闭</button></header><input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="搜索材料" /> <div>{available.map((material) => <label key={material.id}><input type="checkbox" checked={pickedIds.includes(material.id)} onChange={() => setPickedIds((ids) => ids.includes(material.id) ? ids.filter((id) => id !== material.id) : [...ids, material.id])} /><span className={`picker-type ${material.type}`}>{material.type}</span>{material.title}</label>)}</div><button className="primary-button" disabled={!pickedIds.length} onClick={() => void addExisting()}>加入 {pickedIds.length || ''} 份材料</button></div>}
  </section>
}

function RelationInspector({ relation, materials, onClose, onUpdate, onRename, onDelete }: { relation: Relation | null; materials: TopicMap['materials']; onClose(): void; onUpdate(input: Record<string, unknown>): Promise<void>; onRename(label: string): Promise<void>; onDelete(): Promise<void> }): React.ReactElement {
  const [label, setLabel] = useState('')
  useEffect(() => setLabel(relation?.label ?? ''), [relation?.id, relation?.label])
  const title = (id: string): string => materials.find((material) => material.id === id)?.title ?? '未知材料'
  return <aside className="whiteboard-inspector">{relation ? <><header><h3>关系属性</h3><button className="icon-button" title="关闭" onClick={onClose}>×</button></header><p>{title(relation.sourceMaterialId)} → {title(relation.targetMaterialId)}</p><label>关系名称<input value={label} onChange={(event) => setLabel(event.target.value)} onBlur={() => label.trim() && void onRename(label.trim())}/></label><label>关系类型<select value={['关联', '前提', '依赖', '佐证', '实现', '验证'].includes(relation.label) ? relation.label : '自定义'} onChange={(event) => event.target.value !== '自定义' && void onRename(event.target.value)}><option value="关联">关联</option><option value="前提">前提</option><option value="依赖">依赖</option><option value="佐证">佐证</option><option value="实现">实现</option><option value="验证">验证</option><option value="自定义">自定义</option></select></label><label>路径<select value={relation.lineKind ?? 'auto'} onChange={(event) => void onUpdate({ lineKind: event.target.value })}><option value="auto">智能路径</option><option value="straight">直线</option><option value="bezier">曲线</option><option value="orthogonal">折线</option></select></label><label>颜色<input type="color" value={relation.lineColor ?? '#08776f'} onChange={(event) => void onUpdate({ color: event.target.value })}/></label><label>起点箭头<select value={relation.sourceArrowStyle ?? (relation.createdBy === 'manual' ? 'triangle' : 'none')} onChange={(event) => void onUpdate({ sourceArrowStyle: event.target.value })}><option value="none">无箭头</option><option value="triangle">实心箭头</option><option value="open-triangle">空心箭头</option><option value="diamond">菱形</option></select></label><label>终点箭头<select value={relation.targetArrowStyle ?? 'triangle'} onChange={(event) => void onUpdate({ targetArrowStyle: event.target.value })}><option value="none">无箭头</option><option value="triangle">实心箭头</option><option value="open-triangle">空心箭头</option><option value="diamond">菱形</option></select></label><button className="secondary-button" onClick={() => void onUpdate({ animated: relation.animated === false })}>{relation.animated === false ? '开启动画' : '关闭动画'}</button><button className="danger-button" onClick={() => void onDelete()}>删除关系</button></> : <><h3>关系属性</h3><p>点击一条连线后，可在这里修改名称、类型和样式。</p></>}</aside>
}
