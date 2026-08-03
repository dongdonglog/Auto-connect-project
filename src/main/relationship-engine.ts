/**
 * relationship-engine.ts
 *
 * 关系引擎核心算法（Material Map 0.1 / Phase A：关系正确性）。
 *
 * 输入：工作区材料集合（id + 文件名 + 文本）。
 * 输出：材料间关系，每条关系带类型、分数、状态与最多 4 条最高分证据。
 *
 * 关系类型优先级与分数区间：
 *   explicit_reference (0.92–1.0) > entity_overlap (0.42–0.75) > structural (<= 0.1)
 *
 * 反噪声规则：
 *   1. 通用高频实体（>=60% 材料出现）不产生 entity_overlap 关系；
 *   2. 无法定位到工作区材料的引用（外链、缺失文件）不产生关系；
 *   3. 仅凭日期/编号的相邻候选不产生 structural 关系。
 *
 * 增量重算：
 *   updateMaterial() 只重算变更材料的直接候选集合（与其有显式引用
 *   或共享实体的材料对），不重建整个工作区。
 *
 * 状态保留：
 *   hidden / fixed 状态在重算时保持；fixed 关系即使证据消失也不被移除。
 */

import { parseReferences, type ParsedReference } from './reference-parser'
import {
  computeWorkspaceEntityStats,
  extractEntityMentions,
  filterUncommonMentions,
  type EntityMentionRecord,
  type WorkspaceEntityStats
} from './entity-extractor'

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 关系类型（即证据类型，取该关系最高优先级证据的类型） */
export type RelationType = 'explicit_reference' | 'entity_overlap' | 'structural'

/** 关系状态：visible 正常展示；hidden 用户隐藏；fixed 用户固定（防重算移除） */
export type RelationStatus = 'visible' | 'hidden' | 'fixed'

/** 一条关系证据 */
export interface EngineEvidence {
  type: RelationType
  /** 证据分数（决定证据排序，每条关系最多保留 4 条最高分） */
  score: number
  sourceMaterialId: string
  targetMaterialId: string
  /** 证据文本：引用原文或实体提及摘录 */
  text: string
  /** 来源材料中的偏移（引用起始位置 / 实体提及位置） */
  sourceOffset: number | null
  lineNumber: number | null
  /** entity_overlap 证据对应的规范化实体名，其余类型为 null */
  entity: string | null
}

/** 一条材料间关系 */
export interface EngineRelation {
  /** 稳定 ID：按材料 ID 排序的 "a::b" 形式，重算时保持不变 */
  id: string
  sourceMaterialId: string
  targetMaterialId: string
  relationType: RelationType
  /** 关系分数 = 最高优先级证据的聚合分 */
  score: number
  status: RelationStatus
  evidence: EngineEvidence[]
  updatedAt: string
}

/** 引擎输入的工作区材料 */
export interface EngineMaterial {
  id: string
  /** 文件名（含扩展名），供引用解析匹配 */
  fileName: string
  /** 工作区内相对路径（可选） */
  relativePath?: string
  /** 材料全文 */
  text: string
}

/** 外部提供的结构候选（可选）。仅凭日期/编号相邻的候选会被拒绝 */
export interface StructuralCandidate {
  sourceMaterialId: string
  targetMaterialId: string
  /** 结构证据描述（如 "同一目录相邻"）；不得仅为日期/编号 */
  text: string
  /** 结构分，<= 0.1，缺省 0.08 */
  score?: number
}

/** 引擎可调参数 */
export interface RelationshipEngineOptions {
  /** 每条关系最多保留的证据条数，默认 4 */
  maxEvidencePerRelation?: number
  /** entity_overlap 建边所需的最少共享实体数，默认 1 */
  minSharedEntities?: number
  /** 当前时间注入（测试用），默认 ISO now */
  now?: () => string
}

// ---------------------------------------------------------------------------
// 分数区间常量
// ---------------------------------------------------------------------------

/** explicit_reference: 0.92 起，每多一条独立引用 +0.02，封顶 1.0 */
const EXPLICIT_BASE = 0.92
const EXPLICIT_STEP = 0.02
const EXPLICIT_MAX = 1.0

/** entity_overlap: 0.42 起，按共享实体加权计数线性增至 0.75 */
const OVERLAP_BASE = 0.42
const OVERLAP_MAX = 0.75
/** 加权共享计数达到该值时分数封顶 */
const OVERLAP_SATURATION = 3

/** structural 分数硬上限 */
const STRUCTURAL_MAX = 0.1

/** 关系类型优先级（数值越小优先级越高） */
const TYPE_PRIORITY: Record<RelationType, number> = {
  explicit_reference: 0,
  entity_overlap: 1,
  structural: 2
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 生成稳定关系 ID 与规范化的材料对（按 ID 排序，保证无向一致性） */
function pairOf(a: string, b: string): { id: string; source: string; target: string } {
  return a < b ? { id: `${a}::${b}`, source: a, target: b } : { id: `${b}::${a}`, source: b, target: a }
}

/** 反噪声规则 3：证据文本仅由日期/编号/序号构成时视为噪声 */
function isDateOrNumberOnlyEvidence(text: string): boolean {
  // 先剥离空白与标点（unicode 感知，保留中文等字母），再判断剩余内容
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '')
  if (!stripped) return true // 纯标点/空白，无实质证据
  return /^(?:\d{4}年?\d{1,2}月?\d{1,2}日?|\d+|[一二三四五六七八九十百千万]+)$/.test(stripped)
}

/** 聚合 explicit_reference 分数：独立引用条数越多越高 */
function explicitScore(referenceCount: number): number {
  return Math.min(EXPLICIT_MAX, EXPLICIT_BASE + EXPLICIT_STEP * Math.max(0, referenceCount - 1))
}

/**
 * 聚合 entity_overlap 分数：
 * 每个共享实体按 (1 - df/N) 加权（越稀有权重越高），
 * 加权和达到 OVERLAP_SATURATION 时封顶 0.75。
 */
function overlapScore(shared: Array<{ normalized: string; df: number }>, materialCount: number): number {
  const weighted = shared.reduce((sum, entity) => {
    const rarity = materialCount > 0 ? 1 - entity.df / materialCount : 1
    return sum + Math.max(0.2, rarity) // 权重下限 0.2，避免高频但未达 common 阈值的实体贡献为零
  }, 0)
  const ratio = Math.min(1, weighted / OVERLAP_SATURATION)
  return OVERLAP_BASE + (OVERLAP_MAX - OVERLAP_BASE) * ratio
}

// ---------------------------------------------------------------------------
// 关系引擎
// ---------------------------------------------------------------------------

export class RelationshipEngine {
  private readonly maxEvidence: number
  private readonly minSharedEntities: number
  private readonly now: () => string

  /** 工作区材料快照 */
  private materials = new Map<string, EngineMaterial>()
  /** 当前关系状态（pairId -> relation） */
  private relations = new Map<string, EngineRelation>()
  /** 每个材料的非通用实体提及缓存 */
  private mentionsCache = new Map<string, EntityMentionRecord[]>()
  /** 每个材料的已解析显式引用缓存（仅保留已解析到目标的） */
  private referencesCache = new Map<string, ParsedReference[]>()
  /** 工作区级实体统计（common 标记） */
  private entityStats: WorkspaceEntityStats = { documentFrequency: new Map(), common: new Map(), materialCount: 0 }
  /** 外部注入的结构候选 */
  private structuralCandidates: StructuralCandidate[] = []

  constructor(options: RelationshipEngineOptions = {}) {
    this.maxEvidence = options.maxEvidencePerRelation ?? 4
    this.minSharedEntities = options.minSharedEntities ?? 1
    this.now = options.now ?? (() => new Date().toISOString())
  }

  // -------------------------------------------------------------------------
  // 全量计算
  // -------------------------------------------------------------------------

  /**
   * 全量重建工作区关系。
   * 与旧状态合并：hidden/fixed 状态保留；fixed 关系即使不再被计算出来也保留。
   *
   * @param materials 工作区材料集合
   * @param structuralCandidates 可选结构候选（会经过反噪声校验）
   */
  computeWorkspace(materials: EngineMaterial[], structuralCandidates: StructuralCandidate[] = []): EngineRelation[] {
    this.materials = new Map(materials.map((material) => [material.id, material]))
    this.structuralCandidates = structuralCandidates
    this.rebuildAnalysisCaches()

    const candidatePairs = this.collectAllCandidatePairs()
    const next = new Map<string, EngineRelation>()
    for (const pairId of candidatePairs) {
      const relation = this.computePair(pairId)
      if (relation) next.set(pairId, relation)
    }
    this.relations = this.mergeWithPreviousState(next, this.relations)
    return this.getRelations()
  }

  // -------------------------------------------------------------------------
  // 增量重算
  // -------------------------------------------------------------------------

  /**
   * 单材料更新（新增/修改）后的增量重算。
   * 只重算该材料的直接候选集合：与它有显式引用（双向）或共享实体的材料对。
   *
   * @returns 本次受影响（新增/更新/删除）的关系
   */
  updateMaterial(material: EngineMaterial): EngineRelation[] {
    const before = new Map(this.relations)
    this.materials.set(material.id, material)
    // 实体统计依赖全量 df，需重建提及缓存与统计（轻量：纯内存词表匹配）
    this.rebuildAnalysisCaches()

    const affectedPairs = this.collectCandidatePairsFor(material.id)
    // 该材料历史上参与过的关系也必须复查（证据可能已消失）
    for (const [pairId, relation] of before) {
      if (relation.sourceMaterialId === material.id || relation.targetMaterialId === material.id) {
        affectedPairs.add(pairId)
      }
    }

    const next = new Map(this.relations)
    for (const pairId of affectedPairs) {
      const relation = this.computePair(pairId)
      if (relation) next.set(pairId, relation)
      else next.delete(pairId)
    }
    this.relations = this.mergeWithPreviousState(next, before)

    return this.getRelations().filter((relation) => {
      const pairId = relation.id
      const old = before.get(pairId)
      if (!old) return affectedPairs.has(pairId)
      return affectedPairs.has(pairId) && (old.score !== relation.score || old.status !== relation.status || old.evidence.length !== relation.evidence.length)
    })
  }

  /** 移除材料及其参与的关系（fixed 关系同样移除——材料已不存在） */
  removeMaterial(materialId: string): void {
    this.materials.delete(materialId)
    this.rebuildAnalysisCaches()
    for (const [pairId, relation] of [...this.relations]) {
      if (relation.sourceMaterialId === materialId || relation.targetMaterialId === materialId) {
        this.relations.delete(pairId)
      }
    }
  }

  /** 获取当前全部关系（按分数降序） */
  getRelations(): EngineRelation[] {
    return [...this.relations.values()].sort((a, b) => b.score - a.score)
  }

  /** 手动设置关系状态（hidden / fixed / visible），供用户操作入口调用 */
  setRelationStatus(pairId: string, status: RelationStatus): EngineRelation | null {
    const relation = this.relations.get(pairId)
    if (!relation) return null
    const updated = { ...relation, status, updatedAt: this.now() }
    this.relations.set(pairId, updated)
    return updated
  }

  // -------------------------------------------------------------------------
  // 内部：缓存与统计
  // -------------------------------------------------------------------------

  /** 重建解析缓存与工作区级实体统计 */
  private rebuildAnalysisCaches(): void {
    const locators = [...this.materials.values()].map((material) => ({
      id: material.id,
      fileName: material.fileName,
      relativePath: material.relativePath
    }))

    this.referencesCache = new Map()
    this.mentionsCache = new Map()
    const mentionsByMaterial: Array<{ materialId: string; mentions: EntityMentionRecord[] }> = []

    for (const material of this.materials.values()) {
      // 显式引用：仅保留已解析到工作区材料的（反噪声规则 2：外链/未定位目标丢弃）
      const references = parseReferences(material.id, material.text, locators)
        .filter((reference) => reference.targetMaterialId !== null)
      this.referencesCache.set(material.id, references)

      const mentions = extractEntityMentions(material.id, material.text)
      this.mentionsCache.set(material.id, mentions)
      mentionsByMaterial.push({ materialId: material.id, mentions })
    }

    this.entityStats = computeWorkspaceEntityStats(mentionsByMaterial)

    // 反噪声规则 1：通用高频实体从提及缓存中剔除
    for (const [materialId, mentions] of this.mentionsCache) {
      this.mentionsCache.set(materialId, filterUncommonMentions(mentions, this.entityStats))
    }
  }

  /** 全量候选材料对：有显式引用（双向）或共享 >= minSharedEntities 个非通用实体 */
  private collectAllCandidatePairs(): Set<string> {
    const pairs = new Set<string>()
    this.collectReferencePairs((pairId) => pairs.add(pairId))

    // 实体倒排：entity -> materialIds
    const byEntity = new Map<string, string[]>()
    for (const [materialId, mentions] of this.mentionsCache) {
      for (const mention of mentions) {
        const list = byEntity.get(mention.normalized) ?? []
        list.push(materialId)
        byEntity.set(mention.normalized, list)
      }
    }
    const sharedCount = new Map<string, number>()
    for (const materialIds of byEntity.values()) {
      for (let i = 0; i < materialIds.length; i++) {
        for (let j = i + 1; j < materialIds.length; j++) {
          const pairId = pairOf(materialIds[i], materialIds[j]).id
          sharedCount.set(pairId, (sharedCount.get(pairId) ?? 0) + 1)
        }
      }
    }
    for (const [pairId, count] of sharedCount) {
      if (count >= this.minSharedEntities) pairs.add(pairId)
    }
    // 结构候选对（先过反噪声校验再纳入候选）
    for (const candidate of this.structuralCandidates) {
      if (isDateOrNumberOnlyEvidence(candidate.text)) continue
      if (!this.materials.has(candidate.sourceMaterialId) || !this.materials.has(candidate.targetMaterialId)) continue
      pairs.add(pairOf(candidate.sourceMaterialId, candidate.targetMaterialId).id)
    }
    return pairs
  }

  /** 单材料的直接候选对：引用相关对 + 共享实体对 */
  private collectCandidatePairsFor(materialId: string): Set<string> {
    const pairs = new Set<string>()
    this.collectReferencePairs((pairId, a, b) => {
      if (a === materialId || b === materialId) pairs.add(pairId)
    })
    const myEntities = new Set((this.mentionsCache.get(materialId) ?? []).map((mention) => mention.normalized))
    for (const [otherId, mentions] of this.mentionsCache) {
      if (otherId === materialId) continue
      const shared = mentions.filter((mention) => myEntities.has(mention.normalized)).length
      if (shared >= this.minSharedEntities) pairs.add(pairOf(materialId, otherId).id)
    }
    // 涉及该材料的结构候选对
    for (const candidate of this.structuralCandidates) {
      if (candidate.sourceMaterialId === materialId || candidate.targetMaterialId === materialId) {
        pairs.add(pairOf(candidate.sourceMaterialId, candidate.targetMaterialId).id)
      }
    }
    return pairs
  }

  /** 遍历全部显式引用对（双向都算候选） */
  private collectReferencePairs(visit: (pairId: string, a: string, b: string) => void): void {
    for (const references of this.referencesCache.values()) {
      for (const reference of references) {
        const target = reference.targetMaterialId
        if (!target || target === reference.sourceMaterialId) continue
        const pair = pairOf(reference.sourceMaterialId, target)
        visit(pair.id, pair.source, pair.target)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部：单对关系计算
  // -------------------------------------------------------------------------

  /** 计算一个材料对的关系；证据不足时返回 null */
  private computePair(pairId: string): EngineRelation | null {
    const { source, target } = pairOf(...(pairId.split('::') as [string, string]))
    const evidence: EngineEvidence[] = []

    // --- explicit_reference 证据（双向收集） ---
    const explicitRefs: ParsedReference[] = []
    for (const materialId of [source, target]) {
      for (const reference of this.referencesCache.get(materialId) ?? []) {
        const other = materialId === source ? target : source
        if (reference.targetMaterialId === other) explicitRefs.push(reference)
      }
    }
    for (const reference of explicitRefs) {
      evidence.push({
        type: 'explicit_reference',
        score: EXPLICIT_MAX, // 排序用：显式证据优先保留
        sourceMaterialId: reference.sourceMaterialId,
        targetMaterialId: reference.targetMaterialId ?? target,
        text: reference.rawText,
        sourceOffset: reference.startOffset,
        lineNumber: reference.lineNumber,
        entity: null
      })
    }

    // --- entity_overlap 证据（仅非通用实体） ---
    const sourceMentions = this.mentionsCache.get(source) ?? []
    const targetMentions = this.mentionsCache.get(target) ?? []
    const targetEntities = new Map(targetMentions.map((mention) => [mention.normalized, mention]))
    const shared: Array<{ normalized: string; df: number; mention: EntityMentionRecord }> = []
    for (const mention of sourceMentions) {
      if (targetEntities.has(mention.normalized)) {
        shared.push({
          normalized: mention.normalized,
          df: this.entityStats.documentFrequency.get(mention.normalized) ?? 1,
          mention
        })
      }
    }
    const aggregateOverlap = shared.length >= this.minSharedEntities
      ? overlapScore(shared, this.entityStats.materialCount)
      : 0
    for (const entity of shared) {
      const mention = entity.mention
      evidence.push({
        type: 'entity_overlap',
        score: aggregateOverlap, // 同一对材料的实体证据同分，按分数截断时并列
        sourceMaterialId: source,
        targetMaterialId: target,
        text: mention.excerpt,
        sourceOffset: mention.startOffset,
        lineNumber: mention.lineNumber,
        entity: entity.normalized
      })
    }

    // --- structural 证据（外部候选，反噪声校验） ---
    let structuralScore = 0
    for (const candidate of this.structuralCandidates) {
      const candidatePair = pairOf(candidate.sourceMaterialId, candidate.targetMaterialId)
      if (candidatePair.id !== pairId) continue
      // 反噪声规则 3：仅凭日期/编号的相邻不产生关系
      if (isDateOrNumberOnlyEvidence(candidate.text)) continue
      const score = Math.min(STRUCTURAL_MAX, Math.max(0, candidate.score ?? 0.08))
      structuralScore = Math.max(structuralScore, score)
      evidence.push({
        type: 'structural',
        score,
        sourceMaterialId: candidate.sourceMaterialId,
        targetMaterialId: candidate.targetMaterialId,
        text: candidate.text,
        sourceOffset: null,
        lineNumber: null,
        entity: null
      })
    }

    if (evidence.length === 0) return null

    // 关系分数：按类型优先级取最高优先级的聚合分
    const relationType: RelationType = explicitRefs.length > 0
      ? 'explicit_reference'
      : shared.length >= this.minSharedEntities
        ? 'entity_overlap'
        : 'structural'
    const score = relationType === 'explicit_reference'
      ? explicitScore(explicitRefs.length)
      : relationType === 'entity_overlap'
        ? aggregateOverlap
        : structuralScore
    if (score <= 0) return null

    // 证据截断：类型优先级优先，同类型按分数降序，最多 maxEvidence 条
    const kept = evidence
      .sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] || b.score - a.score)
      .slice(0, this.maxEvidence)

    return {
      id: pairId,
      sourceMaterialId: source,
      targetMaterialId: target,
      relationType,
      score,
      status: 'visible',
      evidence: kept,
      updatedAt: this.now()
    }
  }

  // -------------------------------------------------------------------------
  // 内部：状态合并
  // -------------------------------------------------------------------------

  /**
   * 将新计算的关系与旧状态合并：
   *  - hidden / fixed 状态保留（分数与证据刷新，状态不变）；
   *  - fixed 关系即使本次未被计算出来也保留（用户固定优先于算法结果）；
   *  - hidden 关系未被重新计算出来时丢弃（材料已无关联证据，无需保留隐藏标记）。
   */
  private mergeWithPreviousState(next: Map<string, EngineRelation>, previous: Map<string, EngineRelation>): Map<string, EngineRelation> {
    const merged = new Map<string, EngineRelation>()
    for (const [pairId, relation] of next) {
      const old = previous.get(pairId)
      if (old && old.status !== 'visible') {
        merged.set(pairId, { ...relation, status: old.status })
      } else {
        merged.set(pairId, relation)
      }
    }
    for (const [pairId, old] of previous) {
      if (!merged.has(pairId) && old.status === 'fixed') {
        merged.set(pairId, { ...old, updatedAt: this.now() })
      }
    }
    return merged
  }
}

// ---------------------------------------------------------------------------
// 便捷函数：一次性全量计算（无状态场景 / 测试）
// ---------------------------------------------------------------------------

/**
 * 一次性计算工作区关系（等价于 new RelationshipEngine().computeWorkspace()）。
 */
export function computeWorkspaceRelations(
  materials: EngineMaterial[],
  structuralCandidates: StructuralCandidate[] = [],
  options: RelationshipEngineOptions = {}
): EngineRelation[] {
  return new RelationshipEngine(options).computeWorkspace(materials, structuralCandidates)
}
