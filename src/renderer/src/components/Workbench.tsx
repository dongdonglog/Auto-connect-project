import { Link2, Sparkles, Upload } from 'lucide-react'
import { useEffect, useState, type MouseEvent } from 'react'
import type { Material, Topic } from '../types'
import { MaterialCard } from './MaterialCard'

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
  const pageSize = 15
  const filtered = materials.filter((material) => !topicFilter || materialTopics[material.id]?.some((topic) => topic.id === topicFilter))
  const ordered = [...filtered].sort((a, b) => sort === 'recent' ? b.importedAt.localeCompare(a.importedAt) : (materialTopics[a.id]?.[0]?.name ?? '永未归类').localeCompare(materialTopics[b.id]?.[0]?.name ?? '永未归类', 'zh-CN'))
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
          <h2>从一份材料开始</h2>
          <p>拖入文件、写一段笔记，或者添加链接。</p>
          <div>
            <button className="primary-button" onClick={onImport}><Upload size={17}/>导入文件</button>
            <button className="secondary-button" onClick={onLink}><Link2 size={17}/>添加链接</button>
            <button className="secondary-button" onClick={onDemo}><Sparkles size={17}/>创建学习路径演示</button>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="workbench">
      <div className="section-heading">
        <div>
          <h2>最近导入</h2>
          <p>材料完成分析后会自动补充摘要与关联。</p>
        </div>
        <div className="workbench-actions">
          <button className="secondary-button" onClick={onDemo}><Sparkles size={15}/>创建学习路径演示</button>
          <span>{filtered.length} 份材料</span>
        </div>
      </div>
      <div className="workbench-filters">
        <select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}>
          <option value="">全部主题</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'topic')}>
          <option value="recent">最近导入</option>
          <option value="topic">按主题</option>
        </select>
      </div>
      {selectedIds.length > 0 && (
        <div className="bulk-material-actions">
          <span>已选择 {selectedIds.length} 份材料</span>
          <button className="primary-button" onClick={() => onCreateTopic(selectedIds)}>从所选创建主题</button>
          <button className="secondary-button" onClick={() => setSelectedIds([])}>取消选择</button>
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
          <button className="secondary-button" disabled={currentPage === 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <span>第 {currentPage} / {pageCount} 页</span>
          <button className="secondary-button" disabled={currentPage === pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
        </div>
      )}
    </section>
  )
}
