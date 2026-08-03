// entity-extractor smoke 验证（vitest）
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMON_ENTITY_DF_RATIO,
  computeWorkspaceEntityStats,
  extractEntityMentions,
  filterUncommonMentions,
  normalizeEntityName
} from '../entity-extractor'

const dir = join(__dirname, 'fixtures/relationship')
const read = (name: string) => readFileSync(join(dir, name), 'utf8')

describe('entity-extractor smoke', () => {
  it('details.md 提取出 SQLite / React Flow / TypeScript / IPC', () => {
    const mentions = extractEntityMentions('details.md', read('details.md'))
    const names = mentions.map((m) => m.canonical)
    expect(names).toContain('SQLite')
    expect(names).toContain('React Flow')
    expect(names).toContain('TypeScript')
    expect(names).toContain('IPC')
  })

  it('多词术语优先：React Flow 命中后不再重复计数 React', () => {
    const mentions = extractEntityMentions('details.md', read('details.md'))
    const normalized = mentions.map((m) => m.normalized)
    expect(normalized).toContain('react flow')
    expect(normalized).not.toContain('react')
  })

  it('同一材料内同一实体去重，且记录位置与摘录', () => {
    const mentions = extractEntityMentions('details.md', read('details.md'))
    const sqlite = mentions.filter((m) => m.normalized === 'sqlite')
    expect(sqlite).toHaveLength(1)
    expect(sqlite[0].startOffset).toBeGreaterThan(0)
    expect(sqlite[0].endOffset).toBeGreaterThan(sqlite[0].startOffset)
    expect(sqlite[0].excerpt.toLowerCase()).toContain('sqlite')
    expect(sqlite[0].lineNumber).toBeGreaterThan(0)
  })

  it('规范化：大小写统一、空白压缩', () => {
    expect(normalizeEntityName('  React   Flow ')).toBe('react flow')
    expect(extractEntityMentions('m', 'use SQLITE and sqlite').map((m) => m.normalized)).toEqual(['sqlite'])
  })

  it('noise.md 不提取任何受控词表实体', () => {
    expect(extractEntityMentions('noise.md', read('noise.md'))).toHaveLength(0)
  })

  it('通用高频词抑制：df 占比 >= 60% 的实体标记为 common 并被过滤', () => {
    // 构造 5 个材料，其中 "sqlite" 出现在 3 个（60%）→ common
    const materials = ['a', 'b', 'c', 'd', 'e'].map((materialId) => ({
      materialId,
      text: materialId === 'e' ? 'nothing here' : 'uses SQLite daily'
    }))
    // a,b,c 含 sqlite（3/5 = 60%）；d,e 不含（d 的文本实际含，调整：）
    materials[3].text = 'plain text'
    const mentionsByMaterial = materials.map(({ materialId, text }) => ({
      materialId,
      mentions: extractEntityMentions(materialId, text)
    }))
    const stats = computeWorkspaceEntityStats(mentionsByMaterial)
    expect(stats.materialCount).toBe(5)
    expect(stats.common.get('sqlite')).toBe(true) // 3/5 >= 0.6
    expect(filterUncommonMentions(mentionsByMaterial[0].mentions, stats)).toHaveLength(0)
    // 阈值常数可被测试引用
    expect(COMMON_ENTITY_DF_RATIO).toBe(0.6)
  })

  it('低于阈值的实体不标记 common', () => {
    const mentionsByMaterial = ['a', 'b', 'c', 'd', 'e'].map((materialId) => ({
      materialId,
      mentions: extractEntityMentions(materialId, materialId === 'a' ? 'Redis cache' : 'plain')
    }))
    const stats = computeWorkspaceEntityStats(mentionsByMaterial)
    expect(stats.common.get('redis')).toBe(false) // 1/5 = 20%
    expect(filterUncommonMentions(mentionsByMaterial[0].mentions, stats)).toHaveLength(1)
  })

  it('全部 fixture 材料整体统计不抛错', () => {
    const all = readdirSync(dir).map((name) => ({
      materialId: basename(name),
      mentions: extractEntityMentions(basename(name), read(name))
    }))
    const stats = computeWorkspaceEntityStats(all)
    expect(stats.materialCount).toBe(9)
    // SQLite 出现在 overview/details/中文文档 3/9 ≈ 33%，不应是 common
    expect(stats.common.get('sqlite')).toBe(false)
  })
})
