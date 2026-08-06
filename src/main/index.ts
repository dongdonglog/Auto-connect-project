import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service'
import { AiService } from './ai-service'
import type { KnowledgeQuestion, ModelSettings, ProviderProfileInput } from './types'
import { AppStore } from './app-store'
import { MaterialMapMcpServer } from './material-mcp'
import { resetLearningPathDemo } from './demo-service'
import { assertEnum, assertId, assertLimit, assertNumber, assertString, IpcValidationError } from './ipc-validation'

const MATERIAL_RELATION_STATUSES = ['visible', 'hidden', 'fixed'] as const

let window: BrowserWindow | null = null
const workspace = new WorkspaceService()
let appStore: AppStore
let ai: AiService
let materialTools: MaterialMapMcpServer


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
  ipcMain.handle('workspace:inspect', (_event, root: string) => workspace.inspectWorkspace(root))
  ipcMain.handle('workspace:inspectPackage', (_event, file: string) => workspace.inspectPackage(file))
  ipcMain.handle('workspace:open', async (_event, root: string, password?: string) => { const summary = await workspace.open(root, password); appStore.rememberWorkspace(summary.root, summary.name); return summary })
  ipcMain.handle('workspace:export', (_event, destination: string) => workspace.exportPackage(destination))
  ipcMain.handle('workspace:import', async (_event, file: string, destination: string, password?: string) => {
    const summary = await workspace.importPackage(file, destination, password)
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
  ipcMain.handle('materials:relations', (_event, materialId: string, limit?: number, includeHidden?: boolean) => workspace.listMaterialRelations(assertId(materialId, '材料标识'), assertLimit(limit, 20), includeHidden === true))
  ipcMain.handle('materials:relationEvidence', (_event, relationId: string) => workspace.listRelationshipEvidence(assertId(relationId, '关系标识')))
  ipcMain.handle('materials:relationStatus', (_event, relationId: string, status) => workspace.updateMaterialRelationStatus(assertId(relationId, '关系标识'), assertEnum(status, MATERIAL_RELATION_STATUSES, '关系状态')))
  ipcMain.handle('materials:fixRelation', (_event, relationId: string, topicId?: string) => workspace.fixMaterialRelation(assertId(relationId, '关系标识'), topicId === undefined || topicId === null ? undefined : assertId(topicId, '主题标识')))
  ipcMain.handle('sources:list', () => workspace.listFolderSources())
  ipcMain.handle('sources:add', (_event, input) => workspace.addFolderSource(input))
  ipcMain.handle('sources:update', (_event, id: string, input) => workspace.updateFolderSource(id, input))
  ipcMain.handle('sources:remove', (_event, id: string) => workspace.removeFolderSource(id))
  ipcMain.handle('sources:rescan', (_event, id: string) => workspace.rescanFolderSource(id))
  ipcMain.handle('sources:pause', (_event, id: string) => workspace.pauseFolderSource(id))
  ipcMain.handle('sources:capability', () => workspace.indexCapability())
  ipcMain.handle('topics:list', () => workspace.listTopics())
  ipcMain.handle('topics:listArchived', () => workspace.listArchivedTopics())
  ipcMain.handle('topics:create', (_event, name: string, description: string) => workspace.createTopic(assertString(name, '主题名称', 80), assertString(description ?? '', '主题描述', 500)))
  ipcMain.handle('topics:addMaterial', (_event, topicId: string, materialId: string, workstreamId?: string) => workspace.addToTopic(assertId(topicId, '主题标识'), assertId(materialId, '材料标识'), workstreamId === undefined || workstreamId === null ? undefined : assertId(workstreamId, '分组标识')))
  ipcMain.handle('topics:addMaterials', (_event, topicId: string, materialIds: string[]) => { if (!Array.isArray(materialIds) || materialIds.length > 200) throw new IpcValidationError('材料列表无效。'); return workspace.addMaterialsToTopic(assertId(topicId, '主题标识'), materialIds.map((materialId) => assertId(materialId, '材料标识'))) })
  ipcMain.handle('topics:forMaterial', (_event, materialId: string) => workspace.topicsForMaterial(assertId(materialId, '材料标识')))
  ipcMain.handle('topics:removeMaterial', (_event, topicId: string, materialId: string) => workspace.removeFromTopic(assertId(topicId, '主题标识'), assertId(materialId, '材料标识')))
  ipcMain.handle('topics:archive', (_event, topicId: string) => workspace.archiveTopic(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:restore', (_event, topicId: string) => workspace.restoreTopic(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:deleteArchived', (_event, topicId: string) => workspace.deleteArchivedTopic(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:map', (_event, topicId: string) => workspace.topicMap(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:rebuildTopology', (_event, topicId: string) => workspace.rebuildSystemTopology(assertId(topicId, '主题标识')))
  ipcMain.handle('demo:create', () => resetLearningPathDemo(workspace))
  ipcMain.handle('workstreams:create', (_event, topicId: string, name: string) => workspace.createWorkstream(topicId, name))
  ipcMain.handle('workstreams:update', (_event, id: string, name: string) => workspace.updateWorkstream(id, name))
  ipcMain.handle('workstreams:delete', (_event, id: string) => workspace.deleteWorkstream(id))
  ipcMain.handle('workstreams:moveMaterial', (_event, topicId: string, materialId: string, workstreamId: string | null) => workspace.moveMaterial(topicId, materialId, workstreamId))
  ipcMain.handle('topics:positionMaterial', (_event, topicId: string, materialId: string, x: number, y: number) => workspace.positionMaterial(assertId(topicId, '主题标识'), assertId(materialId, '材料标识'), assertNumber(x, '横坐标'), assertNumber(y, '纵坐标')))
  ipcMain.handle('topics:layout', (_event, topicId: string, positions: Array<{ materialId: string; x: number; y: number }>) => { if (!Array.isArray(positions) || positions.length > 500) throw new IpcValidationError('布局数据无效。'); return workspace.positionMaterials(assertId(topicId, '主题标识'), positions.map((position) => ({ materialId: assertId(position?.materialId, '材料标识'), x: assertNumber(position?.x, '横坐标'), y: assertNumber(position?.y, '纵坐标') }))) })
  ipcMain.handle('topics:updateCardStyle', (_event, topicId: string, materialId: string, input: { color?: string | null; tags?: string[]; note?: string | null }) => workspace.updateCardStyle(assertId(topicId, '主题标识'), assertId(materialId, '材料标识'), input))
  ipcMain.handle('topics:updateCardOrder', (_event, topicId: string, materialId: string, sequence: number) => workspace.updateCardOrder(assertId(topicId, '主题标识'), assertId(materialId, '材料标识'), assertNumber(sequence, '排序序号')))
  ipcMain.handle('topics:resetCardOrder', (_event, topicId: string) => workspace.resetCardOrder(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:updateRelationStyle', (_event, topicId: string, relationId: string, input) => workspace.updateRelationStyle(assertId(topicId, '主题标识'), assertId(relationId, '关系标识'), input))
  ipcMain.handle('topics:executeCommand', (_event, topicId: string, command) => {
    if (!command || typeof command !== 'object' || Array.isArray(command) || !('kind' in command) || !('payload' in command) || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) throw new IpcValidationError('画板编辑命令无效。')
    return workspace.executeTopicEditorCommand(assertId(topicId, '主题标识'), { kind: assertString(command.kind, '命令类型', 48), payload: command.payload as Record<string, unknown> })
  })
  ipcMain.handle('topics:undo', (_event, topicId: string) => workspace.undoTopicEditorCommand(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:redo', (_event, topicId: string) => workspace.redoTopicEditorCommand(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:history', (_event, topicId: string) => workspace.topicHistoryStatus(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:proposals', (_event, topicId: string) => workspace.listTopicProposals(assertId(topicId, '主题标识')))
  ipcMain.handle('topics:acceptProposal', (_event, topicId: string, proposalId: string) => workspace.acceptTopicProposal(assertId(topicId, '主题标识'), assertId(proposalId, '提案标识')))
  ipcMain.handle('topics:archiveProposal', (_event, topicId: string, proposalId: string) => workspace.archiveTopicProposal(assertId(topicId, '主题标识'), assertId(proposalId, '提案标识')))
  ipcMain.handle('relations:create', (_event, relation) => workspace.createRelation({ ...relation, sourceMaterialId: assertId(relation?.sourceMaterialId, '来源材料标识'), targetMaterialId: assertId(relation?.targetMaterialId, '目标材料标识'), label: assertString(relation?.label, '关系标签', 64) }))
  ipcMain.handle('relations:update', (_event, id: string, label: string) => workspace.updateRelation(id, label))
  ipcMain.handle('relations:delete', (_event, id: string) => workspace.deleteRelation(id))
  ipcMain.handle('search', (_event, query: string) => workspace.searchKnowledge(query))
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
  ipcMain.handle('ai:ask', (_event, question: string | KnowledgeQuestion) => ai.ask(question))
  ipcMain.handle('ai:tools:list', () => materialTools.listTools())
  ipcMain.handle('ai:tools:call', (_event, name: string, args: Record<string, unknown>) => materialTools.call(assertString(name, '工具名称', 80), args && typeof args === 'object' && !Array.isArray(args) ? args : {}))
  ipcMain.handle('ai:explainRelation', (_event, relationId: string) => ai.explainMaterialRelation(assertId(relationId, '关系标识')))
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

app.whenReady().then(() => { appStore = new AppStore(app.getPath('userData'), safeStorage); ai = new AiService(workspace, appStore); materialTools = new MaterialMapMcpServer(workspace); registerIpc(); createMenu(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { workspace.close(); if (process.platform !== 'darwin') app.quit() })
