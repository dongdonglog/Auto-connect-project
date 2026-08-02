import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'

export interface VectorCapability { available: boolean; version: string | null; error: string | null }

export function detectVectorCapability(): VectorCapability {
  const db = new DatabaseSync(':memory:', { allowExtension: true })
  try {
    sqliteVec.load(db)
    const row = db.prepare('SELECT vec_version() AS version').get() as { version?: string }
    return { available: true, version: row.version ?? null, error: null }
  } catch (error) {
    return { available: false, version: null, error: error instanceof Error ? error.message : 'sqlite-vec unavailable' }
  } finally { db.close() }
}
