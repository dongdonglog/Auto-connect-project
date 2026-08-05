import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { decrypt, deriveKey, encrypt, createSalt } from './crypto'
import { extractFile, fetchLinkMetadata, plainExcerpt, type ExtractedMaterial } from './parsers'
import { chunkHash, chunkText, tokenize } from './indexer'
import { detectVectorCapability, type VectorCapability } from './db/vector-capability'
import { VectorStore } from './db/vector-store'
import { NativeDatabase } from './db/native-database'
import { stableTopicOrder, topologyPositions } from '../shared/topic-topology'
import type { AnalysisStatus, Entity, EntityMention, EntityMentionSource, EntityType, FolderSource, Job, LineDash, Material, MaterialAnalysisCard, MaterialChunk, MaterialRelation, MaterialRelationStatus, MaterialTag, ModelSettings, Relation, RelationWaypoint, RelationshipEvidence, SearchHit, Topic, TopicAnalysisRun, TopicCandidateStatus, TopicEditorCommand, TopicHistoryStatus, TopicRelationCandidate, TopicRelationCandidateRecord, TopicMap, TopicProposal, WorkspaceSummary, Workstream } from './types'

type SqlRow = Record<string, unknown>
interface WorkspaceConfig { id: string; name: string; encrypted: boolean; salt?: string }
const now = () => new Date().toISOString()
const id = () => randomUUID()
const MAX_AUTO_EXTRACT_BYTES = 10 * 1024 * 1024

function first<T>(rows: SqlRow[]): T | null { return (rows[0] as T) ?? null }
function asMaterial(row: SqlRow): Material {
  return {
    ...row,
    id: String(row.id), type: row.type as Material['type'], title: String(row.title),
    mimeType: row.mime_type as string | null, sourcePath: row.source_path as string | null,
    storedPath: row.stored_path as string | null, url: row.url as string | null,
    siteName: row.site_name as string | null, excerpt: row.excerpt as string | null,
    extractedText: row.extracted_text as string | null, importedAt: String(row.imported_at),
    occurredAt: row.occurred_at as string | null, occurredAtSource: row.occurred_at_source as Material['occurredAtSource'],
    status: row.status as Material['status'], error: row.error as string | null, hash: row.hash as string | null,
    availability: (row.availability as Material['availability']) ?? 'available', lastIndexedAt: row.lastIndexedAt as string | null ?? null
  }
}
const topicPalette = ['#08776f', '#3568b8', '#a14569', '#b26a21', '#7654a6', '#3c7d66']
function topicColor(id: string): string { return topicPalette[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % topicPalette.length] }
function asTopic(row: SqlRow): Topic { return { ...row, id: String(row.id), name: String(row.name), description: row.description as string | null, createdAt: String(row.created_at), archivedAt: row.archived_at as string | null, color: String(row.color ?? topicColor(String(row.id))), revision: Number(row.revision ?? 0) } }
function asWorkstream(row: SqlRow): Workstream { return { ...row, id: String(row.id), topicId: String(row.topic_id), name: String(row.name), position: Number(row.position), source: row.source as Workstream['source'] } }
function parseRoutePoints(value: unknown): RelationWaypoint[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((point): point is RelationWaypoint => Boolean(point) && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))).slice(0, 24).map((point) => ({ x: Number(point.x), y: Number(point.y) }))
  } catch { return [] }
}
function asRelation(row: SqlRow): Relation { return { ...row, id: String(row.id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), label: String(row.label), relationType: String(row.relation_type), evidenceText: row.evidence_text as string | null, evidenceMaterialId: row.evidence_material_id as string | null, confidence: row.confidence as number | null, createdBy: row.created_by as Relation['createdBy'], createdAt: String(row.created_at), lineColor: row.lineColor as string | null, sourceArrow: Boolean(row.sourceArrow), sourceArrowStyle: (row.sourceArrowStyle as Relation['sourceArrowStyle']) ?? (row.sourceArrow ? 'triangle' : null), targetArrowStyle: (row.targetArrowStyle as Relation['targetArrowStyle']) ?? 'triangle', animated: row.animated === undefined || row.animated === null ? true : Boolean(row.animated), archived: Boolean(row.archived), branchIndex: Number(row.branchIndex ?? 0), lineKind: (row.lineKind as Relation['lineKind']) ?? 'auto', lineWidth: Math.max(1, Math.min(8, Number(row.lineWidth ?? 2.75))), lineDash: (row.lineDash as LineDash) ?? 'auto', routePoints: parseRoutePoints(row.routePoints), labelAnchor: Math.max(.05, Math.min(.95, Number(row.labelAnchor ?? .5))) } }
function normalizeColor(value: string | null | undefined): string | null { return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null }
function normalizeTags(tags: string[]): string[] { return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 32)))].slice(0, 12) }
function normalizeOptionalText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim().slice(0, limit)
  return text || null
}
function normalizeNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('A numeric editor value is invalid.')
  return Math.max(minimum, Math.min(maximum, number))
}
function normalizeRoutePoints(value: unknown): RelationWaypoint[] {
  if (!Array.isArray(value)) throw new Error('Route points must be an array.')
  if (value.length > 24) throw new Error('A connection may have at most 24 route points.')
  return value.map((point) => {
    if (!point || typeof point !== 'object') throw new Error('A route point is invalid.')
    const row = point as Record<string, unknown>
    const x = Number(row.x); const y = Number(row.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('A route point is invalid.')
    return { x: Math.max(-100000, Math.min(100000, x)), y: Math.max(-100000, Math.min(100000, y)) }
  })
}
const validHandle = (value: unknown, direction: 'in' | 'out'): string | null => {
  if (value === undefined || value === null || value === '') return null
  const handle = String(value)
  if (!new RegExp(`^${direction}-(left|top|right|bottom)$`).test(handle)) throw new Error(`Invalid ${direction} port.`)
  return handle
}
function extractedTags(title: string, text: string, headings: string[]): Array<{ tag: string; source: MaterialTag['source']; weight: number }> {
  const values = new Map<string, { source: MaterialTag['source']; weight: number }>(); const add = (tag: string, source: MaterialTag['source'], weight: number) => { const value = tag.trim().replace(/^\d+[.、\s-]*/, '').slice(0, 28); if (value.length < 2 || /^(第?\d+[章节课讲]|场景|问题|总结|示例)$/u.test(value)) return; const old = values.get(value); if (!old || weight > old.weight) values.set(value, { source, weight }) }
  add(title.replace(/^\d+[-_\s]*/, ''), 'title', 1)
  headings.slice(0, 4).forEach((heading) => add(heading, 'heading', .9))
  const phrases = text.match(/[A-Za-z][A-Za-z0-9+.#_-]{1,24}|[\u4e00-\u9fff]{2,10}/g) ?? []; const counts = new Map<string, number>(); phrases.forEach((phrase) => counts.set(phrase, (counts.get(phrase) ?? 0) + 1)); [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 8).forEach(([phrase, count]) => add(phrase, 'phrase', Math.min(.75, .3 + count * .1)))
  return [...values.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 6).map(([tag, value]) => ({ tag, ...value }))
}
const commonTerms = new Set(['chapter', 'section', 'example', 'introduction', 'summary', 'material', 'document', 'system', 'service', 'project', '问题', '场景', '总结', '示例', '材料', '文档', '系统', '项目', '开发', '实现', '使用', '设计'])
const technologyPattern = /\b(?:Go|Golang|JavaScript|TypeScript|Python|Java|Rust|C\+\+|React|Vue|Node\.js|Node|Electron|SQLite|MySQL|PostgreSQL|MongoDB|Redis|Docker|Kubernetes|Git|GitHub|HTTP|HTTPS|REST|API|JSON|Markdown|PDF|JWT|OAuth|gRPC|SQL|Linux|Windows|macOS)\b/gi
const normalizeEntity = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()
interface MaterialReference { value: string; source: Extract<EntityMentionSource, 'link' | 'import'>; startOffset: number; endOffset: number }

function materialReferences(text: string): MaterialReference[] {
  const references: MaterialReference[] = []
  const add = (value: string, source: MaterialReference['source'], startOffset: number): void => {
    const normalized = value.trim().replace(/[?#].*$/, '').replaceAll('\\', '/')
    if (!normalized || /^https?:\/\//i.test(normalized)) return
    const endOffset = startOffset + normalized.length
    if (references.some((item) => startOffset < item.endOffset && endOffset > item.startOffset)) return
    const canonical = normalized.replace(/^\.\//, '').toLowerCase()
    const key = `${source}:${canonical}`
    if (references.some((item) => `${item.source}:${item.value.replace(/^\.\//, '').toLowerCase()}` === key)) return
    references.push({ value: normalized, source, startOffset, endOffset })
  }
  const fileExtension = '(?:md|markdown|txt|pdf|docx?|csv|json|html?|tsx?|jsx?|py|go|java|rs)'
  for (const match of text.matchAll(new RegExp(`\\[[^\\]]*\\]\\(([^)\\s]+\\.${fileExtension})(?:#[^)\\s]*)?\\)`, 'gi'))) {
    const value = String(match[1]); add(value, 'link', (match.index ?? 0) + String(match[0]).indexOf(value))
  }
  for (const match of text.matchAll(new RegExp(`(?:import|from|require)\\s*[('"\\x60]?([^'"\\x60\\s)]+\\.${fileExtension})[)'"\\x60]?`, 'gi'))) {
    const value = String(match[1]); add(value, 'import', (match.index ?? 0) + String(match[0]).indexOf(value))
  }
  for (const match of text.matchAll(new RegExp(`(?:\\.\\.?[\\/])?[\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff ._\\/-]*\\.${fileExtension}`, 'gi'))) add(String(match[0]), 'link', match.index ?? 0)
  return references.slice(0, 16)
}

export class WorkspaceService {
  private db: NativeDatabase | null = null
  private dbTempPath: string | null = null
  private root = ''
  private config: WorkspaceConfig | null = null
  private key: Buffer | null = null
  private processingTail: Promise<void> = Promise.resolve()
  private folderWatchers = new Map<string, FSWatcher>()
  private pendingFolderEvents = new Map<string, ReturnType<typeof setTimeout>>()
  private ftsEnabled = false
  private readonly vectorCapability: VectorCapability = detectVectorCapability()
  private vectorStore: VectorStore | null = null
  private embeddingProvider: ((texts: string[]) => Promise<number[][] | null>) | null = null
  private transactionDepth = 0

  close(): void {
    for (const sourceId of this.folderWatchers.keys()) this.stopFolderWatcher(sourceId)
    for (const timer of this.pendingFolderEvents.values()) clearTimeout(timer)
    this.pendingFolderEvents.clear()
    this.vectorStore?.close(); this.vectorStore = null
    this.db?.close(); if (this.dbTempPath) NativeDatabase.removeIfPresent(this.dbTempPath); this.db = null; this.dbTempPath = null; this.root = ''; this.config = null; this.key = null; this.transactionDepth = 0
  }

  private requireDb(): NativeDatabase { if (!this.db) throw new Error('Open or create a workspace first.'); return this.db }
  private query(sql: string, params: unknown[] = []): SqlRow[] {
    const statement = this.requireDb().prepare(sql); statement.bind(params as never[]); const rows: SqlRow[] = []
    while (statement.step()) rows.push(statement.getAsObject())
    statement.free(); return rows
  }
  private run(sql: string, params: unknown[] = []): void { this.requireDb().run(sql, params as never[]); this.persist() }
  private configPath(): string { return join(this.root, 'workspace.json') }
  private dbPath(): string { return join(this.root, this.config?.encrypted ? 'workspace.sqlite.enc' : 'workspace.sqlite') }
  private materialsPath(): string { return join(this.root, 'materials') }
  private vectorsPath(): string { return join(this.root, 'vectors.sqlite') }
  private persist(): void {
    if (this.transactionDepth > 0) return
    const data = Buffer.from(this.requireDb().export())
    writeFileSync(this.dbPath(), this.config?.encrypted ? encrypt(data, this.key!) : data)
  }
  private withTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()
    const database = this.requireDb()
    this.transactionDepth = 1
    database.exec('BEGIN')
    let committed = false
    try {
      const result = operation()
      database.exec('COMMIT')
      committed = true
      this.transactionDepth = 0
      this.persist()
      return result
    } catch (error) {
      try { if (!committed) database.exec('ROLLBACK') } finally { this.transactionDepth = 0 }
      throw error
    }
  }
  private initializeSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, mime_type TEXT, source_path TEXT, stored_path TEXT, url TEXT, site_name TEXT, excerpt TEXT, extracted_text TEXT, imported_at TEXT NOT NULL, occurred_at TEXT, occurred_at_source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, hash TEXT);
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, archived_at TEXT, color TEXT, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS topic_materials (topic_id TEXT NOT NULL, material_id TEXT NOT NULL, workstream_id TEXT, canvas_x REAL, canvas_y REAL, position_source TEXT NOT NULL DEFAULT 'auto', card_color TEXT, card_tags TEXT, card_note TEXT, sequence INTEGER, sequence_source TEXT NOT NULL DEFAULT 'time', added_at TEXT, display_title TEXT, display_excerpt TEXT, card_width REAL, card_height REAL, card_text_color TEXT, card_font_size REAL, card_collapsed INTEGER NOT NULL DEFAULT 0, card_z_index INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(topic_id, material_id));
      CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, label TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_text TEXT, evidence_material_id TEXT, confidence REAL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, topic_id TEXT);
      CREATE TABLE IF NOT EXISTS topic_relation_styles (topic_id TEXT NOT NULL, relation_id TEXT NOT NULL, line_color TEXT, source_arrow INTEGER NOT NULL DEFAULT 0, source_arrow_style TEXT NOT NULL DEFAULT 'none', target_arrow_style TEXT NOT NULL DEFAULT 'triangle', animated INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, branch_index INTEGER NOT NULL DEFAULT 0, line_kind TEXT NOT NULL DEFAULT 'auto', source_handle TEXT, target_handle TEXT, line_width REAL NOT NULL DEFAULT 2.75, line_dash TEXT NOT NULL DEFAULT 'auto', route_points TEXT NOT NULL DEFAULT '[]', label_anchor REAL NOT NULL DEFAULT .5, PRIMARY KEY(topic_id, relation_id));
      CREATE TABLE IF NOT EXISTS topic_editor_history (topic_id TEXT NOT NULL, sequence INTEGER NOT NULL, command_json TEXT NOT NULL, inverse_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(topic_id, sequence));
      CREATE TABLE IF NOT EXISTS topic_editor_history_state (topic_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folder_sources (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, include_patterns TEXT NOT NULL DEFAULT '[]', exclude_patterns TEXT NOT NULL DEFAULT '[]', watch_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_index_state (material_id TEXT PRIMARY KEY, source_id TEXT, availability TEXT NOT NULL DEFAULT 'available', last_indexed_at TEXT, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS material_chunks (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, page_number INTEGER, heading TEXT, hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_proposals (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, material_id TEXT, relation_id TEXT, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_analysis_cards (material_id TEXT NOT NULL, content_hash TEXT NOT NULL, model_id TEXT NOT NULL, title TEXT NOT NULL, date TEXT, headings TEXT NOT NULL, keywords TEXT NOT NULL, evidence_chunk_ids TEXT NOT NULL, summary TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY(material_id, content_hash, model_id));
      CREATE TABLE IF NOT EXISTS topic_analysis_runs (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, topic_revision INTEGER NOT NULL, stage TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, added_relations INTEGER NOT NULL DEFAULT 0, rejected_candidates INTEGER NOT NULL DEFAULT 0, error TEXT, summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_tags (material_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(material_id, tag));
      CREATE TABLE IF NOT EXISTS topic_relation_candidates (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, shared_tags TEXT NOT NULL, score REAL NOT NULL, status TEXT NOT NULL DEFAULT 'visible', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(topic_id, source_material_id, target_material_id));
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, text TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, type TEXT NOT NULL, weight REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_mentions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, material_id TEXT NOT NULL, source TEXT NOT NULL, start_offset INTEGER, end_offset INTEGER, excerpt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entity_mentions_material_idx ON entity_mentions(material_id);
      CREATE INDEX IF NOT EXISTS entity_mentions_entity_idx ON entity_mentions(entity_id);
      CREATE TABLE IF NOT EXISTS material_relations (id TEXT PRIMARY KEY, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, score REAL NOT NULL, relation_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible', updated_at TEXT NOT NULL, UNIQUE(source_material_id, target_material_id));
      CREATE INDEX IF NOT EXISTS material_relations_source_idx ON material_relations(source_material_id, status, score DESC);
      CREATE TABLE IF NOT EXISTS relationship_evidence (id TEXT PRIMARY KEY, relation_id TEXT NOT NULL, type TEXT NOT NULL, score REAL NOT NULL, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, source_entity_id TEXT, target_entity_id TEXT, source_offset INTEGER, target_offset INTEGER, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS relationship_evidence_relation_idx ON relationship_evidence(relation_id);
    `)
    try { this.requireDb().run('CREATE VIRTUAL TABLE IF NOT EXISTS material_chunks_fts USING fts5(chunk_id UNINDEXED, material_id UNINDEXED, title, text, heading)'); this.ftsEnabled = true } catch { this.ftsEnabled = false }
    const topicTableColumns = this.query('PRAGMA table_info(topics)').map((row) => String(row.name))
    if (!topicTableColumns.includes('archived_at')) this.requireDb().run('ALTER TABLE topics ADD COLUMN archived_at TEXT')
    if (!topicTableColumns.includes('color')) this.requireDb().run('ALTER TABLE topics ADD COLUMN color TEXT')
    if (!topicTableColumns.includes('revision')) this.requireDb().run('ALTER TABLE topics ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    for (const topic of this.query("SELECT id FROM topics WHERE color IS NULL OR color=''")) this.requireDb().run('UPDATE topics SET color=? WHERE id=?', [topicColor(String(topic.id)), String(topic.id)])
    const topicColumns = this.query('PRAGMA table_info(topic_materials)').map((row) => String(row.name))
    if (!topicColumns.includes('canvas_x')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN canvas_x REAL')
    if (!topicColumns.includes('canvas_y')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN canvas_y REAL')
    if (!topicColumns.includes('position_source')) this.requireDb().run("ALTER TABLE topic_materials ADD COLUMN position_source TEXT NOT NULL DEFAULT 'auto'")
    if (!topicColumns.includes('card_color')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_color TEXT')
    if (!topicColumns.includes('card_tags')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_tags TEXT')
    if (!topicColumns.includes('card_note')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_note TEXT')
    if (!topicColumns.includes('sequence')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN sequence INTEGER')
    if (!topicColumns.includes('sequence_source')) this.requireDb().run("ALTER TABLE topic_materials ADD COLUMN sequence_source TEXT NOT NULL DEFAULT 'time'")
    if (!topicColumns.includes('added_at')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN added_at TEXT')
    if (!topicColumns.includes('display_title')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN display_title TEXT')
    if (!topicColumns.includes('display_excerpt')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN display_excerpt TEXT')
    if (!topicColumns.includes('card_width')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_width REAL')
    if (!topicColumns.includes('card_height')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_height REAL')
    if (!topicColumns.includes('card_text_color')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_text_color TEXT')
    if (!topicColumns.includes('card_font_size')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_font_size REAL')
    if (!topicColumns.includes('card_collapsed')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_collapsed INTEGER NOT NULL DEFAULT 0')
    if (!topicColumns.includes('card_z_index')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_z_index INTEGER NOT NULL DEFAULT 0')
    this.requireDb().run('UPDATE topic_materials SET added_at=COALESCE(added_at, ?) WHERE added_at IS NULL', [now()])
    const relationStyleColumns = this.query('PRAGMA table_info(topic_relation_styles)').map((row) => String(row.name))
    const relationColumns = this.query('PRAGMA table_info(relations)').map((row) => String(row.name))
    if (!relationColumns.includes('topic_id')) this.requireDb().run('ALTER TABLE relations ADD COLUMN topic_id TEXT')
    if (!relationStyleColumns.includes('source_arrow')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN source_arrow INTEGER NOT NULL DEFAULT 0')
    if (!relationStyleColumns.includes('animated')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN animated INTEGER NOT NULL DEFAULT 1')
    if (!relationStyleColumns.includes('archived')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
    if (!relationStyleColumns.includes('branch_index')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN branch_index INTEGER NOT NULL DEFAULT 0')
    if (!relationStyleColumns.includes('line_kind')) this.requireDb().run("ALTER TABLE topic_relation_styles ADD COLUMN line_kind TEXT NOT NULL DEFAULT 'auto'")
    if (!relationStyleColumns.includes('source_arrow_style')) this.requireDb().run("ALTER TABLE topic_relation_styles ADD COLUMN source_arrow_style TEXT NOT NULL DEFAULT 'none'")
    if (!relationStyleColumns.includes('target_arrow_style')) this.requireDb().run("ALTER TABLE topic_relation_styles ADD COLUMN target_arrow_style TEXT NOT NULL DEFAULT 'triangle'")
    if (!relationStyleColumns.includes('source_handle')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN source_handle TEXT')
    if (!relationStyleColumns.includes('target_handle')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN target_handle TEXT')
    if (!relationStyleColumns.includes('line_width')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN line_width REAL NOT NULL DEFAULT 2.75')
    if (!relationStyleColumns.includes('line_dash')) this.requireDb().run("ALTER TABLE topic_relation_styles ADD COLUMN line_dash TEXT NOT NULL DEFAULT 'auto'")
    if (!relationStyleColumns.includes('route_points')) this.requireDb().run("ALTER TABLE topic_relation_styles ADD COLUMN route_points TEXT NOT NULL DEFAULT '[]'")
    if (!relationStyleColumns.includes('label_anchor')) this.requireDb().run('ALTER TABLE topic_relation_styles ADD COLUMN label_anchor REAL NOT NULL DEFAULT .5')
    // Version 1 incorrectly made every manual edge bidirectional at startup.
    // Normalize that old default once, then preserve any arrow style the user
    // explicitly chooses in the relation inspector.
    const directedManualEdges = this.query("SELECT value FROM settings WHERE key='directed-manual-edges-v1'")[0]
    if (!directedManualEdges) {
      this.requireDb().run("UPDATE topic_relation_styles SET source_arrow=0, source_arrow_style='none' WHERE source_arrow_style='triangle' AND relation_id IN (SELECT id FROM relations WHERE created_by='manual')")
      this.requireDb().run("INSERT INTO settings (key, value) VALUES ('directed-manual-edges-v1', 'complete')")
    }
    // Imported files use their workspace import time unless the user explicitly set a date.
    this.requireDb().run("UPDATE materials SET occurred_at=imported_at, occurred_at_source='import' WHERE occurred_at_source IN ('content', 'metadata')")
    this.persist()
  }
  private repairFileTitles(): void {
    for (const material of this.listMaterials()) {
      if (material.type !== 'file' || !material.sourcePath || !material.storedPath) continue
      const internalTitle = basename(material.storedPath, extname(material.storedPath))
      if (material.title === internalTitle) this.run('UPDATE materials SET title=? WHERE id=?', [basename(material.sourcePath, extname(material.sourcePath)), material.id])
    }
  }

  async create(root: string, name: string, password?: string): Promise<WorkspaceSummary> {
    this.close()
    mkdirSync(root, { recursive: true }); mkdirSync(join(root, 'materials'), { recursive: true })
    const config: WorkspaceConfig = { id: id(), name, encrypted: Boolean(password), salt: password ? createSalt() : undefined }
    writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2))
    this.root = root; this.config = config; this.key = password ? deriveKey(password, config.salt!) : null
    this.dbTempPath = config.encrypted ? join(root, `.workspace-${id()}.sqlite`) : null
    this.db = new NativeDatabase(this.dbTempPath ?? this.dbPath()); this.initializeSchema(); this.recoverProcessingJobs(); this.backfillMaterialChunks(); this.setupVectorStore(); this.startFolderWatchers()
    return this.summary()
  }
  async open(root: string, password?: string): Promise<WorkspaceSummary> {
    const config = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')) as WorkspaceConfig
    if (config.encrypted && !password) throw new Error('This workspace requires its password.')
    const nextKey = config.encrypted ? deriveKey(password!, config.salt!) : null
    const file = join(root, config.encrypted ? 'workspace.sqlite.enc' : 'workspace.sqlite')
    const raw = existsSync(file) ? readFileSync(file) : undefined
    // Validate encrypted bytes before closing the active workspace. A mistyped
    // password must not leave the current UI connected to a closed database.
    const decrypted = config.encrypted && raw ? decrypt(raw, nextKey!) : undefined
    this.close()
    this.root = root; this.config = config; this.key = nextKey
    try {
      if (config.encrypted) { this.dbTempPath = join(root, `.workspace-${id()}.sqlite`); this.db = NativeDatabase.fromBytes(this.dbTempPath, decrypted) }
      else this.db = new NativeDatabase(file)
      this.initializeSchema(); this.repairFileTitles(); this.rebuildExistingSystemTopologies(); this.recoverProcessingJobs(); this.backfillMaterialChunks(); this.backfillMaterialTags(); this.backfillMaterialRelations(); this.setupVectorStore(); this.startFolderWatchers(); return this.summary()
    } catch (error) { this.close(); throw error }
  }
  summary(): WorkspaceSummary { if (!this.config) throw new Error('No workspace open.'); return { id: this.config.id, name: this.config.name, root: this.root, encrypted: this.config.encrypted } }
  inspectWorkspace(root: string): { name: string; encrypted: boolean } {
    const config = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')) as WorkspaceConfig
    return { name: String(config.name ?? '未命名工作区'), encrypted: Boolean(config.encrypted) }
  }
  indexCapability(): { fts: boolean; vector: VectorCapability } { return { fts: this.ftsEnabled, vector: this.vectorCapability } }
  setEmbeddingProvider(provider: (texts: string[]) => Promise<number[][] | null>): void { this.embeddingProvider = provider; this.setupVectorStore() }
  listMaterials(): Material[] { return this.query('SELECT m.*, mis.availability AS availability, mis.last_indexed_at AS lastIndexedAt FROM materials m LEFT JOIN material_index_state mis ON mis.material_id=m.id ORDER BY m.imported_at DESC').map(asMaterial) }
  getMaterial(materialId: string): Material | null { const row = first<SqlRow>(this.query('SELECT m.*, mis.availability AS availability, mis.last_indexed_at AS lastIndexedAt FROM materials m LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE m.id = ?', [materialId])); return row ? asMaterial(row) : null }
  listJobs(): Job[] { return this.query('SELECT * FROM jobs ORDER BY updated_at DESC').map((row) => ({ id: String(row.id), materialId: String(row.material_id), kind: String(row.kind), status: row.status as Job['status'], error: row.error as string | null, updatedAt: String(row.updated_at) })) }
  startJob(materialId: string, kind: string): string { const jobId = id(); this.run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)', [jobId, materialId, kind, 'running', null, now()]); return jobId }
  finishJob(jobId: string): void { this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?', ['complete', null, now(), jobId]) }
  failJob(jobId: string, error: string): void { this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?', ['failed', error, now(), jobId]) }
  analysisStatus(topicId: string): AnalysisStatus {
    const rows = this.query('SELECT j.status, j.error FROM jobs j JOIN topic_materials tm ON tm.material_id=j.material_id WHERE tm.topic_id=? AND j.kind=? ORDER BY j.updated_at DESC', [topicId, 'ai-analysis'])
    return {
      running: rows.filter((row) => row.status === 'running').length,
      complete: rows.filter((row) => row.status === 'complete').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      latestError: rows.find((row) => row.status === 'failed')?.error as string | null ?? null
    }
  }

  async importFile(filePath: string, keepDuplicate = false): Promise<{ material: Material; duplicateOf?: Material }> {
    const [input, info] = await Promise.all([readFile(filePath), stat(filePath)])
    const hash = createHash('sha256').update(input).digest('hex')
    const duplicate = first<Material>(this.query('SELECT * FROM materials WHERE hash = ?', [hash]))
    if (duplicate && !keepDuplicate) return { material: duplicate, duplicateOf: duplicate }
    const materialId = id(); const extension = extname(filePath); const storedName = `${materialId}${extension || '.bin'}`; const storedPath = join(this.materialsPath(), storedName)
    const importedAt = now()
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'file', basename(filePath, extension), null, filePath, storedName, null, null, null, null, importedAt, importedAt, 'import', 'queued', null, hash])
    if (this.config?.encrypted) await writeFile(storedPath, encrypt(input, this.key!)); else await copyFile(filePath, storedPath)
    const tooLarge = info.size > MAX_AUTO_EXTRACT_BYTES
    this.run('UPDATE materials SET status=?, error=? WHERE id=?', [tooLarge ? 'paused' : 'queued', tooLarge ? '文件超过 10 MB，已导入，等待手动全文解析。' : null, materialId])
    this.run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)', [id(), materialId, 'extract', tooLarge ? 'paused' : 'queued', tooLarge ? '文件超过 10 MB，自动解析已跳过。' : null, importedAt])
    const material = this.getMaterial(materialId)!
    if (!tooLarge) void this.enqueueProcessing(materialId)
    return { material, duplicateOf: duplicate ?? undefined }
  }
  async createNote(title: string, text: string): Promise<Material> {
    const materialId = id(); const date = now()
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'note', title || 'Untitled note', 'text/plain', null, null, null, null, plainExcerpt(text), text, date, date, 'import', 'complete', null, null])
    this.indexMaterialChunks(materialId, text)
    return this.getMaterial(materialId)!
  }
  async createDocument(title: string, text: string, format: 'md' | 'txt' | 'csv' | 'json' | 'html'): Promise<Material> {
    const extension = `.${format}`; const materialId = id(); const date = now(); const storedName = `${materialId}${extension}`
    const mimeType = ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html' } as const)[format]
    const content = text || ''
    writeFileSync(join(this.materialsPath(), storedName), this.config?.encrypted ? encrypt(Buffer.from(content, 'utf8'), this.key!) : content, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'document', title || `Untitled ${format}`, mimeType, null, storedName, null, null, plainExcerpt(content), content, date, date, 'import', 'complete', null, hash])
    this.indexMaterialChunks(materialId, content)
    return this.getMaterial(materialId)!
  }
  async saveTextMaterial(materialId: string, title: string, text: string): Promise<Material> {
    const material = this.getMaterial(materialId); if (!material) throw new Error('Material not found.')
    const editableFile = material.type === 'file' && /\.(md|txt|csv|json|html?)$/i.test(material.sourcePath ?? material.storedPath ?? '')
    if (material.type !== 'document' && !editableFile) throw new Error('This material is read-only. Open it with the default application.')
    if (editableFile) {
      const extension = (extname(material.sourcePath ?? material.storedPath ?? '') || '.txt').slice(1).toLowerCase() as 'md' | 'txt' | 'csv' | 'json' | 'html'
      const version = await this.createDocument(title || material.title, text, extension)
      this.createRelation({ sourceMaterialId: material.id, targetMaterialId: version.id, label: 'new version', relationType: 'version', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
      for (const row of this.query('SELECT topic_id, workstream_id FROM topic_materials WHERE material_id=?', [material.id])) this.addToTopic(String(row.topic_id), version.id, row.workstream_id as string | undefined)
      return version
    }
    const storedFile = join(this.materialsPath(), material.storedPath!)
    writeFileSync(storedFile, this.config?.encrypted ? encrypt(Buffer.from(text, 'utf8'), this.key!) : text, 'utf8')
    this.run('UPDATE materials SET title=?, excerpt=?, extracted_text=?, hash=?, status=?, error=? WHERE id=?', [title || material.title, plainExcerpt(text), text, createHash('sha256').update(text).digest('hex'), 'complete', null, material.id])
    this.indexMaterialChunks(material.id, text)
    return this.getMaterial(material.id)!
  }
  renameMaterial(materialId: string, title: string): Material {
    if (!title.trim()) throw new Error('Material title cannot be empty.')
    this.run('UPDATE materials SET title=? WHERE id=?', [title.trim(), materialId])
    const material = this.getMaterial(materialId); if (!material) throw new Error('Material not found.')
    return material
  }
  deleteMaterial(materialId: string): void {
    const material = this.getMaterial(materialId); if (!material) return
    const relationIds = this.query('SELECT id FROM material_relations WHERE source_material_id=? OR target_material_id=?', [materialId, materialId]).map((row) => String(row.id))
    for (const relationId of relationIds) this.requireDb().run('DELETE FROM relationship_evidence WHERE relation_id=?', [relationId])
    this.requireDb().run('DELETE FROM material_relations WHERE source_material_id=? OR target_material_id=?', [materialId, materialId])
    this.requireDb().run('DELETE FROM entity_mentions WHERE material_id=?', [materialId])
    this.run('DELETE FROM relations WHERE source_material_id=? OR target_material_id=?', [materialId, materialId])
    this.run('DELETE FROM topic_materials WHERE material_id=?', [materialId])
    this.run('DELETE FROM jobs WHERE material_id=?', [materialId])
    this.run('DELETE FROM material_chunks WHERE material_id=?', [materialId])
    if (this.ftsEnabled) this.run('DELETE FROM material_chunks_fts WHERE material_id=?', [materialId])
    this.run('DELETE FROM material_index_state WHERE material_id=?', [materialId])
    this.run('DELETE FROM materials WHERE id=?', [materialId])
    if (material.storedPath) { const stored = join(this.materialsPath(), material.storedPath); if (existsSync(stored)) unlinkSync(stored) }
  }
  importNewVersion(materialId: string): Promise<Material> {
    const material = this.getMaterial(materialId)
    if (!material?.sourcePath || !existsSync(material.sourcePath)) throw new Error('The original source file is unavailable.')
    return this.importFile(material.sourcePath, true).then((result) => {
      this.createRelation({ sourceMaterialId: materialId, targetMaterialId: result.material.id, label: 'new version', relationType: 'version', evidenceText: null, evidenceMaterialId: null, confidence: null, createdBy: 'manual' })
      for (const row of this.query('SELECT topic_id, workstream_id FROM topic_materials WHERE material_id=?', [materialId])) this.addToTopic(String(row.topic_id), result.material.id, row.workstream_id as string | undefined)
      return result.material
    })
  }
  async createLink(url: string): Promise<Material> {
    const materialId = id(); const date = now(); const title = new URL(url).hostname
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'link', title, 'text/uri-list', null, null, url, null, null, null, date, date, 'import', 'queued', null, null])
    this.run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)', [id(), materialId, 'metadata', 'queued', null, date])
    void this.enqueueProcessing(materialId)
    return this.getMaterial(materialId)!
  }
  private enqueueProcessing(materialId: string): Promise<void> {
    const run = this.processingTail.then(() => this.processMaterial(materialId))
    this.processingTail = run.catch(() => undefined)
    return run
  }
  private async processMaterial(materialId: string): Promise<void> {
    const material = this.getMaterial(materialId); if (!material) return
    this.run('UPDATE materials SET status = ?, error = ? WHERE id = ?', ['running', null, materialId])
    try {
      if (material.type === 'file') {
        const storedFile = material.storedPath ? join(this.materialsPath(), material.storedPath) : material.sourcePath ?? ''
        if (!storedFile || !existsSync(storedFile)) throw new Error('The original source file is unavailable.')
        const extracted = await extractFile(storedFile, material.storedPath && this.config?.encrypted ? decrypt(readFileSync(storedFile), this.key!) : undefined)
        const originalTitle = material.sourcePath ? basename(material.sourcePath, extname(material.sourcePath)) : material.title
        this.run('UPDATE materials SET title=?, mime_type=?, excerpt=?, extracted_text=?, occurred_at=?, occurred_at_source=?, status=? WHERE id=?', [originalTitle, extracted.mimeType, plainExcerpt(extracted.text), extracted.text, material.occurredAtSource === 'manual' ? material.occurredAt : material.importedAt, material.occurredAtSource === 'manual' ? 'manual' : 'import', 'complete', materialId])
        this.indexMaterialChunks(materialId, extracted.text, extracted)
      } else if (material.type === 'link') {
        const metadata = await fetchLinkMetadata(material.url!)
        this.run('UPDATE materials SET title=?, site_name=?, excerpt=?, extracted_text=?, status=? WHERE id=?', [metadata.title, metadata.siteName, metadata.excerpt, `${metadata.title}\n${metadata.excerpt}\n${material.url}`, 'complete', materialId])
        this.indexMaterialChunks(materialId, `${metadata.title}\n${metadata.excerpt}\n${material.url}`)
      }
      this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE material_id=? AND status != ?', ['complete', null, now(), materialId, 'complete'])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error'
      this.run('UPDATE materials SET status=?, error=? WHERE id=?', ['failed', message, materialId])
      const availability = material.sourcePath && !material.storedPath && !existsSync(material.sourcePath) ? 'unavailable' : 'available'
      this.run('INSERT OR REPLACE INTO material_index_state (material_id, source_id, availability, last_indexed_at, last_seen_at) VALUES (?, COALESCE((SELECT source_id FROM material_index_state WHERE material_id=?), NULL), ?, COALESCE((SELECT last_indexed_at FROM material_index_state WHERE material_id=?), NULL), ?)', [materialId, materialId, availability, material.lastIndexedAt, now()])
      this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE material_id=? AND status != ?', ['failed', message, now(), materialId, 'complete'])
    }
  }
  retry(materialId: string): void { void this.enqueueProcessing(materialId) }
  updateMaterialDate(id: string, occurredAt: string): void { this.run('UPDATE materials SET occurred_at=?, occurred_at_source=? WHERE id=?', [occurredAt, 'manual', id]) }
  createTopic(name: string, description = ''): Topic { const topicId = id(); const topic = { id: topicId, name, description: description || null, createdAt: now(), archivedAt: null, color: topicColor(topicId), revision: 0 }; this.run('INSERT INTO topics (id, name, description, created_at, archived_at, color, revision) VALUES (?, ?, ?, ?, ?, ?, ?)', [topic.id, topic.name, topic.description, topic.createdAt, null, topic.color, topic.revision]); return topic }
  listTopics(): Topic[] { return this.query('SELECT * FROM topics WHERE archived_at IS NULL ORDER BY created_at DESC').map(asTopic) }
  listArchivedTopics(): Topic[] { return this.query('SELECT * FROM topics WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').map(asTopic) }
  archiveTopic(topicId: string): void { this.run('UPDATE topics SET archived_at=? WHERE id=? AND archived_at IS NULL', [now(), topicId]); this.persist() }
  async restoreTopic(topicId: string): Promise<Topic> {
    const topic = first<Topic>(this.query('SELECT * FROM topics WHERE id=?', [topicId])); if (!topic) throw new Error('Topic not found.')
    const missing = this.query('SELECT tm.*, m.id AS materialId, m.title AS title, m.source_path AS sourcePath, m.stored_path AS storedPath, m.type AS materialType FROM topic_materials tm LEFT JOIN materials m ON m.id=tm.material_id WHERE tm.topic_id=?', [topicId]).filter((row) => !row.materialId || (row.materialType === 'file' && row.storedPath && !existsSync(join(this.materialsPath(), String(row.storedPath)))))
    for (const row of missing) {
      const oldId = String(row.material_id); const title = String(row.title ?? '原材料'); const source = row.sourcePath ? `原始路径：${String(row.sourcePath)}\n` : ''
      const replacement = await this.createNote(`补齐文档：${title}`, `原材料“${title}”在还原主题时不可用。\n${source}\n请重新导入原文件，或在此补充内容后继续整理。`)
      this.requireDb().run('UPDATE topic_materials SET material_id=? WHERE topic_id=? AND material_id=?', [replacement.id, topicId, oldId])
      this.requireDb().run('UPDATE relations SET source_material_id=? WHERE source_material_id=?', [replacement.id, oldId])
      this.requireDb().run('UPDATE relations SET target_material_id=? WHERE target_material_id=?', [replacement.id, oldId])
    }
    this.requireDb().run('UPDATE topics SET archived_at=NULL WHERE id=?', [topicId]); this.persist(); return this.topicMap(topicId).topic
  }
  deleteArchivedTopic(topicId: string): void {
    if (!this.query('SELECT id FROM topics WHERE id=? AND archived_at IS NOT NULL', [topicId])[0]) throw new Error('Only archived topics can be permanently deleted.')
    this.requireDb().run('DELETE FROM topic_relation_styles WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_relation_candidates WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM workstreams WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_editor_history WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_editor_history_state WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topics WHERE id=?', [topicId]); this.persist()
  }
  resetTopicBoard(topicId: string, removeSharedRelations = false): void {
    const map = this.topicMap(topicId)
    // A relation is global data. Resetting one demo board must not erase a
    // relation that is still visible from another topic using the same cards.
    for (const relation of map.relations) {
      const shared = this.query('SELECT 1 FROM topic_materials source JOIN topic_materials target ON source.topic_id=target.topic_id WHERE source.topic_id != ? AND source.material_id=? AND target.material_id=? LIMIT 1', [topicId, relation.sourceMaterialId, relation.targetMaterialId]).length > 0
      if (removeSharedRelations || !shared) this.requireDb().run('DELETE FROM relations WHERE id=?', [relation.id])
    }
    this.requireDb().run('DELETE FROM topic_relation_styles WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_relation_candidates WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM workstreams WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_editor_history WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_editor_history_state WHERE topic_id=?', [topicId])
    this.persist()
  }
  /** Demo boards own their generated materials and may reset their internal topology. */
  deleteRelationsAmong(materialIds: string[]): void {
    const ids = [...new Set(materialIds)]; if (!ids.length) return
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.query(`SELECT id FROM relations WHERE source_material_id IN (${placeholders}) AND target_material_id IN (${placeholders})`, [...ids, ...ids])
    for (const row of rows) this.requireDb().run('DELETE FROM relations WHERE id=?', [String(row.id)])
    this.persist()
  }
  addToTopic(topicId: string, materialId: string, workstreamId?: string, rebuild = true): void { const current = this.query('SELECT sequence, sequence_source FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId])[0]; if (current) { if (workstreamId !== undefined) this.run('UPDATE topic_materials SET workstream_id=? WHERE topic_id=? AND material_id=?', [workstreamId, topicId, materialId]); return }; const next = Number(this.query('SELECT COALESCE(MAX(sequence), 0) AS max FROM topic_materials WHERE topic_id=?', [topicId])[0]?.max ?? 0) + 1; const last = String(this.query('SELECT MAX(added_at) AS value FROM topic_materials WHERE material_id=?', [materialId])[0]?.value ?? ''); const addedAt = new Date(Math.max(Date.now(), Number.isNaN(Date.parse(last)) ? 0 : Date.parse(last) + 1)).toISOString(); this.run('INSERT INTO topic_materials (topic_id, material_id, workstream_id, sequence, sequence_source, added_at) VALUES (?, ?, ?, ?, ?, ?)', [topicId, materialId, workstreamId ?? null, next, 'time', addedAt]); if (rebuild) this.rebuildSystemTopology(topicId) }
  addMaterialsToTopic(topicId: string, materialIds: string[]): void { for (const materialId of [...new Set(materialIds)]) this.addToTopic(topicId, materialId, undefined, false); this.rebuildSystemTopology(topicId) }
  topicsForMaterial(materialId: string): Topic[] { return this.query('SELECT DISTINCT t.* FROM topics t JOIN topic_materials tm ON tm.topic_id=t.id WHERE tm.material_id=? AND t.archived_at IS NULL ORDER BY tm.added_at DESC, t.created_at DESC', [materialId]).map(asTopic) }
  listMaterialsWithTopics(): Array<Material & { topics: Array<{ id: string; name: string; color: string; cardColor: string | null; addedAt: string }> }> {
    return this.listMaterials().map((material) => ({ ...material, topics: this.query('SELECT t.id, t.name, t.color, tm.card_color AS cardColor, tm.added_at AS addedAt FROM topic_materials tm JOIN topics t ON t.id=tm.topic_id WHERE tm.material_id=? AND t.archived_at IS NULL ORDER BY tm.added_at DESC, t.created_at DESC', [material.id]).map((row) => ({ id: String(row.id), name: String(row.name), color: String(row.color ?? topicColor(String(row.id))), cardColor: row.cardColor as string | null, addedAt: String(row.addedAt) })) }))
  }
  updateCardOrder(topicId: string, materialId: string, sequence: number): void { if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Sequence must be a positive integer.'); this.run("UPDATE topic_materials SET sequence=?, sequence_source='manual' WHERE topic_id=? AND material_id=?", [sequence, topicId, materialId]); this.rebuildSystemTopology(topicId) }
  resetCardOrder(topicId: string): void { this.run("UPDATE topic_materials SET sequence=NULL, sequence_source='time' WHERE topic_id=?", [topicId]); this.rebuildSystemTopology(topicId) }
  removeFromTopic(topicId: string, materialId: string): void { this.run('DELETE FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId]); this.rebuildSystemTopology(topicId) }
  createWorkstream(topicId: string, name: string, source: 'ai' | 'manual' = 'manual'): Workstream { const position = this.query('SELECT COUNT(*) AS count FROM workstreams WHERE topic_id=?', [topicId])[0]?.count as number ?? 0; const stream = { id: id(), topicId, name, position: Number(position), source }; this.run('INSERT INTO workstreams VALUES (?, ?, ?, ?, ?)', [stream.id, stream.topicId, stream.name, stream.position, stream.source]); this.persist(); return stream }
  updateWorkstream(id: string, name: string): void { this.run('UPDATE workstreams SET name=? WHERE id=?', [name, id]) }
  deleteWorkstream(id: string): void {
    // Relations belong to materials, so deleting a lane only clears its grouping.
    this.run('UPDATE topic_materials SET workstream_id=NULL WHERE workstream_id=?', [id])
    this.run('DELETE FROM workstreams WHERE id=?', [id])
  }
  moveMaterial(topicId: string, materialId: string, workstreamId: string | null): void { this.run('UPDATE topic_materials SET workstream_id=? WHERE topic_id=? AND material_id=?', [workstreamId, topicId, materialId]); this.persist() }
  private bumpTopicRevision(topicId: string): void { this.requireDb().run('UPDATE topics SET revision=revision+1 WHERE id=?', [topicId]) }
  positionMaterial(topicId: string, materialId: string, x: number, y: number): void { this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=?, position_source='manual' WHERE topic_id=? AND material_id=?", [x, y, topicId, materialId]); this.bumpTopicRevision(topicId); this.persist() }
  positionMaterials(topicId: string, positions: Array<{ materialId: string; x: number; y: number }>): void { for (const position of positions) this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=?, position_source='manual' WHERE topic_id=? AND material_id=?", [position.x, position.y, topicId, position.materialId]); this.bumpTopicRevision(topicId); this.persist() }
  updateCardStyle(topicId: string, materialId: string, input: { color?: string | null; tags?: string[]; note?: string | null }): void {
    const exists = this.query('SELECT material_id FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId]).length > 0
    if (!exists) throw new Error('Material is not part of this topic.')
    const color = input.color === undefined ? undefined : normalizeColor(input.color)
    if (input.color !== undefined && input.color !== null && !color) throw new Error('Card color must be a six-digit hexadecimal value.')
    const tags = input.tags === undefined ? undefined : JSON.stringify(normalizeTags(input.tags))
    const note = input.note === undefined ? undefined : input.note === null ? null : input.note.trim().slice(0, 1000) || null
    const current = this.query('SELECT card_color, card_tags, card_note FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId])[0]!
    this.run('UPDATE topic_materials SET card_color=?, card_tags=?, card_note=? WHERE topic_id=? AND material_id=?', [input.color === undefined ? current.card_color : color, tags ?? current.card_tags, input.note === undefined ? current.card_note : note, topicId, materialId])
  }
  updateCardPresentation(topicId: string, materialId: string, input: { displayTitle?: string | null; displayExcerpt?: string | null; width?: number | null; height?: number | null; textColor?: string | null; fontSize?: number | null; collapsed?: boolean; zIndex?: number }): void {
    const current = this.query('SELECT * FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId])[0]
    if (!current) throw new Error('Material is not part of this topic.')
    const textColor = input.textColor === undefined ? current.card_text_color as string | null : input.textColor === null ? null : normalizeColor(input.textColor)
    if (input.textColor !== undefined && input.textColor !== null && !textColor) throw new Error('Text color must be a six-digit hexadecimal value.')
    const width = input.width === undefined ? current.card_width as number | null : normalizeNumber(input.width, 180, 560)
    const height = input.height === undefined ? current.card_height as number | null : normalizeNumber(input.height, 96, 420)
    const fontSize = input.fontSize === undefined ? current.card_font_size as number | null : normalizeNumber(input.fontSize, 11, 22)
    const zIndex = input.zIndex === undefined ? Number(current.card_z_index ?? 0) : Math.max(-100, Math.min(100, Math.round(Number(input.zIndex))))
    if (!Number.isFinite(zIndex)) throw new Error('Card layer is invalid.')
    this.run('UPDATE topic_materials SET display_title=?, display_excerpt=?, card_width=?, card_height=?, card_text_color=?, card_font_size=?, card_collapsed=?, card_z_index=? WHERE topic_id=? AND material_id=?', [input.displayTitle === undefined ? current.display_title : normalizeOptionalText(input.displayTitle, 120), input.displayExcerpt === undefined ? current.display_excerpt : normalizeOptionalText(input.displayExcerpt, 1000), width, height, textColor, fontSize, input.collapsed === undefined ? Number(current.card_collapsed ?? 0) : input.collapsed ? 1 : 0, zIndex, topicId, materialId])
  }
  updateRelationStyle(topicId: string, relationId: string, input: { color?: string | null; sourceArrow?: boolean; sourceArrowStyle?: Relation['sourceArrowStyle']; targetArrowStyle?: Relation['targetArrowStyle']; animated?: boolean; archived?: boolean; lineKind?: Relation['lineKind']; sourceHandle?: string | null; targetHandle?: string | null; lineWidth?: number; lineDash?: LineDash; routePoints?: RelationWaypoint[]; labelAnchor?: number }): void {
    const color = input.color === undefined ? undefined : normalizeColor(input.color)
    if (input.color !== undefined && input.color !== null && !color) throw new Error('Line color must be a six-digit hexadecimal value.')
    if (input.lineKind && !['auto', 'straight', 'bezier', 'orthogonal'].includes(input.lineKind)) throw new Error('Unsupported line kind.')
    const relation = this.query('SELECT source_material_id, target_material_id, topic_id FROM relations WHERE id=?', [relationId])[0]
    if (!relation) throw new Error('Relationship not found.')
    if (relation.topic_id !== null && relation.topic_id !== undefined && String(relation.topic_id) !== topicId) throw new Error('Relationship is not part of this topic.')
    const members = this.query('SELECT COUNT(*) AS count FROM topic_materials WHERE topic_id=? AND material_id IN (?, ?)', [topicId, String(relation.source_material_id), String(relation.target_material_id)])[0]
    if (Number(members?.count ?? 0) !== 2) throw new Error('Relationship materials are not part of this topic.')
    const allowedArrows = ['none', 'triangle', 'open-triangle', 'diamond']
    if (input.sourceArrowStyle && !allowedArrows.includes(input.sourceArrowStyle)) throw new Error('Unsupported source arrow style.')
    if (input.targetArrowStyle && !allowedArrows.includes(input.targetArrowStyle)) throw new Error('Unsupported target arrow style.')
    if (input.lineDash && !['auto', 'solid', 'dashed', 'dotted'].includes(input.lineDash)) throw new Error('Unsupported line dash.')
    const current = this.query('SELECT line_color, source_arrow, source_arrow_style, target_arrow_style, animated, archived, branch_index, line_kind, source_handle, target_handle, line_width, line_dash, route_points, label_anchor FROM topic_relation_styles WHERE topic_id=? AND relation_id=?', [topicId, relationId])[0]
    const sourceArrowStyle = input.sourceArrowStyle ?? (input.sourceArrow === undefined ? current?.source_arrow_style ?? (Number(current?.source_arrow ?? 0) ? 'triangle' : 'none') : input.sourceArrow ? 'triangle' : 'none')
    const width = input.lineWidth === undefined ? Number(current?.line_width ?? 2.75) : normalizeNumber(input.lineWidth, 1, 8)!
    const anchor = input.labelAnchor === undefined ? Number(current?.label_anchor ?? .5) : normalizeNumber(input.labelAnchor, .05, .95)!
    const routePoints = input.routePoints === undefined ? parseRoutePoints(current?.route_points) : normalizeRoutePoints(input.routePoints)
    const sourceHandle = input.sourceHandle === undefined ? current?.source_handle ?? null : validHandle(input.sourceHandle, 'out')
    const targetHandle = input.targetHandle === undefined ? current?.target_handle ?? null : validHandle(input.targetHandle, 'in')
    this.run('INSERT OR REPLACE INTO topic_relation_styles (topic_id, relation_id, line_color, source_arrow, source_arrow_style, target_arrow_style, animated, archived, branch_index, line_kind, source_handle, target_handle, line_width, line_dash, route_points, label_anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [topicId, relationId, color === undefined ? current?.line_color ?? null : color, sourceArrowStyle === 'none' ? 0 : 1, sourceArrowStyle, input.targetArrowStyle ?? current?.target_arrow_style ?? 'triangle', input.animated === undefined ? Number(current?.animated ?? 1) : input.animated ? 1 : 0, input.archived === undefined ? Number(current?.archived ?? 0) : input.archived ? 1 : 0, Number(current?.branch_index ?? 0), input.lineKind ?? current?.line_kind ?? 'auto', sourceHandle, targetHandle, width, input.lineDash ?? current?.line_dash ?? 'auto', JSON.stringify(routePoints), anchor])
  }
  topicHistoryStatus(topicId: string): TopicHistoryStatus {
    const cursor = Number(this.query('SELECT cursor FROM topic_editor_history_state WHERE topic_id=?', [topicId])[0]?.cursor ?? 0)
    const maximum = Number(this.query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM topic_editor_history WHERE topic_id=?', [topicId])[0]?.sequence ?? 0)
    return { undo: cursor > 0, redo: maximum > cursor, cursor }
  }
  private commandRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Editor command is invalid.')
    return value as Record<string, unknown>
  }
  private commandId(value: unknown, label: string): string {
    const id = String(value ?? '')
    if (!id) throw new Error(`${label} is required.`)
    return id
  }
  private topicMaterialRow(topicId: string, materialId: string): SqlRow {
    const row = this.query('SELECT * FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId])[0]
    if (!row) throw new Error('Material is not part of this topic.')
    return row
  }
  private relationStyleInput(topicId: string, relationId: string): Record<string, unknown> {
    const row = this.query('SELECT * FROM topic_relation_styles WHERE topic_id=? AND relation_id=?', [topicId, relationId])[0]
    return {
      color: row?.line_color as string | null ?? null,
      sourceArrowStyle: row?.source_arrow_style as string | null ?? 'none',
      targetArrowStyle: row?.target_arrow_style as string | null ?? 'triangle',
      animated: row ? Boolean(row.animated) : true,
      archived: row ? Boolean(row.archived) : false,
      lineKind: row?.line_kind as string | null ?? 'auto',
      sourceHandle: row?.source_handle as string | null ?? null,
      targetHandle: row?.target_handle as string | null ?? null,
      lineWidth: Number(row?.line_width ?? 2.75),
      lineDash: row?.line_dash as string | null ?? 'auto',
      routePoints: parseRoutePoints(row?.route_points),
      labelAnchor: Number(row?.label_anchor ?? .5)
    }
  }
  private snapshotRelations(relationIds: string[]): Array<{ relation: SqlRow; styles: SqlRow[] }> {
    return relationIds.flatMap((relationId) => {
      const relation = this.query('SELECT * FROM relations WHERE id=?', [relationId])[0]
      if (!relation) return []
      return [{ relation, styles: this.query('SELECT * FROM topic_relation_styles WHERE relation_id=?', [relationId]) }]
    })
  }
  private restoreRelations(snapshots: Array<{ relation: SqlRow; styles: SqlRow[] }>): void {
    for (const snapshot of snapshots) {
      const relation = snapshot.relation
      this.run('INSERT OR REPLACE INTO relations (id, source_material_id, target_material_id, label, relation_type, evidence_text, evidence_material_id, confidence, created_by, created_at, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, relation.source_material_id, relation.target_material_id, relation.label, relation.relation_type, relation.evidence_text, relation.evidence_material_id, relation.confidence, relation.created_by, relation.created_at, relation.topic_id])
      for (const style of snapshot.styles) this.run('INSERT OR REPLACE INTO topic_relation_styles (topic_id, relation_id, line_color, source_arrow, source_arrow_style, target_arrow_style, animated, archived, branch_index, line_kind, source_handle, target_handle, line_width, line_dash, route_points, label_anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [style.topic_id, style.relation_id, style.line_color, style.source_arrow, style.source_arrow_style, style.target_arrow_style, style.animated, style.archived, style.branch_index, style.line_kind, style.source_handle, style.target_handle, style.line_width ?? 2.75, style.line_dash ?? 'auto', style.route_points ?? '[]', style.label_anchor ?? .5])
    }
  }
  private restoreMaterialRows(rows: SqlRow[]): void {
    for (const row of rows) this.run('INSERT OR REPLACE INTO topic_materials (topic_id, material_id, workstream_id, canvas_x, canvas_y, position_source, card_color, card_tags, card_note, sequence, sequence_source, added_at, display_title, display_excerpt, card_width, card_height, card_text_color, card_font_size, card_collapsed, card_z_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.topic_id, row.material_id, row.workstream_id, row.canvas_x, row.canvas_y, row.position_source, row.card_color, row.card_tags, row.card_note, row.sequence, row.sequence_source, row.added_at, row.display_title, row.display_excerpt, row.card_width, row.card_height, row.card_text_color, row.card_font_size, row.card_collapsed ?? 0, row.card_z_index ?? 0])
  }
  private applyTopicEditorCommand(topicId: string, command: TopicEditorCommand): { inverse: TopicEditorCommand; forward?: TopicEditorCommand } {
    const payload = this.commandRecord(command.payload)
    if (command.kind === 'moveCards') {
      const positions = payload.positions
      if (!Array.isArray(positions) || !positions.length || positions.length > 500) throw new Error('Card positions are invalid.')
      const inversePositions = positions.map((position) => {
        const item = this.commandRecord(position); const materialId = this.commandId(item.materialId, 'Material id'); const row = this.topicMaterialRow(topicId, materialId)
        const x = Number(item.x); const y = Number(item.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Card position is invalid.')
        this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=?, position_source='manual' WHERE topic_id=? AND material_id=?", [x, y, topicId, materialId])
        return { materialId, x: Number(row.canvas_x ?? 0), y: Number(row.canvas_y ?? 0), positionSource: String(row.position_source ?? 'auto') }
      })
      return { inverse: { kind: 'restoreCardPositions', payload: { positions: inversePositions } } }
    }
    if (command.kind === 'restoreCardPositions') {
      const positions = payload.positions
      if (!Array.isArray(positions)) throw new Error('Card positions are invalid.')
      const inversePositions = positions.map((position) => {
        const item = this.commandRecord(position); const materialId = this.commandId(item.materialId, 'Material id'); const row = this.topicMaterialRow(topicId, materialId)
        this.requireDb().run('UPDATE topic_materials SET canvas_x=?, canvas_y=?, position_source=? WHERE topic_id=? AND material_id=?', [Number(item.x), Number(item.y), item.positionSource === 'auto' ? 'auto' : 'manual', topicId, materialId])
        return { materialId, x: Number(row.canvas_x ?? 0), y: Number(row.canvas_y ?? 0), positionSource: String(row.position_source ?? 'auto') }
      })
      return { inverse: { kind: 'restoreCardPositions', payload: { positions: inversePositions } } }
    }
    if (command.kind === 'patchCard') {
      const materialId = this.commandId(payload.materialId, 'Material id'); const patch = this.commandRecord(payload.patch); const current = this.topicMaterialRow(topicId, materialId)
      let tags: string[] = []; try { const parsed = JSON.parse(String(current.card_tags ?? '[]')); if (Array.isArray(parsed)) tags = parsed.filter((value): value is string => typeof value === 'string') } catch { /* Legacy malformed values are ignored. */ }
      const previous = { displayTitle: current.display_title as string | null, displayExcerpt: current.display_excerpt as string | null, width: current.card_width as number | null, height: current.card_height as number | null, textColor: current.card_text_color as string | null, fontSize: current.card_font_size as number | null, collapsed: Boolean(current.card_collapsed), zIndex: Number(current.card_z_index ?? 0), color: current.card_color as string | null, tags, note: current.card_note as string | null }
      this.updateCardPresentation(topicId, materialId, patch)
      if ('color' in patch || 'tags' in patch || 'note' in patch) this.updateCardStyle(topicId, materialId, { color: patch.color === undefined ? undefined : patch.color === null ? null : String(patch.color), tags: Array.isArray(patch.tags) ? patch.tags.map(String) : undefined, note: patch.note === undefined ? undefined : patch.note === null ? null : String(patch.note) })
      return { inverse: { kind: 'patchCard', payload: { materialId, patch: previous } } }
    }
    if (command.kind === 'patchRelationStyle') {
      const relationId = this.commandId(payload.relationId, 'Relation id'); const patch = this.commandRecord(payload.patch); const previous = this.relationStyleInput(topicId, relationId)
      this.updateRelationStyle(topicId, relationId, patch)
      return { inverse: { kind: 'patchRelationStyle', payload: { relationId, patch: previous } } }
    }
    if (command.kind === 'renameRelation') {
      const relationId = this.commandId(payload.relationId, 'Relation id'); const row = this.query('SELECT label FROM relations WHERE id=?', [relationId])[0]
      if (!row) throw new Error('Relationship not found.')
      const label = normalizeOptionalText(payload.label, 64) ?? ''
      this.requireDb().run('UPDATE relations SET label=? WHERE id=?', [label, relationId])
      return { inverse: { kind: 'renameRelation', payload: { relationId, label: String(row.label) } } }
    }
    if (command.kind === 'reconnectRelation') {
      const relationId = this.commandId(payload.relationId, 'Relation id'); const row = this.query('SELECT * FROM relations WHERE id=?', [relationId])[0]
      if (!row) throw new Error('Relationship not found.')
      const previousStyle = this.relationStyleInput(topicId, relationId)
      const sourceMaterialId = this.commandId(payload.sourceMaterialId, 'Source material'); const targetMaterialId = this.commandId(payload.targetMaterialId, 'Target material')
      if (sourceMaterialId === targetMaterialId) throw new Error('A material cannot be related to itself.')
      this.topicMaterialRow(topicId, sourceMaterialId); this.topicMaterialRow(topicId, targetMaterialId)
      const duplicate = this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND created_by=? AND id<>?', [sourceMaterialId, targetMaterialId, row.created_by, relationId])[0]
      if (duplicate) throw new Error('This relationship already exists.')
      this.requireDb().run('UPDATE relations SET source_material_id=?, target_material_id=? WHERE id=?', [sourceMaterialId, targetMaterialId, relationId])
      this.updateRelationStyle(topicId, relationId, { sourceHandle: payload.sourceHandle === undefined ? undefined : payload.sourceHandle === null ? null : String(payload.sourceHandle), targetHandle: payload.targetHandle === undefined ? undefined : payload.targetHandle === null ? null : String(payload.targetHandle) })
      return { inverse: { kind: 'reconnectRelation', payload: { relationId, sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), sourceHandle: previousStyle.sourceHandle, targetHandle: previousStyle.targetHandle } } }
    }
    if (command.kind === 'createRelation') {
      const relationInput = this.commandRecord(payload.relation)
      const sourceMaterialId = this.commandId(relationInput.sourceMaterialId, 'Source material')
      const targetMaterialId = this.commandId(relationInput.targetMaterialId, 'Target material')
      this.topicMaterialRow(topicId, sourceMaterialId); this.topicMaterialRow(topicId, targetMaterialId)
      const relation = this.createRelation({ sourceMaterialId, targetMaterialId, label: normalizeOptionalText(relationInput.label, 64) ?? '', relationType: normalizeOptionalText(relationInput.relationType, 48) ?? 'related', evidenceText: null, evidenceMaterialId: relationInput.evidenceMaterialId ? String(relationInput.evidenceMaterialId) : null, confidence: relationInput.confidence === null || relationInput.confidence === undefined ? null : Number(relationInput.confidence), createdBy: 'manual' })
      const style = relationInput.style && typeof relationInput.style === 'object' ? this.commandRecord(relationInput.style) : null
      if (style) this.updateRelationStyle(topicId, relation.id, style)
      const snapshot = this.snapshotRelations([relation.id])
      return { forward: { kind: 'restoreRelations', payload: { relations: snapshot } }, inverse: { kind: 'deleteRelations', payload: { relationIds: [relation.id] } } }
    }
    if (command.kind === 'deleteRelations') {
      const relationIds = payload.relationIds
      if (!Array.isArray(relationIds) || !relationIds.length) throw new Error('No relationships selected.')
      const ids = relationIds.map((value) => this.commandId(value, 'Relation id'))
      const snapshot = this.snapshotRelations(ids)
      for (const item of snapshot) {
        this.topicMaterialRow(topicId, this.commandId(item.relation.source_material_id, 'Source material'))
        this.topicMaterialRow(topicId, this.commandId(item.relation.target_material_id, 'Target material'))
      }
      if (snapshot.length !== ids.length) throw new Error('Relationship not found.')
      for (const relationId of ids) { this.requireDb().run('DELETE FROM topic_relation_styles WHERE relation_id=?', [relationId]); this.requireDb().run('DELETE FROM relations WHERE id=?', [relationId]) }
      return { inverse: { kind: 'restoreRelations', payload: { relations: snapshot } } }
    }
    if (command.kind === 'restoreRelations') {
      const relations = payload.relations
      if (!Array.isArray(relations)) throw new Error('Relationship history is invalid.')
      const snapshots = relations.map((value) => this.commandRecord(value)).map((value) => ({ relation: this.commandRecord(value.relation), styles: Array.isArray(value.styles) ? value.styles.map((style) => this.commandRecord(style)) : [] }))
      this.restoreRelations(snapshots)
      return { inverse: { kind: 'deleteRelations', payload: { relationIds: snapshots.map((snapshot) => String(snapshot.relation.id)) } } }
    }
    if (command.kind === 'deleteSelection') {
      const materialIds = Array.isArray(payload.materialIds) ? [...new Set(payload.materialIds.map((value) => this.commandId(value, 'Material id')))] : []
      const relationIds = Array.isArray(payload.relationIds) ? [...new Set(payload.relationIds.map((value) => this.commandId(value, 'Relation id')))] : []
      if (!materialIds.length && !relationIds.length) throw new Error('No board objects selected.')
      const rows = materialIds.map((materialId) => this.topicMaterialRow(topicId, materialId))
      const relations = this.snapshotRelations(relationIds)
      for (const item of relations) {
        this.topicMaterialRow(topicId, this.commandId(item.relation.source_material_id, 'Source material'))
        this.topicMaterialRow(topicId, this.commandId(item.relation.target_material_id, 'Target material'))
      }
      if (relations.length !== relationIds.length) throw new Error('Relationship not found.')
      for (const row of rows) this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, String(row.material_id)])
      for (const relationId of relationIds) { this.requireDb().run('DELETE FROM topic_relation_styles WHERE relation_id=?', [relationId]); this.requireDb().run('DELETE FROM relations WHERE id=?', [relationId]) }
      return { inverse: { kind: 'restoreSelection', payload: { rows, relations } } }
    }
    if (command.kind === 'restoreSelection') {
      const rows = Array.isArray(payload.rows) ? payload.rows.map((row) => this.commandRecord(row)) : []
      const relations = Array.isArray(payload.relations) ? payload.relations.map((value) => this.commandRecord(value)).map((value) => ({ relation: this.commandRecord(value.relation), styles: Array.isArray(value.styles) ? value.styles.map((style) => this.commandRecord(style)) : [] })) : []
      this.restoreMaterialRows(rows); this.restoreRelations(relations)
      return { inverse: { kind: 'deleteSelection', payload: { materialIds: rows.map((row) => String(row.material_id)), relationIds: relations.map((snapshot) => String(snapshot.relation.id)) } } }
    }
    if (command.kind === 'removeMaterials') {
      const materialIds = payload.materialIds
      if (!Array.isArray(materialIds) || !materialIds.length) throw new Error('No cards selected.')
      const rows = materialIds.map((value) => this.topicMaterialRow(topicId, this.commandId(value, 'Material id')))
      for (const row of rows) this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, String(row.material_id)])
      return { inverse: { kind: 'restoreMaterials', payload: { rows } } }
    }
    if (command.kind === 'restoreMaterials') {
      const rows = payload.rows
      if (!Array.isArray(rows)) throw new Error('Card history is invalid.')
      const records = rows.map((row) => this.commandRecord(row)); this.restoreMaterialRows(records)
      return { inverse: { kind: 'removeMaterials', payload: { materialIds: records.map((row) => String(row.material_id)) } } }
    }
    throw new Error(`Unsupported editor command: ${command.kind}`)
  }
  executeTopicEditorCommand(topicId: string, command: TopicEditorCommand): void {
    this.withTransaction(() => {
      if (!this.query('SELECT id FROM topics WHERE id=?', [topicId])[0]) throw new Error('Topic not found.')
      const result = this.applyTopicEditorCommand(topicId, command)
      const state = this.topicHistoryStatus(topicId); const sequence = state.cursor + 1
      this.requireDb().run('DELETE FROM topic_editor_history WHERE topic_id=? AND sequence>?', [topicId, state.cursor])
      this.requireDb().run('INSERT OR REPLACE INTO topic_editor_history (topic_id, sequence, command_json, inverse_json, created_at) VALUES (?, ?, ?, ?, ?)', [topicId, sequence, JSON.stringify(result.forward ?? command), JSON.stringify(result.inverse), now()])
      this.requireDb().run('INSERT OR REPLACE INTO topic_editor_history_state (topic_id, cursor) VALUES (?, ?)', [topicId, sequence])
      this.bumpTopicRevision(topicId)
    })
  }
  undoTopicEditorCommand(topicId: string): TopicHistoryStatus {
    return this.withTransaction(() => {
      const state = this.topicHistoryStatus(topicId); if (!state.undo) return state
      const row = this.query('SELECT inverse_json FROM topic_editor_history WHERE topic_id=? AND sequence=?', [topicId, state.cursor])[0]
      if (!row) return state
      this.applyTopicEditorCommand(topicId, JSON.parse(String(row.inverse_json)) as TopicEditorCommand)
      this.requireDb().run('INSERT OR REPLACE INTO topic_editor_history_state (topic_id, cursor) VALUES (?, ?)', [topicId, state.cursor - 1])
      this.bumpTopicRevision(topicId); return this.topicHistoryStatus(topicId)
    })
  }
  redoTopicEditorCommand(topicId: string): TopicHistoryStatus {
    return this.withTransaction(() => {
      const state = this.topicHistoryStatus(topicId); if (!state.redo) return state
      const row = this.query('SELECT command_json FROM topic_editor_history WHERE topic_id=? AND sequence=?', [topicId, state.cursor + 1])[0]
      if (!row) return state
      this.applyTopicEditorCommand(topicId, JSON.parse(String(row.command_json)) as TopicEditorCommand)
      this.requireDb().run('INSERT OR REPLACE INTO topic_editor_history_state (topic_id, cursor) VALUES (?, ?)', [topicId, state.cursor + 1])
      this.bumpTopicRevision(topicId); return this.topicHistoryStatus(topicId)
    })
  }
  rebuildSystemTopology(topicId: string): void {
    const map = this.topicMap(topicId)
    const ordered = stableTopicOrder(map.materials)
    const positions = topologyPositions(ordered)
    this.requireDb().exec('BEGIN')
    try {
      this.requireDb().run("DELETE FROM relations WHERE created_by='system' AND topic_id=?", [topicId])
      for (const position of positions) this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=? WHERE topic_id=? AND material_id=? AND position_source <> 'manual'", [position.x, position.y, topicId, position.materialId])
      this.bumpTopicRevision(topicId)
      this.requireDb().exec('COMMIT')
      this.persist()
      this.rebuildTopicCandidates(topicId)
    } catch (error) { this.requireDb().exec('ROLLBACK'); throw error }
  }
  private rebuildExistingSystemTopologies(): void {
    for (const row of this.query('SELECT id FROM topics WHERE archived_at IS NULL')) this.rebuildSystemTopology(String(row.id))
  }
  createRelation(input: Omit<Relation, 'id' | 'createdAt'>): Relation {
    if (input.sourceMaterialId === input.targetMaterialId) throw new Error('A material cannot be related to itself.')
    // AI suggestions are an independent review layer. A user must be able to
    // formalize the same direction without first deleting the suggestion.
    const duplicate = this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND created_by=? LIMIT 1', [input.sourceMaterialId, input.targetMaterialId, input.createdBy])[0]
    if (duplicate) throw new Error('This relationship already exists.')
    const relation = { id: id(), ...input, createdAt: now() }
    this.run('INSERT INTO relations (id, source_material_id, target_material_id, label, relation_type, evidence_text, evidence_material_id, confidence, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, relation.sourceMaterialId, relation.targetMaterialId, relation.label, relation.relationType, relation.evidenceText, relation.evidenceMaterialId, relation.confidence, relation.createdBy, relation.createdAt])
    if (relation.createdBy === 'manual') this.run("DELETE FROM relations WHERE created_by='system' AND source_material_id=? AND target_material_id=?", [relation.sourceMaterialId, relation.targetMaterialId])
    return relation
  }
  listMaterialRelations(materialId: string, limit = 5, includeHidden = false): MaterialRelation[] {
    const rows = this.query(`SELECT mr.*, CASE WHEN mr.source_material_id=? THEN mr.target_material_id ELSE mr.source_material_id END AS other_id FROM material_relations mr WHERE (mr.source_material_id=? OR mr.target_material_id=?) ${includeHidden ? '' : "AND mr.status <> 'hidden'"} ORDER BY CASE mr.status WHEN 'fixed' THEN 0 WHEN 'visible' THEN 1 ELSE 2 END, mr.score DESC, mr.updated_at DESC LIMIT ?`, [materialId, materialId, materialId, Math.max(1, Math.min(20, limit))])
    return rows.flatMap((row) => {
      const target = this.getMaterial(String(row.other_id)); if (!target) return []
      const relationId = String(row.id)
      const evidence = this.listRelationshipEvidence(relationId)
      return [{ id: relationId, sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), score: Number(row.score), relationType: row.relation_type as MaterialRelation['relationType'], status: row.status as MaterialRelationStatus, updatedAt: String(row.updated_at), target, evidence }]
    })
  }
  getMaterialRelation(relationId: string): MaterialRelation | null {
    const row = this.query('SELECT * FROM material_relations WHERE id=?', [relationId])[0]; if (!row) return null
    const target = this.getMaterial(String(row.target_material_id)); if (!target) return null
    return { id: String(row.id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), score: Number(row.score), relationType: row.relation_type as MaterialRelation['relationType'], status: row.status as MaterialRelationStatus, updatedAt: String(row.updated_at), target, evidence: this.listRelationshipEvidence(String(row.id)) }
  }
  listRelationshipEvidence(relationId: string): RelationshipEvidence[] {
    const location = (materialId: string, entityId: string | null, offset: number | null): { endOffset: number | null; pageNumber: number | null; heading: string | null } => {
      const mention = entityId ? this.query('SELECT end_offset FROM entity_mentions WHERE material_id=? AND entity_id=? ORDER BY CASE WHEN start_offset=? THEN 0 ELSE 1 END LIMIT 1', [materialId, entityId, offset])[0] : null
      const chunk = offset == null ? null : this.query('SELECT page_number, heading FROM material_chunks WHERE material_id=? AND start_offset<=? AND end_offset>=? ORDER BY ordinal LIMIT 1', [materialId, offset, offset])[0]
      let endOffset = mention?.end_offset == null ? null : Number(mention.end_offset)
      if (offset != null) {
        const materialText = this.getMaterial(materialId)?.extractedText ?? ''
        const rawToken = materialText.slice(offset).match(/^[^\s)\]}>,'"`;\uff0c\u3002\uff1b\uff1a]+/)?.[0]
        if (rawToken) endOffset = offset + rawToken.length
      }
      return { endOffset, pageNumber: chunk?.page_number == null ? null : Number(chunk.page_number), heading: chunk?.heading == null ? null : String(chunk.heading) }
    }
    return this.query('SELECT * FROM relationship_evidence WHERE relation_id=? ORDER BY score DESC, created_at', [relationId]).map((row) => {
      const sourceMaterialId = String(row.source_material_id); const targetMaterialId = String(row.target_material_id)
      const sourceOffset = row.source_offset == null ? null : Number(row.source_offset); const targetOffset = row.target_offset == null ? null : Number(row.target_offset)
      const source = location(sourceMaterialId, row.source_entity_id as string | null, sourceOffset); const target = location(targetMaterialId, row.target_entity_id as string | null, targetOffset)
      return { id: String(row.id), relationId: String(row.relation_id), type: row.type as RelationshipEvidence['type'], score: Number(row.score), sourceMaterialId, targetMaterialId, sourceEntityId: row.source_entity_id as string | null, targetEntityId: row.target_entity_id as string | null, sourceOffset, targetOffset, sourceEndOffset: source.endOffset, targetEndOffset: target.endOffset, sourcePageNumber: source.pageNumber, targetPageNumber: target.pageNumber, sourceHeading: source.heading, targetHeading: target.heading, text: String(row.text), createdAt: String(row.created_at) }
    })
  }
  updateMaterialRelationStatus(relationId: string, status: MaterialRelationStatus): void {
    if (!['visible', 'hidden', 'fixed'].includes(status)) throw new Error('Unsupported material relation status.')
    if (!this.query('SELECT id FROM material_relations WHERE id=?', [relationId])[0]) throw new Error('Material relationship not found.')
    this.run('UPDATE material_relations SET status=?, updated_at=? WHERE id=?', [status, now(), relationId])
  }
  fixMaterialRelation(relationId: string, topicId?: string): Relation {
    const row = this.query('SELECT * FROM material_relations WHERE id=?', [relationId])[0]; if (!row) throw new Error('Material relationship not found.')
    const sourceMaterialId = String(row.source_material_id); const targetMaterialId = String(row.target_material_id)
    if (topicId && !this.query('SELECT id FROM topics WHERE id=? AND archived_at IS NULL', [topicId])[0]) throw new Error('Topic not found.')
    const existing = this.query("SELECT * FROM relations WHERE source_material_id=? AND target_material_id=? AND created_by IN ('manual', 'local') LIMIT 1", [sourceMaterialId, targetMaterialId])[0]
    // A fixed discovery retains its evidence and direction. User-drawn edges are
    // directed by default and only gain a source arrow when the user chooses one.
    const relation = existing ? asRelation(existing) : this.createRelation({ sourceMaterialId, targetMaterialId, label: row.relation_type === 'references' ? '引用' : '关联', relationType: row.relation_type === 'references' ? 'references' : 'related', evidenceText: this.listRelationshipEvidence(relationId).map((item) => item.text).join('\n').slice(0, 1600) || null, evidenceMaterialId: sourceMaterialId, confidence: Number(row.score), createdBy: 'local' })
    if (topicId) { this.addToTopic(topicId, sourceMaterialId, undefined, false); this.addToTopic(topicId, targetMaterialId, undefined, false) }
    this.updateMaterialRelationStatus(relationId, 'fixed'); return relation
  }
  private entityFor(text: string, type: EntityType, weight: number): Entity {
    const normalized = `${type}:${normalizeEntity(text)}`
    const row = this.query('SELECT * FROM entities WHERE normalized=?', [normalized])[0]
    if (row) { if (Number(row.weight) < weight) this.requireDb().run('UPDATE entities SET weight=? WHERE id=?', [weight, String(row.id)]); return { id: String(row.id), text: String(row.text), normalized: String(row.normalized), type: row.type as EntityType, weight: Math.max(Number(row.weight), weight) } }
    const entity = { id: id(), text: text.trim().slice(0, 80), normalized, type, weight }
    this.requireDb().run('INSERT INTO entities (id, text, normalized, type, weight) VALUES (?, ?, ?, ?, ?)', [entity.id, entity.text, entity.normalized, entity.type, entity.weight]); return entity
  }
  private indexMaterialEntities(materialId: string, text: string, headings: string[]): void {
    const material = this.getMaterial(materialId); if (!material) return
    this.requireDb().run('DELETE FROM entity_mentions WHERE material_id=?', [materialId])
    const seen = new Set<string>(); const add = (textValue: string, type: EntityType, source: EntityMentionSource, weight: number, startOffset: number | null = null) => {
      const value = textValue.trim().replace(/^[-#\s\d.]+/, '').slice(0, 80); const normalized = normalizeEntity(value)
      if (value.length < 2 || commonTerms.has(normalized) || seen.has(`${type}:${normalized}`)) return
      seen.add(`${type}:${normalized}`); const entity = this.entityFor(value, type, weight)
      const offset = startOffset ?? text.toLowerCase().indexOf(value.toLowerCase()); const excerpt = offset >= 0 ? text.slice(Math.max(0, offset - 80), offset + value.length + 160) : value
      this.requireDb().run('INSERT INTO entity_mentions (id, entity_id, material_id, source, start_offset, end_offset, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)', [id(), entity.id, materialId, source, offset >= 0 ? offset : null, offset >= 0 ? offset + value.length : null, excerpt.slice(0, 420)])
    }
    add(material.title, 'project', 'title', 1)
    for (const heading of headings.slice(0, 6)) add(heading, 'project', 'heading', .8)
    for (const match of text.matchAll(technologyPattern)) add(match[0], 'technology', 'body', .85, match.index ?? null)
    for (const reference of materialReferences(text)) add(reference.value, 'file_reference', reference.source, 1, reference.startOffset)
    const phrases = text.match(/[A-Za-z][A-Za-z0-9+.#_-]{2,30}|[\u4e00-\u9fff]{3,10}/g) ?? []; const counts = new Map<string, number>(); phrases.forEach((phrase) => { const normalized = normalizeEntity(phrase); if (!commonTerms.has(normalized)) counts.set(phrase, (counts.get(phrase) ?? 0) + 1) })
    for (const [phrase, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 4)) add(phrase, 'technology', 'body', Math.min(.65, .25 + count * .1))
  }
  private referenceMatchesMaterial(reference: string, source: Material, target: Material): boolean {
    const normalizedReference = reference.trim().replace(/[?#].*$/, '').replaceAll('\\', '/')
    if (!normalizedReference) return false
    const candidates = new Set<string>()
    const add = (value: string | null | undefined): void => { if (value) candidates.add(normalizeEntity(value.replaceAll('\\', '/'))) }
    add(normalizedReference)
    add(basename(normalizedReference))
    add(basename(normalizedReference, extname(normalizedReference)))
    if (source.sourcePath) add(resolve(dirname(source.sourcePath), normalizedReference))
    const targetPaths = [target.sourcePath, target.storedPath ? join(this.materialsPath(), target.storedPath) : null]
    for (const targetPath of targetPaths) {
      if (!targetPath) continue
      const normalizedPath = normalizeEntity(targetPath.replaceAll('\\', '/'))
      if (candidates.has(normalizedPath)) return true
    }
    const targetFile = basename(target.sourcePath ?? target.storedPath ?? '')
    const targetNames = [target.title, targetFile, basename(targetFile, extname(targetFile))].filter(Boolean).map(normalizeEntity)
    return targetNames.some((name) => candidates.has(name))
  }

  private rebuildMaterialRelations(materialId: string): void {
    const source = this.getMaterial(materialId); if (!source) return
    const prior = new Map(this.query('SELECT * FROM material_relations WHERE source_material_id=? OR target_material_id=?', [materialId, materialId]).map((row) => [`${[String(row.source_material_id), String(row.target_material_id)].sort().join(':')}`, row]))
    for (const row of prior.values()) this.requireDb().run('DELETE FROM relationship_evidence WHERE relation_id=?', [String(row.id)])
    this.requireDb().run('DELETE FROM material_relations WHERE source_material_id=? OR target_material_id=?', [materialId, materialId])
    const materials = this.listMaterials().filter((item) => item.id !== materialId && item.status === 'complete')
    const ownMentions = this.query('SELECT em.*, e.text AS entity_text, e.type AS entity_type, e.normalized AS normalized, e.weight AS entity_weight FROM entity_mentions em JOIN entities e ON e.id=em.entity_id WHERE em.material_id=?', [materialId])
    for (const other of materials) {
      const otherMentions = this.query('SELECT em.*, e.text AS entity_text, e.type AS entity_type, e.normalized AS normalized, e.weight AS entity_weight FROM entity_mentions em JOIN entities e ON e.id=em.entity_id WHERE em.material_id=?', [other.id])
      const evidence: Array<Omit<RelationshipEvidence, 'id' | 'relationId' | 'createdAt'>> = []
      for (const mention of ownMentions) {
        if (String(mention.entity_type) !== 'file_reference' || !this.referenceMatchesMaterial(String(mention.entity_text), source, other)) continue
        evidence.push({ type: 'explicit_reference', score: 1, sourceMaterialId: materialId, targetMaterialId: other.id, sourceEntityId: String(mention.entity_id), targetEntityId: null, sourceOffset: mention.start_offset as number | null, targetOffset: null, text: `“${source.title}”通过“${String(mention.entity_text)}”引用了“${other.title}”。` })
      }
      for (const mention of otherMentions) {
        if (String(mention.entity_type) !== 'file_reference' || !this.referenceMatchesMaterial(String(mention.entity_text), other, source)) continue
        evidence.push({ type: 'explicit_reference', score: 1, sourceMaterialId: other.id, targetMaterialId: materialId, sourceEntityId: String(mention.entity_id), targetEntityId: null, sourceOffset: mention.start_offset as number | null, targetOffset: null, text: `“${other.title}”通过“${String(mention.entity_text)}”引用了“${source.title}”。` })
      }
      const byEntity = new Map(ownMentions.map((mention) => [String(mention.entity_id), mention]))
      for (const targetMention of otherMentions) {
        const sourceMention = byEntity.get(String(targetMention.entity_id)); if (!sourceMention || String(sourceMention.entity_type) === 'file_reference') continue
        const uses = Number(this.query('SELECT COUNT(DISTINCT material_id) AS count FROM entity_mentions WHERE entity_id=?', [String(targetMention.entity_id)])[0]?.count ?? 0)
        if (uses >= Math.max(3, Math.ceil((materials.length + 1) * .6))) continue
        evidence.push({ type: 'entity_overlap', score: Math.min(.75, .18 + (Number(sourceMention.entity_weight ?? .4) + Number(targetMention.entity_weight ?? .4)) / 2), sourceMaterialId: materialId, targetMaterialId: other.id, sourceEntityId: String(sourceMention.entity_id), targetEntityId: String(targetMention.entity_id), sourceOffset: sourceMention.start_offset as number | null, targetOffset: targetMention.start_offset as number | null, text: `两份材料都提到“${String(targetMention.entity_text)}”。` })
      }
      const selected = evidence.sort((left, right) => right.score - left.score).slice(0, 4); if (!selected.length) continue
      const explicit = selected.find((item) => item.type === 'explicit_reference'); const orientedSource = explicit?.sourceMaterialId ?? (materialId < other.id ? materialId : other.id); const orientedTarget = explicit?.targetMaterialId ?? (materialId < other.id ? other.id : materialId)
      const score = Math.min(1, explicit ? .92 + selected.filter((item) => item.type === 'entity_overlap').length * .02 : selected.reduce((sum, item) => sum + item.score, 0) / Math.max(1, selected.length))
      if (!explicit && score < .42) continue
      const key = [orientedSource, orientedTarget].sort().join(':'); const old = prior.get(key); const relationId = String(old?.id ?? id()); const status = String(old?.status ?? 'visible')
      this.requireDb().run('INSERT INTO material_relations (id, source_material_id, target_material_id, score, relation_type, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [relationId, orientedSource, orientedTarget, score, explicit ? 'references' : 'shares_entities', status, now()])
      for (const item of selected) this.requireDb().run('INSERT INTO relationship_evidence (id, relation_id, type, score, source_material_id, target_material_id, source_entity_id, target_entity_id, source_offset, target_offset, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id(), relationId, item.type, item.score, item.sourceMaterialId, item.targetMaterialId, item.sourceEntityId, item.targetEntityId, item.sourceOffset, item.targetOffset, item.text, now()])
    }
    this.persist()
  }
  listMaterialTags(materialId: string): MaterialTag[] { return this.query('SELECT material_id, tag, source, weight FROM material_tags WHERE material_id=? ORDER BY weight DESC, tag', [materialId]).map((row) => ({ materialId: String(row.material_id), tag: String(row.tag), source: row.source as MaterialTag['source'], weight: Number(row.weight) })) }
  listTopicCandidates(topicId: string): TopicRelationCandidateRecord[] { return this.query('SELECT * FROM topic_relation_candidates WHERE topic_id=? ORDER BY score DESC', [topicId]).map((row) => ({ id: String(row.id), topicId: String(row.topic_id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), sharedTags: JSON.parse(String(row.shared_tags ?? '[]')) as string[], score: Number(row.score), status: row.status as TopicCandidateStatus, createdAt: String(row.created_at), updatedAt: String(row.updated_at) })) }
  updateCandidateStatus(topicId: string, candidateId: string, status: TopicCandidateStatus): void { if (!['visible', 'hidden', 'accepted'].includes(status)) throw new Error('Unsupported candidate status.'); this.run('UPDATE topic_relation_candidates SET status=?, updated_at=? WHERE id=? AND topic_id=?', [status, now(), candidateId, topicId]) }
  acceptCandidate(topicId: string, candidateId: string): Relation {
    const row = this.query('SELECT * FROM topic_relation_candidates WHERE id=? AND topic_id=?', [candidateId, topicId])[0]; if (!row) throw new Error('Candidate relationship not found.')
    const sharedTags = JSON.parse(String(row.shared_tags ?? '[]')) as string[]
    const relation = this.createRelation({ sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), label: sharedTags[0] ?? '关联', relationType: 'related', evidenceText: `本地共享标签：${sharedTags.join('、')}`, evidenceMaterialId: String(row.source_material_id), confidence: Number(row.score), createdBy: 'manual' })
    this.updateCandidateStatus(topicId, candidateId, 'accepted'); return relation
  }
  rebuildTopicCandidates(topicId: string): void {
    const materialIds = this.query('SELECT material_id FROM topic_materials WHERE topic_id=?', [topicId]).map((row) => String(row.material_id)); if (!materialIds.length) return
    const placeholders = materialIds.map(() => '?').join(','); const tagRows = this.query(`SELECT material_id, tag, weight FROM material_tags WHERE material_id IN (${placeholders})`, materialIds)
    const tags = new Map<string, Map<string, number>>(); const frequency = new Map<string, number>()
    for (const row of tagRows) { const materialId = String(row.material_id); const tag = String(row.tag); const current = tags.get(materialId) ?? new Map<string, number>(); current.set(tag, Number(row.weight)); tags.set(materialId, current); frequency.set(tag, (frequency.get(tag) ?? 0) + 1) }
    const previous = new Map(this.query('SELECT * FROM topic_relation_candidates WHERE topic_id=?', [topicId]).map((row) => [`${row.source_material_id}:${row.target_material_id}`, row]))
    const current = new Set<string>(); const proposals: Array<{ source: string; target: string; shared: string[]; score: number }> = []
    for (let left = 0; left < materialIds.length; left += 1) for (let right = left + 1; right < materialIds.length; right += 1) {
      const source = materialIds[left]; const target = materialIds[right]; const sourceTags = tags.get(source) ?? new Map(); const targetTags = tags.get(target) ?? new Map()
      const shared = [...sourceTags.keys()].filter((tag) => targetTags.has(tag) && (frequency.get(tag) ?? 0) < Math.max(3, materialIds.length * .65)).sort((a, b) => (targetTags.get(b)! + sourceTags.get(b)!) - (targetTags.get(a)! + sourceTags.get(a)!)).slice(0, 3)
      if (!shared.length) continue
      const score = shared.reduce((sum, tag) => sum + (sourceTags.get(tag) ?? 0) + (targetTags.get(tag) ?? 0), 0); proposals.push({ source, target, shared, score })
    }
    const degree = new Map<string, number>(); for (const proposal of proposals.sort((left, right) => right.score - left.score)) { if ((degree.get(proposal.source) ?? 0) >= 3 || (degree.get(proposal.target) ?? 0) >= 3) continue; degree.set(proposal.source, (degree.get(proposal.source) ?? 0) + 1); degree.set(proposal.target, (degree.get(proposal.target) ?? 0) + 1); const key = `${proposal.source}:${proposal.target}`; current.add(key); const old = previous.get(key); this.requireDb().run('INSERT OR REPLACE INTO topic_relation_candidates (id, topic_id, source_material_id, target_material_id, shared_tags, score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [String(old?.id ?? id()), topicId, proposal.source, proposal.target, JSON.stringify(proposal.shared), proposal.score, String(old?.status ?? 'visible'), String(old?.created_at ?? now()), now()]) }
    for (const [key, row] of previous) if (!current.has(key) && String(row.status) !== 'accepted') this.requireDb().run('DELETE FROM topic_relation_candidates WHERE id=?', [String(row.id)])
    this.persist()
  }
  hasConnection(sourceMaterialId: string, targetMaterialId: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? LIMIT 1', [sourceMaterialId, targetMaterialId]).length > 0 }
  hasRelation(sourceMaterialId: string, targetMaterialId: string, label: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND label=? LIMIT 1', [sourceMaterialId, targetMaterialId, label]).length > 0 }
  updateRelation(id: string, label: string): void { this.run('UPDATE relations SET label=? WHERE id=?', [label, id]) }
  deleteRelation(id: string): void { this.run('DELETE FROM relations WHERE id=?', [id]) }
  topicMap(topicId: string): TopicMap {
    const topic = first<Topic>(this.query('SELECT * FROM topics WHERE id=?', [topicId])); if (!topic) throw new Error('Topic not found')
    const materials = this.query('SELECT m.*, mis.availability AS availability, mis.last_indexed_at AS lastIndexedAt, tm.workstream_id AS workstreamId, tm.canvas_x AS canvasX, tm.canvas_y AS canvasY, tm.position_source AS positionSource, tm.card_color AS cardColor, tm.card_tags AS cardTags, tm.card_note AS cardNote, tm.sequence AS sequence, tm.sequence_source AS sequenceSource, tm.added_at AS addedAt, tm.display_title AS displayTitle, tm.display_excerpt AS displayExcerpt, tm.card_width AS cardWidth, tm.card_height AS cardHeight, tm.card_text_color AS cardTextColor, tm.card_font_size AS cardFontSize, tm.card_collapsed AS cardCollapsed, tm.card_z_index AS cardZIndex FROM materials m JOIN topic_materials tm ON tm.material_id=m.id LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE tm.topic_id=? ORDER BY m.occurred_at', [topicId]).map((row) => { let cardTags: string[] = []; try { const value = JSON.parse(String(row.cardTags ?? '[]')); if (Array.isArray(value)) cardTags = value.filter((tag): tag is string => typeof tag === 'string') } catch { /* Old or invalid rows use empty tags. */ } const material = asMaterial(row); return { ...material, workstreamId: row.workstreamId as string | null, canvasX: row.canvasX as number | null, canvasY: row.canvasY as number | null, positionSource: row.positionSource === 'manual' ? 'manual' as const : 'auto' as const, cardColor: row.cardColor as string | null, cardTags, tags: this.listMaterialTags(material.id), cardNote: row.cardNote as string | null, sequence: row.sequence as number | null, sequenceSource: String(row.sequenceSource ?? 'time'), addedAt: row.addedAt as string | null, displayTitle: row.displayTitle as string | null, displayExcerpt: row.displayExcerpt as string | null, cardWidth: row.cardWidth === null ? null : Number(row.cardWidth), cardHeight: row.cardHeight === null ? null : Number(row.cardHeight), cardTextColor: row.cardTextColor as string | null, cardFontSize: row.cardFontSize === null ? null : Number(row.cardFontSize), cardCollapsed: Boolean(row.cardCollapsed), cardZIndex: Number(row.cardZIndex ?? 0) } })
    const ids = materials.map((m) => m.id); const placeholders = ids.map(() => '?').join(',') || "''"
    const candidates = this.listTopicCandidates(topicId)
    return { topic, materials, workstreams: this.query('SELECT * FROM workstreams WHERE topic_id=? ORDER BY position', [topicId]).map(asWorkstream), relations: this.query(`SELECT r.*, trs.line_color AS lineColor, trs.source_arrow AS sourceArrow, trs.source_arrow_style AS sourceArrowStyle, trs.target_arrow_style AS targetArrowStyle, trs.animated AS animated, trs.archived AS archived, trs.branch_index AS branchIndex, trs.line_kind AS lineKind, trs.source_handle AS sourceHandle, trs.target_handle AS targetHandle, trs.line_width AS lineWidth, trs.line_dash AS lineDash, trs.route_points AS routePoints, trs.label_anchor AS labelAnchor FROM relations r LEFT JOIN topic_relation_styles trs ON trs.relation_id=r.id AND trs.topic_id=? WHERE r.source_material_id IN (${placeholders}) AND r.target_material_id IN (${placeholders}) AND (r.topic_id IS NULL OR r.topic_id=?)`, [topicId, ...ids, ...ids, topicId]).map(asRelation), candidates, history: this.topicHistoryStatus(topicId) }
  }
  getMaterialAnalysisCard(materialId: string, modelId: string): MaterialAnalysisCard | null {
    const material = this.getMaterial(materialId); if (!material) return null
    const contentHash = material.hash ?? chunkHash(material.extractedText ?? material.excerpt ?? material.title)
    const row = this.query('SELECT * FROM material_analysis_cards WHERE material_id=? AND content_hash=? AND model_id=?', [materialId, contentHash, modelId])[0]
    if (!row) return null
    const parse = (value: unknown): string[] => { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } }
    return { materialId, contentHash, modelId, title: String(row.title), date: row.date as string | null, headings: parse(row.headings), keywords: parse(row.keywords), evidenceChunkIds: parse(row.evidence_chunk_ids), summary: String(row.summary), generatedAt: String(row.generated_at) }
  }
  saveMaterialAnalysisCard(card: MaterialAnalysisCard): void {
    this.run('INSERT OR REPLACE INTO material_analysis_cards (material_id, content_hash, model_id, title, date, headings, keywords, evidence_chunk_ids, summary, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [card.materialId, card.contentHash, card.modelId, card.title, card.date, JSON.stringify(card.headings), JSON.stringify(card.keywords), JSON.stringify(card.evidenceChunkIds), card.summary, card.generatedAt])
  }
  materialEvidenceWindow(materialId: string, query: string, limit = 2): MaterialChunk[] {
    const chunks = this.listMaterialChunks(materialId); if (!chunks.length) return []
    const terms = new Set(tokenize(query)); const scored = chunks.map((chunk) => ({ chunk, score: tokenize(`${chunk.heading ?? ''} ${chunk.text}`).reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal)
    const selected = scored.slice(0, Math.max(1, limit)).flatMap(({ chunk }) => chunks.filter((candidate) => Math.abs(candidate.ordinal - chunk.ordinal) <= 1))
    return [...new Map(selected.map((chunk) => [chunk.id, chunk])).values()].sort((a, b) => a.ordinal - b.ordinal)
  }
  startTopicAnalysisRun(topicId: string, topicRevision: number, total: number): TopicAnalysisRun {
    const run = { id: id(), topicId, topicRevision, stage: 'preparing' as const, completed: 0, total, addedRelations: 0, rejectedCandidates: 0, error: null, summary: null, createdAt: now(), updatedAt: now() }
    this.run('INSERT INTO topic_analysis_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [run.id, run.topicId, run.topicRevision, run.stage, run.completed, run.total, run.addedRelations, run.rejectedCandidates, null, null, run.createdAt, run.updatedAt]); return run
  }
  updateTopicAnalysisRun(runId: string, input: Partial<Pick<TopicAnalysisRun, 'stage' | 'completed' | 'total' | 'addedRelations' | 'rejectedCandidates' | 'error' | 'summary'>>): TopicAnalysisRun | null {
    const current = this.query('SELECT * FROM topic_analysis_runs WHERE id=?', [runId])[0]; if (!current) return null
    const next = { stage: input.stage ?? String(current.stage), completed: input.completed ?? Number(current.completed), total: input.total ?? Number(current.total), addedRelations: input.addedRelations ?? Number(current.added_relations), rejectedCandidates: input.rejectedCandidates ?? Number(current.rejected_candidates), error: input.error === undefined ? current.error : input.error, summary: input.summary === undefined ? current.summary : input.summary, updatedAt: now() }
    this.run('UPDATE topic_analysis_runs SET stage=?, completed=?, total=?, added_relations=?, rejected_candidates=?, error=?, summary=?, updated_at=? WHERE id=?', [next.stage, next.completed, next.total, next.addedRelations, next.rejectedCandidates, next.error, next.summary, next.updatedAt, runId])
    return this.topicAnalysisRun(runId)
  }
  topicAnalysisRun(runId: string): TopicAnalysisRun | null { const row = this.query('SELECT * FROM topic_analysis_runs WHERE id=?', [runId])[0]; return row ? { id: String(row.id), topicId: String(row.topic_id), topicRevision: Number(row.topic_revision), stage: row.stage as TopicAnalysisRun['stage'], completed: Number(row.completed), total: Number(row.total), addedRelations: Number(row.added_relations), rejectedCandidates: Number(row.rejected_candidates), error: row.error as string | null, summary: row.summary as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null }
  latestTopicAnalysisRun(topicId: string): TopicAnalysisRun | null { const row = this.query('SELECT id FROM topic_analysis_runs WHERE topic_id=? ORDER BY created_at DESC LIMIT 1', [topicId])[0]; return row ? this.topicAnalysisRun(String(row.id)) : null }
  listTopicAnalysisRuns(topicId: string, limit = 10): TopicAnalysisRun[] { return this.query('SELECT id FROM topic_analysis_runs WHERE topic_id=? ORDER BY created_at DESC LIMIT ?', [topicId, Math.max(1, Math.min(50, limit))]).flatMap((row) => { const run = this.topicAnalysisRun(String(row.id)); return run ? [run] : [] }) }
  applyTopicAnalysis(topicId: string, expectedRevision: number, candidates: TopicRelationCandidate[], positions: Array<{ materialId: string; x: number; y: number }>): number {
    const topic = this.topicMap(topicId).topic; if (topic.revision !== expectedRevision) throw new Error('The topic changed while analysis was running. No AI changes were applied.')
    const materialIds = new Set(this.topicMap(topicId).materials.map((material) => material.id)); const existing = new Set(this.topicMap(topicId).relations.map((relation) => `${relation.sourceMaterialId}:${relation.targetMaterialId}`)); const incoming = new Set<string>(); let added = 0
    this.requireDb().exec('BEGIN')
    try {
      for (const candidate of candidates) {
        const key = `${candidate.sourceMaterialId}:${candidate.targetMaterialId}`
        if (!materialIds.has(candidate.sourceMaterialId) || !materialIds.has(candidate.targetMaterialId) || candidate.sourceMaterialId === candidate.targetMaterialId || existing.has(key) || incoming.has(candidate.targetMaterialId)) continue
        const relationId = id(); this.requireDb().run('INSERT INTO relations (id, source_material_id, target_material_id, label, relation_type, evidence_text, evidence_material_id, confidence, created_by, created_at, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [relationId, candidate.sourceMaterialId, candidate.targetMaterialId, candidate.label?.slice(0, 48) || candidate.relationType, candidate.evidence.slice(0, 1600), candidate.sourceMaterialId, Math.max(0, Math.min(1, candidate.confidence)), 'ai', now(), topicId]); incoming.add(candidate.targetMaterialId); added += 1
      }
      for (const position of positions) this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=? WHERE topic_id=? AND material_id=? AND position_source <> 'manual'", [position.x, position.y, topicId, position.materialId])
      this.bumpTopicRevision(topicId); this.requireDb().exec('COMMIT'); this.persist(); return added
    } catch (error) { this.requireDb().exec('ROLLBACK'); throw error }
  }
  private recoverProcessingJobs(): void {
    const stale = this.query("SELECT DISTINCT material_id FROM jobs WHERE status='running' UNION SELECT id AS material_id FROM materials WHERE status='running'").map((row) => String(row.material_id))
    if (!stale.length) return
    this.requireDb().run("UPDATE jobs SET status='queued', error=NULL, updated_at=? WHERE status='running'", [now()])
    this.requireDb().run("UPDATE materials SET status='queued', error=NULL WHERE id IN (SELECT material_id FROM jobs WHERE status='queued') AND status='running'")
    this.persist()
    for (const materialId of stale) void this.enqueueProcessing(materialId)
  }

  private indexMaterialChunks(materialId: string, text: string, extracted?: Pick<ExtractedMaterial, 'pages'>): void {
    const indexedAt = now()
    const chunks = chunkText(text)
    const previousChunkIds = this.listMaterialChunks(materialId).map((chunk) => chunk.id)
    this.vectorStore?.removeMaterial(previousChunkIds)
    this.requireDb().run('DELETE FROM material_chunks WHERE material_id=?', [materialId])
    if (this.ftsEnabled) this.requireDb().run('DELETE FROM material_chunks_fts WHERE material_id=?', [materialId])
    for (const chunk of chunks) {
      const chunkId = id()
      const pageNumber = extracted?.pages?.find((page) => chunk.startOffset < extracted.pages!.slice(0, extracted.pages!.indexOf(page) + 1).reduce((offset, item) => offset + item.text.length + 1, 0))?.pageNumber ?? null
      this.requireDb().run('INSERT INTO material_chunks (id, material_id, ordinal, text, start_offset, end_offset, page_number, heading, hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [chunkId, materialId, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset, pageNumber, chunk.heading, chunkHash(chunk.text), indexedAt])
      if (this.ftsEnabled) this.requireDb().run('INSERT INTO material_chunks_fts (chunk_id, material_id, title, text, heading) SELECT ?, ?, title, ?, ? FROM materials WHERE id=?', [chunkId, materialId, chunk.text, chunk.heading, materialId])
    }
    this.requireDb().run('INSERT OR REPLACE INTO material_index_state (material_id, source_id, availability, last_indexed_at, last_seen_at) VALUES (?, COALESCE((SELECT source_id FROM material_index_state WHERE material_id=?), NULL), ?, ?, ?)', [materialId, materialId, 'available', indexedAt, indexedAt])
    const material = this.getMaterial(materialId); const headings = chunks.map((chunk) => chunk.heading).filter((heading): heading is string => Boolean(heading)); this.requireDb().run('DELETE FROM material_tags WHERE material_id=?', [materialId]); for (const tag of extractedTags(material?.title ?? '', text, headings)) this.requireDb().run('INSERT INTO material_tags (material_id, tag, source, weight) VALUES (?, ?, ?, ?)', [materialId, tag.tag, tag.source, tag.weight])
    this.indexMaterialEntities(materialId, text, headings)
    this.persist()
    this.rebuildMaterialRelations(materialId)
    void this.embedMaterial(materialId)
  }

  private setupVectorStore(): void {
    this.vectorStore?.close(); this.vectorStore = null
    if (this.embeddingProvider && this.config && !this.config.encrypted && this.vectorCapability.available) try { this.vectorStore = new VectorStore(this.vectorsPath()) } catch { this.vectorStore = null }
  }

  private async embedMaterial(materialId: string): Promise<void> {
    if (!this.vectorStore || !this.embeddingProvider) return
    const chunks = this.listMaterialChunks(materialId); if (!chunks.length) return
    try {
      const vectors = await this.embeddingProvider(chunks.map((chunk) => chunk.text)); if (!vectors || vectors.length !== chunks.length) return
      for (const [index, vector] of vectors.entries()) this.vectorStore.upsert(chunks[index].id, vector)
    } catch { /* FTS remains available when embeddings fail. */ }
  }

  async searchKnowledgeAsync(query: string, options: { limit?: number; sourceId?: string } = {}): Promise<{ hits: SearchHit[]; mode: 'fts' | 'hybrid' }> {
    const lexical = this.searchKnowledge(query, options)
    if (!this.vectorStore || !this.embeddingProvider) return { hits: lexical, mode: 'fts' }
    try {
      const vectors = await this.embeddingProvider([query]); const vector = vectors?.[0]; if (!vector) return { hits: lexical, mode: 'fts' }
      const vectorHits = this.vectorStore.search(vector, options.limit ?? 8)
      const byChunk = new Map(lexical.map((hit) => [hit.chunkId, hit]))
      const missingIds = vectorHits.map((hit) => hit.chunkId).filter((chunkId) => !byChunk.has(chunkId))
      if (missingIds.length) {
        const placeholders = missingIds.map(() => '?').join(',')
        const rows = this.query(`SELECT c.id AS chunkId, c.material_id AS materialId, m.title, c.text, c.heading, c.page_number AS pageNumber, m.source_path AS sourcePath, COALESCE(mis.availability, 'available') AS availability FROM material_chunks c JOIN materials m ON m.id=c.material_id LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE c.id IN (${placeholders})`, missingIds)
        for (const [index, row] of rows.entries()) byChunk.set(String(row.chunkId), { materialId: String(row.materialId), chunkId: String(row.chunkId), title: String(row.title), text: String(row.text), score: 1 / (index + 1), sourcePath: row.sourcePath as string | null, pageNumber: row.pageNumber === null ? null : Number(row.pageNumber), heading: row.heading as string | null, availability: (row.availability as SearchHit['availability']) ?? 'available' })
      }
      const hits = vectorHits.map((hit) => byChunk.get(hit.chunkId)).filter((hit): hit is SearchHit => Boolean(hit))
      return { hits: hits.length ? hits : lexical, mode: hits.length ? 'hybrid' : 'fts' }
    } catch { return { hits: lexical, mode: 'fts' } }
  }

  private backfillMaterialChunks(): void {
    const rows = this.query('SELECT m.id, m.extracted_text FROM materials m LEFT JOIN material_chunks c ON c.material_id=m.id WHERE m.extracted_text IS NOT NULL AND c.id IS NULL GROUP BY m.id')
    for (const row of rows) this.indexMaterialChunks(String(row.id), String(row.extracted_text ?? ''))
  }
  private backfillMaterialTags(): void {
    const rows = this.query("SELECT m.id, m.title, m.extracted_text FROM materials m WHERE m.extracted_text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM material_tags t WHERE t.material_id=m.id)")
    for (const row of rows) {
      const materialId = String(row.id); const text = String(row.extracted_text ?? ''); const headings = this.listMaterialChunks(materialId).map((chunk) => chunk.heading).filter((heading): heading is string => Boolean(heading))
      for (const tag of extractedTags(String(row.title), text, headings)) this.requireDb().run('INSERT INTO material_tags (material_id, tag, source, weight) VALUES (?, ?, ?, ?)', [materialId, tag.tag, tag.source, tag.weight])
    }
    for (const row of this.query('SELECT id FROM topics WHERE archived_at IS NULL')) this.rebuildTopicCandidates(String(row.id))
    this.persist()
  }
  private backfillMaterialRelations(): void {
    const missing = this.query("SELECT m.id FROM materials m WHERE m.status='complete' AND m.extracted_text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entity_mentions em WHERE em.material_id=m.id)")
    for (const row of missing) {
      const materialId = String(row.id); const text = String(this.getMaterial(materialId)?.extractedText ?? ''); const headings = this.listMaterialChunks(materialId).map((chunk) => chunk.heading).filter((heading): heading is string => Boolean(heading))
      this.indexMaterialEntities(materialId, text, headings)
    }
    for (const row of missing) this.rebuildMaterialRelations(String(row.id))
  }

  private folderRow(row: SqlRow): FolderSource {
    const parse = (value: unknown): string[] => { try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] } }
    return { id: String(row.id), rootPath: String(row.root_path), enabled: Boolean(row.enabled), includePatterns: parse(row.include_patterns), excludePatterns: parse(row.exclude_patterns), watchEnabled: Boolean(row.watch_enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  listFolderSources(): FolderSource[] { return this.query('SELECT * FROM folder_sources ORDER BY created_at').map((row) => this.folderRow(row)) }

  async addFolderSource(input: Omit<FolderSource, 'id' | 'createdAt' | 'updatedAt'>): Promise<FolderSource> {
    if (!existsSync(input.rootPath)) throw new Error('Folder does not exist.')
    const source = { ...input, id: id(), createdAt: now(), updatedAt: now() }
    this.run('INSERT INTO folder_sources (id, root_path, enabled, include_patterns, exclude_patterns, watch_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [source.id, source.rootPath, source.enabled ? 1 : 0, JSON.stringify(source.includePatterns), JSON.stringify(source.excludePatterns), source.watchEnabled ? 1 : 0, source.createdAt, source.updatedAt])
    await this.rescanFolderSource(source.id)
    if (source.watchEnabled) this.watchFolderSource(source.id)
    return this.folderRow(this.query('SELECT * FROM folder_sources WHERE id=?', [source.id])[0])
  }

  updateFolderSource(id: string, input: Partial<Omit<FolderSource, 'id' | 'createdAt' | 'updatedAt'>>): FolderSource {
    const current = this.query('SELECT * FROM folder_sources WHERE id=?', [id])[0]
    if (!current) throw new Error('Folder source not found.')
    const source = this.folderRow(current)
    const next = { ...source, ...input, updatedAt: now() }
    this.run('UPDATE folder_sources SET root_path=?, enabled=?, include_patterns=?, exclude_patterns=?, watch_enabled=?, updated_at=? WHERE id=?', [next.rootPath, next.enabled ? 1 : 0, JSON.stringify(next.includePatterns), JSON.stringify(next.excludePatterns), next.watchEnabled ? 1 : 0, next.updatedAt, id])
    this.stopFolderWatcher(id)
    if (next.enabled && next.watchEnabled) this.watchFolderSource(id)
    return next
  }

  removeFolderSource(sourceId: string): void {
    this.stopFolderWatcher(sourceId)
    this.run('UPDATE material_index_state SET source_id=NULL WHERE source_id=?', [sourceId])
    this.run('DELETE FROM folder_sources WHERE id=?', [sourceId])
  }

  pauseFolderSource(sourceId: string): FolderSource { return this.updateFolderSource(sourceId, { enabled: false }) }

  async rescanFolderSource(sourceId: string): Promise<{ scanned: number; indexed: number; unavailable: number }> {
    const row = this.query('SELECT * FROM folder_sources WHERE id=?', [sourceId])[0]
    if (!row) throw new Error('Folder source not found.')
    const source = this.folderRow(row)
    if (!source.enabled) return { scanned: 0, indexed: 0, unavailable: 0 }
    const files = this.walkFolder(source.rootPath, source.includePatterns, source.excludePatterns)
    const seen = new Set(files)
    let indexed = 0
    for (const filePath of files) { if (await this.indexExternalFile(sourceId, filePath)) indexed += 1 }
    const existing = this.query('SELECT mis.material_id, m.source_path FROM material_index_state mis JOIN materials m ON m.id=mis.material_id WHERE mis.source_id=?', [sourceId])
    let unavailable = 0
    for (const item of existing) if (!seen.has(String(item.source_path))) { this.run('UPDATE material_index_state SET availability=?, last_seen_at=? WHERE material_id=?', ['unavailable', now(), String(item.material_id)]); unavailable += 1 }
    return { scanned: files.length, indexed, unavailable }
  }

  private walkFolder(root: string, includePatterns: string[], excludePatterns: string[]): string[] {
    const files: string[] = []
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const path = join(directory, entry.name)
        const relativePath = path.slice(root.length + 1).replaceAll('\\', '/')
        if (excludePatterns.some((pattern) => this.matchesPathPattern(relativePath, pattern))) continue
        if (entry.isDirectory()) visit(path)
        else if (this.isIndexablePath(path) && (!includePatterns.length || includePatterns.some((pattern) => this.matchesPathPattern(relativePath, pattern)))) files.push(path)
      }
    }
    visit(root); return files
  }

  private matchesPathPattern(relativePath: string, pattern: string): boolean {
    const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (!normalized) return false
    let escaped = ''
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index]
      if (char === '*' && normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') { escaped += '(?:.*/)?'; index += 2 } else { escaped += '.*'; index += 1 }
      } else if (char === '*') escaped += '[^/]*'
      else if (char === '?') escaped += '[^/]'
      else escaped += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    }
    return new RegExp(`^${escaped}$`, 'i').test(relativePath) || new RegExp(`(^|/)${escaped}$`, 'i').test(relativePath)
  }

  private isIndexablePath(filePath: string): boolean { return /\.(md|markdown|txt|csv|json|html?|pdf|docx?)$/i.test(filePath) }

  private async indexExternalFile(sourceId: string, filePath: string): Promise<boolean> {
    const input = await readFile(filePath); const info = await stat(filePath); const hash = createHash('sha256').update(input).digest('hex')
    const existing = this.query('SELECT m.id, m.hash FROM materials m JOIN material_index_state mis ON mis.material_id=m.id WHERE mis.source_id=? AND m.source_path=?', [sourceId, filePath])[0]
    if (existing && String(existing.hash ?? '') === hash) { this.run('UPDATE material_index_state SET availability=?, last_seen_at=? WHERE material_id=?', ['available', now(), String(existing.id)]); return false }
    const materialId = existing ? String(existing.id) : id(); const importedAt = now()
    if (!existing) {
      this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'file', basename(filePath, extname(filePath)), null, filePath, null, null, null, null, null, importedAt, importedAt, 'import', 'queued', null, hash])
      this.run('INSERT INTO material_index_state (material_id, source_id, availability, last_indexed_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [materialId, sourceId, 'available', null, importedAt])
    } else this.run('UPDATE materials SET hash=?, status=?, error=? WHERE id=?', [hash, 'queued', null, materialId])
    if (info.size <= MAX_AUTO_EXTRACT_BYTES) void this.enqueueProcessing(materialId)
    else this.run('UPDATE materials SET status=?, error=? WHERE id=?', ['paused', '文件超过 10 MB，自动解析已跳过。', materialId])
    return true
  }

  private watchFolderSource(sourceId: string): void {
    this.stopFolderWatcher(sourceId)
    const source = this.folderRow(this.query('SELECT * FROM folder_sources WHERE id=?', [sourceId])[0])
    const watcher = chokidar.watch(source.rootPath, { ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } })
    const accepts = (filePath: string): boolean => {
      const relativePath = String(filePath).slice(source.rootPath.length + 1).replaceAll('\\', '/')
      return this.isIndexablePath(filePath) && (!source.includePatterns.length || source.includePatterns.some((pattern) => this.matchesPathPattern(relativePath, pattern))) && !source.excludePatterns.some((pattern) => this.matchesPathPattern(relativePath, pattern))
    }
    const schedule = (filePath: string): void => {
      if (!accepts(filePath)) return
      const key = `${sourceId}:${filePath}`
      const previous = this.pendingFolderEvents.get(key)
      if (previous) clearTimeout(previous)
      this.pendingFolderEvents.set(key, setTimeout(() => {
        this.pendingFolderEvents.delete(key)
        void this.indexExternalFile(sourceId, filePath)
      }, 250))
    }
    watcher.on('add', schedule)
    watcher.on('change', schedule)
    watcher.on('unlink', (filePath) => { this.run('UPDATE material_index_state SET availability=?, last_seen_at=? WHERE source_id=? AND material_id IN (SELECT id FROM materials WHERE source_path=?)', ['unavailable', now(), sourceId, filePath]) })
    this.folderWatchers.set(sourceId, watcher)
  }

  private stopFolderWatcher(sourceId: string): void { const watcher = this.folderWatchers.get(sourceId); if (watcher) { void watcher.close(); this.folderWatchers.delete(sourceId) } }

  private startFolderWatchers(): void { for (const source of this.listFolderSources()) if (source.enabled && source.watchEnabled) this.watchFolderSource(source.id) }

  listMaterialChunks(materialId: string): MaterialChunk[] { return this.query('SELECT * FROM material_chunks WHERE material_id=? ORDER BY ordinal', [materialId]).map((row) => ({ id: String(row.id), materialId: String(row.material_id), ordinal: Number(row.ordinal), text: String(row.text), startOffset: Number(row.start_offset), endOffset: Number(row.end_offset), pageNumber: row.page_number === null ? null : Number(row.page_number), heading: row.heading as string | null, hash: String(row.hash), indexedAt: String(row.indexed_at) })) }

  listTopicProposals(topicId: string, status: TopicProposal['status'] = 'pending'): TopicProposal[] {
    return this.query('SELECT * FROM topic_proposals WHERE topic_id=? AND status=? ORDER BY created_at DESC', [topicId, status]).map((row) => {
      let payload: Record<string, unknown> = {}; try { payload = JSON.parse(String(row.payload ?? '{}')) } catch { /* tolerate malformed legacy payloads */ }
      return { id: String(row.id), topicId: String(row.topic_id), kind: String(row.kind), reason: String(row.reason), evidence: String(row.evidence), materialId: row.material_id as string | null, relationId: row.relation_id as string | null, payload, status: row.status as TopicProposal['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
    })
  }

  createTopicProposals(topicId: string, proposals: Array<Omit<TopicProposal, 'id' | 'topicId' | 'status' | 'createdAt' | 'updatedAt'>>): TopicProposal[] {
    const created = now()
    for (const proposal of proposals) this.run('INSERT INTO topic_proposals (id, topic_id, kind, reason, evidence, material_id, relation_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id(), topicId, proposal.kind, proposal.reason, proposal.evidence, proposal.materialId ?? null, proposal.relationId ?? null, JSON.stringify(proposal.payload ?? {}), 'pending', created, created])
    return this.listTopicProposals(topicId)
  }

  updateTopicProposalStatus(proposalId: string, status: TopicProposal['status']): TopicProposal | null {
    this.run('UPDATE topic_proposals SET status=?, updated_at=? WHERE id=?', [status, now(), proposalId])
    const row = first<SqlRow>(this.query('SELECT * FROM topic_proposals WHERE id=?', [proposalId])); if (!row) return null
    return this.listTopicProposals(String(row.topic_id), status)[0] ?? null
  }

  searchKnowledge(query: string, options: { limit?: number; sourceId?: string } = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30)); const terms = tokenize(query); if (!terms.length) return []
    const rows = this.ftsEnabled
      ? this.query(`SELECT c.id AS chunkId, c.material_id AS materialId, m.title, c.text, c.heading, c.page_number AS pageNumber, m.source_path AS sourcePath, COALESCE(mis.availability, 'available') AS availability FROM material_chunks_fts f JOIN material_chunks c ON c.id=f.chunk_id JOIN materials m ON m.id=c.material_id LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE f.material_chunks_fts MATCH ? ${options.sourceId ? 'AND mis.source_id=?' : ''} ORDER BY bm25(material_chunks_fts) LIMIT ?`, [terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR '), ...(options.sourceId ? [options.sourceId] : []), limit])
      : this.query(`SELECT c.id AS chunkId, c.material_id AS materialId, m.title, c.text, c.heading, c.page_number AS pageNumber, m.source_path AS sourcePath, COALESCE(mis.availability, 'available') AS availability FROM material_chunks c JOIN materials m ON m.id=c.material_id LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE (${terms.map(() => 'c.text LIKE ?').join(' OR ')}) ${options.sourceId ? 'AND mis.source_id=?' : ''} ORDER BY c.ordinal LIMIT ?`, [...terms.map((term) => `%${term}%`), ...(options.sourceId ? [options.sourceId] : []), limit])
    const fallbackRows = rows.length ? rows : this.query(`SELECT m.id AS materialId, m.title, COALESCE(m.excerpt, m.extracted_text, '') AS text, m.source_path AS sourcePath, COALESCE(mis.availability, 'available') AS availability FROM materials m LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE (${terms.map(() => 'm.title LIKE ? OR m.extracted_text LIKE ? OR m.excerpt LIKE ?').join(' OR ')}) ${options.sourceId ? 'AND mis.source_id=?' : ''} ORDER BY m.imported_at DESC LIMIT ?`, [...terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]), ...(options.sourceId ? [options.sourceId] : []), limit])
    return fallbackRows.map((row, index) => ({ materialId: String(row.materialId), chunkId: String(row.chunkId ?? `material:${row.materialId}`), title: String(row.title), text: String(row.text), score: 1 / (index + 1), sourcePath: row.sourcePath as string | null, pageNumber: row.pageNumber === null || row.pageNumber === undefined ? null : Number(row.pageNumber), heading: row.heading as string | null ?? null, availability: (row.availability as SearchHit['availability']) ?? 'available' }))
  }
  search(query: string): Material[] { return this.query('SELECT m.*, mis.availability AS availability, mis.last_indexed_at AS lastIndexedAt FROM materials m LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE m.title LIKE ? OR m.extracted_text LIKE ? OR m.excerpt LIKE ? ORDER BY m.imported_at DESC', [`%${query}%`, `%${query}%`, `%${query}%`]).map(asMaterial) }
  getSettings(): ModelSettings { const settings = first<{ value: string }>(this.query('SELECT value FROM settings WHERE key=?', ['model'])); return settings ? JSON.parse(settings.value) : { profileId: null, provider: 'ollama', baseUrl: 'http://localhost:11434', chatModel: '', embeddingModel: '', allowCloud: false, enabled: false } }
  saveSettings(settings: ModelSettings): void { this.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', ['model', JSON.stringify(settings)]) }
  async exportPackage(destination: string): Promise<void> { await new Promise<void>((resolve, reject) => { const stream = createWriteStream(destination); const archive = new ZipArchive({ zlib: { level: 8 } }); stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); archive.pipe(stream); archive.directory(this.root, false); void archive.finalize() }) }
  async inspectPackage(packagePath: string): Promise<{ name: string; encrypted: boolean }> {
    const archive = await unzipper.Open.file(packagePath)
    const config = archive.files.find((file) => file.path === 'workspace.json')
    if (!config) throw new Error('工作区包缺少 workspace.json。')
    const parsed = JSON.parse((await config.buffer()).toString('utf8')) as WorkspaceConfig
    return { name: String(parsed.name ?? '未命名工作区'), encrypted: Boolean(parsed.encrypted) }
  }
  async importPackage(packagePath: string, destination: string, password?: string): Promise<WorkspaceSummary> { mkdirSync(destination, { recursive: true }); await (await unzipper.Open.file(packagePath)).extract({ path: destination }); return this.open(destination, password) }
}
