import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

export const builtMain = resolve('out/main/index.js')

/** 构建产物是否存在；缺失时所有 E2E 用例应 skip */
export const electronAvailable = existsSync(builtMain)

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  workspaceRoot: string
}

/** 通过 preload API 在工作区内准备数据，绕过原生文件对话框 */
export type MaterialMapApi = {
  workspace: {
    create(root: string, name: string, password?: string): Promise<unknown>
    open(root: string, password?: string): Promise<unknown>
    import(file: string, destination: string): Promise<unknown>
    export(destination: string): Promise<void>
  }
  materials: {
    list(): Promise<Array<{ id: string; title: string }>>
    note(title: string, text: string): Promise<unknown>
    document(title: string, text: string, format: 'md' | 'txt' | 'csv' | 'json' | 'html'): Promise<unknown>
    relations(materialId: string, limit?: number, includeHidden?: boolean): Promise<Array<{ id: string }>>
    relationEvidence(relationId: string): Promise<unknown>
    relationStatus(relationId: string, status: 'visible' | 'hidden' | 'fixed'): Promise<unknown>
  }
  topics: {
    create(name: string): Promise<{ id: string }>
    addMaterials(topicId: string, materialIds: string[]): Promise<unknown>
  }
}

export function apiOf(window: Page): Promise<MaterialMapApi> {
  return window.evaluate(() => (window as unknown as { materialMap: MaterialMapApi }).materialMap) as never
}

export async function launchApp(): Promise<LaunchedApp> {
  const app = await electron.launch({
    args: [builtMain],
    timeout: 20_000,
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'material-map-pw-'))
  return { app, window, workspaceRoot }
}

export async function closeApp(launched: LaunchedApp | null): Promise<void> {
  if (!launched) return
  await launched.app.close().catch(() => undefined)
  rmSync(launched.workspaceRoot, { recursive: true, force: true })
}

/** 在临时目录创建工作区并注入两份互相关联的材料 */
export async function seedWorkspace(window: Page, workspaceRoot: string): Promise<void> {
  await window.evaluate(async (root) => {
    const api = (window as unknown as { materialMap: MaterialMapApi }).materialMap
    await api.workspace.create(root, 'E2E Workspace')
    await api.materials.document('01-Alpha.md', '# Alpha\nSee [Beta](02-Beta.md).\nShared evidence token alpha-beta.', 'md')
    await api.materials.document('02-Beta.md', '# Beta\nBacklink to [Alpha](01-Alpha.md).\nShared evidence token alpha-beta.', 'md')
  }, workspaceRoot)
}
