import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppStore } from './app-store'

const roots: string[] = []
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'material-map-store-')); roots.push(root); return root }
const safeStorage = { encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') }

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('AppStore recent workspaces', () => {
  it('keeps the six most recently opened workspaces and refreshes existing entries', () => {
    const store = new AppStore(makeRoot(), safeStorage as never)
    for (let index = 0; index < 7; index += 1) store.rememberWorkspace(`/workspace/${index}`, `Workspace ${index}`)
    store.rememberWorkspace('/workspace/2', 'Workspace two')
    const recent = store.listRecent()
    expect(recent).toHaveLength(6)
    expect(recent[0]).toMatchObject({ root: '/workspace/2', name: 'Workspace two' })
    expect(recent.some((item) => item.root === '/workspace/0')).toBe(false)
  })
})
