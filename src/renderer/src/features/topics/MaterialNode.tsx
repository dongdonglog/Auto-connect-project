import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TopicMap } from '../../types'

export type MaterialNodeData = { material: TopicMap['materials'][number]; index: number; connecting: boolean }

const typeColor = (type: string): string => type === 'file' ? '#3568b8' : type === 'document' ? '#7654a6' : type === 'link' ? '#a14569' : '#b26a21'

export function MaterialNode({ data }: NodeProps): React.ReactElement {
  const { material, index, connecting } = data as MaterialNodeData
  const color = material.cardColor ?? typeColor(material.type)
  return <div className="flow-material-node" style={{ borderColor: color, backgroundColor: `${color}12` }}>
    <b className="flow-node-number" style={{ backgroundColor: color }}>{index + 1}</b>
    <Handle id="in-left" type="target" position={Position.Left} isConnectable={connecting} />
    <Handle id="in-top" type="target" position={Position.Top} isConnectable={connecting} />
    <small>{material.occurredAt?.slice(0, 10) ?? '未标记日期'}</small>
    <strong>{material.title}</strong>
    <span>{material.excerpt || material.type}</span>
    {(material.cardTags ?? []).length > 0 && <em className="flow-card-tags">{(material.cardTags ?? []).slice(0, 2).join(' · ')}</em>}
    {material.cardNote && <i className="flow-card-note" title={material.cardNote}>有画板备注</i>}
    <Handle id="out-right" type="source" position={Position.Right} isConnectable={connecting} />
    <Handle id="out-bottom" type="source" position={Position.Bottom} isConnectable={connecting} />
  </div>
}
