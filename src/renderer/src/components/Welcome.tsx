import { FolderOpen, Network, Plus, Upload, X } from 'lucide-react'

export interface RecentWorkspace {
  root: string
  name: string
  openedAt: string
}

export interface WelcomeProps {
  recent: RecentWorkspace[]
  onCreate(): void
  onOpen(): void
  onImport(): void
  onRecent(root: string): void
  onForget(root: string): void
}

export function Welcome({ recent, onCreate, onOpen, onImport, onRecent, onForget }: WelcomeProps): React.ReactElement {
  return (
    <div className="welcome">
      <div className="welcome-mark"><Network size={32}/></div>
      <p className="eyebrow">LOCAL MATERIAL MAP</p>
      <h1>让材料自己长出脉络。</h1>
      <p className="welcome-copy">文件、笔记和链接都保留在自己的工作区。导入后，按你的主题和时间慢慢形成一张可编辑的材料地图。</p>
      <div className="welcome-actions">
        <button className="primary-button large" onClick={onCreate}><Plus size={18}/>创建工作区</button>
        <button className="secondary-button large" onClick={onOpen}><FolderOpen size={18}/>打开工作区</button>
        <button className="secondary-button large" onClick={onImport}><Upload size={18}/>导入工作区</button>
      </div>
      {recent.length > 0 && (
        <div className="recent-workspaces">
          <h2>最近工作区</h2>
          {recent.map((item) => (
            <div key={item.root}>
              <button onClick={() => onRecent(item.root)}>
                <FolderOpen size={15}/><span>{item.name}</span><small>{item.root}</small>
              </button>
              <button title="从最近列表移除" onClick={() => onForget(item.root)}><X size={14}/></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
