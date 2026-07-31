import type { Material } from './types'

export type ImportNotice = { path: string; title: string; materialId?: string; status: Material['status'] | 'duplicate' }

export function syncImportNotices(notices: ImportNotice[], materials: Material[]): ImportNotice[] {
  return notices.map((notice) => {
    if (notice.status === 'duplicate') return notice
    const material = (notice.materialId ? materials.find((candidate) => candidate.id === notice.materialId) : undefined) ?? materials.find((candidate) => candidate.sourcePath === notice.path)
    if (!material || (notice.materialId === material.id && notice.status === material.status && notice.title === material.title)) return notice
    return { ...notice, materialId: material.id, title: material.title, status: material.status }
  })
}
