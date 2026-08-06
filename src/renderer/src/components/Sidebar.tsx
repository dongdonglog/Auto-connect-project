import { useState } from 'react'
import { Archive, Bot, ChevronRight, FolderOpen, Map, Network, Plus, Search, Settings2, Trash2, Upload } from 'lucide-react'
import type { Topic, Workspace } from '../types'
import type { RecentWorkspace } from './Welcome'
import { useI18n } from '../i18n'

export interface SidebarProps {
  workspace: Workspace
  recentWorkspaces: RecentWorkspace[]
  topics: Topic[]
  archivedTopics: Topic[]
  activeTopicId: string | null
  showExplorer: boolean
  showChat: boolean
  onShowWorkbench(): void
  onShowExplorer(): void
  onShowChat(): void
  onOpenTopic(topic: Topic): void
  onNewTopic(): void
  onCreateWorkspace(): void
  onOpenWorkspace(): void
  onImportWorkspace(): void
  onOpenRecent(root: string): void
  onCloseWorkspace(): void
  onRestoreTopic(topic: Topic): void
  onDeleteArchivedTopic(topic: Topic): void
  onShowSources(): void
  onShowSettings(): void
  onExportWorkspace(): void
}

export function Sidebar({ workspace, recentWorkspaces, topics, archivedTopics, activeTopicId, showExplorer, showChat, onShowWorkbench, onShowExplorer, onShowChat, onOpenTopic, onNewTopic, onCreateWorkspace, onOpenWorkspace, onImportWorkspace, onOpenRecent, onCloseWorkspace, onRestoreTopic, onDeleteArchivedTopic, onShowSources, onShowSettings, onExportWorkspace }: SidebarProps): React.ReactElement {
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const { t } = useI18n()
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Network size={19}/></div><span>Material Map</span></div>
      <button className="workspace-switch" onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu)}>
        <span className="workspace-dot"/><span>{workspace.name}</span><ChevronRight size={15}/>
      </button>
      {showWorkspaceMenu && (
        <div className="workspace-popover">
          <button onClick={onCreateWorkspace}>{t('sidebar.createWorkspace')}</button>
          <button onClick={onOpenWorkspace}>{t('sidebar.openWorkspace')}</button>
          <button onClick={onImportWorkspace}>{t('sidebar.importWorkspace')}</button>
          {recentWorkspaces.filter((item) => item.root !== workspace.root).map((item) => (
            <button key={item.root} onClick={() => onOpenRecent(item.root)}>{item.name}</button>
          ))}
          <button onClick={onCloseWorkspace}>{t('sidebar.closeWorkspace')}</button>
        </div>
      )}
      <nav>
        <button className={!activeTopicId && !showExplorer && !showChat ? 'nav-item active' : 'nav-item'} onClick={onShowWorkbench}><Archive size={17}/>{t('sidebar.workbench')}</button>
        <button className={showExplorer ? 'nav-item active' : 'nav-item'} onClick={onShowExplorer}><Search size={17}/>{t('sidebar.explorer')}</button>
        <button className={showChat ? 'nav-item active' : 'nav-item'} onClick={onShowChat}><Bot size={17}/>{t('sidebar.chat')}</button>
        <div className="nav-section">
          <span>{t('sidebar.topics')}</span>
          <button title={t('sidebar.newTopic')} aria-label={t('sidebar.newTopic')} onClick={onNewTopic}><Plus size={15}/></button>
        </div>
        {topics.map((topic) => (
          <button key={topic.id} className={activeTopicId === topic.id ? 'topic-item active' : 'topic-item'} onClick={() => onOpenTopic(topic)}>
            <Map size={15}/>{topic.name}
          </button>
        ))}
        <div className="nav-section archived-heading">
          <button className="archived-toggle" onClick={() => setShowArchived((value) => !value)}>
            <Archive size={14}/>{t('sidebar.archived')} {archivedTopics.length ? `(${archivedTopics.length})` : ''}
          </button>
        </div>
        {showArchived && archivedTopics.map((topic) => (
          <div className="archived-topic" key={topic.id}>
            <span>{topic.name}</span>
            <button title={t('sidebar.restoreTopic')} onClick={() => onRestoreTopic(topic)}>{t('sidebar.restore')}</button>
            <button title={t('sidebar.deleteArchivedTopic')} aria-label={t('sidebar.deleteArchivedTopic')} onClick={() => onDeleteArchivedTopic(topic)}><Trash2 size={13}/></button>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={onShowSources}><FolderOpen size={17}/>{t('sidebar.sources')}</button>
        <button className="nav-item" onClick={onShowSettings}><Settings2 size={17}/>{t('sidebar.settings')}</button>
        <button className="nav-item" onClick={onExportWorkspace}><Upload size={17}/>{t('sidebar.exportWorkspace')}</button>
      </div>
    </aside>
  )
}
