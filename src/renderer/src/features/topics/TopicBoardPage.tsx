import { ErrorBoundary } from '../../app/ErrorBoundary'
import type { Material, TopicMap } from '../../types'
import { TopicCanvas } from './TopicCanvas'

export function TopicBoardPage({ map, materials, onRefresh, onSelect, onImportFiles, onBack }: { map: TopicMap; materials: Material[]; onRefresh(): Promise<void>; onSelect(material: Material): void; onImportFiles(paths: string[], position: { x: number; y: number }): Promise<void>; onBack?: () => void }): React.ReactElement {
  return <ErrorBoundary fallback={(error, retry) => <section className="topic-error"><h2>主题画板无法加载</h2><p>{error.message || '主题数据或画布渲染发生错误。'}</p>{onBack && <button className="secondary-button" onClick={onBack}>返回工作台</button>}<button className="primary-button" onClick={retry}>重试</button></section>}><TopicCanvas map={map} materials={materials} onRefresh={onRefresh} onSelect={onSelect} onImportFiles={onImportFiles} /></ErrorBoundary>
}
