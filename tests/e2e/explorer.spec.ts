import { expect, test } from 'playwright/test'
import { closeApp, electronAvailable, launchApp, seedWorkspace, type LaunchedApp, type MaterialMapApi } from './helpers'

/**
 * Explorer 三栏界面：列表 → 阅读器 → 关系栏
 * 覆盖证据展开、关系固定（fixed）/隐藏（hidden）流程。
 * UI 交互与 preload API 结合：API 准备数据与触发状态变更，UI 断言展示结果。
 */

test.skip(!electronAvailable, '缺少 out/main/index.js，请先执行 npm run build')

let launched: LaunchedApp | null = null
test.afterEach(async () => { await closeApp(launched); launched = null })

test.describe('Explorer 三栏与关系管理', () => {
  test('三栏布局渲染：材料列表、阅读器、关系栏', async () => {
    launched = await launchApp()
    const { window, workspaceRoot } = launched
    await seedWorkspace(window, workspaceRoot)
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    // 进入 Explorer 视图（默认视图或通过侧边栏导航）
    const explorer = window.locator('.explorer-view')
    if (!(await explorer.count())) await window.locator('.nav-item', { hasText: /Explorer|浏览|材料/ }).first().click()

    await expect(window.locator('.explorer-list')).toBeVisible()
    // 选中第一份材料，阅读器与关系栏应出现
    await window.locator('.explorer-list .explorer-document, .explorer-list li, .explorer-list button').first().click()
    await expect(window.locator('.explorer-reader')).toBeVisible()
    await expect(window.locator('.explorer-relations')).toBeVisible()
  })

  test('关系证据可展开查看', async () => {
    launched = await launchApp()
    const { window, workspaceRoot } = launched
    await seedWorkspace(window, workspaceRoot)
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    const relationCount = await window.evaluate(async () => {
      const api = (window as unknown as { materialMap: MaterialMapApi }).materialMap
      const [first] = await api.materials.list()
      return (await api.materials.relations(first.id, 5)).length
    })
    test.skip(relationCount === 0, '合成材料未产生系统关系，跳过证据展开断言')

    const explorer = window.locator('.explorer-view')
    if (!(await explorer.count())) await window.locator('.nav-item', { hasText: /Explorer|浏览|材料/ }).first().click()
    await window.locator('.explorer-list .explorer-document, .explorer-list li, .explorer-list button').first().click()

    const relation = window.locator('.explorer-relations .explorer-relation, .relation-list > *').first()
    await expect(relation).toBeVisible()
    await relation.click()
    await expect(window.locator('.relation-evidence, .evidence-item').first()).toBeVisible()
  })

  test('关系固定与隐藏状态生效', async () => {
    launched = await launchApp()
    const { window, workspaceRoot } = launched
    await seedWorkspace(window, workspaceRoot)

    const statusFlow = await window.evaluate(async () => {
      const api = (window as unknown as { materialMap: MaterialMapApi }).materialMap
      const [first] = await api.materials.list()
      const relations = await api.materials.relations(first.id, 5)
      if (!relations.length) return null
      const target = relations[0]
      await api.materials.relationStatus(target.id, 'fixed')
      const afterFix = (await api.materials.relations(first.id, 5, true)).map((relation) => relation.id)
      await api.materials.relationStatus(target.id, 'hidden')
      const visibleAfterHide = (await api.materials.relations(first.id, 5)).map((relation) => relation.id)
      const allAfterHide = (await api.materials.relations(first.id, 5, true)).map((relation) => relation.id)
      return { target: target.id, afterFix, visibleAfterHide, allAfterHide }
    })
    test.skip(!statusFlow, '合成材料未产生系统关系，跳过固定/隐藏断言')

    expect(statusFlow!.afterFix).toContain(statusFlow!.target)
    // 隐藏后默认列表不再返回该关系，但 includeHidden 仍可见
    expect(statusFlow!.visibleAfterHide).not.toContain(statusFlow!.target)
    expect(statusFlow!.allAfterHide).toContain(statusFlow!.target)
  })
})
