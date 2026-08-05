import type { MouseEvent } from 'react'
import { CheckCircle2, CircleAlert, Clock3, FilePlus2, FileText, Link2, LoaderCircle } from 'lucide-react'
import type { Material, Topic } from '../types'

export interface MaterialCardProps {
  material: Material
  topics: Topic[]
  selected: boolean
  onClick(material: Material, event: MouseEvent): void
  onContext(material: Material, x: number, y: number): void
}

const icon = (type: string) => type === 'link' ? <Link2 size={16}/> : type === 'note' ? <FilePlus2 size={16}/> : <FileText size={16}/>

function status(material: Material): React.ReactElement {
  if (material.availability === 'unavailable') return <span className="status failed"><CircleAlert size={13}/>原文件失联</span>
  if (material.status === 'complete') return <span className="status complete"><CheckCircle2 size={13}/>已整理</span>
  if (material.status === 'failed') return <span className="status failed"><CircleAlert size={13}/>需重试</span>
  return <span className="status pending"><LoaderCircle size={13}/>处理中</span>
}

export function MaterialCard({ material, topics, selected, onClick, onContext }: MaterialCardProps): React.ReactElement {
  return (
    <button
      className={`material-card ${selected ? 'selected' : ''}`}
      onClick={(event) => onClick(material, event)}
      onContextMenu={(event) => { event.preventDefault(); onContext(material, event.clientX, event.clientY) }}
    >
      <div className={`material-type ${material.type}`}>{icon(material.type)}<span>{material.type}</span></div>
      <h3>{material.title}</h3>
      <p>{material.availability === 'unavailable' ? '原始文件已失联，仍可查看最近快照。' : material.excerpt || material.error || '等待分析材料内容'}</p>
      {topics.length > 0 && (
        <div className="material-topic-tags">
          {topics.slice(0, 3).map((topic) => <span key={topic.id} style={{ borderColor: topic.color, color: topic.color }}>{topic.name}</span>)}
        </div>
      )}
      <div className="card-footer">
        <span><Clock3 size={13}/>{material.importedAt.slice(0, 10)}</span>
        {status(material)}
      </div>
    </button>
  )
}
