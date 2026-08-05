import { useEffect, useState } from 'react'
import { Clock3, FilePlus2, FileText, Link2, LoaderCircle, Map, Plus, X } from 'lucide-react'
import type { Material, Topic, TopicMap } from '../types'
import { MaterialPreview } from '../MaterialPreview'

export interface ContextPanelProps {
  material: Material
  topics: Topic[]
  activeTopic: TopicMap | null
  onClose(): void
  onRefresh(): Promise<void>
  onOpenTopic(topic: Topic): void
}

const materialIcon = (type: string) => type === 'link' ? <Link2 size={16}/> : type === 'note' ? <FilePlus2 size={16}/> : <FileText size={16}/>
const toDay = (value?: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value)) : '未标记日期'
const isEditable = (material: Material) => material.type === 'note' || material.type === 'document' || (material.type === 'file' && /\.(md|txt|csv|json|html?)$/i.test(material.sourcePath ?? material.storedPath ?? ''))
const cardColors = ['#4f7cff', '#08776f', '#b26a21', '#a14569', '#7654a6']

function BoardAttributes({ topic, material, onRefresh }: { topic: TopicMap; material: Material; onRefresh(): Promise<void> }): React.ReactElement | null {
  const boardMaterial = topic.materials.find((item) => item.id === material.id)
  const [color, setColor] = useState(boardMaterial?.cardColor ?? '')
  const [tags, setTags] = useState((boardMaterial?.cardTags ?? []).join(', '))
  const [note, setNote] = useState(boardMaterial?.cardNote ?? '')

  useEffect(() => {
    setColor(boardMaterial?.cardColor ?? '')
    setTags((boardMaterial?.cardTags ?? []).join(', '))
    setNote(boardMaterial?.cardNote ?? '')
  }, [boardMaterial?.cardColor, boardMaterial?.cardNote, boardMaterial?.cardTags, material.id])

  if (!boardMaterial) return null

  const save = async () => {
    await window.materialMap.topics.updateCardStyle(topic.topic.id, material.id, {
      color: color || undefined,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      note: note.trim() || undefined
    })
    await onRefresh()
  }

  return <section className="panel-section board-attributes">
    <div className="panel-section-title"><h3>画板属性</h3><span>仅当前主题</span></div>
    <label><span>卡片颜色</span><div className="color-control">
      {cardColors.map((preset) => <button key={preset} type="button" title={preset} aria-label={`使用颜色 ${preset}`} className={color === preset || (!color && preset === cardColors[0]) ? 'active' : ''} style={{ backgroundColor: preset }} onClick={() => setColor(preset)}/>) }
      <input type="color" aria-label="自定义卡片颜色" value={color || cardColors[0]} onChange={(event) => setColor(event.target.value)}/>
    </div></label>
    <label><span>标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用逗号分隔"/></label>
    <label><span>备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="仅在当前主题中显示"/></label>
    <div className="board-attribute-actions"><button className="secondary-button" onClick={() => void save()}>保存画板属性</button></div>
  </section>
}

export function ContextPanel({ material, topics, activeTopic, onClose, onRefresh, onOpenTopic }: ContextPanelProps): React.ReactElement {
  const [adding, setAdding] = useState(false)
  const [memberships, setMemberships] = useState<Topic[]>([])
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(material.title)
  const [text, setText] = useState(material.extractedText ?? '')
  const [saved, setSaved] = useState(true)
  const editable = isEditable(material)
  const loadMemberships = () => void window.materialMap.topics.forMaterial(material.id).then((items: unknown[]) => setMemberships(items as Topic[]))
  useEffect(() => {
    setTitle(material.title)
    setText(material.extractedText ?? '')
    setEditing(false)
    setSaved(true)
    loadMemberships()
  }, [material.id])
  const save = async () => {
    await window.materialMap.materials.saveText(material.id, title, text)
    setSaved(true)
    setEditing(false)
    await onRefresh()
  }
  const addToTopic = async (topicId: string) => {
    await window.materialMap.topics.addMaterial(topicId, material.id)
    setAdding(false)
    await onRefresh()
    loadMemberships()
    const topic = topics.find((item) => item.id === topicId)
    if (topic) onOpenTopic(topic)
  }
  return (
    <aside className={`context-panel ${editing ? 'editing' : ''}`}>
      <header>
        <div className={`material-type ${material.type}`}>{materialIcon(material.type)}<span>{material.type}</span></div>
        <button className="icon-button" onClick={onClose}><X size={18}/></button>
      </header>
      {editing ? (
        <>
          <input className="editor-title" value={title} onChange={(event) => { setTitle(event.target.value); setSaved(false) }}/>
          <div className="document-editor">
            <section>
              <span>编辑</span>
              <textarea className="material-editor" value={text} onChange={(event) => { setText(event.target.value); setSaved(false) }}/>
            </section>
            <section>
              <span>预览</span>
              <div className="document-preview"><MaterialPreview material={material} text={text}/></div>
            </section>
          </div>
          <div className="editor-actions">
            <button className="secondary-button" onClick={() => setEditing(false)}>取消</button>
            <button className="primary-button" disabled={saved} onClick={() => void save()}>保存</button>
          </div>
        </>
      ) : (
        <>
          <h2>{material.title}</h2>
          <div className="panel-meta"><span><Clock3 size={14}/>{toDay(material.occurredAt)}</span></div>
          <div className="preview"><p>{material.extractedText || material.excerpt || material.error || '材料仍在等待处理。'}</p></div>
          <div className="panel-actions">
            {editable
              ? <button className="secondary-button" onClick={() => setEditing(true)}>编辑内容</button>
              : <button className="secondary-button" onClick={() => void window.materialMap.materials.open(material.id)}>用默认程序打开</button>}
          </div>
        </>
      )}
      {material.error && (
        <button className="retry-button" onClick={async () => { await window.materialMap.materials.retry(material.id); await onRefresh() }}>
          <LoaderCircle size={15}/>重新处理
        </button>
      )}
      <section className="panel-section">
        <div className="panel-section-title">
          <h3>所在主题</h3>
          <button onClick={() => setAdding(!adding)}><Plus size={15}/></button>
        </div>
        {adding && <div className="topic-picker">{topics.map((topic) => <button key={topic.id} onClick={() => void addToTopic(topic.id)}>{topic.name}</button>)}</div>}
        {memberships.length ? (
          <div className="relationship-list">
            {memberships.map((topic) => (
              <button className="relationship" key={topic.id} onClick={() => onOpenTopic(topic)}>
                <Map size={14}/><span>{topic.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="panel-empty">尚未加入主题</p>}
      </section>
      {activeTopic && <BoardAttributes topic={activeTopic} material={material} onRefresh={onRefresh}/>}
      <section className="panel-section">
        <h3>时间</h3>
        <input className="date-input" type="date" defaultValue={material.occurredAt?.slice(0, 10)} onChange={async (event) => {
          if (event.target.value) {
            await window.materialMap.materials.date(material.id, `${event.target.value}T00:00:00.000Z`)
            await onRefresh()
          }
        }}/>
      </section>
    </aside>
  )
}
