import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

let app: Awaited<ReturnType<typeof electron.launch>> | null = null
let modelServer: Server | null = null
afterEach(async () => {
  await app?.close(); app = null
  if (modelServer) await new Promise<void>((resolve) => modelServer?.close(() => resolve()))
  modelServer = null
})

async function startTestModel(): Promise<string> {
  modelServer = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'e2e-model' }] })); return }
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      const prompt = String((JSON.parse(body) as { prompt?: string }).prompt ?? '')
      const relevant = prompt.split('Relevant local excerpts:\n')[1] ?? ''
      const citation = relevant.match(/\[([^:\]\s]+):([^\]\s]+)\]/)?.[0] ?? prompt.match(/\[([^:\]\s]+):([^\]\s]+)\]/)?.[0] ?? ''
      const answer = prompt.includes('现在有什么材料，我们一共有多少')
        ? `当前工作台共有 4 份材料：Alpha、Beta、Gamma 和 Delta。${citation}`
        : `测试模型根据本地材料回答。${citation}`
      response.end(JSON.stringify({ response: answer }))
    })
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

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
    expect(await window.evaluate(() => {
      const api = (window as unknown as { materialMap: Record<string, unknown> }).materialMap
      return ['analyze', 'planTopicOperation', 'topicTools'].map((key) => Object.hasOwn(api, key))
    })).toEqual([false, false, false])
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
        await api.topics.executeCommand(topic.id, { kind: 'moveCards', payload: { positions: [{ materialId: materials[0].id, x: 280, y: 160 }] } })
        await api.topics.executeCommand(topic.id, { kind: 'patchCard', payload: { materialId: materials[0].id, patch: { displayTitle: 'Board title', displayExcerpt: 'Board-only text', width: 280 } } })
        await api.topics.executeCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: materials[0].id, targetMaterialId: materials[1].id, label: '', relationType: 'related', style: { sourceArrowStyle: 'none', targetArrowStyle: 'triangle', routePoints: [{ x: 240, y: 90 }] } } } })
        const map = await api.topics.map(topic.id)
        await api.topics.undo(topic.id)
        const afterUndo = await api.topics.map(topic.id)
        await api.topics.redo(topic.id)
        const afterRedo = await api.topics.map(topic.id)
        return { materials: materials.length, hits: hits.length, systemRelations: map.relations.filter((relation: { createdBy: string }) => relation.createdBy === 'system').length, first: map.relations.find((relation: { createdBy: string }) => relation.createdBy === 'system')?.label, displayTitle: map.materials.find((material: { id: string }) => material.id === materials[0].id)?.displayTitle, routePoints: map.relations[0]?.routePoints, afterUndoRelations: afterUndo.relations.length, afterRedoRelations: afterRedo.relations.length, undo: afterRedo.history.undo, redo: afterRedo.history.redo }
      }, workspaceRoot)
    expect(result).toEqual({ materials: 2, hits: 2, systemRelations: 0, first: undefined, displayTitle: 'Board title', routePoints: [{ x: 240, y: 90 }], afterUndoRelations: 0, afterRedoRelations: 1, undo: true, redo: false })
    } finally {
      await app?.close()
      app = null
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('supports macOS canvas selection, contextual menus, pan, drag, connection, and undo', async () => {
    if (process.platform !== 'darwin') return
    const main = resolve('out/main/index.js')
    const modelBaseUrl = await startTestModel()
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'material-map-canvas-e2e-'))
    const workspaceName = `Canvas UI ${Date.now()}`
    const rendererErrors: string[] = []
    try {
      app = await electron.launch({ args: [main], timeout: 20_000, env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' } })
      const window = await app.firstWindow()
      window.on('console', (message) => { if (message.type() === 'error') rendererErrors.push(message.text()) })
      await window.waitForLoadState('domcontentloaded')
      const setup = await window.evaluate(async ({ root, name }) => {
        const api = (window as unknown as { materialMap: any }).materialMap
        await api.workspace.create(root, name)
        const names = ['Alpha', 'Beta', 'Gamma', 'Delta']
        for (const materialName of names) {
          if (materialName === 'Alpha') await api.materials.document(materialName, '# Alpha\nRead [Beta](Beta.md) before the canvas test.', 'md')
          else if (materialName === 'Beta') await api.materials.document(materialName, '# Beta\nBeta canvas test.', 'md')
          else await api.materials.note(materialName, `${materialName} canvas test`)
        }
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const jobs = await api.jobs()
          if (jobs.every((job: { status: string }) => job.status === 'complete' || job.status === 'failed')) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const byTitle = Object.fromEntries((await api.materials.list()).map((material: { id: string; title: string }) => [material.title, material])) as Record<string, { id: string }>
        const positions = [{ x: 100, y: 100 }, { x: 460, y: 100 }, { x: 100, y: 360 }, { x: 460, y: 360 }]
        const cards = names.map((materialName) => byTitle[materialName])
        const topic = await api.topics.create('Canvas interactions')
        await api.topics.addMaterials(topic.id, cards.map((card) => card.id))
        await api.topics.executeCommand(topic.id, { kind: 'moveCards', payload: { positions: cards.map((card, index) => ({ materialId: card.id, ...positions[index] })) } })
        await api.topics.executeCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: byTitle.Alpha.id, targetMaterialId: byTitle.Beta.id, label: '关联', relationType: 'related', style: { sourceArrowStyle: 'none', targetArrowStyle: 'triangle' } } } })
        await api.topics.executeCommand(topic.id, { kind: 'createRelation', payload: { relation: { sourceMaterialId: byTitle.Gamma.id, targetMaterialId: byTitle.Delta.id, label: '依赖', relationType: 'depends_on', style: { sourceArrowStyle: 'none', targetArrowStyle: 'triangle' } } } })
        return { topicId: topic.id, alphaId: byTitle.Alpha.id, betaId: byTitle.Beta.id, gammaId: byTitle.Gamma.id }
      }, { root: workspaceRoot, name: workspaceName }) as { topicId: string; alphaId: string; betaId: string; gammaId: string }

      // Opening through the recent-workspace UI makes this a renderer test,
      // rather than only invoking the same IPC methods directly.
      await window.reload()
      await window.getByRole('button', { name: new RegExp(workspaceName) }).click()
      await window.locator('.app-shell').waitFor()
      await window.getByRole('button', { name: '工作台', exact: true }).click()
      expect(await window.locator('.knowledge-chat').count()).toBe(0)
      await window.locator('.material-card', { hasText: 'Alpha' }).click()
      await window.locator('.explorer-view').waitFor()
      expect(await window.locator('.explorer-reader > header h1').textContent()).toBe('Alpha')
      const betaRelation = window.locator('.explorer-relation', { hasText: 'Beta' }).first()
      await betaRelation.getByTitle('查看证据').click()
      await betaRelation.getByTitle('在阅读器中定位原文').first().click()
      await window.locator('.evidence-locator').waitFor()
      expect(await window.locator('[data-evidence-highlight]').textContent()).toBe('Beta.md')
      await window.getByRole('button', { name: '工作台', exact: true }).click()
      await window.getByRole('button', { name: '知识库问答', exact: true }).click()
      await window.locator('.knowledge-chat-page').waitFor()
      expect(await window.locator('.knowledge-chat').count()).toBe(1)
      const chatInput = window.getByLabel('询问材料')
      await expect.poll(() => chatInput.isDisabled()).toBe(true)
      expect(await window.getByText('先配置 AI', { exact: true }).count()).toBe(1)
      await window.getByRole('button', { name: '配置 AI', exact: true }).last().click()
      await window.getByRole('heading', { name: '模型与隐私', exact: true }).waitFor()
      await window.locator('.modal header .icon-button').click()
      const configured = await window.evaluate(async (baseUrl) => {
        const api = (window as unknown as { materialMap: any }).materialMap
        const profile = await api.profiles.save({ name: `E2E Ollama ${Date.now()}`, provider: 'ollama', wireApi: 'chat_completions', baseUrl })
        await api.settings.save({ profileId: profile.id, provider: profile.provider, baseUrl: profile.baseUrl, chatModel: profile.recommendedModel, embeddingModel: '', allowCloud: false, enabled: true })
        return profile.recommendedModel
      }, modelBaseUrl)
      expect(configured).toBe('e2e-model')
      await window.getByRole('button', { name: '工作台', exact: true }).click()
      await window.getByRole('button', { name: '知识库问答', exact: true }).click()
      await expect.poll(() => window.getByLabel('询问材料').isEnabled()).toBe(true)
      await chatInput.fill('canvas test')
      await chatInput.press('Enter')
      await expect.poll(() => window.locator('.knowledge-chat-row.assistant:not(.loading)').count()).toBe(1)
      await chatInput.fill('这些材料还提到了什么？')
      await chatInput.press('Enter')
      await expect.poll(() => window.locator('.knowledge-chat-row.assistant:not(.loading)').count()).toBe(2)
      await chatInput.fill('现在有什么材料，我们一共有多少')
      await chatInput.press('Enter')
      await expect.poll(() => window.locator('.knowledge-chat-row.assistant:not(.loading)').count()).toBe(3)
      expect(await window.locator('.knowledge-chat-row.user').count()).toBe(3)
      expect(await window.locator('.knowledge-chat-answer').last().textContent()).toContain('当前工作台共有 4 份材料：Alpha、Beta、Gamma 和 Delta。')
      expect(await window.locator('.knowledge-chat-answer').last().textContent()).not.toContain('证据不足')
      expect(await window.locator('.knowledge-chat-answer-meta').last().textContent()).toContain('模型 · e2e-model')
      const firstAnswer = await window.locator('.knowledge-chat-answer').first().textContent()
      expect(firstAnswer).toContain('[1]')
      expect(firstAnswer).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{20,}:/i)
      expect(await window.locator('.knowledge-chat-sessions').count()).toBe(0)
      expect(await window.locator('.knowledge-chat-citations summary').first().textContent()).toContain('1 个来源')
      await window.locator('.knowledge-chat-citations summary').first().click()
      await window.locator('.knowledge-chat-citation-list button').first().click()
      await window.locator('.explorer-view').waitFor()
      await window.getByRole('button', { name: '知识库问答', exact: true }).click()
      await expect.poll(() => window.locator('.knowledge-chat-row.user').count()).toBe(3)
      await window.getByTitle('新建对话').click()
      expect(await window.getByText('询问你的材料', { exact: true }).count()).toBe(1)
      await window.getByTitle('会话记录').click()
      expect(await window.locator('.knowledge-chat-history-menu > header').textContent()).toContain('2/10')
      await window.getByRole('menuitem', { name: /canvas test/ }).click()
      expect(await window.locator('.knowledge-chat-row.user').count()).toBe(3)
      await window.getByTitle('清空问答').click()
      expect(await window.getByText('询问你的材料', { exact: true }).count()).toBe(1)
      await window.getByRole('button', { name: 'Canvas interactions', exact: true }).click()
      await window.locator('.react-flow__node').nth(3).waitFor()
      await window.waitForTimeout(250)
      expect({ edgesBeforeClick: await window.locator('.react-flow__edge').count(), rendererErrors }).toEqual({ edgesBeforeClick: 2, rendererErrors: [] })
      const firstCard = await window.locator('.react-flow__node', { hasText: 'Alpha' }).boundingBox()
      expect(firstCard).not.toBeNull()
      await window.mouse.click(firstCard!.x + firstCard!.width / 2, firstCard!.y + firstCard!.height / 2)
      expect(await window.locator('.context-panel').count()).toBe(0)
      expect(await window.locator('.whiteboard-inspector h3').textContent()).toBe('画板卡片属性')
      const displayTitle = window.getByLabel('显示标题')
      await displayTitle.fill('Alpha board')
      await displayTitle.blur()
      await expect.poll(async () => {
        const map = await window.evaluate(async ({ topicId }) => (window as unknown as { materialMap: any }).materialMap.topics.map(topicId), setup)
        const card = map.materials.find((material: { id: string }) => material.id === setup.alphaId)
        return { title: card?.title, displayTitle: card?.displayTitle }
      }).toEqual({ title: 'Alpha', displayTitle: 'Alpha board' })
      await expect.poll(() => window.locator('.react-flow__edge').count()).toBe(2)
      const relationState = await window.evaluate(async ({ topicId }) => {
        const map = await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)
        return { mapLabels: map.relations.map((relation: { label: string }) => relation.label).sort(), edgeCount: document.querySelectorAll('.react-flow__edge').length }
      }, setup)
      expect(relationState).toEqual({ mapLabels: ['依赖', '关联'], edgeCount: 2 })
      expect(await window.locator('.relation-edge-label').allTextContents()).toEqual(expect.arrayContaining(['关联', '依赖']))
      await window.locator('.relation-edge-label', { hasText: '关联' }).click()
      expect(await window.locator('.whiteboard-inspector h3').textContent()).toBe('关系属性')
      const firstLine = await window.locator('.relation-hit-area').first().boundingBox()
      expect(firstLine).not.toBeNull()
      await window.mouse.click(firstLine!.x + firstLine!.width / 4, firstLine!.y + firstLine!.height / 2)
      expect(await window.locator('.whiteboard-inspector h3').textContent()).toBe('关系属性')
      expect(await window.locator('.relation-endpoint-handle').count()).toBe(2)
      const reconnectSource = window.locator('.relation-endpoint-handle.source').first()
      const reconnectTarget = window.locator('.react-flow__node', { hasText: 'Gamma' }).locator('.react-flow__handle.source[data-handleid="out-bottom"]')
      const reconnectSourceBox = await reconnectSource.boundingBox(); const reconnectTargetBox = await reconnectTarget.boundingBox()
      expect(reconnectSourceBox).not.toBeNull(); expect(reconnectTargetBox).not.toBeNull()
      await window.mouse.move(reconnectSourceBox!.x + reconnectSourceBox!.width / 2, reconnectSourceBox!.y + reconnectSourceBox!.height / 2)
      await window.mouse.down()
      await window.mouse.move(reconnectTargetBox!.x + reconnectTargetBox!.width / 2, reconnectTargetBox!.y + reconnectTargetBox!.height / 2, { steps: 12 })
      await window.mouse.up()
      await window.waitForTimeout(250)
      const reconnected = await window.evaluate(async ({ topicId, betaId, gammaId }) => {
        const map = await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)
        return map.relations.find((relation: { sourceMaterialId: string; targetMaterialId: string }) => relation.sourceMaterialId === gammaId && relation.targetMaterialId === betaId)
      }, setup)
      expect(reconnected).toMatchObject({ sourceMaterialId: setup.gammaId, targetMaterialId: setup.betaId, sourceHandle: 'out-bottom', targetHandle: 'in-left' })

      const nodeBounds = await window.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))
      const selection = {
        left: Math.min(...nodeBounds.map((rect) => rect.left)), right: Math.max(...nodeBounds.map((rect) => rect.right)),
        top: Math.min(...nodeBounds.map((rect) => rect.top)), bottom: Math.max(...nodeBounds.map((rect) => rect.bottom))
      }
      const selectedBlank = { x: (selection.left + selection.right) / 2, y: (selection.top + selection.bottom) / 2 }
      const pane = await window.locator('.react-flow__pane').boundingBox()
      expect(pane).not.toBeNull()
      const canvasBlank = { x: selectedBlank.x, y: pane!.y + pane!.height - 14 }

      await window.mouse.move(selection.left - 20, selection.top - 20)
      await window.mouse.down()
      await window.mouse.move(selection.right + 20, selection.bottom + 20, { steps: 12 })
      await window.mouse.up()
      expect(await window.locator('.react-flow__node.selected').count()).toBe(4)

      await window.mouse.click(selectedBlank.x, selectedBlank.y, { button: 'right' })
      await window.getByRole('button', { name: '删除所选内容' }).waitFor()
      await window.mouse.click(canvasBlank.x, canvasBlank.y)
      await window.mouse.move(selection.left - 20, selection.top - 20)
      await window.mouse.down()
      await window.mouse.move(selection.right + 20, selection.bottom + 20, { steps: 12 })
      await window.mouse.up()
      expect(await window.locator('.react-flow__node.selected').count()).toBe(4)
      await window.keyboard.down('Control')
      await window.mouse.click(selectedBlank.x, selectedBlank.y)
      await window.keyboard.up('Control')
      await window.getByRole('button', { name: '删除所选内容' }).waitFor()

      await window.mouse.click(canvasBlank.x, canvasBlank.y)
      await window.mouse.click(canvasBlank.x, canvasBlank.y, { button: 'right' })
      const canvasMenuText = await window.locator('.canvas-menu').textContent()
      expect(canvasMenuText).toContain('新建卡片')
      expect(canvasMenuText).toContain('粘贴文本为卡片')
      await window.mouse.click(canvasBlank.x, canvasBlank.y)

      const beforePan = await window.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform)
      await window.keyboard.down('Space')
      await window.mouse.move(canvasBlank.x, canvasBlank.y)
      await window.mouse.down()
      await window.mouse.move(canvasBlank.x + 45, canvasBlank.y - 20, { steps: 6 })
      await window.mouse.up()
      await window.keyboard.up('Space')
      expect(await window.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform)).not.toBe(beforePan)

      const alpha = window.locator('.react-flow__node', { hasText: 'Alpha' })
      const alphaBefore = await window.evaluate(async ({ topicId, alphaId }) => {
        const map = await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)
        const card = map.materials.find((material: { id: string }) => material.id === alphaId)
        return { x: card.canvasX, y: card.canvasY }
      }, setup)
      const alphaBox = await alpha.boundingBox()
      expect(alphaBox).not.toBeNull()
      await window.mouse.move(alphaBox!.x + 100, alphaBox!.y + 80)
      await window.mouse.down()
      await window.mouse.move(alphaBox!.x + 145, alphaBox!.y + 104, { steps: 8 })
      await window.mouse.up()
      await window.waitForTimeout(250)
      const alphaAfter = await window.evaluate(async ({ topicId, alphaId }) => {
        const map = await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)
        const card = map.materials.find((material: { id: string }) => material.id === alphaId)
        return { x: card.canvasX, y: card.canvasY }
      }, setup)
      expect(alphaAfter).not.toEqual(alphaBefore)

      const gamma = window.locator('.react-flow__node', { hasText: 'Gamma' })
      const source = alpha.locator('.react-flow__handle.source[data-handleid="out-top"]')
      const target = gamma.locator('.react-flow__handle.target[data-handleid="in-bottom"]')
      const sourceBox = await source.boundingBox(); const targetBox = await target.boundingBox()
      expect(sourceBox).not.toBeNull(); expect(targetBox).not.toBeNull()
      await window.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
      await window.mouse.down()
      await window.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 })
      await window.mouse.up()
      await window.waitForTimeout(250)
      const created = await window.evaluate(async ({ topicId, alphaId, gammaId }) => {
        const map = await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)
        return map.relations.find((relation: { sourceMaterialId: string; targetMaterialId: string }) => relation.sourceMaterialId === alphaId && relation.targetMaterialId === gammaId)
      }, setup)
      expect(created).toMatchObject({ label: '', sourceArrowStyle: 'none', targetArrowStyle: 'triangle', sourceHandle: 'out-top', targetHandle: 'in-bottom' })

      const overlaps = await window.evaluate(() => {
        const intersects = (left: DOMRect, right: DOMRect) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
        const cards = [...document.querySelectorAll('.react-flow__node')].map((node) => node.getBoundingClientRect())
        return [...document.querySelectorAll('.relation-edge-label')].some((label) => cards.some((card) => intersects(label.getBoundingClientRect(), card)))
      })
      expect(overlaps).toBe(false)

      const finalBounds = await window.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))
      const finalSelection = { left: Math.min(...finalBounds.map((rect) => rect.left)), right: Math.max(...finalBounds.map((rect) => rect.right)), top: Math.min(...finalBounds.map((rect) => rect.top)), bottom: Math.max(...finalBounds.map((rect) => rect.bottom)) }
      const finalSelectedBlank = { x: (finalSelection.left + finalSelection.right) / 2, y: (finalSelection.top + finalSelection.bottom) / 2 }
      await window.mouse.move(finalSelection.left - 20, finalSelection.top - 20)
      await window.mouse.down()
      await window.mouse.move(finalSelection.right + 20, finalSelection.bottom + 20, { steps: 12 })
      await window.mouse.up()
      await window.mouse.click(finalSelectedBlank.x, finalSelectedBlank.y, { button: 'right' })
      await window.getByRole('button', { name: '删除所选内容' }).click()
      await expect.poll(() => window.locator('.react-flow__node').count()).toBe(0)
      expect(await window.evaluate(async ({ topicId }) => (await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)).materials.length, setup)).toBe(0)
      await window.keyboard.press('Meta+z')
      await window.locator('.react-flow__node').nth(3).waitFor()
      expect(await window.evaluate(async ({ topicId }) => (await (window as unknown as { materialMap: any }).materialMap.topics.map(topicId)).materials.length, setup)).toBe(4)
      expect(rendererErrors.some((error) => /Maximum update depth exceeded|Too many re-renders/i.test(error))).toBe(false)
    } finally {
      await app?.close()
      app = null
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
