import { Bot, EyeOff, FileText, Link2, Pin, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { MaterialPreview } from '../MaterialPreview'
import type { Material, MaterialRelation, RelationAiExplanation, Topic } from '../types'
import './explorer.css'

export interface ExplorerProps {
  materials: Material[]
  topics: Topic[]
  initialMaterialId?: string | null
  onSelect(material: Material): void
  onChanged(): Promise<void>
}

const relationName: Record<MaterialRelation['relationType'], string> = { references: '显式引用', shares_entities: '共享实体', nearby: '结构邻近' }

export function Explorer({ materials, topics, initialMaterialId, onSelect, onChanged }: ExplorerProps): React.ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(initialMaterialId ?? materials[0]?.id ?? null)
  const [relations, setRelations] = useState<MaterialRelation[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [explaining, setExplaining] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [explanations, setExplanations] = useState<Record<string, RelationAiExplanation>>({})
  const [fixing, setFixing] = useState<MaterialRelation | null>(null)
  const [topicId, setTopicId] = useState('')
  const [newTopicName, setNewTopicName] = useState('')
  const selected = useMemo(() => materials.find((material) => material.id === selectedId) ?? null, [materials, selectedId])
  useEffect(() => { if (initialMaterialId) setSelectedId(initialMaterialId) }, [initialMaterialId])
  const loadRelations = async (materialId: string): Promise<void> => {
    setLoading(true)
    setLoadError('')
    try { setRelations(await window.materialMap.materials.relations(materialId, 5)) }
    catch (error) { setRelations([]); setLoadError(error instanceof Error ? error.message : '无法读取材料关联。') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (!selected) { setRelations([]); return } void loadRelations(selected.id) }, [selected?.id])
  const choose = (material: Material): void => { setSelectedId(material.id); setExpanded(null); setActionError(''); onSelect(material) }
  const changeStatus = async (relation: MaterialRelation, status: 'hidden' | 'fixed'): Promise<void> => {
    setActionError('')
    try {
      if (status === 'fixed') await window.materialMap.materials.fixRelation(relation.id)
      else await window.materialMap.materials.relationStatus(relation.id, status)
      await onChanged()
      if (selected) await loadRelations(selected.id)
    } catch (error) { setActionError(error instanceof Error ? error.message : '无法更新关系状态。') }
  }
  const fixToTopic = async (): Promise<void> => {
    if (!fixing) return
    setActionError('')
    try {
      let destination = topicId
      if (!destination && newTopicName.trim()) destination = (await window.materialMap.topics.create(newTopicName.trim()) as Topic).id
      if (!destination) throw new Error('请选择主题，或输入一个新主题名称。')
      await window.materialMap.materials.fixRelation(fixing.id, destination)
      setFixing(null)
      setTopicId('')
      setNewTopicName('')
      await onChanged()
      if (selected) await loadRelations(selected.id)
    } catch (error) { setActionError(error instanceof Error ? error.message : '无法固定到主题画板。') }
  }
  const explain = async (relation: MaterialRelation): Promise<void> => {
    setExplaining(relation.id)
    setActionError('')
    try {
      const explanation = await window.materialMap.explainRelation(relation.id)
      setExplanations((current) => ({ ...current, [relation.id]: explanation }))
    } catch (error) { setActionError(error instanceof Error ? error.message : 'AI 解释暂时不可用，本地证据仍可查看。') }
    finally { setExplaining(null) }
  }
  return (
    <section className="explorer-view">
      <aside className="explorer-list">
        <header><span>材料探索</span><small>{materials.length} 份</small></header>
        <div>
          {materials.map((material) => (
            <button key={material.id} className={material.id === selectedId ? 'active' : ''} onClick={() => choose(material)}>
              <FileText size={15}/><span>{material.title}</span>
            </button>
          ))}
        </div>
      </aside>
      <article className="explorer-reader">
        {selected ? (
          <>
            <header>
              <span className="material-type">{selected.type}</span>
              <h1>{selected.title}</h1>
              <p>{selected.sourcePath ?? selected.url ?? '工作区材料'}</p>
            </header>
            <div className="explorer-document">
              <MaterialPreview material={selected} text={selected.extractedText ?? selected.excerpt ?? ''}/>
            </div>
          </>
        ) : <div className="explorer-empty">选择一份材料开始探索。</div>}
      </article>
      <aside className="explorer-relations">
        <header>
          <div>
            <h2>关联材料</h2>
            <p>本地即时计算，可展开查看证据。</p>
          </div>
          <span>{relations.length}</span>
        </header>
        {actionError && <p className="explorer-error" role="alert">{actionError}</p>}
        {fixing && (
          <section className="fix-relation">
            <strong>固定到主题画板</strong>
            <p>两份材料与这条正式关系会加入所选主题。</p>
            {topics.length > 0 && (
              <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
                <option value="">选择主题</option>
                {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
              </select>
            )}
            <input value={newTopicName} onChange={(event) => setNewTopicName(event.target.value)} placeholder={topics.length ? '或创建新主题' : '新主题名称'}/>
            <div>
              <button className="secondary-button" onClick={() => setFixing(null)}>取消</button>
              <button className="primary-button" onClick={() => void fixToTopic()}>固定关系</button>
            </div>
          </section>
        )}
        {!selected ? null : loading ? (
          <div className="explorer-empty"><p>正在读取本地关联...</p></div>
        ) : loadError ? (
          <div className="explorer-empty">
            <p>无法读取关联材料。</p>
            <small>{loadError}</small>
            <button className="secondary-button" onClick={() => void loadRelations(selected.id)}>重试</button>
          </div>
        ) : relations.length ? (
          <div className="relation-list">
            {relations.map((relation) => (
              <article key={relation.id} className="explorer-relation">
                <button className="relation-target" onClick={() => choose(relation.target)}>
                  <FileText size={15}/>
                  <span>
                    <strong>{relation.target.title}</strong>
                    <small>{relationName[relation.relationType]} · {Math.round(relation.score * 100)}%</small>
                  </span>
                  <Link2 size={14}/>
                </button>
                <div className="relation-actions">
                  <button title="查看证据" onClick={() => setExpanded(expanded === relation.id ? null : relation.id)}><Sparkles size={14}/></button>
                  <button title="固定到主题画板" disabled={relation.status === 'fixed'} onClick={() => setFixing(relation)}><Pin size={14}/></button>
                  <button title="隐藏这条关联" onClick={() => void changeStatus(relation, 'hidden')}><EyeOff size={14}/></button>
                  <button title="AI 解释" disabled={explaining === relation.id} onClick={() => void explain(relation)}><Bot size={14}/></button>
                </div>
                {expanded === relation.id && (
                  <div className="relation-evidence">
                    {relation.evidence.map((item) => {
                      const originTitle = item.sourceMaterialId === selected.id ? selected.title : relation.target.title
                      return (
                        <div key={item.id} className="evidence-item">
                          <p>{item.text}</p>
                          <small>来源：{originTitle}{item.sourceOffset != null ? ` · 位置 ${item.sourceOffset}` : ''}</small>
                        </div>
                      )
                    })}
                    <button className="evidence-jump" onClick={() => choose(relation.target)}>跳转到「{relation.target.title}」</button>
                    {explanations[relation.id] && (
                      <div className="ai-explanation">
                        <strong>{explanations[relation.id].supported ? explanations[relation.id].label : 'AI 未确认'}</strong>
                        <p>{explanations[relation.id].explanation}</p>
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="explorer-empty">
            <p>未找到可验证关联。</p>
            <small>导入更多有标题、章节或文件引用的材料后会自动更新。</small>
          </div>
        )}
      </aside>
    </section>
  )
}
