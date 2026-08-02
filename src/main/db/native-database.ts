import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type SqlValue = string | number | bigint | null | Uint8Array

class CompatStatement {
  private params: SqlValue[] = []
  private rows: Array<Record<string, unknown>> = []
  private cursor = 0
  constructor(private readonly statement: ReturnType<DatabaseSync['prepare']>) {}
  bind(params: SqlValue[] = []): void { this.params = params }
  step(): boolean { if (!this.rows.length) this.rows = this.statement.all(...this.params) as Array<Record<string, unknown>>; return this.cursor < this.rows.length }
  getAsObject(): Record<string, unknown> { return this.rows[this.cursor++] ?? {} }
  free(): void { this.rows = []; this.cursor = 0 }
}

export class NativeDatabase {
  private readonly database: DatabaseSync
  private readonly databasePath: string
  constructor(readonly filePath: string, data?: Uint8Array) {
    this.databasePath = join(tmpdir(), `material-map-native-${randomUUID()}.sqlite`)
    if (data) writeFileSync(this.databasePath, data)
    else if (existsSync(filePath)) writeFileSync(this.databasePath, readFileSync(filePath))
    this.database = new DatabaseSync(this.databasePath, { allowExtension: true })
  }
  run(sql: string, params: SqlValue[] = []): void { this.database.prepare(sql).run(...params) }
  prepare(sql: string): CompatStatement { return new CompatStatement(this.database.prepare(sql)) }
  exec(sql: string): void { this.database.exec(sql) }
  export(): Buffer {
    const exportPath = `${this.databasePath}.export-${randomUUID()}`
    this.database.exec(`VACUUM INTO '${exportPath.replaceAll("'", "''")}'`)
    const data = readFileSync(exportPath); unlinkSync(exportPath); return data
  }
  close(): void { this.database.close(); NativeDatabase.removeIfPresent(this.databasePath) }
  static fromBytes(filePath: string, data?: Uint8Array): NativeDatabase { return new NativeDatabase(filePath, data) }
  static removeIfPresent(filePath: string): void { if (existsSync(filePath)) unlinkSync(filePath) }
}
