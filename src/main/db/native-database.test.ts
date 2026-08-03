import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeDatabase } from './native-database'

const roots: string[] = []
const databases: NativeDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createDatabase(name = 'workspace.sqlite', data?: Uint8Array): NativeDatabase {
  const root = mkdtempSync(join(tmpdir(), 'material-map-nativedb-')); roots.push(root)
  const db = new NativeDatabase(join(root, name), data); databases.push(db)
  return db
}

describe('NativeDatabase', () => {
  it('runs DDL/DML and reads rows back through prepared statements', () => {
    const db = createDatabase()
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT, weight REAL)')
    db.run('INSERT INTO items (id, label, weight) VALUES (?, ?, ?)', ['a', 'alpha', 1.5])
    db.run('INSERT INTO items (id, label, weight) VALUES (?, ?, ?)', ['b', 'beta', 2.5])
    const statement = db.prepare('SELECT id, label, weight FROM items ORDER BY id')
    statement.bind()
    const rows: Array<Record<string, unknown>> = []
    while (statement.step()) rows.push(statement.getAsObject())
    statement.free()
    expect(rows).toEqual([
      { id: 'a', label: 'alpha', weight: 1.5 },
      { id: 'b', label: 'beta', weight: 2.5 },
    ])
  })

  it('rebinds parameters after free for repeated execution', () => {
    const db = createDatabase()
    db.exec('CREATE TABLE kv (k TEXT, v TEXT)')
    db.run('INSERT INTO kv VALUES (?, ?)', ['x', '1'])
    db.run('INSERT INTO kv VALUES (?, ?)', ['y', '2'])
    const statement = db.prepare('SELECT v FROM kv WHERE k = ?')
    statement.bind(['x'])
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ v: '1' })
    statement.free()
    statement.bind(['y'])
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ v: '2' })
    statement.free()
  })

  it('returns an empty object when stepping past the last row', () => {
    const db = createDatabase()
    db.exec('CREATE TABLE t (n INTEGER)')
    const statement = db.prepare('SELECT n FROM t')
    statement.bind()
    expect(statement.step()).toBe(false)
    expect(statement.getAsObject()).toEqual({})
    statement.free()
  })

  it('export produces bytes that fromBytes can reopen with the same data', () => {
    const db = createDatabase()
    db.exec('CREATE TABLE notes (body TEXT)')
    db.run('INSERT INTO notes VALUES (?)', ['persisted note'])
    const bytes = db.export()
    expect(bytes.length).toBeGreaterThan(0)
    const reopened = createDatabase('copy.sqlite', bytes)
    const statement = reopened.prepare('SELECT body FROM notes')
    statement.bind()
    expect(statement.step()).toBe(true)
    expect(statement.getAsObject()).toEqual({ body: 'persisted note' })
    statement.free()
  })

  it('removeIfPresent is safe for missing paths', () => {
    expect(() => NativeDatabase.removeIfPresent(join(tmpdir(), 'material-map-definitely-missing.sqlite'))).not.toThrow()
  })
})
