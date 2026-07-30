import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service'

const roots: string[] = []
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'material-map-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('WorkspaceService', () => {
  it('stores notes, topics, workstreams, and editable relations locally', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Interview notes', 'Customer feedback on 2026-07-20')
    const target = await service.createNote('Requirements', 'Prioritize offline support')
    const topic = service.createTopic('Offline project')
    const stream = service.createWorkstream(topic.id, 'Research')
    service.addToTopic(topic.id, source.id, stream.id)
    service.addToTopic(topic.id, target.id, stream.id)
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: 'informs', relationType: 'related', evidenceText: 'Customer feedback', evidenceMaterialId: source.id, confidence: 0.88, createdBy: 'manual' })
    service.updateRelation(relation.id, 'supports')
    const map = service.topicMap(topic.id)
    expect(map.materials).toHaveLength(2)
    expect(map.workstreams[0].name).toBe('Research')
    expect(map.relations[0].label).toBe('supports')
    expect(service.search('offline')).toHaveLength(1)
  })

  it('keeps relations when a material moves to another workstream', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Discovery', 'The initial research material.')
    const target = await service.createNote('Decision', 'The resulting decision material.')
    const topic = service.createTopic('Launch')
    const discovery = service.createWorkstream(topic.id, 'Discovery')
    const delivery = service.createWorkstream(topic.id, 'Delivery')
    service.addToTopic(topic.id, source.id, discovery.id)
    service.addToTopic(topic.id, target.id, delivery.id)
    const relation = service.createRelation({
      sourceMaterialId: source.id,
      targetMaterialId: target.id,
      label: 'leads to',
      relationType: 'related',
      evidenceText: 'Initial research material',
      evidenceMaterialId: source.id,
      confidence: 1,
      createdBy: 'manual'
    })

    service.moveMaterial(topic.id, source.id, delivery.id)
    const map = service.topicMap(topic.id)

    expect(map.materials.find((material) => material.id === source.id)?.workstreamId).toBe(delivery.id)
    expect(map.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: relation.id, sourceMaterialId: source.id, targetMaterialId: target.id, label: 'leads to' })
    ]))
  })

  it('records topic analysis job states and detects duplicate relations', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Analysis')
    service.addToTopic(topic.id, source.id)
    service.addToTopic(topic.id, target.id)
    const job = service.startJob(source.id, 'ai-analysis')
    expect(service.analysisStatus(topic.id)).toMatchObject({ running: 1, complete: 0, failed: 0, latestError: null })
    service.finishJob(job)
    service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: 'supports', relationType: 'related', evidenceText: 'Source material', evidenceMaterialId: source.id, confidence: 1, createdBy: 'ai' })
    expect(service.hasRelation(source.id, target.id, 'supports')).toBe(true)
    const failed = service.startJob(target.id, 'ai-analysis')
    service.failJob(failed, 'Model request timed out')
    expect(service.analysisStatus(topic.id)).toMatchObject({ running: 0, complete: 1, failed: 1, latestError: 'Model request timed out' })
  })

  it('recognizes exact duplicate imports without discarding the original', async () => {
    const root = makeRoot(); const input = join(root, 'source.md'); writeFileSync(input, '# Hello\nA local material')
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const first = await service.importFile(input); const second = await service.importFile(input)
    expect(second.duplicateOf?.id).toBe(first.material.id)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    expect(service.listMaterials()).toHaveLength(1)
  })

  it('parses an imported file from its copied workspace path', async () => {
    const root = makeRoot(); const input = join(root, 'meeting.md'); writeFileSync(input, '# Meeting\nOffline search is required.')
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const imported = await service.importFile(input)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    expect(service.getMaterial(imported.material.id)?.title).toBe('meeting')
    expect(service.getMaterial(imported.material.id)?.extractedText).toContain('Offline search')
  })

  it('stores an encrypted workspace database and rejects an incorrect password', async () => {
    const root = join(makeRoot(), 'private-workspace')
    const service = new WorkspaceService()
    await service.create(root, 'Private', 'correct-horse-battery-staple')
    await service.createNote('Private note', 'This remains in the encrypted workspace.')
    expect(existsSync(join(root, 'workspace.sqlite.enc'))).toBe(true)
    const reopened = new WorkspaceService()
    await expect(reopened.open(root, 'wrong-password')).rejects.toThrow()
    await reopened.open(root, 'correct-horse-battery-staple')
    expect(reopened.search('encrypted')).toHaveLength(1)
  })

  it('saves workspace documents and creates a version when editing an imported text file', async () => {
    const root = makeRoot(); const sourcePath = join(root, 'source.txt'); writeFileSync(sourcePath, 'original text')
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const document = await service.createDocument('Plan', '# First draft', 'md')
    await service.saveTextMaterial(document.id, 'Plan revised', '# Revised draft')
    expect(service.getMaterial(document.id)).toMatchObject({ title: 'Plan revised', extractedText: '# Revised draft', type: 'document' })
    const imported = await service.importFile(sourcePath)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    const version = await service.saveTextMaterial(imported.material.id, 'source revision', 'changed text')
    expect(version.type).toBe('document')
    expect(service.listMaterials()).toHaveLength(3)
    expect(service.search('changed text')).toHaveLength(1)
  })

  it('deletes material metadata without deleting the original source file', async () => {
    const root = makeRoot(); const sourcePath = join(root, 'source.txt'); writeFileSync(sourcePath, 'original text')
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const imported = await service.importFile(sourcePath)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    const topic = service.createTopic('Review'); service.addToTopic(topic.id, imported.material.id)
    service.deleteMaterial(imported.material.id)
    expect(existsSync(sourcePath)).toBe(true)
    expect(service.getMaterial(imported.material.id)).toBeNull()
    expect(service.topicMap(topic.id).materials).toHaveLength(0)
  })
})
