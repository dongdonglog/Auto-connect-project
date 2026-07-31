import { describe, expect, it } from 'vitest'
import { syncImportNotices } from './import-state'
import type { Material } from './types'

const material = (overrides: Partial<Material> = {}): Material => ({ id: 'material-1', type: 'file', title: '09-Gin框架实战', mimeType: 'text/markdown', sourcePath: '/notes/09-Gin框架实战.md', storedPath: 'material-1.md', url: null, siteName: null, excerpt: '# Gin', extractedText: '# Gin', importedAt: '2026-07-31T00:00:00.000Z', occurredAt: null, occurredAtSource: 'import', status: 'complete', error: null, hash: 'hash', ...overrides })

describe('syncImportNotices', () => {
  it('repairs a stale queue item from its source path when the card is complete', () => {
    const notices = syncImportNotices([{ path: '/notes/09-Gin框架实战.md', title: '09-Gin框架实战', status: 'running' }], [material()])
    expect(notices[0]).toMatchObject({ materialId: 'material-1', status: 'complete' })
  })

  it('keeps duplicate notices distinct from the original material state', () => {
    const notices = syncImportNotices([{ path: '/notes/09-Gin框架实战.md', title: '09-Gin框架实战', materialId: 'material-1', status: 'duplicate' }], [material()])
    expect(notices[0].status).toBe('duplicate')
  })
})
