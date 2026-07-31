import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service'
import { AiService } from './ai-service'
import type { ModelSettings, ProviderProfileInput } from './types'
import { AppStore } from './app-store'
import { resetLearningPathDemo } from './demo-service'

let window: BrowserWindow | null = null
const workspace = new WorkspaceService()
let appStore: AppStore
let ai: AiService


function createWindow(): void {
  window = new BrowserWindow({ width: 1440, height: 930, minWidth: 1050, minHeight: 700, title: 'Material Map', backgroundColor: '#f7f9fc', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false } })
  // Native Edit-menu roles deliver Cmd/Ctrl clipboard events to focused inputs.
  // Do not intercept them here: doing so prevents controlled React fields from
  // receiving their normal paste event on macOS and Windows.
  window.webContents.setWindowOpenHandler(({ url }) => { void require('electron').shell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('dialog:chooseDirectory', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择工作区文件夹',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('dialog:chooseFiles', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })).filePaths)
  ipcMain.handle('dialog:choosePackage', async () => {
    const result = await dialog.showOpenDialog({ filters: [{ name: 'Material Map workspace', extensions: ['material-workspace'] }], properties: ['openFile'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('dialog:savePackage', async () => (await dialog.showSaveDialog({ defaultPath: 'workspace.material-workspace', filters: [{ name: 'Material Map workspace', extensions: ['material-workspace'] }] })).filePath ?? null)
  ipcMain.handle('workspace:create', async (_event, root: string, name: string, password?: string) => { const summary = await workspace.create(root, name, password); appStore.rememberWorkspace(summary.root, summary.name); return summary })
  ipcMain.handle('workspace:open', async (_event, root: string, password?: string) => { const summary = await workspace.open(root, password); appStore.rememberWorkspace(summary.root, summary.name); return summary })
  ipcMain.handle('workspace:export', (_event, destination: string) => workspace.exportPackage(destination))
  ipcMain.handle('workspace:import', async (_event, file: string, destination: string) => {
    const summary = await workspace.importPackage(file, destination)
    appStore.rememberWorkspace(summary.root, summary.name)
    return summary
  })
  ipcMain.handle('materials:list', () => workspace.listMaterials())
  ipcMain.handle('materials:listWithTopics', () => workspace.listMaterialsWithTopics())
  ipcMain.handle('materials:import', (_event, file: string, duplicate: boolean) => workspace.importFile(file, duplicate))
  ipcMain.handle('materials:note', (_event, title: string, text: string) => workspace.createNote(title, text))
  ipcMain.handle('materials:document', (_event, title: string, text: string, format: 'md' | 'txt' | 'csv' | 'json' | 'html') => workspace.createDocument(title, text, format))
  ipcMain.handle('materials:saveText', (_event, id: string, title: string, text: string) => workspace.saveTextMaterial(id, title, text))
  ipcMain.handle('materials:open', (_event, id: string) => { const material = workspace.getMaterial(id); if (!material) throw new Error('Material not found.'); return shell.openPath(material.sourcePath ?? join(workspace.summary().root, 'materials', material.storedPath ?? '')) })
  ipcMain.handle('materials:rename', (_event, id: string, title: string) => workspace.renameMaterial(id, title))
  ipcMain.handle('materials:delete', (_event, id: string) => workspace.deleteMaterial(id))
  ipcMain.handle('materials:importNewVersion', (_event, id: string) => workspace.importNewVersion(id))
  ipcMain.handle('materials:link', (_event, url: string) => workspace.createLink(url))
  ipcMain.handle('materials:retry', (_event, id: string) => workspace.retry(id))
  ipcMain.handle('materials:date', (_event, id: string, date: string) => workspace.updateMaterialDate(id, date))
  ipcMain.handle('topics:list', () => workspace.listTopics())
  ipcMain.handle('topics:listArchived', () => workspace.listArchivedTopics())
  ipcMain.handle('topics:create', (_event, name: string, description: string) => workspace.createTopic(name, description))
  ipcMain.handle('topics:addMaterial', (_event, topicId: string, materialId: string, workstreamId?: string) => workspace.addToTopic(topicId, materialId, workstreamId))
  ipcMain.handle('topics:addMaterials', (_event, topicId: string, materialIds: string[]) => workspace.addMaterialsToTopic(topicId, materialIds))
  ipcMain.handle('topics:forMaterial', (_event, materialId: string) => workspace.topicsForMaterial(materialId))
  ipcMain.handle('topics:removeMaterial', (_event, topicId: string, materialId: string) => workspace.removeFromTopic(topicId, materialId))
  ipcMain.handle('topics:archive', (_event, topicId: string) => workspace.archiveTopic(topicId))
  ipcMain.handle('topics:restore', (_event, topicId: string) => workspace.restoreTopic(topicId))
  ipcMain.handle('topics:deleteArchived', (_event, topicId: string) => workspace.deleteArchivedTopic(topicId))
  ipcMain.handle('topics:map', (_event, topicId: string) => workspace.topicMap(topicId))
  ipcMain.handle('analysis:topic', (_event, topicId: string) => ai.analyzeTopic(topicId))
  ipcMain.handle('analysis:status', (_event, topicId: string) => workspace.analysisStatus(topicId))
  ipcMain.handle('demo:create', () => resetLearningPathDemo(workspace))
  ipcMain.handle('workstreams:create', (_event, topicId: string, name: string) => workspace.createWorkstream(topicId, name))
  ipcMain.handle('workstreams:update', (_event, id: string, name: string) => workspace.updateWorkstream(id, name))
  ipcMain.handle('workstreams:delete', (_event, id: string) => workspace.deleteWorkstream(id))
  ipcMain.handle('workstreams:moveMaterial', (_event, topicId: string, materialId: string, workstreamId: string | null) => workspace.moveMaterial(topicId, materialId, workstreamId))
  ipcMain.handle('topics:positionMaterial', (_event, topicId: string, materialId: string, x: number, y: number) => workspace.positionMaterial(topicId, materialId, x, y))
  ipcMain.handle('topics:layout', (_event, topicId: string, positions: Array<{ materialId: string; x: number; y: number }>) => workspace.positionMaterials(topicId, positions))
  ipcMain.handle('topics:updateCardStyle', (_event, topicId: string, materialId: string, input: { color?: string | null; tags?: string[]; note?: string | null }) => workspace.updateCardStyle(topicId, materialId, input))
  ipcMain.handle('topics:updateCardOrder', (_event, topicId: string, materialId: string, sequence: number) => workspace.updateCardOrder(topicId, materialId, sequence))
  ipcMain.handle('topics:resetCardOrder', (_event, topicId: string) => workspace.resetCardOrder(topicId))
  ipcMain.handle('topics:updateRelationStyle', (_event, topicId: string, relationId: string, input) => workspace.updateRelationStyle(topicId, relationId, input))
  ipcMain.handle('relations:create', (_event, relation) => workspace.createRelation(relation))
  ipcMain.handle('relations:update', (_event, id: string, label: string) => workspace.updateRelation(id, label))
  ipcMain.handle('relations:delete', (_event, id: string) => workspace.deleteRelation(id))
  ipcMain.handle('search', (_event, query: string) => workspace.search(query))
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('jobs:list', () => workspace.listJobs())
  ipcMain.handle('settings:get', () => workspace.getSettings())
  ipcMain.handle('settings:save', (_event, settings: ModelSettings) => workspace.saveSettings(settings))
  ipcMain.handle('settings:test', (_event, settings: ModelSettings) => ai.testConnection(settings))
  ipcMain.handle('settings:validate', (_event, settings: ModelSettings, topicId?: string) => ai.validate(settings, topicId))
  ipcMain.handle('profiles:list', () => appStore.listProfiles())
  ipcMain.handle('profiles:presets', () => appStore.listPresets())
  ipcMain.handle('profiles:save', (_event, input: ProviderProfileInput) => ai.saveProfileWithModels(input))
  ipcMain.handle('profiles:delete', (_event, id: string) => appStore.deleteProfile(id))
  ipcMain.handle('profiles:refreshModels', (_event, id: string) => ai.refreshModels(id))
  ipcMain.handle('ai-config:get', () => appStore.getActiveConfig())
  ipcMain.handle('ai-config:save', (_event, input: Omit<ProviderProfileInput, 'id' | 'name'>) => appStore.saveActiveConfig(input))
  ipcMain.handle('ai-config:clearLegacy', () => appStore.clearLegacyConfigs())
  ipcMain.handle('workspace:recent', () => appStore.listRecent())
  ipcMain.handle('workspace:forgetRecent', (_event, root: string) => appStore.forgetWorkspace(root))
  ipcMain.handle('ai:analyze', (_event, topicId: string, materialId: string) => ai.analyze(topicId, materialId))
  ipcMain.handle('ai:ask', (_event, question: string) => ai.ask(question))
  ipcMain.handle('ai:planTopicOperation', (_event, topicId: string, question: string) => ai.planTopicOperation(topicId, question))
}

function createMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [
    { label: '新建工作区', click: () => window?.webContents.send('workspace:new') },
    { label: '打开工作区...', click: () => window?.webContents.send('workspace:open') },
    { type: 'separator' },
    { label: '关闭工作区', click: () => window?.webContents.send('workspace:close') },
    { role: 'quit', label: '退出' }
  ] }, { label: '编辑', submenu: [
    { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
    { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' }
  ] }]))
}

app.whenReady().then(() => { appStore = new AppStore(app.getPath('userData'), safeStorage); ai = new AiService(workspace, appStore); registerIpc(); createMenu(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
