import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

let app: Awaited<ReturnType<typeof electron.launch>> | null = null
afterEach(async () => { await app?.close(); app = null })

describe('Electron packaged shell', () => {
  it('opens the built Material Map window and exposes the renderer', async () => {
    const main = resolve('out/main/index.js')
    expect(existsSync(main)).toBe(true)
    app = await electron.launch({ args: [main], timeout: 20_000, env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' } })
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    expect(await window.title()).toBe('Material Map')
    expect(await window.locator('.welcome, .app-shell').count()).toBe(1)
    expect(await window.evaluate(() => typeof (window as unknown as { materialMap?: { workspace?: { create?: unknown } } }).materialMap?.workspace?.create)).toBe('function')
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'material-map-e2e-'))
    try {
      const result = await window.evaluate(async (root) => {
        const api = (window as unknown as { materialMap: any }).materialMap
        await api.workspace.create(root, 'Electron E2E')
        await api.materials.note('02-Second', 'native sqlite e2e token')
        await api.materials.note('01-First', 'native sqlite e2e token')
        const materials = await api.materials.list()
        const hits = await api.search('native sqlite e2e token')
        const topic = await api.topics.create('Topology')
        await api.topics.addMaterials(topic.id, materials.map((material: { id: string }) => material.id))
        const map = await api.topics.map(topic.id)
        return { materials: materials.length, hits: hits.length, systemRelations: map.relations.filter((relation: { createdBy: string }) => relation.createdBy === 'system').length, first: map.relations.find((relation: { createdBy: string }) => relation.createdBy === 'system')?.label }
      }, workspaceRoot)
    expect(result).toEqual({ materials: 2, hits: 2, systemRelations: 0, first: undefined })
    } finally {
      await app?.close()
      app = null
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
