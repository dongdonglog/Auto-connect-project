import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service'
import { AiService } from './ai-service'
import type { ModelSettings, ProviderProfileInput } from './types'
import { AppStore } from './app-store'

let window: BrowserWindow | null = null
const workspace = new WorkspaceService()
let appStore: AppStore
let ai: AiService

async function createAiRelationshipDemo(): Promise<{ id: string; name: string; description: string | null; createdAt: string }> {
  let topic = workspace.listTopics().find((item) => item.name === 'AI 关联演示')
  if (!topic) topic = workspace.createTopic('AI 关联演示', '围绕大模型求职材料建立可编辑的证据关系。')
  const notes = [
    ['目标岗位要求', '2026-07-24\n目标岗位：大模型运维工程师。岗位要求包括 GPU 服务稳定性、推理平台运维、Python 自动化和跨团队排障能力。简历中的 GPU 服务和推理平台经历可作为直接证据。'],
    ['项目证据：推理平台', '2026-07-25\n项目证据：负责企业内部大模型推理平台建设，涵盖 GPU 服务部署、监控告警、容量规划和故障排查。该项目对应目标岗位要求中的推理平台运维能力。'],
    ['简历修订建议', '2026-07-26\n建议在简历项目经历中量化 GPU 服务稳定性成果，并把推理平台建设、监控告警和故障排查放在同一项目证据段落，以回应目标岗位要求。'],
    ['模拟面试反馈', '2026-07-28\n面试反馈：需要更具体说明 GPU 故障排查流程、告警指标和推理服务容量规划。后续应从推理平台项目补充一个可复述的故障案例。'],
    ['下一步行动计划', '2026-07-30\n行动计划：先根据简历修订建议补充推理平台项目数据，再准备 GPU 故障案例，最后用目标岗位要求逐项核对并安排模拟面试。']
  ] as const
  const resume = workspace.listMaterials().find((item) => item.type === 'file' && item.title.includes('大模型简历'))
  if (resume) workspace.addToTopic(topic.id, resume.id)
  for (const [title, text] of notes) {
    let material = workspace.listMaterials().find((item) => item.type === 'note' && item.title === title)
    if (!material) material = await workspace.createNote(title, text)
    const date = text.match(/20\d{2}-\d{2}-\d{2}/)?.[0]
    if (date) workspace.updateMaterialDate(material.id, `${date}T00:00:00.000Z`)
    workspace.addToTopic(topic.id, material.id)
  }
  void ai.analyzeTopic(topic.id).catch(() => undefined)
  return topic
}

function createWindow(): void {
  window = new BrowserWindow({ width: 1440, height: 930, minWidth: 1050, minHeight: 700, title: 'Material Map', backgroundColor: '#f7f9fc', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false } })
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
  ipcMain.handle('dialog:savePackage', async () => (await dialog.showSaveDialog({ defaultPath: 'workspace.material-workspace', filters: [{ name: 'Material Map workspace', extensions: ['material-workspace'] }] })).filePath ?? null)
  ipcMain.handle('workspace:create', async (_event, root: string, name: string, password?: string) => { const summary = await workspace.create(root, name, password); appStore.rememberWorkspace(summary.root, summary.name); return summary })
  ipcMain.handle('workspace:open', async (_event, root: string, password?: string) => { const summary = await workspace.open(root, password); appStore.rememberWorkspace(summary.root, summary.name); return summary })
  ipcMain.handle('workspace:export', (_event, destination: string) => workspace.exportPackage(destination))
  ipcMain.handle('workspace:import', (_event, file: string, destination: string) => workspace.importPackage(file, destination))
  ipcMain.handle('materials:list', () => workspace.listMaterials())
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
  ipcMain.handle('topics:create', (_event, name: string, description: string) => workspace.createTopic(name, description))
  ipcMain.handle('topics:addMaterial', (_event, topicId: string, materialId: string, workstreamId?: string) => { workspace.addToTopic(topicId, materialId, workstreamId); void ai.analyze(topicId, materialId).catch(() => undefined) })
  ipcMain.handle('topics:map', (_event, topicId: string) => workspace.topicMap(topicId))
  ipcMain.handle('analysis:topic', (_event, topicId: string) => ai.analyzeTopic(topicId))
  ipcMain.handle('analysis:status', (_event, topicId: string) => workspace.analysisStatus(topicId))
  ipcMain.handle('demo:create', () => createAiRelationshipDemo())
  ipcMain.handle('workstreams:create', (_event, topicId: string, name: string) => workspace.createWorkstream(topicId, name))
  ipcMain.handle('workstreams:update', (_event, id: string, name: string) => workspace.updateWorkstream(id, name))
  ipcMain.handle('workstreams:moveMaterial', (_event, topicId: string, materialId: string, workstreamId: string | null) => workspace.moveMaterial(topicId, materialId, workstreamId))
  ipcMain.handle('relations:create', (_event, relation) => workspace.createRelation(relation))
  ipcMain.handle('relations:update', (_event, id: string, label: string) => workspace.updateRelation(id, label))
  ipcMain.handle('relations:delete', (_event, id: string) => workspace.deleteRelation(id))
  ipcMain.handle('search', (_event, query: string) => workspace.search(query))
  ipcMain.handle('jobs:list', () => workspace.listJobs())
  ipcMain.handle('settings:get', () => workspace.getSettings())
  ipcMain.handle('settings:save', (_event, settings: ModelSettings) => workspace.saveSettings(settings))
  ipcMain.handle('settings:test', (_event, settings: ModelSettings) => ai.testConnection(settings))
  ipcMain.handle('settings:validate', (_event, settings: ModelSettings, topicId?: string) => ai.validate(settings, topicId))
  ipcMain.handle('profiles:list', () => appStore.listProfiles())
  ipcMain.handle('profiles:presets', () => appStore.listPresets())
  ipcMain.handle('profiles:save', (_event, input: ProviderProfileInput) => appStore.saveProfile(input))
  ipcMain.handle('profiles:delete', (_event, id: string) => appStore.deleteProfile(id))
  ipcMain.handle('profiles:refreshModels', (_event, id: string) => ai.refreshModels(id))
  ipcMain.handle('ai-config:get', () => appStore.getActiveConfig())
  ipcMain.handle('ai-config:save', (_event, input: Omit<ProviderProfileInput, 'id' | 'name'>) => appStore.saveActiveConfig(input))
  ipcMain.handle('ai-config:clearLegacy', () => appStore.clearLegacyConfigs())
  ipcMain.handle('workspace:recent', () => appStore.listRecent())
  ipcMain.handle('workspace:forgetRecent', (_event, root: string) => appStore.forgetWorkspace(root))
  ipcMain.handle('ai:analyze', (_event, topicId: string, materialId: string) => ai.analyze(topicId, materialId))
  ipcMain.handle('ai:ask', (_event, question: string) => ai.ask(question))
}

function createMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '文件', submenu: [
    { label: '新建工作区', click: () => window?.webContents.send('workspace:new') },
    { label: '打开工作区...', click: () => window?.webContents.send('workspace:open') },
    { type: 'separator' },
    { label: '关闭工作区', click: () => window?.webContents.send('workspace:close') },
    { role: 'quit', label: '退出' }
  ] }]))
}

app.whenReady().then(() => { appStore = new AppStore(app.getPath('userData'), safeStorage); ai = new AiService(workspace, appStore); registerIpc(); createMenu(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
