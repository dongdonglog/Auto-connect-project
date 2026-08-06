import { EdgeLabelRenderer, getBezierPath, getStraightPath, type EdgeProps } from '@xyflow/react'
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Relation } from '../../types'
import { buildTopicEdgeRoute, type Point, type PortPosition, type Rect } from '../../lib/topic-edge-routing'

const arrowPath: Record<string, string> = { triangle: 'M1 1 L11 6 L1 11z', 'open-triangle': 'M1 1 L11 6 L1 11', diamond: 'M1 6 L6 1 L11 6 L6 11z' }
type ParallelInfo = { index: number; count: number }
type EdgeData = {
  relation: Relation
  parallel?: ParallelInfo
  obstacles: Rect[]
  labelObstacles: Rect[]
  select(id: string): void
  reconnect(id: string, endpoint: 'source' | 'target', nodeId: string, handleId: string): void
  context(id: string, x: number, y: number): void
  toFlow(point: Point): Point
  updateWaypoints(id: string, points: Point[]): void
}

function parallelSpread(parallel: ParallelInfo | undefined): number {
  if (!parallel || parallel.count <= 1) return 0
  return (parallel.index - (parallel.count - 1) / 2) * 30
}

function strokeDash(relation: Relation): string | undefined {
  if (relation.lineDash === 'solid') return undefined
  if (relation.lineDash === 'dotted') return '2 7'
  if (relation.lineDash === 'dashed') return '9 6'
  return relation.createdBy === 'ai' || relation.createdBy === 'local' ? '7 5' : undefined
}

export function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data: rawData, selected }: EdgeProps): React.ReactElement {
  const data = rawData as EdgeData
  const relation = data.relation
  const [draftWaypoints, setDraftWaypoints] = useState<Point[] | null>(null)
  const waypoints = draftWaypoints ?? relation.routePoints
  useEffect(() => { setDraftWaypoints(null) }, [relation.id, JSON.stringify(relation.routePoints ?? [])])
  // `auto` is a legacy value. It remains readable for old workspaces but is
  // rendered as the supported orthogonal path and is no longer offered in UI.
  const kind = relation.lineKind === 'straight' || relation.lineKind === 'bezier' ? relation.lineKind : 'orthogonal'
  const source = { x: sourceX, y: sourceY }; const target = { x: targetX, y: targetY }
  const label = relation.label.trim()
  const labelSize = { width: Math.min(240, Math.max(72, label.length * 15 + 38)), height: 22 }
  const route = buildTopicEdgeRoute({ source, target, obstacles: data.obstacles, labelObstacles: data.labelObstacles, waypoints, spread: parallelSpread(data.parallel), labelSize, labelAnchor: relation.labelAnchor, sourcePosition: sourcePosition as PortPosition, targetPosition: targetPosition as PortPosition })
  let path = route.path; let labelPoint = route.label
  if (!waypoints?.length && kind === 'straight') {
    ;[path, labelPoint.x, labelPoint.y] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  } else if (!waypoints?.length && kind === 'bezier') {
    ;[path, labelPoint.x, labelPoint.y] = getBezierPath({ sourceX, sourceY, targetX, targetY })
  }
  const color = relation.lineColor ?? (relation.createdBy === 'local' ? '#9a7a38' : relation.createdBy === 'ai' ? '#8aa5b7' : relation.createdBy === 'manual' ? '#08776f' : '#5e7e93')
  const marker = `relation-marker-${id}`
  const markerFor = (style?: string) => style && style !== 'none' ? `url(#${marker}-${style})` : undefined
  const updateWaypoint = (index: number, event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault(); event.stopPropagation()
    const current = waypoints ?? []
    const move = (pointer: PointerEvent): void => {
      const point = data.toFlow({ x: pointer.clientX, y: pointer.clientY })
      setDraftWaypoints(current.map((waypoint, itemIndex) => itemIndex === index ? point : waypoint))
    }
    const release = (pointer: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
      const point = data.toFlow({ x: pointer.clientX, y: pointer.clientY })
      setDraftWaypoints(null)
      data.updateWaypoints(id, current.map((waypoint, itemIndex) => itemIndex === index ? point : waypoint))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
  }
  const addWaypoint = (event: ReactMouseEvent<SVGPathElement>): void => {
    if (!selected) return
    event.preventDefault(); event.stopPropagation()
    data.updateWaypoints(id, [...(waypoints ?? []), data.toFlow({ x: event.clientX, y: event.clientY })])
  }
  const reconnectEndpoint = (endpoint: 'source' | 'target', event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault(); event.stopPropagation()
    const button = event.currentTarget
    button.setPointerCapture(event.pointerId)
    const release = (pointer: PointerEvent): void => {
      button.releasePointerCapture?.(pointer.pointerId)
      button.removeEventListener('pointerup', release)
      button.removeEventListener('pointercancel', release)
      const handle = (document.elementsFromPoint(pointer.clientX, pointer.clientY).find((element) => element instanceof HTMLElement && element.matches('.react-flow__handle')) as HTMLElement | undefined) ?? document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>('.react-flow__handle')
      const node = handle?.closest<HTMLElement>('.react-flow__node')
      const nodeId = node?.getAttribute('data-id')
      const handleId = handle?.getAttribute('data-handleid')
      const expected = endpoint
      if (nodeId && handleId && handle?.classList.contains(expected)) data.reconnect(id, endpoint, nodeId, handleId)
    }
    button.addEventListener('pointerup', release)
    button.addEventListener('pointercancel', release)
  }
  const select = (event: ReactMouseEvent<SVGPathElement | HTMLDivElement>): void => {
    // React Flow otherwise treats the click as a pane interaction after the
    // custom edge handler has run, immediately clearing the selected edge.
    event.preventDefault(); event.stopPropagation()
    data.select(id)
  }
  return <>
    <defs>{Object.entries(arrowPath).map(([name, d]) => <marker key={name} id={`${marker}-${name}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d={d} fill={name === 'open-triangle' ? 'none' : color} stroke={color} strokeWidth="1.4" strokeLinejoin="round" /></marker>)}</defs>
    <path d={path} fill="none" stroke="transparent" strokeWidth={28} className="relation-hit-area" onClick={select} onDoubleClick={addWaypoint} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); data.context(id, event.clientX, event.clientY) }} />
    <path d={path} fill="none" stroke={color} strokeWidth={selected ? Math.max(4, relation.lineWidth ?? 2.75) : relation.lineWidth ?? 2.75} strokeDasharray={strokeDash(relation)} markerStart={markerFor(relation.sourceArrowStyle ?? (relation.sourceArrow ? 'triangle' : 'none'))} markerEnd={markerFor(relation.targetArrowStyle ?? 'triangle')} className={`relation-path ${relation.createdBy !== 'local' && relation.animated !== false && strokeDash(relation) ? 'flowing-relation' : ''}`} onClick={select} />
    {(label || selected) && <EdgeLabelRenderer>
      {label && <div className={`relation-edge-label ${selected ? 'selected' : ''}`} style={{ zIndex: 3, color, transform: `translate(-50%, -50%) translate(${labelPoint.x}px,${labelPoint.y}px)` }} onClick={select} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); data.context(id, event.clientX, event.clientY) }}><span>{label}</span></div>}
      {selected && <>
        <button className="relation-endpoint-handle source" title="拖动起点重连" style={{ transform: `translate(-50%, -50%) translate(${sourceX}px,${sourceY}px)` }} onPointerDown={(event) => reconnectEndpoint('source', event)} />
        <button className="relation-endpoint-handle target" title="拖动终点重连" style={{ transform: `translate(-50%, -50%) translate(${targetX}px,${targetY}px)` }} onPointerDown={(event) => reconnectEndpoint('target', event)} />
      </>}
      {selected && (waypoints ?? []).map((point, index) => <button key={`${point.x}:${point.y}:${index}`} className="route-point-handle" title="拖动折点" style={{ transform: `translate(-50%, -50%) translate(${point.x}px,${point.y}px)` }} onPointerDown={(event) => updateWaypoint(index, event)} onDoubleClick={() => data.updateWaypoints(id, (waypoints ?? []).filter((_, itemIndex) => itemIndex !== index))} />)}
    </EdgeLabelRenderer>}
  </>
}
