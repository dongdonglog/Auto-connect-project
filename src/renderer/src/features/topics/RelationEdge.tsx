import { EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, Position, type EdgeProps } from '@xyflow/react'
import type { Relation } from '../../types'

const arrowPath: Record<string, string> = { triangle: 'M1 1 L11 6 L1 11z', 'open-triangle': 'M1 1 L11 6 L1 11', diamond: 'M1 6 L6 1 L11 6 L6 11z' }
type ParallelInfo = { index: number; count: number }
type EdgeData = { relation: Relation; parallel?: ParallelInfo; select(id: string): void; remove(id: string): Promise<void> }

/** 同一对材料之间的多条连线按序号向两侧岔开：0 → 居中，其余 ±30px 递增。 */
function parallelSpread(parallel: ParallelInfo | undefined): number {
  if (!parallel || parallel.count <= 1) return 0
  return (parallel.index - (parallel.count - 1) / 2) * 30
}

export function RelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data: rawData, selected }: EdgeProps): React.ReactElement {
  const data = rawData as EdgeData
  const relation = data.relation
  const kind = relation.lineKind ?? 'auto'
  const spread = parallelSpread(data.parallel)

  // 主方向：由端口位置决定（左右端口为水平连线，上下端口为垂直连线）。
  const horizontal = (sourcePosition === Position.Left || sourcePosition === Position.Right) && (targetPosition === Position.Left || targetPosition === Position.Right)
  const midX = (sourceX + targetX) / 2
  const midY = (sourceY + targetY) / 2

  let path: string
  let labelX: number
  let labelY: number

  if (spread !== 0 || kind === 'bezier') {
    // 平行岔开或用户选择曲线时：二次贝塞尔，控制点沿法线方向偏移，连线呈平行弧线。
    const dx = targetX - sourceX
    const dy = targetY - sourceY
    const length = Math.hypot(dx, dy) || 1
    const bend = kind === 'bezier' && spread === 0 ? 28 : spread * 1.6
    const controlX = midX + (-dy / length) * bend
    const controlY = midY + (dx / length) * bend
    path = `M${sourceX} ${sourceY} Q${controlX} ${controlY} ${targetX} ${targetY}`
    // 二次贝塞尔 t=0.5 处坐标
    labelX = 0.25 * sourceX + 0.5 * controlX + 0.25 * targetX
    labelY = 0.25 * sourceY + 0.5 * controlY + 0.25 * targetY
  } else if (kind === 'straight') {
    ;[path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  } else {
    // auto / orthogonal：smoothstep，用 centerX/centerY 把转折线垂直移位以岔开平行连线。
    const params = {
      sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
      borderRadius: kind === 'orthogonal' ? 0 : 20,
      offset: 32,
      ...(horizontal ? { centerY: midY + spread } : { centerX: midX + spread })
    }
    ;[path, labelX, labelY] = getSmoothStepPath(params)
  }

  const color = relation.lineColor ?? (relation.createdBy === 'local' ? '#9a7a38' : relation.createdBy === 'ai' ? '#8aa5b7' : '#08776f')
  const marker = `relation-marker-${id}`
  const markerFor = (style?: string) => style && style !== 'none' ? `url(#${marker}-${style})` : undefined
  return <>
    <defs>{Object.entries(arrowPath).map(([name, d]) => <marker key={name} id={`${marker}-${name}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse" markerUnits="strokeWidth"><path d={d} fill={name === 'open-triangle' ? 'none' : color} stroke={color} strokeWidth="1.5" /></marker>)}</defs>
    <path d={path} fill="none" stroke="transparent" strokeWidth={28} className="relation-hit-area" onClick={() => data.select(id)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); void data.remove(id) }} />
    <path d={path} fill="none" stroke={color} strokeWidth={selected ? 4 : 2.75} strokeDasharray={relation.createdBy === 'ai' || relation.createdBy === 'local' ? '7 5' : relation.animated === false ? undefined : '9 6'} markerStart={markerFor(relation.sourceArrowStyle ?? (relation.createdBy === 'manual' ? 'triangle' : relation.sourceArrow ? 'triangle' : 'none'))} markerEnd={markerFor(relation.createdBy === 'local' ? 'none' : relation.targetArrowStyle ?? 'triangle')} className={relation.createdBy === 'local' || relation.animated === false ? '' : 'flowing-relation'} onClick={() => data.select(id)} />
    <EdgeLabelRenderer><div className={`relation-edge-label ${selected ? 'selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }} onClick={() => data.select(id)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); void data.remove(id) }}><span>{relation.label}</span></div></EdgeLabelRenderer>
  </>
}
