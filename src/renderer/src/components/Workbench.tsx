import { Link2, Sparkles, Upload } from 'lucide-react'
import { useEffect, useState, type MouseEvent } from 'react'
import type { Material, Topic } from '../types'
import { MaterialCard } from './MaterialCard'
import { useI18n } from '../i18n'

export interface WorkbenchProps {
  materials: Material[]
  materialTopics: Record<string, Topic[]>
  topics: Topic[]
  onSelect(material: Material): void
  onContext(material: Material, x: number, y: number): void
  onImport(): void
  onLink(): void
  onDemo(): void
  onCreateTopic(materialIds: string[]): void
}

export function Workbench({ materials, materialTopics, topics, onSelect, onContext, onImport, onLink, onDemo, onCreateTopic }: WorkbenchProps): React.ReactElement {
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [topicFilter, setTopicFilter] = useState('')
  const [sort, setSort] = useState<'recent' | 'topic'>('recent')
  const { t, locale } = useI18n()
  const pageSize = 15
  const filtered = materials.filter((material) => !topicFilter || materialTopics[material.id]?.some((topic) => topic.id === topicFilter))
  const ordered = [...filtered].sort((a, b) => sort === 'recent' ? b.importedAt.localeCompare(a.importedAt) : (materialTopics[a.id]?.[0]?.name ?? t('workbench.allTopics')).localeCompare(materialTopics[b.id]?.[0]?.name ?? t('workbench.allTopics'), locale))
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visible = ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  useEffect(() => setPage(1), [topicFilter, sort, materials.length])
  const toggle = (material: Material, event: MouseEvent): void => {
    if (event.metaKey || event.ctrlKey || selectedIds.length) setSelectedIds((ids) => ids.includes(material.id) ? ids.filter((id) => id !== material.id) : [...ids, material.id])
    else onSelect(material)
  }
  if (!materials.length) {
    return (
      <section className="workbench">
        <div className="empty-state">
          <div className="empty-icon"><Upload size={25}/></div>
          <h2>{t('workbench.start')}</h2>
          <p>{t('workbench.startCopy')}</p>
          <div>
            <button className="primary-button" onClick={onImport}><Upload size={17}/>{t('workbench.importFile')}</button>
            <button className="secondary-button" onClick={onLink}><Link2 size={17}/>{t('workbench.addLink')}</button>
            <button className="secondary-button" onClick={onDemo}><Sparkles size={17}/>{t('workbench.demo')}</button>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="workbench">
      <div className="section-heading">
        <div>
          <h2>{t('workbench.recent')}</h2>
          <p>{t('workbench.recentCopy')}</p>
        </div>
        <div className="workbench-actions">
          <button className="secondary-button" onClick={onDemo}><Sparkles size={15}/>{t('workbench.demo')}</button>
          <span>{t('workbench.materialCount', { count: filtered.length })}</span>
        </div>
      </div>
      <div className="workbench-filters">
        <select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}>
          <option value="">{t('workbench.allTopics')}</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'topic')}>
          <option value="recent">{t('workbench.sortRecent')}</option>
          <option value="topic">{t('workbench.sortTopic')}</option>
        </select>
      </div>
      {selectedIds.length > 0 && (
        <div className="bulk-material-actions">
          <span>{t('workbench.selectedCount', { count: selectedIds.length })}</span>
          <button className="primary-button" onClick={() => onCreateTopic(selectedIds)}>{t('workbench.createTopicFromSelected')}</button>
          <button className="secondary-button" onClick={() => setSelectedIds([])}>{t('workbench.clearSelection')}</button>
        </div>
      )}
      <div className="material-grid">
        {visible.map((material) => (
          <MaterialCard
            key={material.id}
            material={material}
            topics={materialTopics[material.id] ?? []}
            selected={selectedIds.includes(material.id)}
            onClick={toggle}
            onContext={onContext}
          />
        ))}
      </div>
      {pageCount > 1 && (
        <div className="workbench-pagination">
          <button className="secondary-button" disabled={currentPage === 1} onClick={() => setPage((value) => value - 1)}>{t('workbench.previous')}</button>
          <span>{t('workbench.page', { current: currentPage, total: pageCount })}</span>
          <button className="secondary-button" disabled={currentPage === pageCount} onClick={() => setPage((value) => value + 1)}>{t('workbench.next')}</button>
        </div>
      )}
    </section>
  )
}
