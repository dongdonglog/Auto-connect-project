// @ts-nocheck —— 本文件为关系引擎 fixture（测试数据），不参与类型检查
/**
 * 预期关系（供测试断言）：
 * explicit_reference <- implementation.md (被 implementation.md import)
 * explicit_reference -> utils.py          (代码 import 引用 ./utils)
 * entity_overlap     -> implementation.md (共享实体: TypeScript)
 */

// 解析器接口定义，使用 TypeScript 严格模式编写。
import { helper } from './utils'

export interface ParsedReference {
  type: 'markdown_link' | 'relative_path' | 'code_import'
  target: string
}

export function parseReferences(text: string): ParsedReference[] {
  void helper
  return []
}
