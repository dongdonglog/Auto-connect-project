import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'

export interface VectorHit { chunkId: string; distance: number }

export class VectorStore {
  private readonly db: DatabaseSync
  private dimension: number | null = null
  private vectorsReady = false

  constructor(path: string) {
    this.db = new DatabaseSync(path, { allowExtension: true })
    sqliteVec.load(this.db)
    this.db.exec('CREATE TABLE IF NOT EXISTS vector_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id TEXT NOT NULL UNIQUE)')
    this.db.exec('CREATE TABLE IF NOT EXISTS vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.prepare("SELECT value FROM vector_meta WHERE key='dimension'").get() as { value?: string } | undefined
    const dimension = row?.value ? Number(row.value) : NaN
    if (Number.isInteger(dimension) && dimension > 0) { this.dimension = dimension; this.createVectorTable(dimension) }
  }

  private createVectorTable(dimension: number): void {
    if (this.vectorsReady) return
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${dimension}])`)
    this.vectorsReady = true
  }

  private ensureDimension(dimension: number): void {
    if (this.dimension !== null && this.dimension !== dimension) throw new Error(`Embedding dimension changed from ${this.dimension} to ${dimension}. Rebuild the vector index.`)
    if (this.dimension === null) {
      this.dimension = dimension
      this.db.exec('CREATE TABLE IF NOT EXISTS vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      this.db.prepare("INSERT OR REPLACE INTO vector_meta (key, value) VALUES ('dimension', ?)").run(String(dimension))
    }
    this.createVectorTable(dimension)
  }

  upsert(chunkId: string, vector: number[]): void {
    if (!vector.length) return
    this.ensureDimension(vector.length)
    const existing = this.db.prepare('SELECT id FROM vector_chunks WHERE chunk_id=?').get(chunkId) as { id?: number } | undefined
    const rowId = existing?.id ?? Number((this.db.prepare('INSERT INTO vector_chunks (chunk_id) VALUES (?)').run(chunkId) as { lastInsertRowid?: number | bigint }).lastInsertRowid)
    if (existing) this.db.prepare('DELETE FROM chunk_vectors WHERE rowid=?').run(rowId)
    this.db.prepare(`INSERT INTO chunk_vectors (rowid, embedding) VALUES (${rowId}, ?)`).run(new Uint8Array(new Float32Array(vector).buffer))
  }

  removeChunk(chunkId: string): void {
    const row = this.db.prepare('SELECT id FROM vector_chunks WHERE chunk_id=?').get(chunkId) as { id?: number } | undefined
    if (!row?.id) return
    if (this.vectorsReady) this.db.prepare('DELETE FROM chunk_vectors WHERE rowid=?').run(row.id)
    this.db.prepare('DELETE FROM vector_chunks WHERE id=?').run(row.id)
  }

  removeMaterial(chunkIds: string[]): void { for (const chunkId of chunkIds) this.removeChunk(chunkId) }

  search(vector: number[], limit: number): VectorHit[] {
    if (!this.vectorsReady || !vector.length) return []
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    const rows = this.db.prepare(`SELECT v.rowid, v.distance, c.chunk_id AS chunkId FROM chunk_vectors v JOIN vector_chunks c ON c.id=v.rowid WHERE v.embedding MATCH ? AND k = ${safeLimit} ORDER BY v.distance`).all(new Uint8Array(new Float32Array(vector).buffer)) as Array<{ chunkId: string; distance: number }>
    return rows.map((row) => ({ chunkId: String(row.chunkId), distance: Number(row.distance) }))
  }

  close(): void { this.db.close() }
}
