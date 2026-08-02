import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { decrypt, deriveKey, encrypt, createSalt } from './crypto'
import { extractFile, fetchLinkMetadata, type ExtractedMaterial } from './parsers'
import { chunkHash, chunkText, tokenize } from './indexer'
import { detectVectorCapability, type VectorCapability } from './db/vector-capability'
import { VectorStore } from './db/vector-store'
import { NativeDatabase } from './db/native-database'
import { stableTopicOrder, topologyPositions } from '../shared/topic-topology'
import type { AnalysisStatus, FolderSource, Job, Material, MaterialAnalysisCard, MaterialChunk, ModelSettings, Relation, SearchHit, Topic, TopicAnalysisRun, TopicRelationCandidate, TopicMap, TopicProposal, WorkspaceSummary, Workstream } from './types'

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
function asRelation(row: SqlRow): Relation { return { ...row, id: String(row.id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), label: String(row.label), relationType: String(row.relation_type), evidenceText: row.evidence_text as string | null, evidenceMaterialId: row.evidence_material_id as string | null, confidence: row.confidence as number | null, createdBy: row.created_by as Relation['createdBy'], createdAt: String(row.created_at), lineColor: row.lineColor as string | null, sourceArrow: Boolean(row.sourceArrow), sourceArrowStyle: (row.sourceArrowStyle as Relation['sourceArrowStyle']) ?? (row.sourceArrow ? 'triangle' : 'none'), targetArrowStyle: (row.targetArrowStyle as Relation['targetArrowStyle']) ?? 'triangle', animated: row.animated === undefined || row.animated === null ? true : Boolean(row.animated), archived: Boolean(row.archived), branchIndex: Number(row.branchIndex ?? 0), lineKind: (row.lineKind as Relation['lineKind']) ?? 'auto' } }
function normalizeColor(value: string | null | undefined): string | null { return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null }
function normalizeTags(tags: string[]): string[] { return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 32)))].slice(0, 12) }

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

  close(): void {
    for (const sourceId of this.folderWatchers.keys()) this.stopFolderWatcher(sourceId)
    for (const timer of this.pendingFolderEvents.values()) clearTimeout(timer)
    this.pendingFolderEvents.clear()
    this.vectorStore?.close(); this.vectorStore = null
    this.db?.close(); if (this.dbTempPath) NativeDatabase.removeIfPresent(this.dbTempPath); this.db = null; this.dbTempPath = null; this.root = ''; this.config = null; this.key = null
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
    const data = Buffer.from(this.requireDb().export())
    writeFileSync(this.dbPath(), this.config?.encrypted ? encrypt(data, this.key!) : data)
  }
  private initializeSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, mime_type TEXT, source_path TEXT, stored_path TEXT, url TEXT, site_name TEXT, excerpt TEXT, extracted_text TEXT, imported_at TEXT NOT NULL, occurred_at TEXT, occurred_at_source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, hash TEXT);
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, archived_at TEXT, color TEXT, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS topic_materials (topic_id TEXT NOT NULL, material_id TEXT NOT NULL, workstream_id TEXT, canvas_x REAL, canvas_y REAL, position_source TEXT NOT NULL DEFAULT 'auto', card_color TEXT, card_tags TEXT, card_note TEXT, sequence INTEGER, sequence_source TEXT NOT NULL DEFAULT 'time', added_at TEXT, PRIMARY KEY(topic_id, material_id));
      CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, label TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_text TEXT, evidence_material_id TEXT, confidence REAL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, topic_id TEXT);
      CREATE TABLE IF NOT EXISTS topic_relation_styles (topic_id TEXT NOT NULL, relation_id TEXT NOT NULL, line_color TEXT, source_arrow INTEGER NOT NULL DEFAULT 0, source_arrow_style TEXT NOT NULL DEFAULT 'none', target_arrow_style TEXT NOT NULL DEFAULT 'triangle', animated INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, branch_index INTEGER NOT NULL DEFAULT 0, line_kind TEXT NOT NULL DEFAULT 'auto', PRIMARY KEY(topic_id, relation_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folder_sources (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, include_patterns TEXT NOT NULL DEFAULT '[]', exclude_patterns TEXT NOT NULL DEFAULT '[]', watch_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_index_state (material_id TEXT PRIMARY KEY, source_id TEXT, availability TEXT NOT NULL DEFAULT 'available', last_indexed_at TEXT, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS material_chunks (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, page_number INTEGER, heading TEXT, hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_proposals (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, material_id TEXT, relation_id TEXT, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_analysis_cards (material_id TEXT NOT NULL, content_hash TEXT NOT NULL, model_id TEXT NOT NULL, title TEXT NOT NULL, date TEXT, headings TEXT NOT NULL, keywords TEXT NOT NULL, evidence_chunk_ids TEXT NOT NULL, summary TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY(material_id, content_hash, model_id));
      CREATE TABLE IF NOT EXISTS topic_analysis_runs (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, topic_revision INTEGER NOT NULL, stage TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, added_relations INTEGER NOT NULL DEFAULT 0, rejected_candidates INTEGER NOT NULL DEFAULT 0, error TEXT, summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    this.close()
    const config = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')) as WorkspaceConfig
    this.root = root; this.config = config; this.key = config.encrypted ? deriveKey(password ?? '', config.salt!) : null
    const file = this.dbPath(); const raw = existsSync(file) ? readFileSync(file) : undefined
    if (config.encrypted && !password) throw new Error('This workspace requires its password.')
    if (config.encrypted) { this.dbTempPath = join(root, `.workspace-${id()}.sqlite`); this.db = NativeDatabase.fromBytes(this.dbTempPath, raw ? decrypt(raw, this.key!) : undefined) }
    else this.db = new NativeDatabase(file)
    this.initializeSchema(); this.repairFileTitles(); this.rebuildExistingSystemTopologies(); this.recoverProcessingJobs(); this.backfillMaterialChunks(); this.setupVectorStore(); this.startFolderWatchers(); return this.summary()
  }
  summary(): WorkspaceSummary { if (!this.config) throw new Error('No workspace open.'); return { id: this.config.id, name: this.config.name, root: this.root, encrypted: this.config.encrypted } }
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
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'note', title || 'Untitled note', 'text/plain', null, null, null, null, text.slice(0, 500), text, date, date, 'import', 'complete', null, null])
    this.indexMaterialChunks(materialId, text)
    return this.getMaterial(materialId)!
  }
  async createDocument(title: string, text: string, format: 'md' | 'txt' | 'csv' | 'json' | 'html'): Promise<Material> {
    const extension = `.${format}`; const materialId = id(); const date = now(); const storedName = `${materialId}${extension}`
    const mimeType = ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html' } as const)[format]
    const content = text || ''
    writeFileSync(join(this.materialsPath(), storedName), this.config?.encrypted ? encrypt(Buffer.from(content, 'utf8'), this.key!) : content, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'document', title || `Untitled ${format}`, mimeType, null, storedName, null, null, content.slice(0, 500), content, date, date, 'import', 'complete', null, hash])
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
    this.run('UPDATE materials SET title=?, excerpt=?, extracted_text=?, hash=?, status=?, error=? WHERE id=?', [title || material.title, text.slice(0, 500), text, createHash('sha256').update(text).digest('hex'), 'complete', null, material.id])
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
        this.run('UPDATE materials SET title=?, mime_type=?, excerpt=?, extracted_text=?, occurred_at=?, occurred_at_source=?, status=? WHERE id=?', [originalTitle, extracted.mimeType, extracted.text.slice(0, 500), extracted.text, material.occurredAtSource === 'manual' ? material.occurredAt : material.importedAt, material.occurredAtSource === 'manual' ? 'manual' : 'import', 'complete', materialId])
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
    this.requireDb().run('DELETE FROM workstreams WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=?', [topicId])
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
    this.requireDb().run('DELETE FROM workstreams WHERE topic_id=?', [topicId])
    this.requireDb().run('DELETE FROM topic_materials WHERE topic_id=?', [topicId])
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
  updateRelationStyle(topicId: string, relationId: string, input: { color?: string | null; sourceArrow?: boolean; sourceArrowStyle?: Relation['sourceArrowStyle']; targetArrowStyle?: Relation['targetArrowStyle']; animated?: boolean; archived?: boolean; lineKind?: Relation['lineKind'] }): void {
    const color = input.color === undefined ? undefined : normalizeColor(input.color)
    if (input.color !== undefined && input.color !== null && !color) throw new Error('Line color must be a six-digit hexadecimal value.')
    if (input.lineKind && !['auto', 'straight', 'bezier', 'orthogonal'].includes(input.lineKind)) throw new Error('Unsupported line kind.')
    if (!this.query('SELECT id FROM relations WHERE id=?', [relationId])[0]) throw new Error('Relationship not found.')
    const allowedArrows = ['none', 'triangle', 'open-triangle', 'diamond']
    if (input.sourceArrowStyle && !allowedArrows.includes(input.sourceArrowStyle)) throw new Error('Unsupported source arrow style.')
    if (input.targetArrowStyle && !allowedArrows.includes(input.targetArrowStyle)) throw new Error('Unsupported target arrow style.')
    const current = this.query('SELECT line_color, source_arrow, source_arrow_style, target_arrow_style, animated, archived, branch_index, line_kind FROM topic_relation_styles WHERE topic_id=? AND relation_id=?', [topicId, relationId])[0]
    const sourceArrowStyle = input.sourceArrowStyle ?? (input.sourceArrow === undefined ? current?.source_arrow_style ?? (Number(current?.source_arrow ?? 0) ? 'triangle' : 'none') : input.sourceArrow ? 'triangle' : 'none')
    this.run('INSERT OR REPLACE INTO topic_relation_styles (topic_id, relation_id, line_color, source_arrow, source_arrow_style, target_arrow_style, animated, archived, branch_index, line_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [topicId, relationId, color === undefined ? current?.line_color ?? null : color, sourceArrowStyle === 'none' ? 0 : 1, sourceArrowStyle, input.targetArrowStyle ?? current?.target_arrow_style ?? 'triangle', input.animated === undefined ? Number(current?.animated ?? 1) : input.animated ? 1 : 0, input.archived === undefined ? Number(current?.archived ?? 0) : input.archived ? 1 : 0, Number(current?.branch_index ?? 0), input.lineKind ?? current?.line_kind ?? 'auto'])
  }
  rebuildSystemTopology(topicId: string): void {
    const map = this.topicMap(topicId)
    const ordered = stableTopicOrder(map.materials)
    const manualDirections = new Set(map.relations.filter((relation) => relation.createdBy === 'manual').map((relation) => `${relation.sourceMaterialId}:${relation.targetMaterialId}`))
    const positions = topologyPositions(ordered)
    this.requireDb().exec('BEGIN')
    try {
      this.requireDb().run("DELETE FROM relations WHERE created_by='system' AND topic_id=?", [topicId])
      for (let index = 1; index < ordered.length; index += 1) {
        const source = ordered[index - 1]; const target = ordered[index]
        if (manualDirections.has(`${source.id}:${target.id}`)) continue
        this.requireDb().run('INSERT INTO relations (id, source_material_id, target_material_id, label, relation_type, evidence_text, evidence_material_id, confidence, created_by, created_at, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id(), source.id, target.id, '\u4e0b\u4e00\u6b65', 'next', '\u7531\u4e3b\u9898\u4e2d\u7684\u786e\u5b9a\u987a\u5e8f\u81ea\u52a8\u751f\u6210\u3002', source.id, 1, 'system', now(), topicId])
      }
      for (const position of positions) this.requireDb().run("UPDATE topic_materials SET canvas_x=?, canvas_y=? WHERE topic_id=? AND material_id=? AND position_source <> 'manual'", [position.x, position.y, topicId, position.materialId])
      this.bumpTopicRevision(topicId)
      this.requireDb().exec('COMMIT')
      this.persist()
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
  hasConnection(sourceMaterialId: string, targetMaterialId: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? LIMIT 1', [sourceMaterialId, targetMaterialId]).length > 0 }
  hasRelation(sourceMaterialId: string, targetMaterialId: string, label: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND label=? LIMIT 1', [sourceMaterialId, targetMaterialId, label]).length > 0 }
  updateRelation(id: string, label: string): void { this.run('UPDATE relations SET label=? WHERE id=?', [label, id]) }
  deleteRelation(id: string): void { this.run('DELETE FROM relations WHERE id=?', [id]) }
  topicMap(topicId: string): TopicMap {
    const topic = first<Topic>(this.query('SELECT * FROM topics WHERE id=?', [topicId])); if (!topic) throw new Error('Topic not found')
    const materials = this.query('SELECT m.*, mis.availability AS availability, mis.last_indexed_at AS lastIndexedAt, tm.workstream_id AS workstreamId, tm.canvas_x AS canvasX, tm.canvas_y AS canvasY, tm.position_source AS positionSource, tm.card_color AS cardColor, tm.card_tags AS cardTags, tm.card_note AS cardNote, tm.sequence AS sequence, tm.sequence_source AS sequenceSource, tm.added_at AS addedAt FROM materials m JOIN topic_materials tm ON tm.material_id=m.id LEFT JOIN material_index_state mis ON mis.material_id=m.id WHERE tm.topic_id=? ORDER BY m.occurred_at', [topicId]).map((row) => { let cardTags: string[] = []; try { const value = JSON.parse(String(row.cardTags ?? '[]')); if (Array.isArray(value)) cardTags = value.filter((tag): tag is string => typeof tag === 'string') } catch { /* Old or invalid rows use empty tags. */ } return { ...asMaterial(row), workstreamId: row.workstreamId as string | null, canvasX: row.canvasX as number | null, canvasY: row.canvasY as number | null, positionSource: row.positionSource === 'manual' ? 'manual' as const : 'auto' as const, cardColor: row.cardColor as string | null, cardTags, cardNote: row.cardNote as string | null, sequence: row.sequence as number | null, sequenceSource: String(row.sequenceSource ?? 'time'), addedAt: row.addedAt as string | null } })
    const ids = materials.map((m) => m.id); const placeholders = ids.map(() => '?').join(',') || "''"
    return { topic, materials, workstreams: this.query('SELECT * FROM workstreams WHERE topic_id=? ORDER BY position', [topicId]).map(asWorkstream), relations: this.query(`SELECT r.*, trs.line_color AS lineColor, trs.source_arrow AS sourceArrow, trs.source_arrow_style AS sourceArrowStyle, trs.target_arrow_style AS targetArrowStyle, trs.animated AS animated, trs.archived AS archived, trs.branch_index AS branchIndex, trs.line_kind AS lineKind FROM relations r LEFT JOIN topic_relation_styles trs ON trs.relation_id=r.id AND trs.topic_id=? WHERE r.source_material_id IN (${placeholders}) AND r.target_material_id IN (${placeholders}) AND (r.topic_id IS NULL OR r.topic_id=?)`, [topicId, ...ids, ...ids, topicId]).map(asRelation) }
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
    this.persist()
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
  async importPackage(packagePath: string, destination: string): Promise<WorkspaceSummary> { mkdirSync(destination, { recursive: true }); await (await unzipper.Open.file(packagePath)).extract({ path: destination }); return this.open(destination) }
}
