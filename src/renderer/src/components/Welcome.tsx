import { FolderOpen, Network, Plus, Upload, X } from 'lucide-react'
import { useI18n } from '../i18n'

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
  const { t, locale, setLocale } = useI18n()
  return (
    <div className="welcome">
      <div className="welcome-language"><label>{t('language')}<select value={locale} onChange={(event) => setLocale(event.target.value as 'zh-CN' | 'en-US')} aria-label={t('language')}><option value="zh-CN">{t('language.zh')}</option><option value="en-US">{t('language.en')}</option></select></label></div>
      <div className="welcome-mark"><Network size={32}/></div>
      <p className="eyebrow">{t('welcome.eyebrow')}</p>
      <h1>{t('welcome.title')}</h1>
      <p className="welcome-copy">{t('welcome.copy')}</p>
      <div className="welcome-actions">
        <button className="primary-button large" onClick={onCreate}><Plus size={18}/>{t('welcome.createWorkspace')}</button>
        <button className="secondary-button large" onClick={onOpen}><FolderOpen size={18}/>{t('welcome.openWorkspace')}</button>
        <button className="secondary-button large" onClick={onImport}><Upload size={18}/>{t('welcome.importWorkspace')}</button>
      </div>
      {recent.length > 0 && (
        <div className="recent-workspaces">
          <h2>{t('welcome.recentWorkspaces')}</h2>
          {recent.map((item) => (
            <div key={item.root}>
              <button onClick={() => onRecent(item.root)}>
                <FolderOpen size={15}/><span>{item.name}</span><small>{item.root}</small>
              </button>
              <button title={t('welcome.forgetRecent')} aria-label={t('welcome.forgetRecent')} onClick={() => onForget(item.root)}><X size={14}/></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
