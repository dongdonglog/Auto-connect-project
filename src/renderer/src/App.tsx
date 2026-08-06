import React, { useEffect, useState } from 'react'
import { Archive, ArrowLeft, Plus, Search, Upload } from 'lucide-react'
import type { Material, Topic, TopicMap, Workspace } from './types'
import { syncImportNotices, type ImportNotice } from './import-state'
import { TopicBoardPage as TopicBoard } from './features/topics/TopicBoardPage'
import { SourcePanel } from './features/sources/SourcePanel'
import { Welcome } from './components/Welcome'
import { Sidebar } from './components/Sidebar'
import { Workbench } from './components/Workbench'
import { Explorer } from './components/Explorer'
import { KnowledgeChatPage } from './features/workbench/KnowledgeChatPage'
import { ContextPanel } from './components/ContextPanel'
import { ImportQueue } from './components/ImportQueue'
import { MaterialMenu } from './components/MaterialMenu'
import { LinkDialog, NoteDialog, SettingsDialog, TopicDialog, WorkspaceDialog, WorkspacePasswordDialog } from './components/Dialogs'
import { Toast } from './components/Toast'
import { useI18n } from './i18n'

export default function App(): React.ReactElement {
  const { t } = useI18n()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<Array<{ root: string; name: string; openedAt: string }>>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialTopics, setMaterialTopics] = useState<Record<string, Topic[]>>({})
  const [topics, setTopics] = useState<Topic[]>([])
  const [archivedTopics, setArchivedTopics] = useState<Topic[]>([])
  const [selected, setSelected] = useState<Material | null>(null)
  const [showExplorer, setShowExplorer] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [explorerMaterialId, setExplorerMaterialId] = useState<string | null>(null)
  const [activeTopic, setActiveTopic] = useState<TopicMap | null>(null)
  const [query, setQuery] = useState('')
  const [showNote, setShowNote] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [showTopic, setShowTopic] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [showSources, setShowSources] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [passwordRequest, setPasswordRequest] = useState<{ kind: 'open' | 'import'; name: string; root?: string; file?: string; destination?: string } | null>(null)
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
      setShowChat(false)
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
      const info = await window.materialMap.workspace.inspect(root)
      if (info.encrypted) { setPasswordRequest({ kind: 'open', name: info.name, root }); return }
      setWorkspace(await window.materialMap.workspace.open(root) as Workspace)
      await refreshRecent()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('app.workspaceOpenError'))
    }
  }
  const importWorkspace = async () => {
    const file = await window.materialMap.choosePackage()
    if (!file) return
    const destination = await window.materialMap.chooseDirectory()
    if (!destination) return
    try {
      const info = await window.materialMap.workspace.inspectPackage(file)
      if (info.encrypted) { setPasswordRequest({ kind: 'import', name: info.name, file, destination }); return }
      setWorkspace(await window.materialMap.workspace.import(file, destination) as Workspace)
      await refreshRecent()
      setMessage(t('app.workspaceImported'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('app.workspaceImportError'))
    }
  }
  const openRecent = async (root: string) => {
    try {
      const info = await window.materialMap.workspace.inspect(root)
      if (info.encrypted) { setPasswordRequest({ kind: 'open', name: info.name, root }); return }
      setWorkspace(await window.materialMap.workspace.open(root) as Workspace)
      await refreshRecent()
    } catch {
      setMessage(t('app.workspaceOpenFailed'))
    }
  }
  const exportWorkspace = async () => {
    const destination = await window.materialMap.savePackage()
    if (destination) {
      await window.materialMap.workspace.export(destination)
      setMessage(t('app.workspaceExported'))
    }
  }
  const createDemo = async () => {
    try {
      const topic = await window.materialMap.demo.create() as Topic
      await refresh()
      await openTopic(topic)
      setMessage(t('app.demoCreated'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('app.createDemoFailed'))
    }
  }
  const createTopicFromMaterials = async (materialIds: string[]) => {
    const name = window.prompt(t('dialog.topicName'))
    if (!name?.trim()) return
    const topic = await window.materialMap.topics.create(name.trim()) as Topic
    await window.materialMap.topics.addMaterials(topic.id, materialIds)
    await refresh()
    setActiveTopic(await window.materialMap.topics.map(topic.id) as TopicMap)
    setSelected(null)
    setShowChat(false)
    setMessage(t('app.materialsAdded', { count: materialIds.length }))
  }

  const passwordDialog = passwordRequest && <WorkspacePasswordDialog title={passwordRequest.kind === 'open' ? t('dialog.openEncryptedWorkspace') : t('dialog.importEncryptedWorkspace')} name={passwordRequest.name} onClose={() => setPasswordRequest(null)} onSubmit={async (password) => {
    const request = passwordRequest
    if (request.kind === 'open' && request.root) setWorkspace(await window.materialMap.workspace.open(request.root, password) as Workspace)
    if (request.kind === 'import' && request.file && request.destination) setWorkspace(await window.materialMap.workspace.import(request.file, request.destination, password) as Workspace)
    setPasswordRequest(null)
    await refreshRecent()
  }}/>

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
            onSave={async (name, password) => {
              try {
                setWorkspace(await window.materialMap.workspace.create(workspaceRoot, name, password) as Workspace)
                setWorkspaceRoot(null)
                await refreshRecent()
              } catch (error) {
                setMessage(error instanceof Error ? error.message : '无法创建工作区')
              }
            }}
          />
        )}
        {passwordDialog}
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
    setShowChat(false)
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
        showChat={showChat}
        onShowWorkbench={() => { setActiveTopic(null); setSelected(null); setShowExplorer(false); setShowChat(false) }}
        onShowExplorer={() => { setActiveTopic(null); setSelected(null); setShowExplorer(true); setShowChat(false) }}
        onShowChat={() => { setActiveTopic(null); setSelected(null); setShowExplorer(false); setShowChat(true) }}
        onOpenTopic={(topic) => void openTopic(topic)}
        onNewTopic={() => setShowTopic(true)}
        onCreateWorkspace={() => void createWorkspace()}
        onOpenWorkspace={() => void openWorkspace()}
        onImportWorkspace={() => void importWorkspace()}
        onOpenRecent={(root) => void openRecent(root)}
        onCloseWorkspace={() => setWorkspace(null)}
        onRestoreTopic={async (topic) => { await window.materialMap.topics.restore(topic.id); await refreshTopics(); setMessage(t('app.topicRestored', { name: topic.name })) }}
        onDeleteArchivedTopic={async (topic) => {
          if (!window.confirm(t('app.deleteTopicConfirm', { name: topic.name }))) return
          await window.materialMap.topics.deleteArchived(topic.id)
          await refreshTopics()
        }}
        onShowSources={() => setShowSources(true)}
        onShowSettings={() => setShowSettings(true)}
        onExportWorkspace={() => void exportWorkspace()}
      />
      <main
        className={`main${showChat && !activeTopic && !showExplorer ? ' knowledge-chat-main' : ''}`}
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
                <button className="back-button" onClick={() => { setActiveTopic(null); setShowChat(false) }}><ArrowLeft size={17}/>{t('app.backToWorkbench')}</button>
                <h1>{activeTopic.topic.name}</h1>
              </>
            ) : showExplorer ? (
              <>
                <h1>{t('app.explorer')}</h1>
                <p>{t('app.explorerSubtitle')}</p>
              </>
            ) : showChat ? (
              <><h1>{t('app.chat')}</h1><p>{t('app.chatSubtitle')}</p></>
            ) : (
              <>
                <h1>{t('app.workbench')}</h1>
                <p>{t('app.workbenchSubtitle')}</p>
              </>
            )}
          </div>
          <div className="top-actions">
            <label className="search">
              <Search size={16}/>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('app.searchPlaceholder')}
              />
            </label>
            {activeTopic && (
              <button className="secondary-button" onClick={async () => {
                if (!window.confirm(t('app.archiveTopicConfirm', { name: activeTopic.topic.name }))) return
                await window.materialMap.topics.archive(activeTopic.topic.id)
                setActiveTopic(null)
                await refresh()
                setMessage(t('app.topicArchived'))
              }}><Archive size={15}/>{t('app.archiveTopic')}</button>
            )}
            <button className="icon-button" title={t('app.importFile')} aria-label={t('app.importFile')} onClick={() => void importFiles()}><Upload size={18}/></button>
            <button className="primary-button" onClick={() => setShowNote(true)}><Plus size={17}/>{t('app.newMaterial')}</button>
          </div>
        </header>
        {imports.length > 0 && (
          <ImportQueue items={imports} onRetry={(path, keepDuplicate) => void importPaths([path], keepDuplicate)} onClear={() => setImports([])}/>
        )}
        {activeTopic ? (
          <TopicBoard
            map={activeTopic}
            materials={materials}
            onRefresh={topicRefresh}
            onImportFiles={(paths, position) => importPaths(paths, false, { topicId: activeTopic.topic.id, position })}
          />
        ) : showExplorer ? (
          <Explorer materials={materials} topics={topics} initialMaterialId={explorerMaterialId} onSelect={(material) => setExplorerMaterialId(material.id)} onChanged={refresh}/>
        ) : showChat ? (
          <KnowledgeChatPage key={workspace.id} workspaceId={workspace.id} settingsRevision={settingsRevision} onConfigure={() => setShowSettings(true)} onOpenCitation={(citation) => openExplorerById(citation.materialId)}/>
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
      {showSettings && (
        <SettingsDialog topicId={activeTopic?.topic.id} onClose={() => { setShowSettings(false); setSettingsRevision((revision) => revision + 1) }}/>
      )}
      {passwordDialog}
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
