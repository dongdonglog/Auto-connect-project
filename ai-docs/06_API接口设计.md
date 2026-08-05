# 06 API 接口设计

状态：0.1 不提供网络 API。本文中的 API 是 Electron renderer 经 preload 调用 main process 的 IPC 契约。

## 1. 契约原则

- channel 按资源命名，调用方只依赖 `window.materialMap` 的类型。
- 参数与返回值必须在 `src/main/types.ts`、`src/preload/index.ts`、`src/preload/index.d.ts` 和 renderer 类型中同步。
- main process 验证 ID、状态枚举、边界和权限；renderer 不信任自己传入的数据。
- 失败使用 rejected Promise，消息可展示但不得泄露 API Key 或完整本地路径以外的敏感数据。

## 2. 工作区与材料

| IPC | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `workspace:create` | root, name, password? | `WorkspaceSummary` | 创建本地工作区 |
| `workspace:open` | root, password? | `WorkspaceSummary` | schema 迁移和回填 |
| `workspace:export` | destination | void | 打包完整工作区 |
| `workspace:import` | package, destination | `WorkspaceSummary` | 解包并打开 |
| `materials:list` | - | `Material[]` | 工作台列表 |
| `materials:import` | file, duplicate | material/duplicate | 异步解析入队 |
| `materials:saveText` | id, title, text | `Material` | 保存可编辑材料并重新索引 |

## 3. Explorer 关系接口

```ts
materials.relations(materialId: string, limit?: number): Promise<MaterialRelation[]>
materials.relationEvidence(relationId: string): Promise<RelationshipEvidence[]>
materials.relationStatus(relationId: string, status: 'visible'|'hidden'|'fixed'): Promise<void>
materials.fixRelation(relationId: string): Promise<Relation>
ai.explainRelation(relationId: string): Promise<RelationAiExplanation>
```

`relations` 默认 limit 为 5，最大 20，过滤 `hidden`。`fixRelation` 必须幂等：已有同向手动关系时复用它；随后将自动关系置为 `fixed`。AI 解释不写入 schema，不改变关系状态。

## 4. 主题画板接口

| IPC | 关键参数 | 行为 |
| --- | --- | --- |
| `topics:map` | topicId | 返回成员、正式关系、样式和兼容候选 |
| `relations:create` | `Omit<Relation, id, createdAt>` | 建立正式关系，拒绝自环与同来源同方向重复 |
| `topics:updateRelationStyle` | topicId, relationId, style | 保存箭头、线型、颜色、source/target handle |
| `topics:positionMaterial` | topicId, materialId, x, y | 保存手动位置 |

四边端口值使用 `in-left/out-left/in-top/out-top/in-right/out-right/in-bottom/out-bottom`。连接的 source/target 和 handle 都必须持久化。

## 5. 搜索与 AI 接口

- `search(query)`：返回 `SearchHit[]`，FTS 优先，可选 hybrid。
- `ai:ask(question)`：返回 `GroundedAnswer`；没有命中时返回 `insufficient-evidence`，不虚构回答。
- `ai:explainRelation(relationId)`：返回 `RelationAiExplanation`，仅解释该关系，不写入或修改正式关系。
- 旧批量主题分析与主题工具仅保留历史数据兼容，不提供 renderer、preload 或公开 IPC 入口。

## 6. 测试契约

每新增 channel 至少测试：preload 暴露、main handler 到 service 调用、非法 ID/枚举拒绝、旧工作区和未配置模型的失败路径。E2E 至少验证 create workspace、导入两份相关材料、读取关系、隐藏/固定关系。
