import React, { useEffect, useState } from 'react'
import { Archive, ArrowLeft, Bot, FileText, Plus, Search, Upload, X } from 'lucide-react'
import type { GroundedAnswer, Material, Topic, TopicMap, Workspace } from './types'
import { syncImportNotices, type ImportNotice } from './import-state'
import { TopicBoardPage as TopicBoard } from './features/topics/TopicBoardPage'
import { SourcePanel } from './features/sources/SourcePanel'
import { Welcome } from './components/Welcome'
import { Sidebar } from './components/Sidebar'
import { Workbench } from './components/Workbench'
import { Explorer } from './components/Explorer'
import { ContextPanel } from './components/ContextPanel'
import { ImportQueue } from './components/ImportQueue'
import { MaterialMenu } from './components/MaterialMenu'
import { LinkDialog, NoteDialog, SettingsDialog, TopicDialog, WorkspaceDialog } from './components/Dialogs'
import { Toast } from './components/Toast'

export default function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<Array<{ root: string; name: string; openedAt: string }>>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialTopics, setMaterialTopics] = useState<Record<string, Topic[]>>({})
  const [topics, setTopics] = useState<Topic[]>([])
  const [archivedTopics, setArchivedTopics] = useState<Topic[]>([])
  const [selected, setSelected] = useState<Material | null>(null)
  const [showExplorer, setShowExplorer] = useState(false)
  const [explorerMaterialId, setExplorerMaterialId] = useState<string | null>(null)
  const [activeTopic, setActiveTopic] = useState<TopicMap | null>(null)
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<GroundedAnswer | null>(null)
  const [showNote, setShowNote] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [showTopic, setShowTopic] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [contextMenu, setContextMenu] = useState<{ material: Material; x: number; y: number } | null>(null)
  const [imports, setImports] = useState<ImportNotice[]>([])

  const refreshRecent = async () => setRecentWorkspaces(await window.materialMap.workspace.recent())
  const refresh = async () => {
    if (!workspace) return
    const [nextMaterials, nextTopics, nextArchived] = await Promise.all([
      window.materialMap.materials.listWithTopics(),
      window.materialMap.topics.list(),
      window.materialMap.topics.listArchived()
    ])
    const typedMaterials = nextMaterials as Array<Material & { topics?: Topic[] }>
    setMaterials(typedMaterials)
    setMaterialTopics(Object.fromEntries(typedMaterials.map((material) => [material.id, material.topics ?? []])))
    setTopics(nextTopics as Topic[])
    setArchivedTopics(nextArchived as Topic[])
  }
  const refreshTopics = async () => {
    if (!workspace) return
    const [nextTopics, nextArchived] = await Promise.all([window.materialMap.topics.list(), window.materialMap.topics.listArchived()])
    setTopics(nextTopics as Topic[])
    setArchivedTopics(nextArchived as Topic[])
  }

  useEffect(() => { void refresh() }, [workspace])
  useEffect(() => {
    const changed = () => { void refresh(); setMessage('已删除所选材料。') }
    window.addEventListener('materials:changed', changed)
    return () => window.removeEventListener('materials:changed', changed)
  }, [workspace])
  useEffect(() => {
    void refreshRecent()
    window.materialMap.workspace.onMenu('workspace:new', () => void createWorkspace())
    window.materialMap.workspace.onMenu('workspace:open', () => void openWorkspace())
    window.materialMap.workspace.onMenu('workspace:close', () => setWorkspace(null))
  }, [])
  useEffect(() => {
    if (!selected) return
    const next = materials.find((item) => item.id === selected.id)
    if (next) setSelected(next)
  }, [materials, selected])
  useEffect(() => {
    if (!imports.some((item) => item.status === 'queued' || item.status === 'running')) return
    const timer = window.setInterval(() => void refresh(), 800)
    return () => window.clearInterval(timer)
  }, [imports, workspace])
  useEffect(() => {
    setImports((old) => {
      const next = syncImportNotices(old, materials)
      return next.some((item, index) => item !== old[index]) ? next : old
    })
  }, [materials, imports])

  const openTopic = async (topic: Topic) => {
    try {
      setActiveTopic(await window.materialMap.topics.map(topic.id) as TopicMap)
      setSelected(null)
      setShowExplorer(false)
    } catch (error) {
      setActiveTopic(null)
      setMessage(error instanceof Error ? `无法打开主题：${error.message}` : '无法打开主题。')
    }
  }
  const importPaths = async (paths: string[], keepDuplicate = false, target?: { topicId: string; position: { x: number; y: number } }) => {
    if (!paths.length) return
    setImports((old) => [...paths.map((path) => ({ path, title: path.split(/[\\/]/).at(-1) ?? path, status: 'queued' as const })), ...old].slice(0, 12))
    for (const path of paths) try {
      const result = await window.materialMap.materials.import(path, keepDuplicate) as { material: Material; duplicateOf?: Material }
      if (target && !result.duplicateOf) {
        await window.materialMap.topics.addMaterial(target.topicId, result.material.id)
        await window.materialMap.topics.positionMaterial(target.topicId, result.material.id, target.position.x, target.position.y)
      }
      setImports((old) => old.map((item) => item.path === path ? { ...item, materialId: result.material.id, title: result.material.title, status: result.duplicateOf ? 'duplicate' : item.status === 'complete' ? 'complete' : result.material.status } : item))
    } catch {
      setImports((old) => old.map((item) => item.path === path ? { ...item, status: 'failed' } : item))
    }
    await refresh()
  }
  const importFiles = async () => importPaths(await window.materialMap.chooseFiles())
  const createWorkspace = async () => {
    const root = await window.materialMap.chooseDirectory()
    if (root) setWorkspaceRoot(root)
  }
  const openWorkspace = async () => {
    const root = await window.materialMap.chooseDirectory()
    if (!root) return
    try {
      setWorkspace(await window.materialMap.workspace.open(root) as Workspace)
      await refreshRecent()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法打开工作区')
    }
  }
  const importWorkspace = async () => {
    const file = await window.materialMap.choosePackage()
    if (!file) return
    const destination = await window.materialMap.chooseDirectory()
    if (!destination) return
    try {
      setWorkspace(await window.materialMap.workspace.import(file, destination) as Workspace)
      await refreshRecent()
      setMessage('工作区已导入。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法导入工作区。')
    }
  }
  const openRecent = async (root: string) => {
    try {
      setWorkspace(await window.materialMap.workspace.open(root) as Workspace)
      await refreshRecent()
    } catch {
      setMessage('这个工作区已无法打开，请确认文件夹仍然存在。')
    }
  }
  const exportWorkspace = async () => {
    const destination = await window.materialMap.savePackage()
    if (destination) {
      await window.materialMap.workspace.export(destination)
      setMessage('工作区已导出。')
    }
  }
  const createDemo = async () => {
    try {
      const topic = await window.materialMap.demo.create() as Topic
      await refresh()
      await openTopic(topic)
      setMessage('已创建 AI 关联演示，正在分析主题材料。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法创建 AI 演示。')
    }
  }
  const createTopicFromMaterials = async (materialIds: string[]) => {
    const name = window.prompt('新主题名称')
    if (!name?.trim()) return
    const topic = await window.materialMap.topics.create(name.trim()) as Topic
    await window.materialMap.topics.addMaterials(topic.id, materialIds)
    await refresh()
    setActiveTopic(await window.materialMap.topics.map(topic.id) as TopicMap)
    setSelected(null)
    setMessage(`已将 ${materialIds.length} 份材料加入主题，默认拓扑已生成。需要补充关系时，请在画板中主动请求 AI。`)
  }
  const askQuestion = () => { if (query.trim()) void window.materialMap.ask(query).then(setAnswer) }

  if (!workspace) {
    return (
      <>
        <Welcome
          recent={recentWorkspaces}
          onCreate={createWorkspace}
          onOpen={openWorkspace}
          onImport={importWorkspace}
          onRecent={openRecent}
          onForget={async (root) => { await window.materialMap.workspace.forgetRecent(root); await refreshRecent() }}
        />
        {workspaceRoot && (
          <WorkspaceDialog
            root={workspaceRoot}
            onClose={() => setWorkspaceRoot(null)}
            onSave={async (name) => {
              try {
                setWorkspace(await window.materialMap.workspace.create(workspaceRoot, name) as Workspace)
                setWorkspaceRoot(null)
                await refreshRecent()
              } catch (error) {
                setMessage(error instanceof Error ? error.message : '无法创建工作区')
              }
            }}
          />
        )}
        <Toast message={message} onClose={() => setMessage('')}/>
      </>
    )
  }

  const topicRefresh = async () => {
    if (!activeTopic) return
    try {
      setActiveTopic(await window.materialMap.topics.map(activeTopic.topic.id) as TopicMap)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? `无法刷新主题：${error.message}` : '无法刷新主题。')
    }
  }
  const openExplorerById = (materialId: string) => {
    setExplorerMaterialId(materialId)
    setShowExplorer(true)
    setSelected(null)
  }
  const openInExplorer = (material: Material) => openExplorerById(material.id)

  return (
    <div className="app-shell">
      <Sidebar
        workspace={workspace}
        recentWorkspaces={recentWorkspaces}
        topics={topics}
        archivedTopics={archivedTopics}
        activeTopicId={activeTopic?.topic.id ?? null}
        showExplorer={showExplorer}
        onShowWorkbench={() => { setActiveTopic(null); setSelected(null); setShowExplorer(false) }}
        onShowExplorer={() => { setActiveTopic(null); setSelected(null); setShowExplorer(true) }}
        onOpenTopic={(topic) => void openTopic(topic)}
        onNewTopic={() => setShowTopic(true)}
        onCreateWorkspace={() => void createWorkspace()}
        onOpenWorkspace={() => void openWorkspace()}
        onImportWorkspace={() => void importWorkspace()}
        onOpenRecent={(root) => void openRecent(root)}
        onCloseWorkspace={() => setWorkspace(null)}
        onRestoreTopic={async (topic) => { await window.materialMap.topics.restore(topic.id); await refreshTopics(); setMessage(`已还原“${topic.name}”。`) }}
        onDeleteArchivedTopic={async (topic) => {
          if (!window.confirm(`永久删除主题“${topic.name}”的画板记录？原材料和文件不会删除。`)) return
          await window.materialMap.topics.deleteArchived(topic.id)
          await refreshTopics()
        }}
        onShowSources={() => setShowSources(true)}
        onShowSettings={() => setShowSettings(true)}
        onExportWorkspace={() => void exportWorkspace()}
      />
      <main
        className="main"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const paths = [...event.dataTransfer.files].map((file) => window.materialMap.filePath(file)).filter(Boolean)
          void importPaths(paths, false, activeTopic ? { topicId: activeTopic.topic.id, position: { x: 180, y: 140 } } : undefined)
        }}
      >
        <header className="topbar">
          <div>
            {activeTopic ? (
              <>
                <button className="back-button" onClick={() => setActiveTopic(null)}><ArrowLeft size={17}/>工作台</button>
                <h1>{activeTopic.topic.name}</h1>
              </>
            ) : showExplorer ? (
              <>
                <h1>探索</h1>
                <p>读一份材料，查看有证据的关联材料。</p>
              </>
            ) : (
              <>
                <h1>工作台</h1>
                <p>最近导入的材料，正在逐渐连成脉络。</p>
              </>
            )}
          </div>
          <div className="top-actions">
            <label className="search">
              <Search size={16}/>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') askQuestion() }}
                placeholder="搜索材料或主题"
              />
            </label>
            {activeTopic && (
              <button className="secondary-button" onClick={async () => {
                if (!window.confirm(`归档主题“${activeTopic.topic.name}”？不会删除任何材料和文件。`)) return
                await window.materialMap.topics.archive(activeTopic.topic.id)
                setActiveTopic(null)
                await refresh()
                setMessage('主题已归档。')
              }}><Archive size={15}/>归档主题</button>
            )}
            <button className="icon-button" title="基于本地材料提问" disabled={!query.trim()} onClick={askQuestion}><Bot size={18}/></button>
            <button className="icon-button" title="导入文件" onClick={() => void importFiles()}><Upload size={18}/></button>
            <button className="primary-button" onClick={() => setShowNote(true)}><Plus size={17}/>新建材料</button>
          </div>
        </header>
        {imports.length > 0 && (
          <ImportQueue items={imports} onRetry={(path, keepDuplicate) => void importPaths([path], keepDuplicate)} onClear={() => setImports([])}/>
        )}
        {answer && (
          <section className="answer-panel">
            <div className="answer-heading">
              <span><Bot size={16}/>基于本地材料的回答</span>
              <button className="icon-button" onClick={() => setAnswer(null)}><X size={15}/></button>
            </div>
            <p>{answer.answer}</p>
            <div className="answer-meta">
              {answer.confidence === 'grounded' ? '已基于本地证据' : '材料中没有足够证据'} · {answer.retrievalMode === 'fts' ? '全文检索' : answer.retrievalMode === 'hybrid' ? '混合检索' : '降级检索'}
            </div>
            {answer.citations.length > 0 && (
              <div className="citations">
                {answer.citations.map((citation) => (
                  <button key={`${citation.materialId}:${citation.chunkId ?? 'material'}`} onClick={() => openExplorerById(citation.materialId)}>
                    <FileText size={13}/>{citation.title}{citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ''}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {activeTopic ? (
          <TopicBoard
            map={activeTopic}
            materials={materials}
            onRefresh={topicRefresh}
            onSelect={setSelected}
            onImportFiles={(paths, position) => importPaths(paths, false, { topicId: activeTopic.topic.id, position })}
          />
        ) : showExplorer ? (
          <Explorer materials={materials} topics={topics} initialMaterialId={explorerMaterialId} onSelect={(material) => setExplorerMaterialId(material.id)} onChanged={refresh}/>
        ) : (
          <Workbench
            materials={materials.filter((item) => !query || `${item.title} ${item.excerpt ?? ''} ${(materialTopics[item.id] ?? []).map((topic) => topic.name).join(' ')}`.toLowerCase().includes(query.toLowerCase()))}
            materialTopics={materialTopics}
            topics={topics}
            onSelect={openInExplorer}
            onContext={(material, x, y) => setContextMenu({ material, x, y })}
            onImport={importFiles}
            onLink={() => setShowLink(true)}
            onDemo={() => void createDemo()}
            onCreateTopic={createTopicFromMaterials}
          />
        )}
      </main>
      {selected && !showExplorer && (
        <ContextPanel material={selected} topics={topics} activeTopic={activeTopic} onClose={() => setSelected(null)} onRefresh={activeTopic ? topicRefresh : refresh} onOpenTopic={openTopic}/>
      )}
      {showSources && <SourcePanel onClose={() => setShowSources(false)} onChanged={refresh}/>}
      {showNote && (
        <NoteDialog onClose={() => setShowNote(false)} onSave={async (title, text, format) => {
          if (format === 'note') await window.materialMap.materials.note(title, text)
          else await window.materialMap.materials.document(title, text, format)
          setShowNote(false)
          await refresh()
        }}/>
      )}
      {showLink && (
        <LinkDialog onClose={() => setShowLink(false)} onSave={async (url) => {
          await window.materialMap.materials.link(url)
          setShowLink(false)
          await refresh()
        }}/>
      )}
      {showTopic && (
        <TopicDialog onClose={() => setShowTopic(false)} onSave={async (name, description) => {
          const topic = await window.materialMap.topics.create(name, description) as Topic
          setShowTopic(false)
          await refresh()
          void openTopic(topic)
        }}/>
      )}
      {showSettings && <SettingsDialog topicId={activeTopic?.topic.id} onClose={() => setShowSettings(false)}/>}
      {contextMenu && (
        <MaterialMenu
          material={contextMenu.material}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpen={() => setSelected(contextMenu.material)}
          onRefresh={refresh}
          onMessage={setMessage}
        />
      )}
      <Toast message={message} onClose={() => setMessage('')}/>
    </div>
  )
}
