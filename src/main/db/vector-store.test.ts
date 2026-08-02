import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VectorStore } from './vector-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('VectorStore', () => {
  it('stores and retrieves nearest vectors with sqlite-vec', () => {
    const root = mkdtempSync(join(tmpdir(), 'material-map-vector-')); roots.push(root)
    const store = new VectorStore(join(root, 'vectors.sqlite'))
    store.upsert('chunk-a', [1, 0, 0]); store.upsert('chunk-b', [0, 1, 0])
    expect(store.search([1, 0, 0], 1)[0]).toMatchObject({ chunkId: 'chunk-a' })
    store.removeChunk('chunk-a')
    expect(store.search([1, 0, 0], 2).map((hit) => hit.chunkId)).toEqual(['chunk-b'])
    store.close()
  })
})
