import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TopicMap } from '../../types'

export type MaterialNodeData = {
  material: TopicMap['materials'][number]
  workstreamName?: string
  index: number
  connecting: boolean
  select(): void
  context(x: number, y: number): void
}

const typeColor = (type: string): string => type === 'file' ? '#3568b8' : type === 'document' ? '#7654a6' : type === 'link' ? '#a14569' : '#b26a21'

export function MaterialNode({ data }: NodeProps): React.ReactElement {
  const nodeData = data as MaterialNodeData
  const { material, index, connecting } = nodeData
  const color = material.cardColor ?? typeColor(material.type)
  const title = material.displayTitle ?? material.title
  const excerpt = material.displayExcerpt ?? material.excerpt ?? material.type
  const collapsed = Boolean(material.cardCollapsed)
  const titleFontSize = material.cardFontSize ?? undefined
  const bodyFontSize = titleFontSize ? Math.max(10, titleFontSize - 2) : undefined
  const metaFontSize = titleFontSize ? Math.max(9, titleFontSize - 3) : undefined
  // The card surface must be opaque: otherwise SVG edges behind the node show
  // through the text when a side handle is aligned with a text row.
  return <div className={`flow-material-node ${collapsed ? 'collapsed' : ''}`} style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 8%, white)`, color: material.cardTextColor ?? undefined, width: material.cardWidth ?? undefined, minHeight: material.cardHeight ?? undefined, fontSize: material.cardFontSize ?? undefined }} onClick={() => nodeData.select()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); nodeData.context(event.clientX, event.clientY) }}>
    <b className="flow-node-number" style={{ backgroundColor: color }}>{index + 1}</b>
    {([['left', Position.Left], ['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom]] as const).map(([side, position]) => <span key={side}><Handle id={`in-${side}`} type="target" position={position} isConnectable={connecting} /><Handle id={`out-${side}`} type="source" position={position} isConnectable={connecting} /></span>)}
    <small style={{ fontSize: metaFontSize }}>{material.occurredAt?.slice(0, 10) ?? '未标记日期'}</small>
    <small className="flow-node-workstream" style={{ fontSize: metaFontSize }}>{nodeData.workstreamName ?? 'Unassigned'}</small>
    <strong style={{ fontSize: titleFontSize }}>{title}</strong>
    {!collapsed && <span style={{ color: material.cardTextColor ?? undefined, fontSize: bodyFontSize }}>{excerpt}</span>}
    {!collapsed && ((material.tags ?? []).length > 0 || (material.cardTags ?? []).length > 0) && <em className="flow-card-tags" style={{ fontSize: metaFontSize }}>{[...(material.tags ?? []).map((tag) => tag.tag), ...(material.cardTags ?? [])].slice(0, 3).join(' · ')}</em>}
    {!collapsed && material.cardNote && <i className="flow-card-note" style={{ fontSize: metaFontSize }} title={material.cardNote}>有画板备注</i>}
  </div>
}
