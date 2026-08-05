// reference-parser smoke 验证脚本（vitest）
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReferences, type MaterialLocator } from '../reference-parser'

const dir = join(__dirname, 'fixtures/relationship')
const materials: MaterialLocator[] = readdirSync(dir).map((name) => ({ id: name, fileName: basename(name) }))
const read = (name: string) => readFileSync(join(dir, name), 'utf8')

describe('reference-parser smoke', () => {
  it('overview.md 解析出指向 details.md 与 implementation.md 的显式引用', () => {
    const refs = parseReferences('overview.md', read('overview.md'), materials)
    const targets = refs.filter((r) => r.targetMaterialId).map((r) => `${r.type}->${r.targetMaterialId}`)
    expect(targets).toContain('markdown_link->details.md')
    expect(targets).toContain('markdown_link->implementation.md')
    // frontmatter 中的 "details.md" 注释不带 ./ 前缀且非链接语法，不应被误识别
    expect(refs.every((r) => r.lineNumber > 0)).toBe(true)
  })

  it('implementation.md 中的 import 解析到 api-spec.ts', () => {
    const refs = parseReferences('implementation.md', read('implementation.md'), materials)
    expect(refs.some((r) => r.type === 'code_import' && r.targetMaterialId === 'api-spec.ts')).toBe(true)
  })

  it('api-spec.ts 中 import ./utils 解析到 utils.py', () => {
    const refs = parseReferences('api-spec.ts', read('api-spec.ts'), materials)
    expect(refs.some((r) => r.type === 'code_import' && r.targetMaterialId === 'utils.py')).toBe(true)
  })

  it('utils.py 中 from api_spec import 解析到 api-spec.ts（下划线/连字符互换）', () => {
    const refs = parseReferences('utils.py', read('utils.py'), materials)
    expect(refs.some((r) => r.type === 'code_import' && r.targetMaterialId === 'api-spec.ts')).toBe(true)
    // 标准库 json 不应解析到任何工作区材料
    expect(refs.find((r) => r.normalizedTarget === 'json')?.targetMaterialId ?? null).toBe(null)
  })

  it('中文文档.md 解析出指向 overview.md 的链接（中文文件名材料可作为来源）', () => {
    const refs = parseReferences('中文文档.md', read('中文文档.md'), materials)
    expect(refs.some((r) => r.type === 'markdown_link' && r.targetMaterialId === 'overview.md')).toBe(true)
  })

  it('external-link.md 不产生任何引用（外链被丢弃）', () => {
    const refs = parseReferences('external-link.md', read('external-link.md'), materials)
    expect(refs.filter((r) => r.targetMaterialId)).toHaveLength(0)
  })

  it('noise.md 与 common-words.md 无显式引用', () => {
    expect(parseReferences('noise.md', read('noise.md'), materials).filter((r) => r.targetMaterialId)).toHaveLength(0)
    expect(parseReferences('common-words.md', read('common-words.md'), materials).filter((r) => r.targetMaterialId)).toHaveLength(0)
  })
})
