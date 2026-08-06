import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service'
import { chunkHash } from './indexer'

const roots: string[] = []
const services: WorkspaceService[] = []
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'material-map-')); roots.push(root); return root }
const makeService = () => { const service = new WorkspaceService(); services.push(service); return service }
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceService', () => {
  it('builds explainable material relations from explicit references and shared technical entities', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Explorer')
    const referenced = await service.createDocument('details.md', '# Redis details\nRedis persistence and cache policy.', 'md')
    const source = await service.createDocument('overview.md', '# Overview\nRead [details](details.md). Redis is used for cache policy.', 'md')
    const relations = service.listMaterialRelations(source.id)
    expect(relations).toEqual(expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ id: referenced.id }), relationType: 'references' })]))
    const relation = relations.find((item) => item.target.id === referenced.id)!
    expect(relation.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'explicit_reference', text: expect.stringContaining('引用了') })]))
    service.updateMaterialRelationStatus(relation.id, 'hidden')
    expect(service.listMaterialRelations(source.id)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: relation.id })]))
    service.updateMaterialRelationStatus(relation.id, 'visible')
    const fixed = service.fixMaterialRelation(relation.id)
    expect(fixed.createdBy).toBe('local')
    expect(service.listMaterialRelations(source.id).find((item) => item.id === relation.id)?.status).toBe('fixed')
  })

  it('resolves relative file references with their source offset and preserves status after reindexing', async () => {
    const root = makeRoot(); const files = join(root, 'files'); const docs = join(files, 'docs')
    mkdirSync(docs, { recursive: true })
    const targetPath = join(docs, 'details.md'); const sourcePath = join(files, 'overview.md')
    writeFileSync(targetPath, '# Details\nSQLite persistence details.')
    const sourceText = '# Overview\nRead [details](./docs/details.md) before implementation.'
    writeFileSync(sourcePath, sourceText)
    const service = makeService(); await service.create(join(root, 'workspace'), 'Explorer')
    const folder = await service.addFolderSource({ rootPath: files, enabled: true, includePatterns: [], excludePatterns: [], watchEnabled: false })
    await vi.waitFor(() => expect(service.listMaterials().every((material) => material.status === 'complete')).toBe(true))
    const target = service.listMaterials().find((material) => material.sourcePath === targetPath)!
    const source = service.listMaterials().find((material) => material.sourcePath === sourcePath)!
    const relation = service.listMaterialRelations(source.id).find((item) => item.target.id === target.id)!
    const evidence = relation.evidence.find((item) => item.type === 'explicit_reference')!
    expect(evidence).toMatchObject({ sourceMaterialId: source.id, targetMaterialId: target.id, sourceOffset: sourceText.indexOf('./docs/details.md'), sourceEndOffset: sourceText.indexOf('./docs/details.md') + './docs/details.md'.length, sourceHeading: 'Overview' })
    expect(evidence.text).toContain('docs/details.md')

    service.updateMaterialRelationStatus(relation.id, 'hidden')
    writeFileSync(sourcePath, `${sourceText}\nSQLite is local.`)
    await service.rescanFolderSource(folder.id)
    await vi.waitFor(() => expect(service.getMaterial(source.id)?.extractedText).toContain('SQLite is local.'))
    service.updateMaterialRelationStatus(relation.id, 'visible')
    expect(service.listMaterialRelations(source.id).find((item) => item.id === relation.id)?.status).toBe('visible')

    service.fixMaterialRelation(relation.id)
    writeFileSync(sourcePath, `${sourceText}\nSQLite remains local.`)
    await service.rescanFolderSource(folder.id)
    await vi.waitFor(() => expect(service.getMaterial(source.id)?.extractedText).toContain('SQLite remains local.'))
    expect(service.listMaterialRelations(source.id).find((item) => item.id === relation.id)?.status).toBe('fixed')
  })

  it('fixes a material relation into the selected topic with both materials', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Explorer')
    const details = await service.createDocument('details.md', '# Details\nSQLite persistence details.', 'md')
    const overview = await service.createDocument('overview.md', '# Overview\nRead [details](details.md).', 'md')
    const relation = service.listMaterialRelations(overview.id).find((item) => item.target.id === details.id)!
    const topic = service.createTopic('Storage')
    const fixed = service.fixMaterialRelation(relation.id, topic.id)
    expect(fixed.createdBy).toBe('local')
    expect(service.topicMap(topic.id)).toMatchObject({ materials: expect.arrayContaining([expect.objectContaining({ id: overview.id }), expect.objectContaining({ id: details.id })]), relations: expect.arrayContaining([expect.objectContaining({ id: fixed.id, createdBy: 'local', sourceArrowStyle: null, targetArrowStyle: 'triangle' })]) })
    expect(service.listMaterialRelations(overview.id).find((item) => item.id === relation.id)?.status).toBe('fixed')
  })

  it('restores material relation evidence with a workspace package', async () => {
    const root = makeRoot(); const source = join(root, 'source-workspace'); const destination = join(root, 'imported-workspace'); const packagePath = join(root, 'relations.material-workspace')
    const service = makeService(); await service.create(source, 'Explorer')
    const target = await service.createDocument('target.md', '# Target\nSQLite basics.', 'md')
    const material = await service.createDocument('source.md', '# Source\nSee target.md for SQLite basics.', 'md')
    const relation = service.listMaterialRelations(material.id).find((item) => item.target.id === target.id)!
    service.fixMaterialRelation(relation.id)
    await service.exportPackage(packagePath)
    const restored = makeService(); await restored.importPackage(packagePath, destination)
    expect(restored.listMaterialRelations(material.id).find((item) => item.target.id === target.id)).toMatchObject({ status: 'fixed', evidence: expect.any(Array) })
  })

  it('does not rebuild complete material relations each time a workspace opens', async () => {
    const root = join(makeRoot(), 'workspace')
    const service = makeService(); await service.create(root, 'Explorer')
    await service.createDocument('details.md', '# Details\nSQLite.', 'md')
    await service.createDocument('overview.md', '# Overview\nSee details.md.', 'md')
    service.close()

    const reopened = makeService()
    const rebuild = vi.spyOn(reopened as never, 'rebuildMaterialRelations')
    await reopened.open(root)
    expect(rebuild).not.toHaveBeenCalled()
    reopened.close()
  })

  it('stores notes, topics, workstreams, and editable relations locally', async () => {
    const service = makeService()
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
    const service = makeService()
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
    const service = makeService()
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
    const service = makeService()
    await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Canvas card', 'Placed freely on the board.')
    const topic = service.createTopic('Canvas')
    service.addToTopic(topic.id, material.id)
    service.positionMaterial(topic.id, material.id, 418, 236)
    expect(service.topicMap(topic.id).materials[0]).toMatchObject({ id: material.id, canvasX: 418, canvasY: 236 })
  })

  it('allows an unnamed one-way manual relation', async () => {
    const service = makeService()
    await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board')
    service.addMaterialsToTopic(topic.id, [source.id, target.id])
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: '', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.updateRelationStyle(topic.id, relation.id, { sourceArrowStyle: 'none' })
    expect(service.topicMap(topic.id).relations.find((item) => item.id === relation.id)).toMatchObject({ label: '', sourceArrowStyle: 'none', targetArrowStyle: 'triangle' })
  })

  it('preserves a source arrow explicitly enabled by the user', async () => {
    const root = makeRoot()
    const service = makeService()
    await service.create(root, 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board')
    service.addMaterialsToTopic(topic.id, [source.id, target.id])
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: '', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.updateRelationStyle(topic.id, relation.id, { sourceArrowStyle: 'triangle' })
    service.close()
    await service.open(root)
    expect(service.topicMap(topic.id).relations.find((item) => item.id === relation.id)?.sourceArrowStyle).toBe('triangle')
  })

  it('stores card and relation colors per topic without changing another topic', async () => {
    const service = makeService()
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

  it('persists topic editor commands, card display overrides, and redo history across reopening', async () => {
    const root = makeRoot()
    const service = makeService()
    await service.create(root, 'Research')
    const source = await service.createNote('Original title', 'Original material excerpt.')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board')
    service.addMaterialsToTopic(topic.id, [source.id, target.id])

    service.executeTopicEditorCommand(topic.id, { kind: 'moveCards', payload: { positions: [{ materialId: source.id, x: 320, y: 180 }] } })
    service.executeTopicEditorCommand(topic.id, { kind: 'patchCard', payload: { materialId: source.id, patch: { displayTitle: 'Only on this board', displayExcerpt: 'Board-only summary', width: 300, height: 150, textColor: '#3568b8', fontSize: 16, collapsed: false, zIndex: 4, color: '#a14569' } } })
    service.executeTopicEditorCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: source.id, targetMaterialId: target.id, label: '', relationType: 'related', style: { sourceArrowStyle: 'none', targetArrowStyle: 'triangle', lineWidth: 4, lineDash: 'solid', routePoints: [{ x: 280, y: 80 }] } } } })

    expect(service.topicMap(topic.id).materials.find((material) => material.id === source.id)).toMatchObject({ title: 'Original title', displayTitle: 'Only on this board', displayExcerpt: 'Board-only summary', canvasX: 320, canvasY: 180, cardWidth: 300, cardHeight: 150, cardTextColor: '#3568b8', cardFontSize: 16, cardZIndex: 4, cardColor: '#a14569' })
    expect(service.topicMap(topic.id).relations).toEqual(expect.arrayContaining([expect.objectContaining({ sourceMaterialId: source.id, targetMaterialId: target.id, label: '', sourceArrowStyle: 'none', targetArrowStyle: 'triangle', lineWidth: 4, lineDash: 'solid', routePoints: [{ x: 280, y: 80 }] })]))
    expect(service.topicHistoryStatus(topic.id)).toMatchObject({ undo: true, redo: false, cursor: 3 })

    service.undoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).relations).toHaveLength(0)
    service.redoTopicEditorCommand(topic.id)
    service.close()
    await service.open(root)
    expect(service.topicHistoryStatus(topic.id)).toMatchObject({ undo: true, redo: false, cursor: 3 })
    service.undoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).relations).toHaveLength(0)
    service.undoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).materials.find((material) => material.id === source.id)).toMatchObject({ displayTitle: null, displayExcerpt: null, cardWidth: null, cardColor: null })
  })

  it('rolls back a failed editor command without leaving partial styles or history', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board'); service.addMaterialsToTopic(topic.id, [source.id, target.id])

    expect(() => service.executeTopicEditorCommand(topic.id, { kind: 'patchCard', payload: { materialId: source.id, patch: { displayTitle: 'Should not persist', color: 'invalid' } } })).toThrow('six-digit')
    expect(service.topicMap(topic.id).materials.find((material) => material.id === source.id)).toMatchObject({ displayTitle: null, cardColor: null })
    expect(service.topicHistoryStatus(topic.id)).toMatchObject({ cursor: 0, undo: false, redo: false })

    expect(() => service.executeTopicEditorCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: source.id, targetMaterialId: target.id, style: { sourceHandle: 'in-left' } } } })).toThrow('Invalid out port')
    expect(service.topicMap(topic.id).relations).toHaveLength(0)
    expect(service.topicHistoryStatus(topic.id)).toMatchObject({ cursor: 0, undo: false, redo: false })
  })

  it('persists all four-side port combinations and keeps relation edits scoped to the topic', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board'); const otherTopic = service.createTopic('Other')
    service.addMaterialsToTopic(topic.id, [source.id, target.id])
    service.addMaterialsToTopic(otherTopic.id, [source.id, target.id])
    const relation = service.createRelation({ sourceMaterialId: source.id, targetMaterialId: target.id, label: '', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    const sides = ['left', 'top', 'right', 'bottom'] as const
    for (const sourceSide of sides) for (const targetSide of sides) {
      service.updateRelationStyle(topic.id, relation.id, { sourceHandle: `out-${sourceSide}`, targetHandle: `in-${targetSide}` })
      expect(service.topicMap(topic.id).relations.find((item) => item.id === relation.id)).toMatchObject({ sourceHandle: `out-${sourceSide}`, targetHandle: `in-${targetSide}` })
    }
    expect(() => service.updateRelationStyle(otherTopic.id, relation.id, { lineWidth: 4 })).not.toThrow()
    expect(service.topicMap(topic.id).relations.find((item) => item.id === relation.id)?.lineWidth).toBe(2.75)
    expect(service.topicMap(otherTopic.id).relations.find((item) => item.id === relation.id)?.lineWidth).toBe(4)
    expect(() => service.updateRelationStyle(topic.id, relation.id, { sourceHandle: 'in-left' })).toThrow('Invalid out port')
  })

  it('reconnects a formal relation as a directed edge and supports undo/redo', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const source = await service.createNote('Source', 'Source material')
    const target = await service.createNote('Target', 'Target material')
    const topic = service.createTopic('Board'); service.addMaterialsToTopic(topic.id, [source.id, target.id])
    service.executeTopicEditorCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: source.id, targetMaterialId: target.id, style: { sourceHandle: 'out-right', targetHandle: 'in-left' } } } })
    const relation = service.topicMap(topic.id).relations[0]
    service.executeTopicEditorCommand(topic.id, { kind: 'reconnectRelation', payload: { relationId: relation.id, sourceMaterialId: target.id, targetMaterialId: source.id, sourceHandle: 'out-bottom', targetHandle: 'in-top' } })
    expect(service.topicMap(topic.id).relations[0]).toMatchObject({ sourceMaterialId: target.id, targetMaterialId: source.id, sourceHandle: 'out-bottom', targetHandle: 'in-top' })
    service.undoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).relations[0]).toMatchObject({ sourceMaterialId: source.id, targetMaterialId: target.id, sourceHandle: 'out-right', targetHandle: 'in-left' })
    service.redoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).relations[0]).toMatchObject({ sourceMaterialId: target.id, targetMaterialId: source.id, sourceHandle: 'out-bottom', targetHandle: 'in-top' })
  })

  it('keeps hidden Explorer relations hidden after a workspace restart', async () => {
    const root = makeRoot(); const service = makeService(); await service.create(root, 'Explorer')
    const target = await service.createDocument('target.md', '# Target\nSQLite basics.', 'md')
    const source = await service.createDocument('source.md', '# Source\nSee target.md for SQLite basics.', 'md')
    const relation = service.listMaterialRelations(source.id).find((item) => item.target.id === target.id)!
    service.updateMaterialRelationStatus(relation.id, 'hidden')
    service.close(); await service.open(root)
    expect(service.listMaterialRelations(source.id)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: relation.id })]))
    expect(service.listMaterialRelations(source.id, 20, true)).toEqual(expect.arrayContaining([expect.objectContaining({ id: relation.id, status: 'hidden' })]))
  })

  it('undoes a mixed card and relationship deletion as one editor operation', async () => {
    const service = makeService()
    await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'First material')
    const second = await service.createNote('Second', 'Second material')
    const third = await service.createNote('Third', 'Third material')
    const topic = service.createTopic('Board')
    service.addMaterialsToTopic(topic.id, [first.id, second.id, third.id])
    const detached = service.createRelation({ sourceMaterialId: second.id, targetMaterialId: third.id, label: 'keep separate', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })

    service.executeTopicEditorCommand(topic.id, { kind: 'deleteSelection', payload: { materialIds: [first.id], relationIds: [detached.id] } })
    expect(service.topicMap(topic.id).materials.map((material) => material.id)).not.toContain(first.id)
    expect(service.topicMap(topic.id).relations.map((relation) => relation.id)).not.toContain(detached.id)
    expect(service.topicHistoryStatus(topic.id).cursor).toBe(1)

    service.undoTopicEditorCommand(topic.id)
    expect(service.topicMap(topic.id).materials.map((material) => material.id)).toContain(first.id)
    expect(service.topicMap(topic.id).relations.map((relation) => relation.id)).toContain(detached.id)
  })

  it('removes a material from a topic without deleting the material or its workspace data', async () => {
    const service = makeService()
    await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Reusable', 'Keep this material in the workspace.')
    const topic = service.createTopic('Board')
    service.addToTopic(topic.id, material.id)
    service.removeFromTopic(topic.id, material.id)
    expect(service.topicMap(topic.id).materials).toHaveLength(0)
    expect(service.getMaterial(material.id)).toMatchObject({ title: 'Reusable' })
  })

  it('persists a batch topology layout and rejects duplicate or self relationships', async () => {
    const service = makeService()
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
    const service = makeService(); await service.create(makeRoot(), 'Research')
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
    const service = makeService()
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
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
    const first = await service.importFile(input); const second = await service.importFile(input)
    expect(second.duplicateOf?.id).toBe(first.material.id)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    expect(service.listMaterials()).toHaveLength(1)
  })

  it('parses an imported file from its copied workspace path', async () => {
    const root = makeRoot(); const input = join(root, 'meeting.md'); writeFileSync(input, '# Meeting\nOffline search is required.')
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
    const imported = await service.importFile(input)
    await vi.waitFor(() => expect(service.listJobs().every((job) => job.status === 'complete')).toBe(true))
    expect(service.getMaterial(imported.material.id)?.title).toBe('meeting')
    expect(service.getMaterial(imported.material.id)?.extractedText).toContain('Offline search')
  })

  it('finishes a small Markdown import and tracks same-named materials independently', async () => {
    const root = makeRoot(); const firstPath = join(root, 'first', 'notes.md'); const secondPath = join(root, 'second', 'notes.md')
    mkdirSync(join(root, 'first')); mkdirSync(join(root, 'second'))
    writeFileSync(firstPath, `# First\n${'a'.repeat(12_300)}`); writeFileSync(secondPath, '# Second\nDifferent content')
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
    const [first, second] = await Promise.all([service.importFile(firstPath), service.importFile(secondPath)])
    await vi.waitFor(() => expect([service.getMaterial(first.material.id)?.status, service.getMaterial(second.material.id)?.status]).toEqual(['complete', 'complete']))
    expect(service.getMaterial(first.material.id)?.extractedText).toHaveLength(12_308)
    expect(service.getMaterial(second.material.id)?.extractedText).toContain('Different content')
  })

  it('imports files over 10 MB without starting automatic extraction', async () => {
    const root = makeRoot(); const sourcePath = join(root, 'large.md'); writeFileSync(sourcePath, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'))
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
    const imported = await service.importFile(sourcePath)
    expect(service.getMaterial(imported.material.id)).toMatchObject({ status: 'paused', error: expect.stringContaining('10 MB') })
    expect(service.listJobs()).toEqual(expect.arrayContaining([expect.objectContaining({ materialId: imported.material.id, status: 'paused' })]))
  })

  it('stores an encrypted workspace database and rejects an incorrect password', async () => {
    const root = join(makeRoot(), 'private-workspace')
    const service = makeService()
    await service.create(root, 'Private', 'correct-horse-battery-staple')
    await service.createNote('Private note', 'This remains in the encrypted workspace.')
    expect(existsSync(join(root, 'workspace.sqlite.enc'))).toBe(true)
    const reopened = makeService()
    await reopened.create(join(makeRoot(), 'already-open'), 'Already open')
    await reopened.createNote('Current note', 'Keep the active workspace usable.')
    await expect(reopened.open(root, 'wrong-password')).rejects.toThrow()
    expect(reopened.search('active workspace')).toHaveLength(1)
    await reopened.open(root, 'correct-horse-battery-staple')
    expect(reopened.search('encrypted')).toHaveLength(1)
  })

  it('inspects and imports an encrypted workspace package only with its password', async () => {
    const root = makeRoot(); const source = join(root, 'private-source'); const destination = join(root, 'private-import'); const packagePath = join(root, 'private.material-workspace')
    const service = makeService(); await service.create(source, 'Private package', 'correct-horse-battery-staple')
    await service.createNote('Private note', 'This package remains encrypted.')
    await service.exportPackage(packagePath)
    await expect(service.inspectPackage(packagePath)).resolves.toEqual({ name: 'Private package', encrypted: true })
    const imported = makeService()
    await expect(imported.importPackage(packagePath, destination, 'wrong-password')).rejects.toThrow()
    await imported.importPackage(packagePath, destination, 'correct-horse-battery-staple')
    expect(imported.summary()).toMatchObject({ name: 'Private package', encrypted: true })
    expect(imported.search('encrypted')).toHaveLength(1)
  })

  it('saves workspace documents and creates a version when editing an imported text file', async () => {
    const root = makeRoot(); const sourcePath = join(root, 'source.txt'); writeFileSync(sourcePath, 'original text')
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
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
    const service = makeService(); await service.create(join(root, 'workspace'), 'Materials')
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
    const service = makeService(); await service.create(source, 'Research')
    await service.createNote('Imported note', 'This survives workspace package import.')
    await service.exportPackage(packagePath)
    const imported = makeService()
    await imported.importPackage(packagePath, destination)
    expect(imported.summary()).toMatchObject({ root: destination, name: 'Research' })
    expect(imported.search('survives')).toHaveLength(1)
  })

  it('archives a topic without deleting its materials, styles, or positions', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Keep me', 'This remains in the workspace.')
    const topic = service.createTopic('Archive me')
    service.addToTopic(topic.id, material.id); service.positionMaterial(topic.id, material.id, 320, 180)
    service.updateCardStyle(topic.id, material.id, { color: '#3568b8', tags: ['保留'], note: 'Still here.' })
    service.archiveTopic(topic.id)
    expect(service.listTopics()).toHaveLength(0)
    expect(service.listArchivedTopics()).toMatchObject([{ id: topic.id }])
    expect(service.getMaterial(material.id)).toMatchObject({ title: 'Keep me' })
    const reopened = makeService(); await reopened.open(service.summary().root)
    expect(reopened.listTopics()).toHaveLength(0)
    expect(reopened.listArchivedTopics()).toMatchObject([{ id: topic.id }])
    reopened.close()
    await service.restoreTopic(topic.id)
    expect(service.topicMap(topic.id).materials[0]).toMatchObject({ id: material.id, canvasX: 320, canvasY: 180, cardColor: '#3568b8', cardTags: ['保留'] })
  })

  it('adds a material batch to one topic and returns only real memberships', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'A'); const second = await service.createNote('Second', 'B')
    const included = service.createTopic('Included'); const other = service.createTopic('Other')
    service.addMaterialsToTopic(included.id, [first.id, second.id, first.id]); service.addToTopic(other.id, second.id)
    expect(service.topicMap(included.id).materials).toHaveLength(2)
    expect(service.topicsForMaterial(first.id)).toMatchObject([{ id: included.id }])
    expect(service.topicsForMaterial(second.id).map((topic) => topic.id).sort()).toEqual([included.id, other.id].sort())
  })

  it('stores manual card order and restores the time-based order without changing material dates', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const first = await service.createNote('First', 'A'); const second = await service.createNote('Second', 'B')
    const topic = service.createTopic('Order'); service.addMaterialsToTopic(topic.id, [first.id, second.id])
    service.updateCardOrder(topic.id, second.id, 1)
    expect(service.topicMap(topic.id).materials.find((item) => item.id === second.id)).toMatchObject({ sequence: 1, sequenceSource: 'manual' })
    service.resetCardOrder(topic.id)
    expect(service.topicMap(topic.id).materials.every((item) => item.sequence === null && item.sequenceSource === 'time')).toBe(true)
    expect(service.getMaterial(second.id)?.occurredAt).toBe(second.importedAt)
  })

  it('does not invent system relationships for numbered materials without AI', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const materials = []
    for (let index = 24; index >= 1; index -= 1) materials.push(await service.createNote(`${String(index).padStart(2, '0')}-Lesson`, `Step ${index}`))
    const topic = service.createTopic('Course'); service.addMaterialsToTopic(topic.id, materials.map((material) => material.id))
    const map = service.topicMap(topic.id)
    const system = map.relations.filter((relation) => relation.createdBy === 'system')
    expect(system).toHaveLength(0)
    expect(map.materials.find((material) => material.title === '01-Lesson')).toMatchObject({ canvasX: 120, canvasY: 120, positionSource: 'auto' })
  })

  it('keeps a manual relationship and manual position when rebuilding the system topology', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const first = await service.createNote('01-First', 'First'); const second = await service.createNote('02-Second', 'Second')
    const topic = service.createTopic('Flow'); service.addToTopic(topic.id, first.id)
    service.createRelation({ sourceMaterialId: first.id, targetMaterialId: second.id, label: 'Manual next', relationType: 'next', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
    service.addToTopic(topic.id, second.id); service.positionMaterial(topic.id, first.id, 999, 333); service.rebuildSystemTopology(topic.id)
    const map = service.topicMap(topic.id)
    expect(map.relations.filter((relation) => relation.createdBy === 'manual')).toHaveLength(1)
    expect(map.relations.filter((relation) => relation.createdBy === 'system')).toHaveLength(0)
    expect(map.materials.find((material) => material.id === first.id)).toMatchObject({ canvasX: 999, canvasY: 333, positionSource: 'manual' })
  })

  it('extracts local tags and persists bounded topic relationship candidates', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const first = await service.createDocument('Go HTTP 服务', '# HTTP 服务\n使用 Go 编写用户服务和 HTTP API。', 'md')
    const second = await service.createDocument('Go API 测试', '# HTTP API 测试\n为 Go 用户服务编写接口测试。', 'md')
    const third = await service.createDocument('数据库设计', '# MySQL\n设计数据库索引。', 'md')
    expect(service.listMaterialTags(first.id).map((tag) => tag.tag)).toContain('HTTP 服务')
    const topic = service.createTopic('Backend'); service.addMaterialsToTopic(topic.id, [first.id, second.id, third.id])
    const candidates = service.listTopicCandidates(topic.id)
    expect(candidates.some((candidate) => [candidate.sourceMaterialId, candidate.targetMaterialId].includes(first.id) && [candidate.sourceMaterialId, candidate.targetMaterialId].includes(second.id))).toBe(true)
    expect(candidates.every((candidate) => candidate.sharedTags.length > 0)).toBe(true)
    service.updateCandidateStatus(topic.id, candidates[0].id, 'hidden')
    expect(service.listTopicCandidates(topic.id).find((candidate) => candidate.id === candidates[0].id)?.status).toBe('hidden')
  })

  it('uses the most recently added real topic membership as the primary workbench topic', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Research')
    const material = await service.createNote('Shared', 'Reusable')
    const older = service.createTopic('Older'); service.addToTopic(older.id, material.id)
    const newer = service.createTopic('Newer'); service.addToTopic(newer.id, material.id)
    expect(service.topicsForMaterial(material.id).map((topic) => topic.id)).toEqual([newer.id, older.id])
    expect(service.listMaterialsWithTopics().find((item) => item.id === material.id)?.topics[0]?.id).toBe(newer.id)
  })

  it('indexes a folder incrementally and preserves a missing source as unavailable', async () => {
    const root = makeRoot(); const sourceRoot = join(root, 'knowledge'); mkdirSync(sourceRoot)
    const filePath = join(sourceRoot, 'guide.md'); writeFileSync(filePath, '# Offline\nLocal search and citations.')
    const service = makeService(); await service.create(join(root, 'workspace'), 'Knowledge')
    const source = await service.addFolderSource({ rootPath: sourceRoot, enabled: true, includePatterns: [], excludePatterns: [], watchEnabled: false })
    await vi.waitFor(() => expect(service.listMaterials()).toHaveLength(1))
    const material = service.listMaterials()[0]
    await vi.waitFor(() => expect(service.getMaterial(material.id)?.status).toBe('complete'))
    expect(service.searchKnowledge('citations')).toEqual(expect.arrayContaining([expect.objectContaining({ materialId: material.id, heading: 'Offline' })]))
    writeFileSync(filePath, '# Offline\nUpdated local evidence.')
    await service.rescanFolderSource(source.id)
    await vi.waitFor(() => expect(service.getMaterial(material.id)?.extractedText).toContain('Updated local evidence'))
    unlinkSync(filePath)
    const result = await service.rescanFolderSource(source.id)
    expect(result.unavailable).toBe(1)
    expect(service.getMaterial(material.id)).toMatchObject({ availability: 'unavailable', extractedText: expect.stringContaining('Updated local evidence') })
  })

  it('creates stable text chunks for notes and returns paragraph-level search hits', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Knowledge')
    const material = await service.createNote('Architecture', '# Storage\n\nSQLite keeps the local index.\n\n# Retrieval\n\nCitations point back to source chunks.')
    const chunks = service.listMaterialChunks(material.id)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toMatchObject({ materialId: material.id, heading: 'Storage' })
    expect(service.searchKnowledge('source chunks')).toEqual(expect.arrayContaining([expect.objectContaining({ materialId: material.id, chunkId: chunks.at(-1)?.id })]))
  })

  it('caches material analysis cards and expands evidence to neighboring chunks', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Knowledge')
    const material = await service.createNote('Architecture', '# Storage\n\nSQLite keeps the local index.\n\n# Retrieval\n\nEvidence windows include nearby chunks.')
    const chunks = service.listMaterialChunks(material.id)
    const card = { materialId: material.id, contentHash: material.hash ?? chunkHash(material.extractedText ?? material.excerpt ?? material.title), modelId: 'model-a', title: material.title, date: material.importedAt, headings: ['Storage'], keywords: ['SQLite'], evidenceChunkIds: [chunks[0].id], summary: 'Local storage.', generatedAt: new Date().toISOString() }
    service.saveMaterialAnalysisCard(card)
    expect(service.getMaterialAnalysisCard(material.id, 'model-a')).toMatchObject({ summary: 'Local storage.', headings: ['Storage'] })
    expect(service.materialEvidenceWindow(material.id, 'retrieval evidence', 1).map((chunk) => chunk.id)).toContain(chunks.at(-1)?.id)
  })

  it('rejects an analysis commit after a topic revision changes', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Knowledge')
    const first = await service.createNote('First', 'First step')
    const second = await service.createNote('Second', 'Second step')
    const topic = service.createTopic('Flow'); service.addMaterialsToTopic(topic.id, [first.id, second.id])
    const revision = service.topicMap(topic.id).topic.revision
    service.positionMaterial(topic.id, first.id, 10, 10)
    expect(() => service.applyTopicAnalysis(topic.id, revision, [{ sourceMaterialId: first.id, targetMaterialId: second.id, relationType: 'next', label: 'next', confidence: .9, evidence: 'Steps are ordered.', sourceChunkIds: [], targetChunkIds: [] }], [])).toThrow('topic changed')
    expect(service.topicMap(topic.id).relations.filter((relation) => relation.createdBy === 'ai')).toHaveLength(0)
  })

  it('applies folder include and exclude patterns and pauses rescans', async () => {
    const root = makeRoot(); const sourceRoot = join(root, 'knowledge'); mkdirSync(join(sourceRoot, 'drafts'), { recursive: true })
    writeFileSync(join(sourceRoot, 'keep.md'), 'keep this')
    writeFileSync(join(sourceRoot, 'skip.txt'), 'skip this')
    writeFileSync(join(sourceRoot, 'drafts', 'nested.md'), 'skip nested')
    const service = makeService(); await service.create(join(root, 'workspace'), 'Knowledge')
    const source = await service.addFolderSource({ rootPath: sourceRoot, enabled: true, includePatterns: ['**/*.md'], excludePatterns: ['drafts/**'], watchEnabled: false })
    expect(service.listMaterials().map((material) => material.title)).toEqual(['keep'])
    const paused = service.pauseFolderSource(source.id)
    expect(paused.enabled).toBe(false)
    expect(await service.rescanFolderSource(source.id)).toEqual({ scanned: 0, indexed: 0, unavailable: 0 })
  })

  it('persists topic proposals until the user accepts or archives them', async () => {
    const service = makeService(); await service.create(makeRoot(), 'Knowledge')
    const topic = service.createTopic('Review')
    const proposals = service.createTopicProposals(topic.id, [{ kind: 'create_relation', reason: 'The guide references the checklist.', evidence: 'Guide paragraph', materialId: null, relationId: null, payload: { label: 'references' } }])
    expect(proposals).toHaveLength(1)
    expect(service.listTopicProposals(topic.id)[0]).toMatchObject({ status: 'pending', payload: { label: 'references' } })
    service.updateTopicProposalStatus(proposals[0].id, 'accepted')
    expect(service.listTopicProposals(topic.id)).toHaveLength(0)
    expect(service.listTopicProposals(topic.id, 'accepted')).toHaveLength(1)
  })

  it('requeues materials left running when a workspace is reopened', async () => {
    const root = join(makeRoot(), 'workspace'); const service = makeService(); await service.create(root, 'Recovery')
    const note = await service.createNote('README', 'Local recovery test')
    service.startJob(note.id, 'extract')
    const reopened = makeService(); await reopened.open(root)
    await vi.waitFor(() => expect(reopened.listJobs().some((job) => job.materialId === note.id && job.status === 'complete')).toBe(true))
  })

  it('stores PDF page numbers on material chunks', async () => {
    const service = makeService(); await service.create(makeRoot(), 'PDF')
    const material = await service.createNote('PDF', 'Page one\n\nPage two')
    ;(service as unknown as { indexMaterialChunks(id: string, text: string, extracted: { pages: Array<{ pageNumber: number; text: string }> }): void }).indexMaterialChunks(material.id, 'Page one\n\nPage two', { pages: [{ pageNumber: 1, text: 'Page one' }, { pageNumber: 2, text: 'Page two' }] })
    expect(service.listMaterialChunks(material.id).map((chunk) => chunk.pageNumber)).toEqual([1, 2])
  })
})
