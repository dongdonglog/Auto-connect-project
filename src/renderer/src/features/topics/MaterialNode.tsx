import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TopicMap } from '../../types'

export type MaterialNodeData = { material: TopicMap['materials'][number]; index: number; connecting: boolean }

const typeColor = (type: string): string => type === 'file' ? '#3568b8' : type === 'document' ? '#7654a6' : type === 'link' ? '#a14569' : '#b26a21'

export function MaterialNode({ data }: NodeProps): React.ReactElement {
  const { material, index, connecting } = data as MaterialNodeData
  const color = material.cardColor ?? typeColor(material.type)
  return <div className="flow-material-node" style={{ borderColor: color, backgroundColor: `${color}12` }}>
    <b className="flow-node-number" style={{ backgroundColor: color }}>{index + 1}</b>
    {([['left', Position.Left], ['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom]] as const).map(([side, position]) => <span key={side}><Handle id={`in-${side}`} type="target" position={position} isConnectable={connecting} /><Handle id={`out-${side}`} type="source" position={position} isConnectable={connecting} /></span>)}
    <small>{material.occurredAt?.slice(0, 10) ?? '未标记日期'}</small>
    <strong>{material.title}</strong>
    <span>{material.excerpt || material.type}</span>
    {((material.tags ?? []).length > 0 || (material.cardTags ?? []).length > 0) && <em className="flow-card-tags">{[...(material.tags ?? []).map((tag) => tag.tag), ...(material.cardTags ?? [])].slice(0, 3).join(' · ')}</em>}
    {material.cardNote && <i className="flow-card-note" title={material.cardNote}>有画板备注</i>}
  </div>
}
