import type { Material } from '../types'
import { useI18n } from '../i18n'

export interface MaterialMenuProps {
  material: Material
  x: number
  y: number
  onClose(): void
  onOpen(): void
  onRefresh(): Promise<void>
  onMessage(message: string): void
}

export function MaterialMenu({ material, x, y, onClose, onOpen, onRefresh, onMessage }: MaterialMenuProps): React.ReactElement {
  const { t } = useI18n()
  const editable = material.type === 'note' || material.type === 'document' || (material.type === 'file' && /\.(md|txt|csv|json|html?)$/i.test(material.sourcePath ?? material.storedPath ?? ''))
  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action()
      await onRefresh()
      onMessage(message)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : t('material.operationFailed'))
    } finally {
      onClose()
    }
  }
  return (
    <div className="material-menu" style={{ left: x, top: y }} onMouseLeave={onClose}>
      <button onClick={() => { onOpen(); onClose() }}>{editable ? t('material.editContent') : t('material.view')}</button>
      <button onClick={() => void act(() => window.materialMap.materials.open(material.id), t('material.openedDefault'))}>{material.type === 'link' ? t('material.openLink') : t('material.openDefault')}</button>
      <button onClick={() => {
        const title = window.prompt(t('material.name'), material.title)
        if (title?.trim()) void act(() => window.materialMap.materials.rename(material.id, title), t('material.renamed'))
      }}>{t('material.name')}</button>
      {material.sourcePath && <button onClick={() => void act(() => window.materialMap.materials.importNewVersion(material.id), t('material.importedVersion'))}>{t('material.importVersion')}</button>}
      <button className="danger" onClick={() => {
        if (window.confirm(t('material.deleteConfirm', { title: material.title }))) void act(() => window.materialMap.materials.delete(material.id), t('material.deleted'))
      }}>{t('material.delete')}</button>
    </div>
  )
}
