import initSqlJs, { type Database } from 'sql.js'
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { decrypt, deriveKey, encrypt, createSalt } from './crypto'
import { extractFile, fetchLinkMetadata } from './parsers'
import type { AnalysisStatus, Job, Material, ModelSettings, Relation, Topic, TopicMap, WorkspaceSummary, Workstream } from './types'

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
    status: row.status as Material['status'], error: row.error as string | null, hash: row.hash as string | null
  }
}
const topicPalette = ['#08776f', '#3568b8', '#a14569', '#b26a21', '#7654a6', '#3c7d66']
function topicColor(id: string): string { return topicPalette[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % topicPalette.length] }
function asTopic(row: SqlRow): Topic { return { ...row, id: String(row.id), name: String(row.name), description: row.description as string | null, createdAt: String(row.created_at), archivedAt: row.archived_at as string | null, color: String(row.color ?? topicColor(String(row.id))) } }
function asWorkstream(row: SqlRow): Workstream { return { ...row, id: String(row.id), topicId: String(row.topic_id), name: String(row.name), position: Number(row.position), source: row.source as Workstream['source'] } }
function asRelation(row: SqlRow): Relation { return { ...row, id: String(row.id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), label: String(row.label), relationType: String(row.relation_type), evidenceText: row.evidence_text as string | null, evidenceMaterialId: row.evidence_material_id as string | null, confidence: row.confidence as number | null, createdBy: row.created_by as Relation['createdBy'], createdAt: String(row.created_at), lineColor: row.lineColor as string | null, sourceArrow: Boolean(row.sourceArrow), sourceArrowStyle: (row.sourceArrowStyle as Relation['sourceArrowStyle']) ?? (row.sourceArrow ? 'triangle' : 'none'), targetArrowStyle: (row.targetArrowStyle as Relation['targetArrowStyle']) ?? 'triangle', animated: row.animated === undefined || row.animated === null ? true : Boolean(row.animated), archived: Boolean(row.archived), branchIndex: Number(row.branchIndex ?? 0), lineKind: (row.lineKind as Relation['lineKind']) ?? 'auto' } }
function normalizeColor(value: string | null | undefined): string | null { return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null }
function normalizeTags(tags: string[]): string[] { return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 32)))].slice(0, 12) }

export class WorkspaceService {
  private SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
  private db: Database | null = null
  private root = ''
  private config: WorkspaceConfig | null = null
  private key: Buffer | null = null
  private processingTail: Promise<void> = Promise.resolve()

  private async sql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
    if (!this.SQL) this.SQL = await initSqlJs({ locateFile: (file: string) => join(dirname(require.resolve('sql.js/dist/sql-wasm.wasm')), file) })
    return this.SQL
  }
  private requireDb(): Database { if (!this.db) throw new Error('Open or create a workspace first.'); return this.db }
  private query(sql: string, params: unknown[] = []): SqlRow[] {
    const statement = this.requireDb().prepare(sql); statement.bind(params as never[]); const rows: SqlRow[] = []
    while (statement.step()) rows.push(statement.getAsObject())
    statement.free(); return rows
  }
  private run(sql: string, params: unknown[] = []): void { this.requireDb().run(sql, params as never[]); this.persist() }
  private configPath(): string { return join(this.root, 'workspace.json') }
  private dbPath(): string { return join(this.root, this.config?.encrypted ? 'workspace.sqlite.enc' : 'workspace.sqlite') }
  private materialsPath(): string { return join(this.root, 'materials') }
  private persist(): void {
    const data = Buffer.from(this.requireDb().export())
    writeFileSync(this.dbPath(), this.config?.encrypted ? encrypt(data, this.key!) : data)
  }
  private initializeSchema(): void {
    this.requireDb().run(`
      CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, mime_type TEXT, source_path TEXT, stored_path TEXT, url TEXT, site_name TEXT, excerpt TEXT, extracted_text TEXT, imported_at TEXT NOT NULL, occurred_at TEXT, occurred_at_source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, hash TEXT);
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, archived_at TEXT, color TEXT);
      CREATE TABLE IF NOT EXISTS topic_materials (topic_id TEXT NOT NULL, material_id TEXT NOT NULL, workstream_id TEXT, canvas_x REAL, canvas_y REAL, card_color TEXT, card_tags TEXT, card_note TEXT, sequence INTEGER, sequence_source TEXT NOT NULL DEFAULT 'time', added_at TEXT, PRIMARY KEY(topic_id, material_id));
      CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, label TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_text TEXT, evidence_material_id TEXT, confidence REAL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_relation_styles (topic_id TEXT NOT NULL, relation_id TEXT NOT NULL, line_color TEXT, source_arrow INTEGER NOT NULL DEFAULT 0, source_arrow_style TEXT NOT NULL DEFAULT 'none', target_arrow_style TEXT NOT NULL DEFAULT 'triangle', animated INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, branch_index INTEGER NOT NULL DEFAULT 0, line_kind TEXT NOT NULL DEFAULT 'auto', PRIMARY KEY(topic_id, relation_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const topicTableColumns = this.query('PRAGMA table_info(topics)').map((row) => String(row.name))
    if (!topicTableColumns.includes('archived_at')) this.requireDb().run('ALTER TABLE topics ADD COLUMN archived_at TEXT')
    if (!topicTableColumns.includes('color')) this.requireDb().run('ALTER TABLE topics ADD COLUMN color TEXT')
    for (const topic of this.query('SELECT id FROM topics WHERE color IS NULL OR color=""')) this.requireDb().run('UPDATE topics SET color=? WHERE id=?', [topicColor(String(topic.id)), String(topic.id)])
    const topicColumns = this.query('PRAGMA table_info(topic_materials)').map((row) => String(row.name))
    if (!topicColumns.includes('canvas_x')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN canvas_x REAL')
    if (!topicColumns.includes('canvas_y')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN canvas_y REAL')
    if (!topicColumns.includes('card_color')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_color TEXT')
    if (!topicColumns.includes('card_tags')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_tags TEXT')
    if (!topicColumns.includes('card_note')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN card_note TEXT')
    if (!topicColumns.includes('sequence')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN sequence INTEGER')
    if (!topicColumns.includes('sequence_source')) this.requireDb().run("ALTER TABLE topic_materials ADD COLUMN sequence_source TEXT NOT NULL DEFAULT 'time'")
    if (!topicColumns.includes('added_at')) this.requireDb().run('ALTER TABLE topic_materials ADD COLUMN added_at TEXT')
    this.requireDb().run('UPDATE topic_materials SET added_at=COALESCE(added_at, ?) WHERE added_at IS NULL', [now()])
    const relationStyleColumns = this.query('PRAGMA table_info(topic_relation_styles)').map((row) => String(row.name))
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
    mkdirSync(root, { recursive: true }); mkdirSync(join(root, 'materials'), { recursive: true })
    const config: WorkspaceConfig = { id: id(), name, encrypted: Boolean(password), salt: password ? createSalt() : undefined }
    writeFileSync(join(root, 'workspace.json'), JSON.stringify(config, null, 2))
    this.root = root; this.config = config; this.key = password ? deriveKey(password, config.salt!) : null
    const SQL = await this.sql(); this.db = new SQL.Database(); this.initializeSchema()
    return this.summary()
  }
  async open(root: string, password?: string): Promise<WorkspaceSummary> {
    const config = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')) as WorkspaceConfig
    this.root = root; this.config = config; this.key = config.encrypted ? deriveKey(password ?? '', config.salt!) : null
    const SQL = await this.sql(); const file = this.dbPath(); const raw = existsSync(file) ? readFileSync(file) : undefined
    if (config.encrypted && !password) throw new Error('This workspace requires its password.')
    this.db = raw ? new SQL.Database(config.encrypted ? decrypt(raw, this.key!) : raw) : new SQL.Database()
    this.initializeSchema(); this.repairFileTitles(); return this.summary()
  }
  summary(): WorkspaceSummary { if (!this.config) throw new Error('No workspace open.'); return { id: this.config.id, name: this.config.name, root: this.root, encrypted: this.config.encrypted } }
  listMaterials(): Material[] { return this.query('SELECT * FROM materials ORDER BY imported_at DESC').map(asMaterial) }
  getMaterial(materialId: string): Material | null { const row = first<SqlRow>(this.query('SELECT * FROM materials WHERE id = ?', [materialId])); return row ? asMaterial(row) : null }
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
    return this.getMaterial(materialId)!
  }
  async createDocument(title: string, text: string, format: 'md' | 'txt' | 'csv' | 'json' | 'html'): Promise<Material> {
    const extension = `.${format}`; const materialId = id(); const date = now(); const storedName = `${materialId}${extension}`
    const mimeType = ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html' } as const)[format]
    const content = text || ''
    writeFileSync(join(this.materialsPath(), storedName), this.config?.encrypted ? encrypt(Buffer.from(content, 'utf8'), this.key!) : content, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'document', title || `Untitled ${format}`, mimeType, null, storedName, null, null, content.slice(0, 500), content, date, date, 'import', 'complete', null, hash])
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
        const storedFile = join(this.materialsPath(), material.storedPath!)
        const extracted = await extractFile(storedFile, this.config?.encrypted ? decrypt(readFileSync(storedFile), this.key!) : undefined)
        const originalTitle = material.sourcePath ? basename(material.sourcePath, extname(material.sourcePath)) : material.title
        this.run('UPDATE materials SET title=?, mime_type=?, excerpt=?, extracted_text=?, occurred_at=?, occurred_at_source=?, status=? WHERE id=?', [originalTitle, extracted.mimeType, extracted.text.slice(0, 500), extracted.text, material.occurredAtSource === 'manual' ? material.occurredAt : material.importedAt, material.occurredAtSource === 'manual' ? 'manual' : 'import', 'complete', materialId])
      } else if (material.type === 'link') {
        const metadata = await fetchLinkMetadata(material.url!)
        this.run('UPDATE materials SET title=?, site_name=?, excerpt=?, extracted_text=?, status=? WHERE id=?', [metadata.title, metadata.siteName, metadata.excerpt, `${metadata.title}\n${metadata.excerpt}\n${material.url}`, 'complete', materialId])
      }
      this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE material_id=? AND status != ?', ['complete', null, now(), materialId, 'complete'])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error'
      this.run('UPDATE materials SET status=?, error=? WHERE id=?', ['failed', message, materialId])
      this.run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE material_id=? AND status != ?', ['failed', message, now(), materialId, 'complete'])
    }
  }
  retry(materialId: string): void { void this.enqueueProcessing(materialId) }
  updateMaterialDate(id: string, occurredAt: string): void { this.run('UPDATE materials SET occurred_at=?, occurred_at_source=? WHERE id=?', [occurredAt, 'manual', id]) }
  createTopic(name: string, description = ''): Topic { const topicId = id(); const topic = { id: topicId, name, description: description || null, createdAt: now(), archivedAt: null, color: topicColor(topicId) }; this.run('INSERT INTO topics (id, name, description, created_at, archived_at, color) VALUES (?, ?, ?, ?, ?, ?)', [topic.id, topic.name, topic.description, topic.createdAt, null, topic.color]); return topic }
  listTopics(): Topic[] { return this.query('SELECT * FROM topics WHERE archived_at IS NULL ORDER BY created_at DESC').map(asTopic) }
  listArchivedTopics(): Topic[] { return this.query('SELECT * FROM topics WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').map(asTopic) }
  archiveTopic(topicId: string): void { this.run('UPDATE topics SET archived_at=? WHERE id=? AND archived_at IS NULL', [now(), topicId]) }
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
  addToTopic(topicId: string, materialId: string, workstreamId?: string): void { const current = this.query('SELECT sequence, sequence_source FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId])[0]; if (current) { if (workstreamId !== undefined) this.run('UPDATE topic_materials SET workstream_id=? WHERE topic_id=? AND material_id=?', [workstreamId, topicId, materialId]); return }; const next = Number(this.query('SELECT COALESCE(MAX(sequence), 0) AS max FROM topic_materials WHERE topic_id=?', [topicId])[0]?.max ?? 0) + 1; const last = String(this.query('SELECT MAX(added_at) AS value FROM topic_materials WHERE material_id=?', [materialId])[0]?.value ?? ''); const addedAt = new Date(Math.max(Date.now(), Number.isNaN(Date.parse(last)) ? 0 : Date.parse(last) + 1)).toISOString(); this.run('INSERT INTO topic_materials (topic_id, material_id, workstream_id, sequence, sequence_source, added_at) VALUES (?, ?, ?, ?, ?, ?)', [topicId, materialId, workstreamId ?? null, next, 'time', addedAt]) }
  addMaterialsToTopic(topicId: string, materialIds: string[]): void { for (const materialId of [...new Set(materialIds)]) this.addToTopic(topicId, materialId) }
  topicsForMaterial(materialId: string): Topic[] { return this.query('SELECT DISTINCT t.* FROM topics t JOIN topic_materials tm ON tm.topic_id=t.id WHERE tm.material_id=? AND t.archived_at IS NULL ORDER BY tm.added_at DESC, t.created_at DESC', [materialId]).map(asTopic) }
  listMaterialsWithTopics(): Array<Material & { topics: Array<{ id: string; name: string; color: string; cardColor: string | null; addedAt: string }> }> {
    return this.listMaterials().map((material) => ({ ...material, topics: this.query('SELECT t.id, t.name, t.color, tm.card_color AS cardColor, tm.added_at AS addedAt FROM topic_materials tm JOIN topics t ON t.id=tm.topic_id WHERE tm.material_id=? AND t.archived_at IS NULL ORDER BY tm.added_at DESC, t.created_at DESC', [material.id]).map((row) => ({ id: String(row.id), name: String(row.name), color: String(row.color ?? topicColor(String(row.id))), cardColor: row.cardColor as string | null, addedAt: String(row.addedAt) })) }))
  }
  updateCardOrder(topicId: string, materialId: string, sequence: number): void { if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Sequence must be a positive integer.'); this.run("UPDATE topic_materials SET sequence=?, sequence_source='manual' WHERE topic_id=? AND material_id=?", [sequence, topicId, materialId]) }
  resetCardOrder(topicId: string): void { this.run("UPDATE topic_materials SET sequence=NULL, sequence_source='time' WHERE topic_id=?", [topicId]) }
  removeFromTopic(topicId: string, materialId: string): void { this.run('DELETE FROM topic_materials WHERE topic_id=? AND material_id=?', [topicId, materialId]) }
  createWorkstream(topicId: string, name: string, source: 'ai' | 'manual' = 'manual'): Workstream { const position = this.query('SELECT COUNT(*) AS count FROM workstreams WHERE topic_id=?', [topicId])[0]?.count as number ?? 0; const stream = { id: id(), topicId, name, position: Number(position), source }; this.run('INSERT INTO workstreams VALUES (?, ?, ?, ?, ?)', [stream.id, stream.topicId, stream.name, stream.position, stream.source]); return stream }
  updateWorkstream(id: string, name: string): void { this.run('UPDATE workstreams SET name=? WHERE id=?', [name, id]) }
  deleteWorkstream(id: string): void {
    // Relations belong to materials, so deleting a lane only clears its grouping.
    this.run('UPDATE topic_materials SET workstream_id=NULL WHERE workstream_id=?', [id])
    this.run('DELETE FROM workstreams WHERE id=?', [id])
  }
  moveMaterial(topicId: string, materialId: string, workstreamId: string | null): void { this.run('UPDATE topic_materials SET workstream_id=? WHERE topic_id=? AND material_id=?', [workstreamId, topicId, materialId]) }
  positionMaterial(topicId: string, materialId: string, x: number, y: number): void { this.run('UPDATE topic_materials SET canvas_x=?, canvas_y=? WHERE topic_id=? AND material_id=?', [x, y, topicId, materialId]) }
  positionMaterials(topicId: string, positions: Array<{ materialId: string; x: number; y: number }>): void { for (const position of positions) this.requireDb().run('UPDATE topic_materials SET canvas_x=?, canvas_y=? WHERE topic_id=? AND material_id=?', [position.x, position.y, topicId, position.materialId]); this.persist() }
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
  createRelation(input: Omit<Relation, 'id' | 'createdAt'>): Relation {
    if (input.sourceMaterialId === input.targetMaterialId) throw new Error('A material cannot be related to itself.')
    // AI suggestions are an independent review layer. A user must be able to
    // formalize the same direction without first deleting the suggestion.
    const duplicate = this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND created_by=? LIMIT 1', [input.sourceMaterialId, input.targetMaterialId, input.createdBy])[0]
    if (duplicate) throw new Error('This relationship already exists.')
    const relation = { id: id(), ...input, createdAt: now() }; this.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, relation.sourceMaterialId, relation.targetMaterialId, relation.label, relation.relationType, relation.evidenceText, relation.evidenceMaterialId, relation.confidence, relation.createdBy, relation.createdAt]); return relation
  }
  hasConnection(sourceMaterialId: string, targetMaterialId: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? LIMIT 1', [sourceMaterialId, targetMaterialId]).length > 0 }
  hasRelation(sourceMaterialId: string, targetMaterialId: string, label: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND label=? LIMIT 1', [sourceMaterialId, targetMaterialId, label]).length > 0 }
  updateRelation(id: string, label: string): void { this.run('UPDATE relations SET label=? WHERE id=?', [label, id]) }
  deleteRelation(id: string): void { this.run('DELETE FROM relations WHERE id=?', [id]) }
  topicMap(topicId: string): TopicMap {
    const topic = first<Topic>(this.query('SELECT * FROM topics WHERE id=?', [topicId])); if (!topic) throw new Error('Topic not found')
    const materials = this.query('SELECT m.*, tm.workstream_id AS workstreamId, tm.canvas_x AS canvasX, tm.canvas_y AS canvasY, tm.card_color AS cardColor, tm.card_tags AS cardTags, tm.card_note AS cardNote, tm.sequence AS sequence, tm.sequence_source AS sequenceSource FROM materials m JOIN topic_materials tm ON tm.material_id=m.id WHERE tm.topic_id=? ORDER BY m.occurred_at', [topicId]).map((row) => { let cardTags: string[] = []; try { const value = JSON.parse(String(row.cardTags ?? '[]')); if (Array.isArray(value)) cardTags = value.filter((tag): tag is string => typeof tag === 'string') } catch { /* Old or invalid rows use empty tags. */ } return { ...asMaterial(row), workstreamId: row.workstreamId as string | null, canvasX: row.canvasX as number | null, canvasY: row.canvasY as number | null, cardColor: row.cardColor as string | null, cardTags, cardNote: row.cardNote as string | null, sequence: row.sequence as number | null, sequenceSource: String(row.sequenceSource ?? 'time') } })
    const ids = materials.map((m) => m.id); const placeholders = ids.map(() => '?').join(',') || "''"
    return { topic, materials, workstreams: this.query('SELECT * FROM workstreams WHERE topic_id=? ORDER BY position', [topicId]).map(asWorkstream), relations: this.query(`SELECT r.*, trs.line_color AS lineColor, trs.source_arrow AS sourceArrow, trs.source_arrow_style AS sourceArrowStyle, trs.target_arrow_style AS targetArrowStyle, trs.animated AS animated, trs.archived AS archived, trs.branch_index AS branchIndex, trs.line_kind AS lineKind FROM relations r LEFT JOIN topic_relation_styles trs ON trs.relation_id=r.id AND trs.topic_id=? WHERE r.source_material_id IN (${placeholders}) AND r.target_material_id IN (${placeholders})`, [topicId, ...ids, ...ids]).map(asRelation) }
  }
  search(query: string): Material[] { return this.query('SELECT * FROM materials WHERE title LIKE ? OR extracted_text LIKE ? OR excerpt LIKE ? ORDER BY imported_at DESC', [`%${query}%`, `%${query}%`, `%${query}%`]).map(asMaterial) }
  getSettings(): ModelSettings { const settings = first<{ value: string }>(this.query('SELECT value FROM settings WHERE key=?', ['model'])); return settings ? JSON.parse(settings.value) : { profileId: null, provider: 'ollama', baseUrl: 'http://localhost:11434', chatModel: '', embeddingModel: '', allowCloud: false, enabled: false } }
  saveSettings(settings: ModelSettings): void { this.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', ['model', JSON.stringify(settings)]) }
  async exportPackage(destination: string): Promise<void> { await new Promise<void>((resolve, reject) => { const stream = createWriteStream(destination); const archive = new ZipArchive({ zlib: { level: 8 } }); stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); archive.pipe(stream); archive.directory(this.root, false); void archive.finalize() }) }
  async importPackage(packagePath: string, destination: string): Promise<WorkspaceSummary> { mkdirSync(destination, { recursive: true }); await (await unzipper.Open.file(packagePath)).extract({ path: destination }); return this.open(destination) }
}
