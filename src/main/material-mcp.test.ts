import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaterialMapMcpServer } from './material-mcp'
import { WorkspaceService } from './workspace-service'

const services: WorkspaceService[] = []
const roots: string[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Material Map local tools', () => {
  it('lists, searches, reads and inspects topic context through bounded tool calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-tools-')); roots.push(root)
    const workspace = new WorkspaceService(); services.push(workspace)
    await workspace.create(join(root, 'workspace'), 'Tools')
    const first = await workspace.createNote('Go 基础', '# Go 基础\n\n变量和接口。')
    const second = await workspace.createNote('发布检查', '上线前执行回滚演练。')
    const topic = workspace.createTopic('学习路径'); workspace.addMaterialsToTopic(topic.id, [first.id, second.id])
    const server = new MaterialMapMcpServer(workspace)
    expect(server.listTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_materials', 'search_materials', 'read_material', 'get_topic_context']))
    expect(await server.call('list_materials', {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, title: 'Go 基础' }), expect.objectContaining({ id: second.id, title: '发布检查' })]))
    expect(await server.call('search_materials', { query: '接口' })).toMatchObject({ mode: 'fts', hits: [expect.objectContaining({ materialId: first.id, text: expect.stringContaining('接口') })] })
    expect(await server.call('read_material', { materialId: first.id })).toMatchObject({ material: { id: first.id, title: 'Go 基础' }, chunks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('变量') })]) })
    expect(await server.call('get_topic_context', { topicId: topic.id })).toMatchObject({ topic: { id: topic.id, name: '学习路径' }, materials: expect.arrayContaining([expect.objectContaining({ id: first.id })]) })
    expect(await server.call('topic.get_context', { topicId: topic.id })).toMatchObject({ topicId: topic.id, materials: expect.arrayContaining([expect.objectContaining({ id: first.id })]) })
  })

  it('rejects unknown tools and missing required arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-tools-')); roots.push(root)
    const workspace = new WorkspaceService(); services.push(workspace)
    await workspace.create(join(root, 'workspace'), 'Tools')
    const server = new MaterialMapMcpServer(workspace)
    await expect(server.call('search_materials', {})).rejects.toThrow('query is required')
    await expect(server.call('does_not_exist', {})).rejects.toThrow('Unknown Material Map tool')
  })

  it('persists only reviewable topic proposals for requested board changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-tools-')); roots.push(root)
    const workspace = new WorkspaceService(); services.push(workspace)
    await workspace.create(join(root, 'workspace'), 'Tools')
    const first = await workspace.createNote('First', 'First material')
    const second = await workspace.createNote('Second', 'Second material')
    const topic = workspace.createTopic('Flow'); workspace.addMaterialsToTopic(topic.id, [first.id, second.id])
    const server = new MaterialMapMcpServer(workspace)
    const result = await server.call('propose_topic_changes', { topicId: topic.id, actions: [{ kind: 'create_relation', reason: 'Sequence is explicit.', evidence: 'The first material precedes the second.', payload: { sourceMaterialId: first.id, targetMaterialId: second.id, relationType: 'next', label: '下一步' } }] }) as { requiresUserReview: boolean; proposals: Array<{ kind: string }> }
    expect(result).toMatchObject({ requiresUserReview: true, proposals: [{ kind: 'create_relation' }] })
    expect(workspace.topicMap(topic.id).relations).toHaveLength(0)
    expect(workspace.listTopicProposals(topic.id)).toHaveLength(1)
    const invalid = await server.call('propose_topic_changes', { topicId: topic.id, actions: [{ kind: 'set_sequence', reason: 'Invalid order.', evidence: 'No valid position.', payload: { materialId: first.id, sequence: 0 } }] }) as { proposals: unknown[] }
    expect(invalid.proposals).toHaveLength(0)
    expect(workspace.listTopicProposals(topic.id)).toHaveLength(1)
  })
})
