// relationship-engine smoke 验证（vitest）
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RelationshipEngine, computeWorkspaceRelations, type EngineMaterial } from '../relationship-engine'

const dir = join(__dirname, 'fixtures/relationship')
const loadMaterials = (): EngineMaterial[] =>
  readdirSync(dir).map((name) => ({ id: basename(name), fileName: basename(name), text: readFileSync(join(dir, name), 'utf8') }))

const find = (relations: ReturnType<RelationshipEngine['getRelations']>, a: string, b: string) =>
  relations.find((r) => r.id === (a < b ? `${a}::${b}` : `${b}::${a}`))

describe('relationship-engine smoke', () => {
  it('显式引用关系：overview -> details / implementation，分数在 [0.92, 1.0]', () => {
    const relations = computeWorkspaceRelations(loadMaterials())
    const overviewDetails = find(relations, 'overview.md', 'details.md')
    expect(overviewDetails?.relationType).toBe('explicit_reference')
    expect(overviewDetails!.score).toBeGreaterThanOrEqual(0.92)
    expect(overviewDetails!.score).toBeLessThanOrEqual(1.0)
    expect(find(relations, 'overview.md', 'implementation.md')?.relationType).toBe('explicit_reference')
    // 带 anchor 的链接同样解析
    expect(find(relations, 'overview.md', 'implementation.md')?.evidence.some((e) => e.text.includes('#核心算法'))).toBe(true)
  })

  it('代码 import 关系：implementation <-> api-spec、api-spec <-> utils', () => {
    const relations = computeWorkspaceRelations(loadMaterials())
    expect(find(relations, 'implementation.md', 'api-spec.ts')?.relationType).toBe('explicit_reference')
    expect(find(relations, 'api-spec.ts', 'utils.py')?.relationType).toBe('explicit_reference')
  })

  it('实体重叠关系：details <-> 中文文档（共享 SQLite），分数在 [0.42, 0.75]', () => {
    const relations = computeWorkspaceRelations(loadMaterials())
    const pair = find(relations, 'details.md', '中文文档.md')
    expect(pair?.relationType).toBe('entity_overlap')
    expect(pair!.score).toBeGreaterThanOrEqual(0.42)
    expect(pair!.score).toBeLessThanOrEqual(0.75)
    expect(pair!.evidence.some((e) => e.entity === 'sqlite')).toBe(true)
  })

  it('反噪声：external-link / noise / common-words 不产生任何关系', () => {
    const relations = computeWorkspaceRelations(loadMaterials())
    for (const noisy of ['external-link.md', 'noise.md', 'common-words.md']) {
      expect(relations.filter((r) => r.sourceMaterialId === noisy || r.targetMaterialId === noisy)).toHaveLength(0)
    }
  })

  it('结构候选：合法文本产生 <=0.1 分关系；纯日期/编号候选被拒绝', () => {
    const relations = computeWorkspaceRelations(
      [ { id: 'a', fileName: 'a.md', text: 'alpha' }, { id: 'b', fileName: 'b.md', text: 'beta' }, { id: 'c', fileName: 'c.md', text: 'gamma' } ],
      [
        { sourceMaterialId: 'a', targetMaterialId: 'b', text: '同一目录相邻导入', score: 0.08 },
        { sourceMaterialId: 'b', targetMaterialId: 'c', text: '2026-08-03', score: 0.08 },
        { sourceMaterialId: 'a', targetMaterialId: 'c', text: '001', score: 0.08 }
      ]
    )
    const ab = find(relations, 'a', 'b')
    expect(ab?.relationType).toBe('structural')
    expect(ab!.score).toBeLessThanOrEqual(0.1)
    expect(find(relations, 'b', 'c')).toBeUndefined()
    expect(find(relations, 'a', 'c')).toBeUndefined()
  })

  it('证据截断：每条关系最多保留 4 条最高分证据', () => {
    const text = ['SQLite', 'React Flow', 'TypeScript', 'Docker', 'Redis', 'JSON'].join(' ')
    const relations = computeWorkspaceRelations([
      { id: 'x', fileName: 'x.md', text },
      { id: 'y', fileName: 'y.md', text },
      // 稀释材料：使共享实体 df=2/4=50% < 60%，避免被 common 抑制
      { id: 'p', fileName: 'p.md', text: '普通文字' },
      { id: 'q', fileName: 'q.md', text: '其他内容' }
    ])
    const pair = find(relations, 'x', 'y')
    expect(pair!.evidence.length).toBeLessThanOrEqual(4)
    expect(pair!.evidence.every((e) => e.type === 'entity_overlap')).toBe(true)
  })

  it('通用高频实体抑制：>=60% 材料出现的实体不建边', () => {
    // 5 个材料中 SQLite 出现 3 次（60%）→ common，a/b 间不能因 SQLite 建边
    const materials: EngineMaterial[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      fileName: `${id}.md`,
      text: id === 'a' || id === 'b' || id === 'c' ? 'uses SQLite' : 'plain words'
    }))
    const relations = computeWorkspaceRelations(materials)
    expect(relations).toHaveLength(0)
  })

  it('增量重算：updateMaterial 只影响直接候选对，其余关系保持不变', () => {
    const engine = new RelationshipEngine()
    const materials = loadMaterials()
    engine.computeWorkspace(materials)
    const beforeRelations = engine.getRelations()
    const detailsOverview = find(beforeRelations, 'overview.md', 'details.md')

    // 修改 noise.md：新增对 overview.md 的引用 → 只应新增 noise-overview 关系
    const updated: EngineMaterial = {
      id: 'noise.md', fileName: 'noise.md',
      text: '现在引用 [概览](./overview.md)。'
    }
    const affected = engine.updateMaterial(updated)
    const noiseOverview = find(engine.getRelations(), 'noise.md', 'overview.md')
    expect(noiseOverview?.relationType).toBe('explicit_reference')
    // 与 noise.md 无关的关系未被重算删除
    expect(find(engine.getRelations(), 'overview.md', 'details.md')?.score).toBe(detailsOverview?.score)
    expect(affected.every((r) => r.id.includes('noise.md'))).toBe(true)
  })

  it('增量重算：移除引用后关系消失', () => {
    const engine = new RelationshipEngine()
    engine.computeWorkspace(loadMaterials())
    expect(find(engine.getRelations(), 'overview.md', 'details.md')).toBeDefined()
    // overview.md 改为无引用无实体的文本
    engine.updateMaterial({ id: 'overview.md', fileName: 'overview.md', text: '普通文字，没有引用。' })
    expect(find(engine.getRelations(), 'overview.md', 'details.md')).toBeUndefined()
  })

  it('状态保留：hidden 在重算后保持 hidden；fixed 在证据消失后仍保留', () => {
    const engine = new RelationshipEngine()
    engine.computeWorkspace(loadMaterials())
    const pairId = find(engine.getRelations(), 'overview.md', 'details.md')!.id

    engine.setRelationStatus(pairId, 'hidden')
    // 触发 overview.md 重算（内容不变）
    engine.updateMaterial(loadMaterials().find((m) => m.id === 'overview.md')!)
    expect(find(engine.getRelations(), 'overview.md', 'details.md')?.status).toBe('hidden')

    engine.setRelationStatus(pairId, 'fixed')
    // 移除引用证据，fixed 关系仍保留
    engine.updateMaterial({ id: 'overview.md', fileName: 'overview.md', text: '普通文字。' })
    const kept = find(engine.getRelations(), 'overview.md', 'details.md')
    expect(kept?.status).toBe('fixed')
  })

  it('removeMaterial 移除其全部关系（含 fixed）', () => {
    const engine = new RelationshipEngine()
    engine.computeWorkspace(loadMaterials())
    const pairId = find(engine.getRelations(), 'overview.md', 'details.md')!.id
    engine.setRelationStatus(pairId, 'fixed')
    engine.removeMaterial('overview.md')
    expect(engine.getRelations().some((r) => r.sourceMaterialId === 'overview.md' || r.targetMaterialId === 'overview.md')).toBe(false)
  })
})
