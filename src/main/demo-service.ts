import type { Material, Topic } from './types'
import { WorkspaceService } from './workspace-service'

const steps = [
  ['学习目标：完成全栈作品', '2026-08-01\n目标：在六周内完成可部署的本地优先知识管理应用。'],
  ['前置知识：JavaScript 与 Git', '2026-08-03\n复习模块、异步编程、分支协作和提交规范。'],
  ['核心概念：React 状态管理', '2026-08-06\n理解受控组件、派生状态、数据流和副作用。'],
  ['实践项目：材料画板', '2026-08-12\n实现材料导入、主题画板、卡片拖拽和关系连线。'],
  ['阶段测验：代码与交互复盘', '2026-08-18\n检查类型、测试、错误提示和键盘操作。'],
  ['错题复习：问题清单', '2026-08-21\n整理问题原因、修复方案和回归用例。'],
  ['最终作品：发布与讲解', '2026-08-28\n完成可运行版本、使用说明和五分钟演示。']
] as const

export async function resetLearningPathDemo(workspace: WorkspaceService): Promise<Topic> {
  let topic = workspace.listTopics().find((item) => item.name === '学习路径演示')
  if (!topic) topic = workspace.createTopic('学习路径演示', '按步骤完成材料整理、连线和复盘。')
  // Demo content is owned by this resettable walkthrough. A reset intentionally
  // removes every old demo edge so the 1→2→…→7 path is always complete.
  else workspace.resetTopicBoard(topic.id, true)
  const materials: Material[] = []
  for (const [index, [title, text]] of steps.entries()) {
    let material = workspace.listMaterials().find((item) => item.type === 'note' && item.title === title)
    if (!material) material = await workspace.createNote(title, text)
    workspace.updateMaterialDate(material.id, `${text.slice(0, 10)}T00:00:00.000Z`)
    workspace.addToTopic(topic.id, material.id)
    workspace.positionMaterial(topic.id, material.id, 120 + index * 310, 170)
    materials.push(material)
  }
  // Clear every old relationship among the seven demo cards. This is purposely
  // broader than a topic reset, because prior app versions stored relations
  // globally and can otherwise trip duplicate validation on recreation.
  workspace.deleteRelationsAmong(materials.map((material) => material.id))
  for (let index = 0; index < materials.length - 1; index += 1) {
    const sourceMaterialId = materials[index].id; const targetMaterialId = materials[index + 1].id
    workspace.createRelation({ sourceMaterialId, targetMaterialId, label: '下一步', relationType: 'next', evidenceText: '学习路径中的顺序依赖。', evidenceMaterialId: sourceMaterialId, confidence: 1, createdBy: 'manual' })
  }
  return workspace.topicMap(topic.id).topic
}
