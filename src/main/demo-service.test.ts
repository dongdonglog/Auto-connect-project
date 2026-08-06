import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetLearningPathDemo } from './demo-service'
import { WorkspaceService } from './workspace-service'

const roots: string[] = []
const services: WorkspaceService[] = []
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'material-map-demo-')); roots.push(value); return value }
const makeService = (): WorkspaceService => { const service = new WorkspaceService(); services.push(service); return service }
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true }))
})

describe('resetLearningPathDemo', () => {
  it('rebuilds one complete seven-step board with editable 3→4 connection', async () => {
    const workspace = makeService(); await workspace.create(root(), 'Demo')
    const first = await resetLearningPathDemo(workspace)
    // A stale relation from an earlier demo version must not block reset.
    const staleSource = workspace.topicMap(first.id).materials[2]; const staleTarget = workspace.topicMap(first.id).materials[3]
    workspace.createRelation({ sourceMaterialId: staleSource.id, targetMaterialId: staleTarget.id, label: '旧关系', relationType: 'related', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'ai' })
    const second = await resetLearningPathDemo(workspace)
    expect(second.id).toBe(first.id)
    const map = workspace.topicMap(first.id)
    expect(map.materials).toHaveLength(7)
    expect(map.relations.filter((relation) => relation.createdBy === 'manual')).toHaveLength(6)
    expect(map.relations.filter((relation) => relation.createdBy === 'ai')).toHaveLength(0)
    const third = map.materials.find((item) => item.title.startsWith('核心概念'))!; const fourth = map.materials.find((item) => item.title.startsWith('实践项目'))!
    const path = map.relations.find((relation) => relation.sourceMaterialId === third.id && relation.targetMaterialId === fourth.id)
    expect(path).toMatchObject({ createdBy: 'manual', label: '下一步' })
    workspace.updateRelation(path!.id, '开始实践')
    expect(workspace.topicMap(first.id).relations.find((relation) => relation.id === path!.id)?.label).toBe('开始实践')
  })
})
