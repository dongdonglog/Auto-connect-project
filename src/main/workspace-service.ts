import initSqlJs, { type Database } from 'sql.js'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as archiverModule from 'archiver'
import unzipper from 'unzipper'
import { decrypt, deriveKey, encrypt, createSalt } from './crypto'
import { extractFile, fetchLinkMetadata } from './parsers'
import type { AnalysisStatus, Job, Material, ModelSettings, Relation, Topic, TopicMap, WorkspaceSummary, Workstream } from './types'

type SqlRow = Record<string, unknown>
interface WorkspaceConfig { id: string; name: string; encrypted: boolean; salt?: string }
const now = () => new Date().toISOString()
const id = () => randomUUID()

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
function asTopic(row: SqlRow): Topic { return { ...row, id: String(row.id), name: String(row.name), description: row.description as string | null, createdAt: String(row.created_at) } }
function asWorkstream(row: SqlRow): Workstream { return { ...row, id: String(row.id), topicId: String(row.topic_id), name: String(row.name), position: Number(row.position), source: row.source as Workstream['source'] } }
function asRelation(row: SqlRow): Relation { return { ...row, id: String(row.id), sourceMaterialId: String(row.source_material_id), targetMaterialId: String(row.target_material_id), label: String(row.label), relationType: String(row.relation_type), evidenceText: row.evidence_text as string | null, evidenceMaterialId: row.evidence_material_id as string | null, confidence: row.confidence as number | null, createdBy: row.created_by as Relation['createdBy'], createdAt: String(row.created_at) } }

export class WorkspaceService {
  private SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
  private db: Database | null = null
  private root = ''
  private config: WorkspaceConfig | null = null
  private key: Buffer | null = null

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
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_materials (topic_id TEXT NOT NULL, material_id TEXT NOT NULL, workstream_id TEXT, PRIMARY KEY(topic_id, material_id));
      CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, source_material_id TEXT NOT NULL, target_material_id TEXT NOT NULL, label TEXT NOT NULL, relation_type TEXT NOT NULL, evidence_text TEXT, evidence_material_id TEXT, confidence REAL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
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
  listJobs(): Job[] { return this.query('SELECT * FROM jobs ORDER BY updated_at DESC').map((row) => row as unknown as Job) }
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
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex')
    const duplicate = first<Material>(this.query('SELECT * FROM materials WHERE hash = ?', [hash]))
    if (duplicate && !keepDuplicate) return { material: duplicate, duplicateOf: duplicate }
    const materialId = id(); const extension = extname(filePath); const storedName = `${materialId}${extension || '.bin'}`; const storedPath = join(this.materialsPath(), storedName)
    const importedAt = now()
    this.run('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [materialId, 'file', basename(filePath, extension), null, filePath, storedName, null, null, null, null, importedAt, importedAt, 'import', 'queued', null, hash])
    if (this.config?.encrypted) writeFileSync(storedPath, encrypt(readFileSync(filePath), this.key!)); else copyFileSync(filePath, storedPath)
    this.run('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)', [id(), materialId, 'extract', 'queued', null, importedAt])
    const material = this.getMaterial(materialId)!
    void this.processMaterial(materialId)
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
    void this.processMaterial(materialId)
    return this.getMaterial(materialId)!
  }
  async processMaterial(materialId: string): Promise<void> {
    const material = this.getMaterial(materialId); if (!material) return
    this.run('UPDATE materials SET status = ?, error = ? WHERE id = ?', ['running', null, materialId])
    try {
      if (material.type === 'file') {
        const storedFile = join(this.materialsPath(), material.storedPath!)
        const extracted = await extractFile(storedFile, this.config?.encrypted ? decrypt(readFileSync(storedFile), this.key!) : undefined)
        const originalTitle = material.sourcePath ? basename(material.sourcePath, extname(material.sourcePath)) : material.title
        this.run('UPDATE materials SET title=?, mime_type=?, excerpt=?, extracted_text=?, occurred_at=?, occurred_at_source=?, status=? WHERE id=?', [originalTitle, extracted.mimeType, extracted.text.slice(0, 500), extracted.text, extracted.occurredAt ?? material.importedAt, extracted.occurredAtSource, 'complete', materialId])
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
  retry(materialId: string): void { void this.processMaterial(materialId) }
  updateMaterialDate(id: string, occurredAt: string): void { this.run('UPDATE materials SET occurred_at=?, occurred_at_source=? WHERE id=?', [occurredAt, 'manual', id]) }
  createTopic(name: string, description = ''): Topic { const topic = { id: id(), name, description: description || null, createdAt: now() }; this.run('INSERT INTO topics VALUES (?, ?, ?, ?)', [topic.id, topic.name, topic.description, topic.createdAt]); return topic }
  listTopics(): Topic[] { return this.query('SELECT * FROM topics ORDER BY created_at DESC').map(asTopic) }
  addToTopic(topicId: string, materialId: string, workstreamId?: string): void { this.run('INSERT OR REPLACE INTO topic_materials VALUES (?, ?, ?)', [topicId, materialId, workstreamId ?? null]) }
  createWorkstream(topicId: string, name: string, source: 'ai' | 'manual' = 'manual'): Workstream { const position = this.query('SELECT COUNT(*) AS count FROM workstreams WHERE topic_id=?', [topicId])[0]?.count as number ?? 0; const stream = { id: id(), topicId, name, position: Number(position), source }; this.run('INSERT INTO workstreams VALUES (?, ?, ?, ?, ?)', [stream.id, stream.topicId, stream.name, stream.position, stream.source]); return stream }
  updateWorkstream(id: string, name: string): void { this.run('UPDATE workstreams SET name=? WHERE id=?', [name, id]) }
  moveMaterial(topicId: string, materialId: string, workstreamId: string | null): void { this.run('UPDATE topic_materials SET workstream_id=? WHERE topic_id=? AND material_id=?', [workstreamId, topicId, materialId]) }
  createRelation(input: Omit<Relation, 'id' | 'createdAt'>): Relation { const relation = { id: id(), ...input, createdAt: now() }; this.run('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [relation.id, relation.sourceMaterialId, relation.targetMaterialId, relation.label, relation.relationType, relation.evidenceText, relation.evidenceMaterialId, relation.confidence, relation.createdBy, relation.createdAt]); return relation }
  hasRelation(sourceMaterialId: string, targetMaterialId: string, label: string): boolean { return this.query('SELECT id FROM relations WHERE source_material_id=? AND target_material_id=? AND label=? LIMIT 1', [sourceMaterialId, targetMaterialId, label]).length > 0 }
  updateRelation(id: string, label: string): void { this.run('UPDATE relations SET label=? WHERE id=?', [label, id]) }
  deleteRelation(id: string): void { this.run('DELETE FROM relations WHERE id=?', [id]) }
  topicMap(topicId: string): TopicMap {
    const topic = first<Topic>(this.query('SELECT * FROM topics WHERE id=?', [topicId])); if (!topic) throw new Error('Topic not found')
    const materials = this.query('SELECT m.*, tm.workstream_id AS workstreamId FROM materials m JOIN topic_materials tm ON tm.material_id=m.id WHERE tm.topic_id=? ORDER BY m.occurred_at', [topicId]).map((row) => ({ ...asMaterial(row), workstreamId: row.workstreamId as string | null }))
    const ids = materials.map((m) => m.id); const placeholders = ids.map(() => '?').join(',') || "''"
    return { topic, materials, workstreams: this.query('SELECT * FROM workstreams WHERE topic_id=? ORDER BY position', [topicId]).map(asWorkstream), relations: this.query(`SELECT * FROM relations WHERE source_material_id IN (${placeholders}) AND target_material_id IN (${placeholders})`, [...ids, ...ids]).map(asRelation) }
  }
  search(query: string): Material[] { return this.query('SELECT * FROM materials WHERE title LIKE ? OR extracted_text LIKE ? OR excerpt LIKE ? ORDER BY imported_at DESC', [`%${query}%`, `%${query}%`, `%${query}%`]).map(asMaterial) }
  getSettings(): ModelSettings { const settings = first<{ value: string }>(this.query('SELECT value FROM settings WHERE key=?', ['model'])); return settings ? JSON.parse(settings.value) : { profileId: null, provider: 'ollama', baseUrl: 'http://localhost:11434', chatModel: '', embeddingModel: '', allowCloud: false, enabled: false } }
  saveSettings(settings: ModelSettings): void { this.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', ['model', JSON.stringify(settings)]) }
  async exportPackage(destination: string): Promise<void> { await new Promise<void>((resolve, reject) => { const output = writeFileSync; void output; const stream = require('node:fs').createWriteStream(destination); const createArchive = archiverModule as unknown as (format: string, options: { zlib: { level: number } }) => { on(event: string, listener: (error: Error) => void): void; pipe(target: unknown): void; directory(source: string, destination: false): void; finalize(): void }; const archive = createArchive('zip', { zlib: { level: 8 } }); stream.on('close', resolve); archive.on('error', reject); archive.pipe(stream); archive.directory(this.root, false); archive.finalize() }) }
  async importPackage(packagePath: string, destination: string): Promise<WorkspaceSummary> { mkdirSync(destination, { recursive: true }); await (await unzipper.Open.file(packagePath)).extract({ path: destination }); return this.open(destination) }
}
