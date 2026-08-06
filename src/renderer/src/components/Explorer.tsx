import { Bot, Eye, EyeOff, FileText, Link2, Pin, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { MaterialPreview } from '../MaterialPreview'
import type { EvidenceFocus } from '../lib/evidence-focus'
import type { Material, MaterialRelation, RelationAiExplanation, Topic } from '../types'
import { useI18n } from '../i18n'
import './explorer.css'

export interface ExplorerProps {
  materials: Material[]
  topics: Topic[]
  initialMaterialId?: string | null
  onSelect(material: Material): void
  onChanged(): Promise<void>
}

export function Explorer({ materials, topics, initialMaterialId, onSelect, onChanged }: ExplorerProps): React.ReactElement {
  const { t, locale } = useI18n()
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
  const [showHidden, setShowHidden] = useState(false)
  const [evidenceFocus, setEvidenceFocus] = useState<EvidenceFocus | null>(null)
  const selected = useMemo(() => materials.find((material) => material.id === selectedId) ?? null, [materials, selectedId])
  useEffect(() => { if (initialMaterialId) { setSelectedId(initialMaterialId); setEvidenceFocus(null) } }, [initialMaterialId])
  const loadRelations = async (materialId: string): Promise<void> => {
    setLoading(true)
    setLoadError('')
    try { setRelations(await window.materialMap.materials.relations(materialId, showHidden ? 20 : 5, showHidden)) }
    catch (error) { setRelations([]); setLoadError(error instanceof Error ? error.message : '无法读取材料关联。') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (!selected) { setRelations([]); return } void loadRelations(selected.id) }, [selected?.id, showHidden])
  const choose = (material: Material, focus: EvidenceFocus | null = null): void => { setSelectedId(material.id); setEvidenceFocus(focus?.materialId === material.id ? focus : null); setExpanded(null); setActionError(''); onSelect(material) }
  const changeStatus = async (relation: MaterialRelation, status: 'visible' | 'hidden' | 'fixed'): Promise<void> => {
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
  const evidenceSource = (relation: MaterialRelation, materialId: string): Material => materialId === relation.target.id ? relation.target : materials.find((material) => material.id === materialId) ?? selected ?? relation.target
  const focusFor = (item: MaterialRelation['evidence'][number], materialId: string): EvidenceFocus | null => {
    const source = item.sourceMaterialId === materialId
    const focus = { key: `${item.id}:${materialId}`, materialId, startOffset: source ? item.sourceOffset : item.targetOffset, endOffset: source ? item.sourceEndOffset ?? null : item.targetEndOffset ?? null, pageNumber: source ? item.sourcePageNumber ?? null : item.targetPageNumber ?? null, heading: source ? item.sourceHeading ?? null : item.targetHeading ?? null }
    return focus.startOffset != null || focus.pageNumber != null || focus.heading != null ? focus : null
  }
  const relationName: Record<MaterialRelation['relationType'], string> = { references: locale === 'zh-CN' ? '显式引用' : 'Explicit reference', shares_entities: locale === 'zh-CN' ? '共享实体' : 'Shared entity', nearby: locale === 'zh-CN' ? '结构邻近' : 'Structural proximity' }
  const evidenceLocation = (item: MaterialRelation['evidence'][number], materialId: string): string => {
    const source = item.sourceMaterialId === materialId
    const page = source ? item.sourcePageNumber : item.targetPageNumber
    const offset = source ? item.sourceOffset : item.targetOffset
    return page ? ` · ${t('explorer.page', { page })}` : offset != null ? ` · ${t('explorer.position', { offset })}` : ''
  }
  return (
    <section className="explorer-view">
      <aside className="explorer-list">
        <header><span>{t('explorer.materials')}</span><small>{t('explorer.materialCount', { count: materials.length })}</small></header>
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
              <p>{selected.sourcePath ?? selected.url ?? t('explorer.workspaceMaterial')}</p>
            </header>
            <div className="explorer-document">
              <MaterialPreview material={selected} text={selected.extractedText ?? selected.excerpt ?? ''} focus={evidenceFocus}/>
            </div>
          </>
        ) : <div className="explorer-empty">{t('explorer.selectToStart')}</div>}
      </article>
      <aside className="explorer-relations">
        <header>
          <div>
            <h2>{t('explorer.relatedMaterials')}</h2>
            <p>{t('explorer.relatedCopy')}</p>
          </div>
          <button className={`hidden-toggle ${showHidden ? 'active' : ''}`} title={showHidden ? t('explorer.showVisible') : t('explorer.showHidden')} aria-label={showHidden ? t('explorer.showVisible') : t('explorer.showHidden')} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye size={15}/> : <EyeOff size={15}/>}<span>{relations.length}</span></button>
        </header>
        {actionError && <p className="explorer-error" role="alert">{actionError}</p>}
        {fixing && (
          <section className="fix-relation">
            <strong>{t('explorer.pinTitle')}</strong>
            <p>{t('explorer.pinCopy')}</p>
            {topics.length > 0 && (
              <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
                <option value="">{t('explorer.selectTopic')}</option>
                {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
              </select>
            )}
            <input value={newTopicName} onChange={(event) => setNewTopicName(event.target.value)} placeholder={topics.length ? t('explorer.orCreateTopic') : t('explorer.newTopic')}/>
            <div>
              <button className="secondary-button" onClick={() => setFixing(null)}>{t('explorer.cancel')}</button>
              <button className="primary-button" onClick={() => void fixToTopic()}>{t('explorer.pinRelation')}</button>
            </div>
          </section>
        )}
        {!selected ? null : loading ? (
          <div className="explorer-empty"><p>{t('explorer.loading')}</p></div>
        ) : loadError ? (
          <div className="explorer-empty">
            <p>{t('explorer.loadFailed')}</p>
            <small>{loadError}</small>
            <button className="secondary-button" onClick={() => void loadRelations(selected.id)}>{t('explorer.retry')}</button>
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
                  <button title={t('explorer.viewEvidence')} aria-label={t('explorer.viewEvidence')} onClick={() => setExpanded(expanded === relation.id ? null : relation.id)}><Sparkles size={14}/></button>
                  <button title={t('explorer.pinTitle')} aria-label={t('explorer.pinTitle')} disabled={relation.status === 'fixed'} onClick={() => setFixing(relation)}><Pin size={14}/></button>
                  {relation.status === 'hidden'
                    ? <button title={t('explorer.restoreRelation')} aria-label={t('explorer.restoreRelation')} onClick={() => void changeStatus(relation, 'visible')}><Eye size={14}/></button>
                    : <button title={t('explorer.hideRelation')} aria-label={t('explorer.hideRelation')} onClick={() => void changeStatus(relation, 'hidden')}><EyeOff size={14}/></button>}
                  <button title={t('explorer.aiExplain')} aria-label={t('explorer.aiExplain')} disabled={explaining === relation.id} onClick={() => void explain(relation)}><Bot size={14}/></button>
                </div>
                {expanded === relation.id && (
                  <div className="relation-evidence">
                    {relation.evidence.map((item) => {
                      const origin = evidenceSource(relation, item.sourceMaterialId)
                      return (
                        <div key={item.id} className="evidence-item">
                          <p>{item.text}</p>
                          <button className="evidence-source" title={t('explorer.locateSource')} onClick={() => choose(origin, focusFor(item, origin.id))}>{t('explorer.source', { title: origin.title })}{evidenceLocation(item, origin.id)}</button>
                        </div>
                      )
                    })}
                    <button className="evidence-jump" onClick={() => choose(relation.target)}>{t('explorer.jumpTo', { title: relation.target.title })}</button>
                    {explanations[relation.id] && (
                      <div className="ai-explanation">
                        <strong>{explanations[relation.id].supported ? explanations[relation.id].label : t('explorer.aiNotConfirmed')}</strong>
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
            <p>{t('explorer.noVerified')}</p>
            <small>{t('explorer.importMore')}</small>
          </div>
        )}
      </aside>
    </section>
  )
}
