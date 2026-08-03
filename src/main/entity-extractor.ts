/**
 * entity-extractor.ts
 *
 * 实体提取器（Material Map 0.1 / Phase A）。
 *
 * 职责：基于受控词表从材料文本中提取实体提及（mention），
 * 做规范化与去重，并在工作区层面做高频通用词抑制
 * （在 >=60% 材料中出现的实体标记为 common，不产生关系）。
 *
 * 设计说明：
 *  - 词表匹配对英文术语使用词边界正则（大小写不敏感），
 *    对含特殊字符的词（如 "C++"、"Node.js"、"@xyflow/react"）做转义处理；
 *  - 多词术语（如 "React Flow"）优先于单词术语匹配，避免重复计数
 *    （通过"区间重叠去重"：同一区间只保留最长匹配）；
 *  - 规范化：trim + 压缩空白 + 小写，用于跨材料实体对齐。
 */

/** 受控实体词表条目 */
export interface VocabularyEntry {
  /** 词表中的规范写法（展示用） */
  canonical: string
  /** 实体类别 */
  category: 'technology' | 'framework' | 'protocol'
}

/** 一条实体提及记录 */
export interface EntityMentionRecord {
  /** 规范化实体名（小写、压缩空白），跨材料对齐键 */
  normalized: string
  /** 词表规范写法 */
  canonical: string
  /** 实体类别 */
  category: VocabularyEntry['category']
  /** 所属材料 ID */
  materialId: string
  /** 提及在原文中的起始偏移 */
  startOffset: number
  /** 提及在原文中的结束偏移 */
  endOffset: number
  /** 提及上下文摘录（前后各取若干字符） */
  excerpt: string
  /** 所在行号（从 1 开始） */
  lineNumber: number
}

/** 工作区级实体统计结果 */
export interface WorkspaceEntityStats {
  /** 规范化实体名 -> 出现过该实体的材料数 */
  documentFrequency: Map<string, number>
  /** 规范化实体名 -> 是否为通用高频实体（df / 材料总数 >= 0.6） */
  common: Map<string, boolean>
  /** 材料总数 */
  materialCount: number
}

/** 通用实体判定阈值：出现材料数占比 >= 0.6 */
export const COMMON_ENTITY_DF_RATIO = 0.6

/** 受控实体词表 */
export const CONTROLLED_VOCABULARY: VocabularyEntry[] = [
  // 技术
  ...['SQLite', 'React', 'TypeScript', 'Electron', 'Node.js', 'Python', 'Go', 'Rust',
    'Docker', 'Kubernetes', 'PostgreSQL', 'MongoDB', 'Redis', 'GraphQL', 'REST',
    'WebSocket', 'OAuth', 'JWT', 'AES', 'RSA', 'SHA256', 'Markdown', 'JSON', 'YAML',
    'CSV', 'PDF', 'DOCX', 'HTML', 'CSS', 'JavaScript', 'Java', 'C++']
    .map((canonical): VocabularyEntry => ({ canonical, category: 'technology' })),
  // 框架 / 库
  ...['React Flow', '@xyflow/react', 'dagre', 'sql.js', 'mammoth', 'pdf-parse',
    'electron-vite', 'electron-builder', 'Vue', 'chokidar']
    .map((canonical): VocabularyEntry => ({ canonical, category: 'framework' })),
  // 协议 / 标准
  ...['HTTP', 'HTTPS', 'gRPC', 'IPC', 'FTP', 'SSH', 'TLS']
    .map((canonical): VocabularyEntry => ({ canonical, category: 'protocol' }))
]

/**
 * 实体规范化：trim、压缩连续空白为单个空格、转小写。
 * 与 workspace-service.ts 中的 normalizeEntity 行为保持一致。
 */
export function normalizeEntityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 转义正则特殊字符（处理 "C++"、"Node.js"、"@xyflow/react" 等） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 词边界：术语首尾为单词字符时用 \b，否则用非单词字符/字符串边界断言 */
function boundaryPattern(term: string): string {
  const escaped = escapeRegExp(term)
  const head = /^\w/.test(term) ? '\\b' : '(?<!\\w)'
  const tail = /\w$/.test(term) ? '\\b' : '(?!\\w)'
  return `${head}${escaped}${tail}`
}

/** 编译词表为匹配计划：按术语长度降序，保证多词术语优先（React Flow > React） */
interface MatchPlan { entry: VocabularyEntry; pattern: RegExp }

function buildMatchPlans(vocabulary: VocabularyEntry[]): MatchPlan[] {
  return [...vocabulary]
    .sort((a, b) => b.canonical.length - a.canonical.length)
    .map((entry) => ({ entry, pattern: new RegExp(boundaryPattern(entry.canonical), 'gi') }))
}

/** 计算文本中某偏移处的行号（从 1 开始） */
function lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/** 截取提及上下文摘录：前后各 contextChars 个字符 */
function excerptAround(text: string, start: number, end: number, contextChars = 24): string {
  const from = Math.max(0, start - contextChars)
  const to = Math.min(text.length, end + contextChars)
  const prefix = from > 0 ? '…' : ''
  const suffix = to < text.length ? '…' : ''
  return `${prefix}${text.slice(from, to).replace(/\s+/g, ' ')}${suffix}`
}

/**
 * 从单个材料文本中提取实体提及。
 * 区间重叠时保留最长匹配（例如 "React Flow" 命中后，其中的 "React" 不再单独计数）。
 *
 * @param materialId 材料 ID
 * @param text       材料全文
 * @param vocabulary 受控词表（默认使用内置 CONTROLLED_VOCABULARY）
 */
export function extractEntityMentions(
  materialId: string,
  text: string,
  vocabulary: VocabularyEntry[] = CONTROLLED_VOCABULARY
): EntityMentionRecord[] {
  const plans = buildMatchPlans(vocabulary)
  // 已占用区间集合： [start, end) 重叠即跳过较短匹配
  const occupied: Array<[number, number]> = []
  const mentions: EntityMentionRecord[] = []
  // 同一材料内同一实体只保留首次提及（去重），但仍记录完整位置信息
  const seen = new Set<string>()

  for (const { entry, pattern } of plans) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (occupied.some(([s, e]) => start < e && end > s)) continue
      occupied.push([start, end])
      const normalized = normalizeEntityName(entry.canonical)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      mentions.push({
        normalized,
        canonical: entry.canonical,
        category: entry.category,
        materialId,
        startOffset: start,
        endOffset: end,
        excerpt: excerptAround(text, start, end),
        lineNumber: lineNumberAt(text, start)
      })
    }
  }

  return mentions.sort((a, b) => a.startOffset - b.startOffset)
}

/**
 * 统计工作区级实体分布并标记通用高频实体。
 * 实体在 >=60% 的材料中出现时标记为 common（不产生关系）。
 *
 * @param mentionsByMaterial 每个材料的实体提及列表
 */
export function computeWorkspaceEntityStats(
  mentionsByMaterial: Array<{ materialId: string; mentions: EntityMentionRecord[] }>
): WorkspaceEntityStats {
  const documentFrequency = new Map<string, number>()
  for (const { mentions } of mentionsByMaterial) {
    const distinct = new Set(mentions.map((mention) => mention.normalized))
    for (const normalized of distinct) {
      documentFrequency.set(normalized, (documentFrequency.get(normalized) ?? 0) + 1)
    }
  }
  const materialCount = mentionsByMaterial.length
  const common = new Map<string, boolean>()
  for (const [normalized, df] of documentFrequency) {
    common.set(normalized, materialCount > 0 && df / materialCount >= COMMON_ENTITY_DF_RATIO)
  }
  return { documentFrequency, common, materialCount }
}

/**
 * 便捷入口：过滤掉通用高频实体的提及。
 * 返回仅保留"非通用"实体的提及列表（供关系引擎计算 entity_overlap）。
 */
export function filterUncommonMentions(
  mentions: EntityMentionRecord[],
  stats: WorkspaceEntityStats
): EntityMentionRecord[] {
  return mentions.filter((mention) => !stats.common.get(mention.normalized))
}
