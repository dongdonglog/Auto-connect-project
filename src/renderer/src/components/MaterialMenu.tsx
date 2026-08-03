import type { Material } from '../types'

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
  const editable = material.type === 'note' || material.type === 'document' || (material.type === 'file' && /\.(md|txt|csv|json|html?)$/i.test(material.sourcePath ?? material.storedPath ?? ''))
  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action()
      await onRefresh()
      onMessage(message)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '操作失败。')
    } finally {
      onClose()
    }
  }
  return (
    <div className="material-menu" style={{ left: x, top: y }} onMouseLeave={onClose}>
      <button onClick={() => { onOpen(); onClose() }}>{editable ? '编辑内容' : '查看材料'}</button>
      <button onClick={() => void act(() => window.materialMap.materials.open(material.id), '已交给默认程序打开。')}>{material.type === 'link' ? '打开链接' : '用默认程序打开'}</button>
      <button onClick={() => {
        const title = window.prompt('材料名称', material.title)
        if (title?.trim()) void act(() => window.materialMap.materials.rename(material.id, title), '材料已重命名。')
      }}>重命名</button>
      {material.sourcePath && <button onClick={() => void act(() => window.materialMap.materials.importNewVersion(material.id), '已导入为新版本。')}>导入为新版本</button>}
      <button className="danger" onClick={() => {
        if (window.confirm(`删除“${material.title}”？原始导入文件不会被删除。`)) void act(() => window.materialMap.materials.delete(material.id), '材料已删除。')
      }}>删除材料</button>
    </div>
  )
}
