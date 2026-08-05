/**
 * reference-parser.ts
 *
 * 显式引用解析器（Material Map 0.1 / Phase A）。
 *
 * 职责：从材料文本中解析"显式引用"——Markdown 链接、相对路径、代码 import/require，
 * 并把引用目标解析到工作区材料 ID（通过文件名匹配）。
 *
 * 反噪声约定：
 *  - 外部 URL（http/https/mailto 等）直接丢弃，不产生工作区关系；
 *  - 无法匹配到任何工作区材料的引用保留在结果中（targetMaterialId 为 null），
 *    由上层关系引擎决定是否丢弃（引擎会丢弃它们）。
 */

/** 引用类型 */
export type ReferenceType = 'markdown_link' | 'relative_path' | 'code_import'

/** 一条结构化引用记录 */
export interface ParsedReference {
  /** 引用类型 */
  type: ReferenceType
  /** 来源材料 ID */
  sourceMaterialId: string
  /** 目标材料 ID；无法解析到工作区材料时为 null */
  targetMaterialId: string | null
  /** 命中原文（含语法符号的完整匹配片段） */
  rawText: string
  /** 引用目标在原文中的起始偏移 */
  startOffset: number
  /** 引用目标在原文中的结束偏移 */
  endOffset: number
  /** 所在行号（从 1 开始） */
  lineNumber: number
  /** 规范化后的目标路径/模块名（去 anchor、去查询串、统一分隔符），便于调试与测试 */
  normalizedTarget: string
}

/** 工作区材料定位信息（解析器只需要最小集合） */
export interface MaterialLocator {
  id: string
  /** 文件名（含扩展名），例如 "details.md"、"中文文档.md" */
  fileName: string
  /** 工作区内相对路径（可选，存在时优先用于 ../dir/file.md 形式的匹配） */
  relativePath?: string
}

/** 已知代码/文本扩展名，用于识别裸相对路径 */
const KNOWN_EXTENSIONS = '(?:md|markdown|txt|pdf|docx?|csv|json|ya?ml|html?|tsx?|jsx?|mjs|cjs|py|go|java|rs)'

/** 判断目标是否为外部 URL / 协议相对链接 / 锚点，这些不产生工作区关系 */
function isExternalTarget(target: string): boolean {
  return /^(?:https?:)?\/\//i.test(target) || /^(?:mailto|tel|data|ftp):/i.test(target) || target.startsWith('#')
}

/**
 * 规范化引用目标：
 *  - 去掉 query 与 anchor；
 *  - 反斜杠统一为正斜杠；
 *  - 去掉开头的 "./"；
 *  - 去掉结尾的 "/"。
 */
export function normalizeTarget(target: string): string {
  let value = target.trim().replace(/[?#].*$/, '').replaceAll('\\', '/')
  value = value.replace(/^\.\//, '').replace(/\/+$/, '')
  return value
}

/**
 * 将代码 import 的模块名转换为候选文件名形式。
 * 例如 "../utils" -> ["../utils.py", "../utils.ts", ...]，"./api-spec" -> ["api-spec.ts", ...]
 * Python 下划线模块名 "api_spec" 同时产出连字符形式 "api-spec"。
 */
function moduleToFileCandidates(moduleName: string): string[] {
  const base = normalizeTarget(moduleName)
  if (!base) return []
  // 已带扩展名的直接返回
  if (new RegExp(`\\.${KNOWN_EXTENSIONS}$`, 'i').test(base)) return [base]
  const variants = new Set<string>([base, base.replaceAll('_', '-'), base.replaceAll('-', '_')])
  const candidates: string[] = []
  for (const variant of variants) {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'md', 'json']) {
      candidates.push(`${variant}.${ext}`)
    }
    // Python 包形式: module/__init__.py
    candidates.push(`${variant}/__init__.py`)
  }
  return candidates
}

/** 计算文本中某偏移处的行号（从 1 开始） */
function lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/** 构建"文件名/相对路径（小写）-> 材料 ID"索引 */
function buildLookup(materials: MaterialLocator[]): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const material of materials) {
    const fileName = material.fileName.toLowerCase()
    if (!lookup.has(fileName)) lookup.set(fileName, material.id)
    // 不带扩展名的文件名也入索引（供 import './module' 形式匹配）
    const stem = fileName.replace(/\.[^.]+$/, '')
    if (stem && !lookup.has(stem)) lookup.set(stem, material.id)
    if (material.relativePath) {
      const rel = normalizeTarget(material.relativePath).toLowerCase()
      if (rel && !lookup.has(rel)) lookup.set(rel, material.id)
      const relStem = rel.replace(/\.[^.]+$/, '')
      if (relStem && !lookup.has(relStem)) lookup.set(relStem, material.id)
    }
  }
  return lookup
}

/**
 * 将规范化后的引用目标解析为材料 ID。
 * 匹配策略（按优先级）：
 *  1. 相对路径全名匹配（含目录，如 "dir/file.md"；"../" 前缀退化为按 basename 匹配）；
 *  2. 文件名匹配（basename，含扩展名）；
 *  3. 模块名匹配（import 形式，尝试补扩展名、连字符/下划线互换）。
 */
export function resolveTarget(rawTarget: string, lookup: Map<string, string>, isCodeImport: boolean): string | null {
  const normalized = normalizeTarget(rawTarget)
  if (!normalized) return null

  const candidates = isCodeImport ? moduleToFileCandidates(normalized) : [normalized]
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    // 1. 完整相对路径匹配
    const direct = lookup.get(lower)
    if (direct) return direct
    // 2. basename 匹配（处理 ./file.md、../dir/file.md）
    const base = lower.split('/').pop() ?? lower
    const byBase = lookup.get(base)
    if (byBase) return byBase
    // 3. 去扩展名的 stem 匹配
    const stem = base.replace(/\.[^.]+$/, '')
    const byStem = lookup.get(stem)
    if (byStem) return byStem
  }
  return null
}

/** 原始命中（尚未解析到材料 ID） */
interface RawHit {
  type: ReferenceType
  rawText: string
  target: string
  startOffset: number
  endOffset: number
}

/** 从文本中抽取全部原始引用命中（未做材料解析） */
function extractRawHits(text: string): RawHit[] {
  const hits: RawHit[] = []

  const push = (type: ReferenceType, rawText: string, target: string, matchIndex: number, targetIndexInMatch: number): void => {
    const startOffset = matchIndex + targetIndexInMatch
    hits.push({ type, rawText, target, startOffset, endOffset: startOffset + target.length })
  }

  // 1. Markdown 链接：[text](path) 与 [text](path#anchor)
  //    目标中允许中文、目录、anchor；不允许空格与右括号。
  const markdownLink = /\[([^\]]*)\]\(([^)\s]+)\)/g
  for (const match of text.matchAll(markdownLink)) {
    const target = match[2]
    push('markdown_link', match[0], target, match.index ?? 0, match[0].lastIndexOf(target))
  }

  // 2. 代码 import / require：
  //    TS/JS: import ... from './module' | import './module' | require('./module')
  //    Python: from module import ... | import module
  const jsImport = /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\s*\(\s*)['"`]([^'"`]+)['"`]\s*\)?/g
  for (const match of text.matchAll(jsImport)) {
    const target = match[1]
    push('code_import', match[0], target, match.index ?? 0, match[0].indexOf(target))
  }
  const pyFromImport = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s/gm
  for (const match of text.matchAll(pyFromImport)) {
    const target = match[1]
    push('code_import', match[0], target, match.index ?? 0, match[0].indexOf(target))
  }
  const pyImport = /^\s*import\s+([A-Za-z_][\w.]*)\s*$/gm
  for (const match of text.matchAll(pyImport)) {
    const target = match[1]
    push('code_import', match[0], target, match.index ?? 0, match[0].indexOf(target))
  }

  // 3. 裸相对路径：./file.md、../dir/file.md（必须带点相对前缀与已知扩展名，
  //    避免把普通文本误判为引用）
  const relativePath = new RegExp(`\\.\\.?/[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff ._/-]*\\.${KNOWN_EXTENSIONS}`, 'gi')
  for (const match of text.matchAll(relativePath)) {
    push('relative_path', match[0], match[0], match.index ?? 0, 0)
  }

  return hits
}

/**
 * 解析单个材料文本中的全部显式引用，并解析到工作区材料 ID。
 *
 * @param sourceMaterialId 来源材料 ID
 * @param text             材料全文（Markdown 源码 / 代码源码）
 * @param materials        工作区材料定位信息集合
 * @returns 结构化引用数组；外部 URL 已被丢弃；未命中材料的引用 targetMaterialId 为 null
 */
export function parseReferences(sourceMaterialId: string, text: string, materials: MaterialLocator[]): ParsedReference[] {
  const lookup = buildLookup(materials)
  const results: ParsedReference[] = []
  const seen = new Set<string>()

  for (const hit of extractRawHits(text)) {
    // 外部链接 / 纯锚点：直接丢弃，不进入结果集
    if (isExternalTarget(hit.target)) continue

    const isCodeImport = hit.type === 'code_import'
    const targetMaterialId = resolveTarget(hit.target, lookup, isCodeImport)

    // 自引用不算关系
    if (targetMaterialId === sourceMaterialId) continue

    // 去重：同一来源、同一目标、同一类型只保留首次出现（保留最早偏移）
    const key = `${hit.type}:${targetMaterialId ?? normalizeTarget(hit.target).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    results.push({
      type: hit.type,
      sourceMaterialId,
      targetMaterialId,
      rawText: hit.rawText,
      startOffset: hit.startOffset,
      endOffset: hit.endOffset,
      lineNumber: lineNumberAt(text, hit.startOffset),
      normalizedTarget: normalizeTarget(hit.target)
    })
  }

  return results.sort((a, b) => a.startOffset - b.startOffset)
}
