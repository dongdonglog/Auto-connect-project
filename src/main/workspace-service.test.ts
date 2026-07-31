import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('moves materials to ungrouped when deleting a workstream and preserves relations', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Review')
    const stream = service.createWorkstream(topic.id, 'Research')
    service.addToTopic(topic.id, source.id, stream.id)
    service.addToTopic(topic.id, target.id, stream.id)
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: 'supports', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.deleteWorkstream(stream.id)
    const map = service.topicMap(topic.id)
    expect(map.workstreams).toHaveLength(0)
    expect(map.materials.every((material) => material.workstreamId === null)).toBe(true)
    expect(map.relations).toEqual(expect.arrayContaining([expect.objectContaining({ id: relation.id })]))
  })

  it('persists free-canvas positions for topic materials', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Canvas card', 'Placed freely on the board.')
    const topic = service.createTopic('Canvas')
    service.addToTopic(topic.id, material.id)
    service.positionMaterial(topic.id, material.id, 418, 236)
    expect(service.topicMap(topic.id).materials[0]).toMatchObject({ id: material.id, canvasX: 418, canvasY: 236 })
  })

  it('stores card and relation colors per topic without changing another topic', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const first = service.createTopic('First'); const second = service.createTopic('Second')
    for (const topic of [first, second]) { service.addToTopic(topic.id, source.id); service.addToTopic(topic.id, target.id) }
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: 'supports', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.updateCardStyle(first.id, source.id, { color: '#3568B8', tags: ['重点', '重点', ' 需求 '], note: '只在第一个主题显示。' })
    service.updateRelationStyle(first.id, relation.id, { color: '#a14569' })
    expect(service.topicMap(first.id).materials.find((item) => item.id === source.id)).toMatchObject({ cardColor: '#3568b8', cardTags: ['重点', '需求'], cardNote: '只在第一个主题显示。' })
    expect(service.topicMap(first.id).relations.find((item) => item.id === relation.id)?.lineColor).toBe('#a14569')
    expect(service.topicMap(second.id).materials.find((item) => item.id === source.id)).toMatchObject({ cardColor: null, cardTags: [], cardNote: null })
    expect(service.topicMap(second.id).relations.find((item) => item.id === relation.id)?.lineColor).toBeNull()
    expect(() => service.updateCardStyle(first.id, source.id, { color: 'blue' })).toThrow('six-digit')
  })

  it('removes a material from a topic without deleting the material or its workspace data', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Reusable', 'Keep this material in the workspace.')
    const topic = service.createTopic('Board')
    service.addToTopic(topic.id, material.id)
    service.removeFromTopic(topic.id, material.id)
    expect(service.topicMap(topic.id).materials).toHaveLength(0)
    expect(service.getMaterial(material.id)).toMatchObject({ title: 'Reusable' })
  })

  it('persists a batch topology layout and rejects duplicate or self relationships', async () => {
    const service = new WorkspaceService()
    await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'First material')
    const second = await service.createNote('Second', 'Second material')
    const topic = service.createTopic('Board')
    service.addToTopic(topic.id, first.id); service.addToTopic(topic.id, second.id)
    service.positionMaterials(topic.id, [{ materialId: first.id, x: 120, y: 80 }, { materialId: second.id, x: 430, y: 80 }])
    service.createRelation({ sourceMaterialId: first.id, targetMaterialId: second.id, label: 'supports', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    expect(() => service.createRelation({ sourceMaterialId: first.id, targetMaterialId: second.id, label: 'duplicates', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })).toThrow('already exists')
    expect(() => service.createRelation({ sourceMaterialId: first.id, targetMaterialId: first.id, label: 'self', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })).toThrow('cannot be related')
    expect(service.topicMap(topic.id).materials).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, canvasX: 120, canvasY: 80 }), expect.objectContaining({ id: second.id, canvasX: 430, canvasY: 80 })]))
  })

  it('allows a formal manual relation beside an AI suggestion in the same direction', async () => {
    const service = new WorkspaceService(); await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'A'); const target = await service.createNote('Target', 'B')
    const topic = service.createTopic('Board'); service.addMaterialsToTopic(topic.id, [source.id, target.id])
    service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: 'AI 建议', relationType: 'related', evidenceText: 'A', evidenceMaterialId: source.id, confidence: .7, createdBy: 'ai' })
    const manual = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: '正式关联', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.updateRelationStyle(topic.id, manual.id, { sourceArrowStyle: 'diamond', targetArrowStyle: 'open-triangle', lineKind: 'bezier', animated: false })
    expect(service.topicMap(topic.id).relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, createdBy: 'manual', sourceArrowStyle: 'diamond', targetArrowStyle: 'open-triangle', lineKind: 'bezier', animated: false })
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

  it('finishes a small Markdown import and tracks same-named materials independently', async () => {
    const root = makeRoot(); const firstPath = join(root, 'first', 'notes.md'); const secondPath = join(root, 'second', 'notes.md')
    mkdirSync(join(root, 'first')); mkdirSync(join(root, 'second'))
    writeFileSync(firstPath, `# First\n${'a'.repeat(12_300)}`); writeFileSync(secondPath, '# Second\nDifferent content')
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const [first, second] = await Promise.all([service.importFile(firstPath), service.importFile(secondPath)])
    await vi.waitFor(() => expect([service.getMaterial(first.material.id)?.status, service.getMaterial(second.material.id)?.status]).toEqual(['complete', 'complete']))
    expect(service.getMaterial(first.material.id)?.extractedText).toHaveLength(12_308)
    expect(service.getMaterial(second.material.id)?.extractedText).toContain('Different content')
  })

  it('imports files over 10 MB without starting automatic extraction', async () => {
    const root = makeRoot(); const sourcePath = join(root, 'large.md'); writeFileSync(sourcePath, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'))
    const service = new WorkspaceService(); await service.create(join(root, 'workspace'), 'Materials')
    const imported = await service.importFile(sourcePath)
    expect(service.getMaterial(imported.material.id)).toMatchObject({ status: 'paused', error: expect.stringContaining('10 MB') })
    expect(service.listJobs()).toEqual(expect.arrayContaining([expect.objectContaining({ materialId: imported.material.id, status: 'paused' })]))
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

  it('exports and imports a workspace package into a new destination', async () => {
    const root = makeRoot(); const source = join(root, 'source-workspace'); const destination = join(root, 'imported-workspace'); const packagePath = join(root, 'research.material-workspace')
    const service = new WorkspaceService(); await service.create(source, 'Research')
    await service.createNote('Imported note', 'This survives workspace package import.')
    await service.exportPackage(packagePath)
    const imported = new WorkspaceService()
    await imported.importPackage(packagePath, destination)
    expect(imported.summary()).toMatchObject({ root: destination, name: 'Research' })
    expect(imported.search('survives')).toHaveLength(1)
  })

  it('archives a topic without deleting its materials, styles, or positions', async () => {
    const service = new WorkspaceService(); await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Keep me', 'This remains in the workspace.')
    const topic = service.createTopic('Archive me')
    service.addToTopic(topic.id, material.id); service.positionMaterial(topic.id, material.id, 320, 180)
    service.updateCardStyle(topic.id, material.id, { color: '#3568b8', tags: ['保留'], note: 'Still here.' })
    service.archiveTopic(topic.id)
    expect(service.listTopics()).toHaveLength(0)
    expect(service.listArchivedTopics()).toMatchObject([{ id: topic.id }])
    expect(service.getMaterial(material.id)).toMatchObject({ title: 'Keep me' })
    await service.restoreTopic(topic.id)
    expect(service.topicMap(topic.id).materials[0]).toMatchObject({ id: material.id, canvasX: 320, canvasY: 180, cardColor: '#3568b8', cardTags: ['保留'] })
  })

  it('adds a material batch to one topic and returns only real memberships', async () => {
    const service = new WorkspaceService(); await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'A'); const second = await service.createNote('Second', 'B')
    const included = service.createTopic('Included'); const other = service.createTopic('Other')
    service.addMaterialsToTopic(included.id, [first.id, second.id, first.id]); service.addToTopic(other.id, second.id)
    expect(service.topicMap(included.id).materials).toHaveLength(2)
    expect(service.topicsForMaterial(first.id)).toMatchObject([{ id: included.id }])
    expect(service.topicsForMaterial(second.id).map((topic) => topic.id).sort()).toEqual([included.id, other.id].sort())
  })

  it('stores manual card order and restores the time-based order without changing material dates', async () => {
    const service = new WorkspaceService(); await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'A'); const second = await service.createNote('Second', 'B')
    const topic = service.createTopic('Order'); service.addMaterialsToTopic(topic.id, [first.id, second.id])
    service.updateCardOrder(topic.id, second.id, 1)
    expect(service.topicMap(topic.id).materials.find((item) => item.id === second.id)).toMatchObject({ sequence: 1, sequenceSource: 'manual' })
    service.resetCardOrder(topic.id)
    expect(service.topicMap(topic.id).materials.every((item) => item.sequence === null && item.sequenceSource === 'time')).toBe(true)
    expect(service.getMaterial(second.id)?.occurredAt).toBe(second.importedAt)
  })

  it('uses the most recently added real topic membership as the primary workbench topic', async () => {
    const service = new WorkspaceService(); await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Shared', 'Reusable')
    const older = service.createTopic('Older'); service.addToTopic(older.id, material.id)
    const newer = service.createTopic('Newer'); service.addToTopic(newer.id, material.id)
    expect(service.topicsForMaterial(material.id).map((topic) => topic.id)).toEqual([newer.id, older.id])
    expect(service.listMaterialsWithTopics().find((item) => item.id === material.id)?.topics[0]?.id).toBe(newer.id)
  })
})
