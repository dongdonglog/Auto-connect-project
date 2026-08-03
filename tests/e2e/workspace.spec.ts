import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'playwright/test'
import { closeApp, electronAvailable, launchApp, seedWorkspace, type LaunchedApp } from './helpers'

/**
 * 工作区生命周期：创建 → 打开 → 导出 → 导入
 * 原生目录选择对话框无法自动化，数据准备通过 preload API 完成，
 * UI 断言聚焦在欢迎页 / 应用外壳的可见状态。
 */

test.skip(!electronAvailable, '缺少 out/main/index.js，请先执行 npm run build')

let launched: LaunchedApp | null = null
test.afterEach(async () => { await closeApp(launched); launched = null })

test.describe('工作区创建/打开/导出/导入', () => {
  test('首次启动展示欢迎页', async () => {
    launched = await launchApp()
    await expect(launched.window.locator('.welcome, .app-shell').first()).toBeVisible()
    await expect(launched.window).toHaveTitle('Material Map')
  })

  test('创建工作区后进入应用主界面', async () => {
    launched = await launchApp()
    await seedWorkspace(launched.window, launched.workspaceRoot)
    await launched.window.reload()
    await launched.window.waitForLoadState('domcontentloaded')
    await expect(launched.window.locator('.app-shell, .sidebar').first()).toBeVisible()
  })

  test('导出并重新导入工作区后材料保持完整', async () => {
    launched = await launchApp()
    const { window, workspaceRoot } = launched
    await seedWorkspace(window, workspaceRoot)

    const exportFile = join(workspaceRoot, 'export.mmzip')
    const importedRoot = join(workspaceRoot, 'imported')
    const result = await window.evaluate(async ({ exportFile: file, importedRoot: dest }) => {
      const api = (window as unknown as { materialMap: import('./helpers').MaterialMapApi }).materialMap
      await api.workspace.export(file)
      const before = (await api.materials.list()).length
      await api.workspace.import(file, dest)
      const after = (await api.materials.list()).length
      return { before, after }
    }, { exportFile, importedRoot })

    expect(existsSync(exportFile)).toBe(true)
    expect(result.before).toBe(2)
    expect(result.after).toBe(2)
  })

  test('加密工作区可用密码重新打开', async () => {
    launched = await launchApp()
    const { window, workspaceRoot } = launched
    const encryptedRoot = join(workspaceRoot, 'encrypted')
    const reopened = await window.evaluate(async (root) => {
      const api = (window as unknown as { materialMap: import('./helpers').MaterialMapApi }).materialMap
      await api.workspace.create(root, 'Encrypted', 'e2e-password')
      await api.workspace.open(root, 'e2e-password')
      return (await api.materials.list()).length
    }, encryptedRoot)
    expect(reopened).toBe(0)
  })
})
