import { EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, type EdgeProps } from '@xyflow/react'
import { useEffect, useState, type MouseEvent } from 'react'
import type { Relation } from '../../types'

const arrowPath: Record<string, string> = { triangle: 'M1 1 L11 6 L1 11z', 'open-triangle': 'M1 1 L11 6 L1 11', diamond: 'M1 6 L6 1 L11 6 L6 11z' }
type EdgeData = { relation: Relation; save(id: string, label: string): Promise<void>; style(id: string, input: Record<string, unknown>): Promise<void>; remove(id: string): Promise<void> }

export function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data: rawData, selected }: EdgeProps): React.ReactElement {
  const data = rawData as EdgeData; const relation = data.relation; const kind = relation.lineKind ?? 'auto'
  const [path] = kind === 'straight' ? getStraightPath({ sourceX, sourceY, targetX, targetY }) : kind === 'bezier' ? getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition }) : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 20, offset: 28 })
  // React Flow's smooth-step label can land on a bend next to a node. Use the
  // geometric midpoint and push it perpendicular to the relationship instead.
  const horizontal = Math.abs(targetX - sourceX) >= Math.abs(targetY - sourceY)
  const x = (sourceX + targetX) / 2 + (horizontal ? 0 : 28)
  const y = (sourceY + targetY) / 2 + (horizontal ? (Math.abs(targetX - sourceX) < 310 ? -92 : -28) : 0)
  const color = relation.lineColor ?? (relation.createdBy === 'ai' ? '#8aa5b7' : '#08776f'); const marker = `relation-marker-${id}`
  const [editing, setEditing] = useState(false); const [label, setLabel] = useState(relation.label)
  useEffect(() => setLabel(relation.label), [relation.label])
  const markerFor = (style?: string) => style && style !== 'none' ? `url(#${marker}-${style})` : undefined
  const save = (): void => { if (label.trim()) void data.save(id, label.trim()); setEditing(false) }
  const edit = (event?: MouseEvent): void => { event?.stopPropagation(); setEditing(true) }
  return <>
    <defs>{Object.entries(arrowPath).map(([name, d]) => <marker key={name} id={`${marker}-${name}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="strokeWidth"><path d={d} fill={name === 'open-triangle' ? 'none' : color} stroke={color} strokeWidth="1.5" /></marker>)}</defs>
    <path d={path} fill="none" stroke="transparent" strokeWidth={28} className="relation-hit-area" onClick={edit} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); void data.remove(id) }} />
    <path d={path} fill="none" stroke={color} strokeWidth={selected ? 4 : 2.75} strokeDasharray={relation.createdBy === 'ai' ? '7 5' : relation.animated === false ? undefined : '9 6'} markerStart={markerFor(relation.sourceArrowStyle ?? (relation.sourceArrow ? 'triangle' : 'none'))} markerEnd={markerFor(relation.targetArrowStyle ?? 'triangle')} className={relation.animated === false ? '' : 'flowing-relation'} onClick={edit} />
    <EdgeLabelRenderer><div className={`relation-edge-label ${selected ? 'selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }} onClick={edit} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); void data.remove(id) }}>
      {editing ? <div className="relation-editor"><input autoFocus value={label} aria-label="关系名称" onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false) }} onBlur={save} />
        <label className="relation-color" aria-label="连线颜色">颜色<input type="color" value={color} onChange={(event) => void data.style(id, { color: event.target.value })} /></label>
        <select aria-label="连线形态" value={kind} onChange={(event) => void data.style(id, { lineKind: event.target.value })}><option value="auto">智能路径</option><option value="straight">直线</option><option value="bezier">曲线</option><option value="orthogonal">折线</option></select>
        <select aria-label="起点箭头" value={relation.sourceArrowStyle ?? 'none'} onChange={(event) => void data.style(id, { sourceArrowStyle: event.target.value })}><option value="none">无起点箭头</option><option value="triangle">实心起点</option><option value="open-triangle">空心起点</option><option value="diamond">菱形起点</option></select>
        <select aria-label="终点箭头" value={relation.targetArrowStyle ?? 'triangle'} onChange={(event) => void data.style(id, { targetArrowStyle: event.target.value })}><option value="none">无终点箭头</option><option value="triangle">实心终点</option><option value="open-triangle">空心终点</option><option value="diamond">菱形终点</option></select>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => void data.style(id, { animated: relation.animated === false })}>{relation.animated === false ? '开启动画' : '关闭动画'}</button>
      </div> : <span>{relation.label}</span>}
    </div></EdgeLabelRenderer>
  </>
}
