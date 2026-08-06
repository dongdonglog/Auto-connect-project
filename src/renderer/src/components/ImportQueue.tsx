import { CheckCircle2, LoaderCircle, X } from 'lucide-react'
import type { ImportNotice } from '../import-state'
import { useI18n } from '../i18n'

export interface ImportQueueProps {
  items: ImportNotice[]
  onRetry(path: string, keepDuplicate?: boolean): void
  onClear(): void
}

export function ImportQueue({ items, onRetry, onClear }: ImportQueueProps): React.ReactElement {
  const { t } = useI18n()
  return (
    <section className="import-queue">
      <div>
        <strong>{t('import.title')}</strong>
        <button className="icon-button" title={t('import.clear')} aria-label={t('import.clear')} onClick={onClear}><X size={14}/></button>
      </div>
      {items.map((item) => (
        <div key={item.path}>
          <span>{item.title}</span>
          {item.status === 'duplicate'
            ? <small>{t('import.duplicate')} <button onClick={() => onRetry(item.path, true)}>{t('import.importCopy')}</button></small>
            : item.status === 'failed'
              ? <button onClick={() => onRetry(item.path)}>{t('import.retry')}</button>
              : item.status === 'paused'
                ? <small>{t('import.paused')}</small>
                : item.status === 'complete'
                  ? <small className="complete"><CheckCircle2 size={13}/>{t('import.complete')}</small>
                  : <small><LoaderCircle size={13}/>{t('import.processing')}</small>}
        </div>
      ))}
    </section>
  )
}
