import { Background, Controls, MiniMap, ReactFlow, SelectionMode, useEdgesState, useNodesState, type Connection, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Material, Relation, TopicMap } from '../../types'
import { layoutTopic } from '../../lib/topic-layout'
import { BoardToolbar } from './BoardToolbar'
import { MaterialNode, type MaterialNodeData } from './MaterialNode'
import { RelationEdge } from './RelationEdge'
import { ipc } from '../../lib/ipc'
import { useTopicConnections } from './useTopicConnections'
import { DemoChecklist } from './DemoChecklist'
import { stableTopicOrder } from '../../../../shared/topic-topology'
import type { Point, Rect } from '../../lib/topic-edge-routing'
import './topic-canvas.css'

type Menu = { x: number; y: number; position: Point; nodeIds: string[]; edgeIds: string[] } | null
type EditorCommand = { kind: string; payload: Record<string, unknown> }
const nodeTypes = { material: MaterialNode }
const edgeTypes = { relation: RelationEdge }

const sameIds = (left: string[], right: string[]): boolean => left.length === right.length && left.every((id, index) => id === right[index])
const inputTarget = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
const handleSide = (handle: string | null | undefined, fallback: 'left' | 'top' | 'right' | 'bottom'): 'left' | 'top' | 'right' | 'bottom' => {
  const side = handle?.match(/(?:in|out)-(left|top|right|bottom)$/)?.[1]
  return side === 'left' || side === 'top' || side === 'right' || side === 'bottom' ? side : fallback
}
const outputHandle = (handle: string | null | undefined, fallback: 'left' | 'top' | 'right' | 'bottom'): string => `out-${handleSide(handle, fallback)}`
const inputHandle = (handle: string | null | undefined, fallback: 'left' | 'top' | 'right' | 'bottom'): string => `in-${handleSide(handle, fallback)}`
const cardColorForType = (type: string): string => type === 'file' ? '#3568b8' : type === 'document' ? '#7654a6' : type === 'link' ? '#a14569' : '#b26a21'

export function TopicCanvas({ map, materials, onRefresh, onImportFiles }: { map: TopicMap; materials: Material[]; onRefresh(): Promise<void>; onImportFiles(paths: string[], position: Point): Promise<void> }): React.ReactElement {
  const [viewMode, setViewMode] = useState<'map' | 'flow'>('map')
  const [notice, setNotice] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu>(null)
  const [pickerPosition, setPickerPosition] = useState<Point | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [flow, setFlow] = useState<ReactFlowInstance<Node<MaterialNodeData>, Edge> | null>(null)
  const didFit = useRef(false)
  const commandTail = useRef(Promise.resolve())
  const deleteSelectionRef = useRef<(nodeIds: string[], edgeIds: string[]) => void>(() => undefined)
  const selectionRef = useRef<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] })
  const contextSelectionRef = useRef<{ nodeIds: string[]; edgeIds: string[] } | null>(null)
  const programmaticSelectionRef = useRef(0)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<MaterialNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const ordered = useMemo(() => stableTopicOrder(map.materials.map((material) => ({ ...material, occurredAt: material.occurredAt ?? null, importedAt: material.importedAt ?? '', sequence: material.sequence ?? null, sequenceSource: material.sequenceSource ?? 'time', addedAt: material.addedAt ?? null }))), [map.materials])

  const setSelection = useCallback((nodeIds: string[], edgeIds: string[]): void => {
    if (sameIds(selectionRef.current.nodeIds, nodeIds) && sameIds(selectionRef.current.edgeIds, edgeIds)) return
    selectionRef.current = { nodeIds, edgeIds }
    setSelectedCardId(nodeIds.length === 1 && edgeIds.length === 0 ? nodeIds[0] : null)
    setSelectedRelationId(nodeIds.length === 0 && edgeIds.length === 1 ? edgeIds[0] : null)
  }, [])
  const applySelection = useCallback((nodeIds: string[], edgeIds: string[]): void => {
    const generation = ++programmaticSelectionRef.current
    setSelection(nodeIds, edgeIds)
    setNodes((current) => current.map((node) => node.selected === nodeIds.includes(node.id) ? node : { ...node, selected: nodeIds.includes(node.id) }))
    setEdges((current) => current.map((edge) => edge.selected === edgeIds.includes(edge.id) ? edge : { ...edge, selected: edgeIds.includes(edge.id) }))
    requestAnimationFrame(() => {
      if (programmaticSelectionRef.current === generation) programmaticSelectionRef.current = 0
    })
  }, [setEdges, setNodes, setSelection])
  const runCommand = useCallback(async (command: EditorCommand): Promise<void> => {
    const execute = commandTail.current.catch(() => undefined).then(async () => {
      await ipc.topic.command(map.topic.id, command)
      await onRefresh()
    })
    commandTail.current = execute
    try { await execute } catch (error) { setNotice(error instanceof Error ? error.message : '无法保存画板编辑。'); throw error }
  }, [map.topic.id, onRefresh])
  const { validate: validConnection, create: connect } = useTopicConnections(map.topic.id, map.relations, onRefresh, setNotice, runCommand)
  const reconnect = useCallback((oldEdge: Edge, connection: Connection): void => {
    const relation = map.relations.find((item) => item.id === oldEdge.id)
    if (!relation || !connection.source || !connection.target) { setNotice('请将关系端点连接到有效的卡片端口。'); return }
    const sourceHandle = connection.sourceHandle ?? oldEdge.sourceHandle ?? relation.sourceHandle ?? 'out-right'
    const targetHandle = connection.targetHandle ?? oldEdge.targetHandle ?? relation.targetHandle ?? 'in-left'
    const sameEndpoints = oldEdge.source === connection.source && oldEdge.target === connection.target
    if (!sameEndpoints) {
      const error = validConnection({ source: connection.source, target: connection.target })
      if (error) { setNotice(error); return }
    }
    void runCommand({ kind: 'reconnectRelation', payload: { relationId: relation.id, sourceMaterialId: connection.source, targetMaterialId: connection.target, sourceHandle, targetHandle } })
  }, [map.relations, runCommand, setNotice, validConnection])
  const undo = useCallback(() => { void (async () => { try { await ipc.topic.undo(map.topic.id); await onRefresh() } catch (error) { setNotice(error instanceof Error ? error.message : '无法撤销。') } })() }, [map.topic.id, onRefresh])
  const redo = useCallback(() => { void (async () => { try { await ipc.topic.redo(map.topic.id); await onRefresh() } catch (error) { setNotice(error instanceof Error ? error.message : '无法重做。') } })() }, [map.topic.id, onRefresh])

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3000); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => { const handler = (event: Event) => setViewMode((event as CustomEvent<'map' | 'flow'>).detail); window.addEventListener('material-map:view-mode', handler); return () => window.removeEventListener('material-map:view-mode', handler) }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (inputTarget(event.target)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if ((event.key === 'Backspace' || event.key === 'Delete') && (selectionRef.current.nodeIds.length || selectionRef.current.edgeIds.length)) { event.preventDefault(); deleteSelectionRef.current(selectionRef.current.nodeIds, selectionRef.current.edgeIds) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  // deleteSelection is deliberately called through the current render closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo])

  useEffect(() => {
    setNodes((current) => ordered.map((material, index) => {
      const stored = { x: material.canvasX ?? 120 + (index % 4) * 340, y: material.canvasY ?? 100 + Math.floor(index / 4) * 210 }
      // The server is refreshed only when an operation has committed. Its
      // position is therefore authoritative and makes undo/redo immediately
      // visible instead of preserving a stale local drag position.
      const position = stored
      return { id: material.id, type: 'material', position, selected: selectionRef.current.nodeIds.includes(material.id), style: { zIndex: material.cardZIndex ?? 0 }, data: {
        material, index, connecting: true,
        select: () => applySelection([material.id], []),
        context: (x: number, y: number) => {
          const captured = contextSelectionRef.current
          contextSelectionRef.current = null
          const nodeIds = captured?.nodeIds.includes(material.id) ? captured.nodeIds : selectionRef.current.nodeIds.includes(material.id) ? selectionRef.current.nodeIds : [material.id]
          const edgeIds = captured?.nodeIds.includes(material.id) ? captured.edgeIds : []
          applySelection(nodeIds, edgeIds)
          setMenu({ x, y, position, nodeIds, edgeIds })
        }
      } }
    }))
  }, [applySelection, ordered, setNodes])

  useEffect(() => {
    const visible = map.relations.filter((relation) => !relation.archived && (viewMode === 'map' || ['next', 'depends_on', 'blocks', 'implements', 'tests'].includes(relation.relationType)))
    const pairGroups = new Map<string, Relation[]>()
    for (const relation of visible) { const key = [relation.sourceMaterialId, relation.targetMaterialId].sort().join('::'); pairGroups.set(key, [...(pairGroups.get(key) ?? []), relation]) }
    const parallelOf = new Map<string, { index: number; count: number }>()
    for (const group of pairGroups.values()) [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).forEach((relation, index) => parallelOf.set(relation.id, { index, count: group.length }))
    const cardBounds = new Map(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y, width: node.measured?.width ?? (node.data.material.cardWidth ?? 220), height: node.measured?.height ?? (node.data.material.cardHeight ?? 116) }]))
    setEdges(visible.map((relation): Edge => ({ id: relation.id, source: relation.sourceMaterialId, target: relation.targetMaterialId, sourceHandle: relation.sourceHandle ?? 'out-right', targetHandle: relation.targetHandle ?? 'in-left', type: 'relation', selected: selectionRef.current.edgeIds.includes(relation.id), data: {
      relation,
      parallel: parallelOf.get(relation.id) ?? { index: 0, count: 1 },
      obstacles: [...cardBounds.entries()].filter(([id]) => id !== relation.sourceMaterialId && id !== relation.targetMaterialId).map(([, rect]) => rect),
      labelObstacles: [...cardBounds.values()],
      select: (id: string) => applySelection([], [id]),
      reconnect: (id: string, endpoint: 'source' | 'target', nodeId: string, handleId: string) => {
        const relation = map.relations.find((item) => item.id === id)
        if (!relation) return
        const oldEdge = { id, source: relation.sourceMaterialId, target: relation.targetMaterialId, sourceHandle: relation.sourceHandle ?? 'out-right', targetHandle: relation.targetHandle ?? 'in-left' } as Edge
        const connection: Connection = endpoint === 'source'
          ? { source: nodeId, target: oldEdge.target, sourceHandle: handleId, targetHandle: oldEdge.targetHandle ?? null }
          : { source: oldEdge.source, target: nodeId, sourceHandle: oldEdge.sourceHandle ?? null, targetHandle: handleId }
        reconnect(oldEdge, connection)
      },
      context: (id: string, x: number, y: number) => {
        const captured = contextSelectionRef.current
        contextSelectionRef.current = null
        const edgeIds = captured?.edgeIds.includes(id) ? captured.edgeIds : selectionRef.current.edgeIds.includes(id) ? selectionRef.current.edgeIds : [id]
        const nodeIds = captured?.edgeIds.includes(id) ? captured.nodeIds : []
        applySelection(nodeIds, edgeIds)
        setMenu({ x, y, position: { x: 0, y: 0 }, nodeIds, edgeIds })
      },
      toFlow: (point: Point) => flow?.screenToFlowPosition(point) ?? point,
      updateWaypoints: (id: string, routePoints: Point[]) => { void runCommand({ kind: 'patchRelationStyle', payload: { relationId: id, patch: { routePoints } } }) }
    } })))
  }, [applySelection, flow, map.relations, nodes, reconnect, runCommand, setEdges, viewMode])

  useEffect(() => {
    if (viewMode === 'map') {
      const stored = new Map(ordered.map((material, index) => [material.id, { x: material.canvasX ?? 120 + (index % 4) * 340, y: material.canvasY ?? 100 + Math.floor(index / 4) * 210 }]))
      setNodes((current) => current.map((node) => ({ ...node, position: stored.get(node.id) ?? node.position })))
      return
    }
    const flowEdges = map.relations.filter((relation) => !relation.archived && ['next', 'depends_on', 'blocks', 'implements', 'tests'].includes(relation.relationType)).map((relation) => ({ id: relation.id, source: relation.sourceMaterialId, target: relation.targetMaterialId })) as Edge[]
    const baseNodes = ordered.map((material, index) => ({ id: material.id, position: { x: material.canvasX ?? 120 + (index % 4) * 340, y: material.canvasY ?? 100 + Math.floor(index / 4) * 210 }, data: {} })) as Node[]
    const nextPositions = new Map(layoutTopic(baseNodes, flowEdges).map((position) => [position.materialId, position]))
    setNodes((current) => current.map((node) => { const next = nextPositions.get(node.id); return next ? { ...node, position: { x: next.x, y: next.y } } : node }))
  }, [map.relations, ordered, setNodes, viewMode])

  const addCard = async (position: Point): Promise<void> => { const material = await ipc.material.createNote('未命名卡片', ''); await ipc.topic.addMaterial(map.topic.id, (material as Material).id); await ipc.topic.position(map.topic.id, (material as Material).id, position.x, position.y); await onRefresh() }
  const pasteCard = async (position: Point, supplied?: string): Promise<void> => { const text = supplied ?? await window.materialMap.clipboard.readText(); if (!text.trim()) { setNotice('剪贴板中没有可用文本。'); return }; const title = text.trim().split(/\r?\n/, 1)[0].slice(0, 48) || '剪贴板笔记'; const material = await ipc.material.createNote(title, text); await ipc.topic.addMaterial(map.topic.id, (material as Material).id); await ipc.topic.position(map.topic.id, (material as Material).id, position.x, position.y); await onRefresh(); setNotice('已从剪贴板创建卡片。') }
  const addExisting = async (): Promise<void> => { if (!pickerPosition || !pickedIds.length) return; await window.materialMap.topics.addMaterials(map.topic.id, pickedIds); setPickerPosition(null); setPickedIds([]); setPickerQuery(''); await onRefresh(); setNotice(`已加入 ${pickedIds.length} 份工作台材料。`) }
  const autoLayout = async (): Promise<void> => { const next = layoutTopic(nodes, edges); await runCommand({ kind: 'moveCards', payload: { positions: next } }); requestAnimationFrame(() => flow?.fitView({ padding: .18 })); setNotice(`已按当前关系整理 ${nodes.length} 张卡片。`) }
  const deleteSelection = async (nodeIds: string[], edgeIds: string[]): Promise<void> => {
    const removed = new Set(nodeIds)
    const detachedEdges = edgeIds.filter((id) => { const edge = edges.find((item) => item.id === id); return edge && !removed.has(edge.source) && !removed.has(edge.target) })
    try {
      await runCommand({ kind: 'deleteSelection', payload: { materialIds: nodeIds, relationIds: detachedEdges } })
      setSelection([], []); setMenu(null)
      if (nodeIds.length || detachedEdges.length) setNotice(nodeIds.length ? `已从当前主题移出 ${nodeIds.length} 张卡片。` : `已删除 ${detachedEdges.length} 条正式关系。`)
    } catch { /* runCommand has already shown the error. */ }
  }
  deleteSelectionRef.current = (nodeIds, edgeIds) => { void deleteSelection(nodeIds, edgeIds) }
  const domSelection = (): { nodeIds: string[]; edgeIds: string[] } => {
    const nodeIds = [...document.querySelectorAll<HTMLElement>('.react-flow__node.selected')]
      .map((element) => element.dataset.id)
      .filter((id): id is string => Boolean(id))
    const edgeIds = [...document.querySelectorAll<HTMLElement>('.react-flow__edge.selected')]
      .map((element) => element.dataset.id)
      .filter((id): id is string => Boolean(id))
    return { nodeIds, edgeIds }
  }
  const activeSelection = (): { nodeIds: string[]; edgeIds: string[] } => {
    const dom = domSelection()
    return dom.nodeIds.length || dom.edgeIds.length ? dom : selectionRef.current
  }
  const selectionContains = (x: number, y: number, selection = activeSelection()): boolean => {
    const ids = [...selection.nodeIds, ...selection.edgeIds]
    const rects = ids.flatMap((id) => { const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"], .react-flow__edge[data-id="${id}"]`); return element ? [element.getBoundingClientRect()] : [] })
    if (!rects.length) return false
    const left = Math.min(...rects.map((rect) => rect.left)); const right = Math.max(...rects.map((rect) => rect.right)); const top = Math.min(...rects.map((rect) => rect.top)); const bottom = Math.max(...rects.map((rect) => rect.bottom))
    return x >= left && x <= right && y >= top && y <= bottom
  }
  const captureContextSelection = (event: ReactPointerEvent): void => {
    if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
    const selection = activeSelection()
    contextSelectionRef.current = selectionContains(event.clientX, event.clientY, selection)
      ? { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] }
      : null
  }
  const takeContextSelection = (): { nodeIds: string[]; edgeIds: string[] } | null => {
    const selection = contextSelectionRef.current
    contextSelectionRef.current = null
    return selection
  }
  const openPaneMenu = (event: MouseEvent | ReactMouseEvent): void => {
    event.preventDefault()
    const position = flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160, y: 120 }
    const selection = takeContextSelection() ?? (selectionContains(event.clientX, event.clientY) ? activeSelection() : { nodeIds: [], edgeIds: [] })
    setMenu({ x: event.clientX, y: event.clientY, position, ...selection })
  }
  const openSelectionMenu = (event: ReactMouseEvent, selectedNodes: Node<MaterialNodeData>[]): void => {
    event.preventDefault(); event.stopPropagation()
    const captured = takeContextSelection()
    const current = activeSelection()
    const nodeIds = captured?.nodeIds ?? (current.nodeIds.length || current.edgeIds.length ? current.nodeIds : selectedNodes.map((node) => node.id))
    const edgeIds = captured?.edgeIds ?? current.edgeIds
    setSelection(nodeIds, edgeIds)
    setMenu({ x: event.clientX, y: event.clientY, position: flow?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 160, y: 120 }, nodeIds, edgeIds })
  }
  const available = materials.filter((material) => !map.materials.some((member) => member.id === material.id) && `${material.title} ${material.type}`.toLowerCase().includes(pickerQuery.toLowerCase()))
  const selectedCard = map.materials.find((material) => material.id === selectedCardId) ?? null
  const selectedRelation = map.relations.find((relation) => relation.id === selectedRelationId) ?? null
  const history = map.history ?? { undo: false, redo: false, cursor: 0 }

  return <section className="topic-view"><div className="topic-toolbar"><div><span className="view-pill">主题画板</span><p>材料与正式关系在当前主题内独立排版和编辑。</p></div></div><DemoChecklist map={map} onReset={() => { if (window.confirm('重置学习路径演示？演示中的卡片位置和关系会恢复为标准流程。')) void window.materialMap.demo.create().then(onRefresh) }} />
    {notice && <div className="canvas-notice">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}
    <div className="whiteboard"><BoardToolbar onAdd={() => void addCard({ x: 180, y: 140 })} onImport={() => void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, { x: 180, y: 140 }))} onLayout={() => void autoLayout()} onFit={() => flow?.fitView({ padding: .18 })} onUndo={undo} onRedo={redo} canUndo={history.undo} canRedo={history.redo} />
      <div className="whiteboard-stage" tabIndex={0} onPointerDownCapture={captureContextSelection} onPaste={(event) => { if (inputTarget(event.target)) return; const text = event.clipboardData.getData('text/plain'); if (!text) return; event.preventDefault(); void pasteCard({ x: 160, y: 120 }, text) }}><div className="flow-map"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => { if (!programmaticSelectionRef.current) setSelection(selectedNodes.map((node) => node.id), selectedEdges.map((edge) => edge.id)) }} onSelectionContextMenu={openSelectionMenu} onConnect={(connection) => void connect(connection)} isValidConnection={(connection) => !validConnection(connection)} onNodeClick={(_event, node) => applySelection([node.id], [])} onNodeContextMenu={(event, node) => { event.preventDefault(); const captured = takeContextSelection(); const current = activeSelection(); const nodeIds = captured?.nodeIds.includes(node.id) ? captured.nodeIds : current.nodeIds.includes(node.id) ? current.nodeIds : [node.id]; const edgeIds = captured?.nodeIds.includes(node.id) ? captured.edgeIds : []; applySelection(nodeIds, edgeIds); setMenu({ x: event.clientX, y: event.clientY, position: node.position, nodeIds, edgeIds }) }} onEdgeClick={(_event, edge) => applySelection([], [edge.id])} onEdgeContextMenu={(event, edge) => { event.preventDefault(); const captured = takeContextSelection(); const current = activeSelection(); const edgeIds = captured?.edgeIds.includes(edge.id) ? captured.edgeIds : current.edgeIds.includes(edge.id) ? current.edgeIds : [edge.id]; const nodeIds = captured?.edgeIds.includes(edge.id) ? captured.nodeIds : []; applySelection(nodeIds, edgeIds); setMenu({ x: event.clientX, y: event.clientY, position: { x: 0, y: 0 }, nodeIds, edgeIds }) }} onNodeDragStop={(_event, node) => { const selected = activeSelection().nodeIds.includes(node.id) ? nodes.filter((item) => activeSelection().nodeIds.includes(item.id)) : [node]; void runCommand({ kind: 'moveCards', payload: { positions: selected.map((item) => ({ materialId: item.id, x: item.position.x, y: item.position.y })) } }) }} onPaneContextMenu={openPaneMenu} onPaneClick={() => { applySelection([], []); setMenu(null) }} onInit={(instance) => { setFlow(instance); if (!didFit.current) { didFit.current = true; requestAnimationFrame(() => instance.fitView({ padding: .18 })) } }} panOnDrag={[2]} panActivationKeyCode="Space" panOnScroll selectionOnDrag selectionMode={SelectionMode.Partial} selectionKeyCode={null} deleteKeyCode={null} multiSelectionKeyCode={["Meta", "Control"]} connectOnClick={false}>
        <Background gap={20} /><MiniMap pannable zoomable /><Controls showInteractive={false} />
      </ReactFlow></div></div>
      {selectedCard && <CardInspector material={selectedCard} onClose={() => { applySelection([], []); setMenu(null) }} onPatchCard={(materialId, patch) => void runCommand({ kind: 'patchCard', payload: { materialId, patch } })} onDeleteCard={(materialId) => void deleteSelection([materialId], [])} />}
      {selectedRelation && <EditorInspector relation={selectedRelation} materials={map.materials} onClose={() => { applySelection([], []); setMenu(null) }} onRenameRelation={(relationId, label) => void runCommand({ kind: 'renameRelation', payload: { relationId, label } })} onPatchRelation={(relationId, patch) => void runCommand({ kind: 'patchRelationStyle', payload: { relationId, patch } })} onReverseRelation={(relation) => void runCommand({ kind: 'reconnectRelation', payload: { relationId: relation.id, sourceMaterialId: relation.targetMaterialId, targetMaterialId: relation.sourceMaterialId, sourceHandle: outputHandle(relation.targetHandle, 'left'), targetHandle: inputHandle(relation.sourceHandle, 'right') } })} onDeleteRelation={(relationId) => void deleteSelection([], [relationId])} />}
    </div>
    {menu && <div className="canvas-menu" style={{ left: menu.x, top: menu.y }}>{menu.nodeIds.length || menu.edgeIds.length ? <>{menu.edgeIds.length === 1 && !menu.nodeIds.length && <button onClick={() => { applySelection([], menu.edgeIds); setMenu(null) }}>打开关系属性</button>}<button className="danger" onClick={() => void deleteSelection(menu.nodeIds, menu.edgeIds)}>删除所选内容</button></> : <><button onClick={() => { void addCard(menu.position); setMenu(null) }}>新建卡片</button><button onClick={() => { void ipc.material.chooseFiles().then((paths: string[]) => onImportFiles(paths, menu.position)); setMenu(null) }}>导入文件到此处</button><button onClick={() => { setPickerPosition(menu.position); setMenu(null) }}>从工作台添加</button><button onClick={() => { void pasteCard(menu.position); setMenu(null) }}>粘贴文本为卡片</button></>}</div>}
    {pickerPosition && <div className="board-material-picker"><header><strong>从工作台添加</strong><button onClick={() => setPickerPosition(null)}>关闭</button></header><input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="搜索材料" /><div>{available.map((material) => <label key={material.id}><input type="checkbox" checked={pickedIds.includes(material.id)} onChange={() => setPickedIds((ids) => ids.includes(material.id) ? ids.filter((id) => id !== material.id) : [...ids, material.id])} /><span className={`picker-type ${material.type}`}>{material.type}</span>{material.title}</label>)}</div><button className="primary-button" disabled={!pickedIds.length} onClick={() => void addExisting()}>加入 {pickedIds.length || ''} 份材料</button></div>}
  </section>
}

function CardInspector({ material, onClose, onPatchCard, onDeleteCard }: { material: TopicMap['materials'][number]; onClose(): void; onPatchCard(materialId: string, patch: Record<string, unknown>): void; onDeleteCard(materialId: string): void }): React.ReactElement {
  const baseExcerpt = material.excerpt ?? ''
  const [title, setTitle] = useState(material.displayTitle ?? material.title)
  const [excerpt, setExcerpt] = useState(material.displayExcerpt ?? baseExcerpt)
  const [tags, setTags] = useState((material.cardTags ?? []).join(', '))
  const [note, setNote] = useState(material.cardNote ?? '')
  useEffect(() => { setTitle(material.displayTitle ?? material.title) }, [material.id, material.displayTitle, material.title])
  useEffect(() => { setExcerpt(material.displayExcerpt ?? baseExcerpt) }, [baseExcerpt, material.displayExcerpt, material.id])
  useEffect(() => { setTags((material.cardTags ?? []).join(', ')) }, [material.cardTags, material.id])
  useEffect(() => { setNote(material.cardNote ?? '') }, [material.cardNote, material.id])
  const commitTitle = (): void => {
    const next = title.trim()
    const override = !next || next === material.title ? null : next
    if (override !== (material.displayTitle ?? null)) onPatchCard(material.id, { displayTitle: override })
  }
  const commitExcerpt = (): void => {
    const next = excerpt.trim()
    const override = !next || next === baseExcerpt.trim() ? null : next
    if (override !== (material.displayExcerpt ?? null)) onPatchCard(material.id, { displayExcerpt: override })
  }
  const commitTags = (): void => {
    const next = [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
    if (JSON.stringify(next) !== JSON.stringify(material.cardTags ?? [])) onPatchCard(material.id, { tags: next })
  }
  const commitNote = (): void => {
    const next = note.trim() || null
    if (next !== (material.cardNote ?? null)) onPatchCard(material.id, { note: next })
  }
  const reset = (): void => onPatchCard(material.id, { displayTitle: null, displayExcerpt: null, width: null, height: null, color: null, textColor: null, fontSize: null, collapsed: false, zIndex: 0, tags: [], note: null })
  return <aside className="whiteboard-inspector card-inspector">
    <header><h3>画板卡片属性</h3><button className="icon-button" title="关闭" onClick={onClose}>×</button></header>
    <p>{material.title}</p>
    <label>显示标题<input aria-label="显示标题" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commitTitle} /></label>
    <label>显示摘要<textarea value={excerpt} onChange={(event) => setExcerpt(event.target.value)} onBlur={commitExcerpt} /></label>
    <div className="inspector-pair">
      <label>宽度<input key={`width:${material.id}:${material.cardWidth ?? 'default'}`} type="number" min="180" max="560" defaultValue={material.cardWidth ?? 220} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value !== (material.cardWidth ?? 220)) onPatchCard(material.id, { width: value }) }} /></label>
      <label>最小高度<input key={`height:${material.id}:${material.cardHeight ?? 'default'}`} type="number" min="96" max="420" defaultValue={material.cardHeight ?? 116} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value !== (material.cardHeight ?? 116)) onPatchCard(material.id, { height: value }) }} /></label>
    </div>
    <div className="inspector-pair">
      <label>卡片颜色<input type="color" value={material.cardColor ?? cardColorForType(material.type)} onChange={(event) => onPatchCard(material.id, { color: event.target.value })} /></label>
      <label>文字颜色<input type="color" value={material.cardTextColor ?? '#2d4058'} onChange={(event) => onPatchCard(material.id, { textColor: event.target.value })} /></label>
    </div>
    <div className="inspector-pair">
      <label>字号<input key={`font:${material.id}:${material.cardFontSize ?? 'default'}`} type="number" min="11" max="22" defaultValue={material.cardFontSize ?? 13} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value !== (material.cardFontSize ?? 13)) onPatchCard(material.id, { fontSize: value }) }} /></label>
      <label>层级<input key={`layer:${material.id}:${material.cardZIndex ?? 0}`} type="number" min="-100" max="100" defaultValue={material.cardZIndex ?? 0} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value !== (material.cardZIndex ?? 0)) onPatchCard(material.id, { zIndex: value }) }} /></label>
    </div>
    <label className="inspector-toggle"><input type="checkbox" checked={Boolean(material.cardCollapsed)} onChange={(event) => onPatchCard(material.id, { collapsed: event.target.checked })} />折叠摘要</label>
    <label>画板标签<input value={tags} onChange={(event) => setTags(event.target.value)} onBlur={commitTags} placeholder="用逗号分隔" /></label>
    <label>画板备注<textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={commitNote} /></label>
    <button className="secondary-button" onClick={reset}>恢复画板默认</button>
    <button className="danger-button" onClick={() => onDeleteCard(material.id)}>移出当前主题</button>
  </aside>
}

function EditorInspector({ relation, materials, onClose, onRenameRelation, onPatchRelation, onReverseRelation, onDeleteRelation }: { relation: Relation; materials: TopicMap['materials']; onClose(): void; onRenameRelation(relationId: string, label: string): void; onPatchRelation(relationId: string, patch: Record<string, unknown>): void; onReverseRelation(relation: Relation): void; onDeleteRelation(relationId: string): void }): React.ReactElement {
  const [relationLabel, setRelationLabel] = useState('')
  useEffect(() => { setRelationLabel(relation.label ?? '') }, [relation.id, relation.label])
  const title = (id: string): string => materials.find((material) => material.id === id)?.displayTitle ?? materials.find((material) => material.id === id)?.title ?? '未知材料'
  return <aside className="whiteboard-inspector"><header><h3>关系属性</h3><button className="icon-button" title="关闭" onClick={onClose}>×</button></header><p>{title(relation.sourceMaterialId)} → {title(relation.targetMaterialId)}</p><label>关系名称<input value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} onBlur={() => { const next = relationLabel.trim(); if (next !== relation.label) onRenameRelation(relation.id, next) }} /></label><div className="inspector-pair"><label>起点端口<select value={handleSide(relation.sourceHandle, 'right')} onChange={(event) => onPatchRelation(relation.id, { sourceHandle: `out-${event.target.value}` })}><option value="left">左侧</option><option value="top">上侧</option><option value="right">右侧</option><option value="bottom">下侧</option></select></label><label>终点端口<select value={handleSide(relation.targetHandle, 'left')} onChange={(event) => onPatchRelation(relation.id, { targetHandle: `in-${event.target.value}` })}><option value="left">左侧</option><option value="top">上侧</option><option value="right">右侧</option><option value="bottom">下侧</option></select></label></div><label>路径<select value={relation.lineKind ?? 'auto'} onChange={(event) => onPatchRelation(relation.id, { lineKind: event.target.value })}><option value="auto">智能避障</option><option value="straight">直线</option><option value="bezier">曲线</option><option value="orthogonal">折线</option></select></label><label>标签位置<input type="range" min=".16" max=".84" step=".04" value={relation.labelAnchor ?? .5} onChange={(event) => onPatchRelation(relation.id, { labelAnchor: Number(event.target.value) })} /></label><label>颜色<input type="color" value={relation.lineColor ?? '#08776f'} onChange={(event) => onPatchRelation(relation.id, { color: event.target.value })} /></label><div className="inspector-pair"><label>线宽<input type="number" min="1" max="8" value={relation.lineWidth ?? 2.75} onChange={(event) => onPatchRelation(relation.id, { lineWidth: Number(event.target.value) })} /></label><label>线型<select value={relation.lineDash ?? 'auto'} onChange={(event) => onPatchRelation(relation.id, { lineDash: event.target.value })}><option value="auto">自动</option><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select></label></div><label>起点箭头<select value={relation.sourceArrowStyle ?? (relation.sourceArrow ? 'triangle' : 'none')} onChange={(event) => onPatchRelation(relation.id, { sourceArrowStyle: event.target.value })}><option value="none">无箭头</option><option value="triangle">实心箭头</option><option value="open-triangle">空心箭头</option><option value="diamond">菱形</option></select></label><label>终点箭头<select value={relation.targetArrowStyle ?? 'triangle'} onChange={(event) => onPatchRelation(relation.id, { targetArrowStyle: event.target.value })}><option value="none">无箭头</option><option value="triangle">实心箭头</option><option value="open-triangle">空心箭头</option><option value="diamond">菱形</option></select></label><button className="secondary-button" onClick={() => onReverseRelation(relation)}>反转方向</button><button className="secondary-button" disabled={!relation.routePoints?.length} onClick={() => onPatchRelation(relation.id, { routePoints: [] })}>清除手工折点</button><button className="secondary-button" onClick={() => onPatchRelation(relation.id, { animated: relation.animated === false })}>{relation.animated === false ? '开启动画' : '关闭动画'}</button><button className="danger-button" onClick={() => onDeleteRelation(relation.id)}>删除关系</button></aside>
}
