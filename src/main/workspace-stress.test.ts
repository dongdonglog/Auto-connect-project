import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceService } from './workspace-service'

describe('WorkspaceService scale smoke', () => {
  it('indexes and searches a few hundred local notes without losing records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-stress-'))
    try {
      const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Stress')
      for (let index = 0; index < 250; index += 1) await service.createNote(`Note ${index}`, `Document ${index} contains local evidence token-${index}.`)
      expect(service.listMaterials()).toHaveLength(250)
      expect(service.searchKnowledge('token-249')[0]).toMatchObject({ title: 'Note 249' })
      const topic = service.createTopic('Large topic'); service.addMaterialsToTopic(topic.id, service.listMaterials().map((material) => material.id))
      const started = Date.now(); service.archiveTopic(topic.id); expect(Date.now() - started).toBeLessThan(2_000)
      expect(service.listArchivedTopics()).toMatchObject([{ id: topic.id }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('serves material relations for a fifty-document workspace within one second', async () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-relations-'))
    try {
      const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Relations')
      const materials = []
      for (let index = 0; index < 50; index += 1) materials.push(await service.createDocument(`doc-${index}.md`, `# Document ${index}\n${index ? `See [previous](doc-${index - 1}.md).` : 'SQLite local storage.'}\nSQLite relation evidence.`, 'md'))
      const started = performance.now()
      const relations = materials.flatMap((material) => service.listMaterialRelations(material.id, 5))
      const elapsed = performance.now() - started
      expect(relations.length).toBeGreaterThan(40)
      expect(elapsed).toBeLessThan(1_000)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)
})
