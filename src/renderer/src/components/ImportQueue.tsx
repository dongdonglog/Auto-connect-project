import { CheckCircle2, LoaderCircle, X } from 'lucide-react'
import type { ImportNotice } from '../import-state'

export interface ImportQueueProps {
  items: ImportNotice[]
  onRetry(path: string, keepDuplicate?: boolean): void
  onClear(): void
}

export function ImportQueue({ items, onRetry, onClear }: ImportQueueProps): React.ReactElement {
  return (
    <section className="import-queue">
      <div>
        <strong>导入队列</strong>
        <button className="icon-button" title="清除记录" onClick={onClear}><X size={14}/></button>
      </div>
      {items.map((item) => (
        <div key={item.path}>
          <span>{item.title}</span>
          {item.status === 'duplicate'
            ? <small>已跳过重复文件 <button onClick={() => onRetry(item.path, true)}>仍然导入副本</button></small>
            : item.status === 'failed'
              ? <button onClick={() => onRetry(item.path)}>重试</button>
              : item.status === 'paused'
                ? <small>待按需解析</small>
                : item.status === 'complete'
                  ? <small className="complete"><CheckCircle2 size={13}/>已完成</small>
                  : <small><LoaderCircle size={13}/>正在解析</small>}
        </div>
      ))}
    </section>
  )
}
