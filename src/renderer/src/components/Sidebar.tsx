import { useState } from 'react'
import { Archive, Bot, ChevronRight, FolderOpen, Map, Network, Plus, Search, Settings2, Trash2, Upload } from 'lucide-react'
import type { Topic, Workspace } from '../types'
import type { RecentWorkspace } from './Welcome'

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
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Network size={19}/></div><span>Material Map</span></div>
      <button className="workspace-switch" onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu)}>
        <span className="workspace-dot"/><span>{workspace.name}</span><ChevronRight size={15}/>
      </button>
      {showWorkspaceMenu && (
        <div className="workspace-popover">
          <button onClick={onCreateWorkspace}>新建工作区</button>
          <button onClick={onOpenWorkspace}>打开工作区</button>
          <button onClick={onImportWorkspace}>导入工作区</button>
          {recentWorkspaces.filter((item) => item.root !== workspace.root).map((item) => (
            <button key={item.root} onClick={() => onOpenRecent(item.root)}>{item.name}</button>
          ))}
          <button onClick={onCloseWorkspace}>关闭工作区</button>
        </div>
      )}
      <nav>
        <button className={!activeTopicId && !showExplorer && !showChat ? 'nav-item active' : 'nav-item'} onClick={onShowWorkbench}><Archive size={17}/>工作台</button>
        <button className={showExplorer ? 'nav-item active' : 'nav-item'} onClick={onShowExplorer}><Search size={17}/>探索</button>
        <button className={showChat ? 'nav-item active' : 'nav-item'} onClick={onShowChat}><Bot size={17}/>知识库问答</button>
        <div className="nav-section">
          <span>主题</span>
          <button title="新建主题" onClick={onNewTopic}><Plus size={15}/></button>
        </div>
        {topics.map((topic) => (
          <button key={topic.id} className={activeTopicId === topic.id ? 'topic-item active' : 'topic-item'} onClick={() => onOpenTopic(topic)}>
            <Map size={15}/>{topic.name}
          </button>
        ))}
        <div className="nav-section archived-heading">
          <button className="archived-toggle" onClick={() => setShowArchived((value) => !value)}>
            <Archive size={14}/>已归档 {archivedTopics.length ? `(${archivedTopics.length})` : ''}
          </button>
        </div>
        {showArchived && archivedTopics.map((topic) => (
          <div className="archived-topic" key={topic.id}>
            <span>{topic.name}</span>
            <button title="还原主题" onClick={() => onRestoreTopic(topic)}>还原</button>
            <button title="永久删除主题记录" onClick={() => onDeleteArchivedTopic(topic)}><Trash2 size={13}/></button>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={onShowSources}><FolderOpen size={17}/>文件夹来源</button>
        <button className="nav-item" onClick={onShowSettings}><Settings2 size={17}/>模型与隐私</button>
        <button className="nav-item" onClick={onExportWorkspace}><Upload size={17}/>导出工作区</button>
      </div>
    </aside>
  )
}
