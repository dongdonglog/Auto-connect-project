# 06 API 接口设计

状态：0.1 不提供网络 API。应用内 API 是 Electron renderer 经 preload 调用 main process 的 IPC 契约；同一组受限材料工具另提供 stdio MCP 适配器。

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
| `topics:proposals` | topicId | 读取当前主题的待审核 Agent 操作 |
| `topics:acceptProposal` | topicId, proposalId | 校验并通过可撤销画板命令应用提案 |
| `topics:archiveProposal` | topicId, proposalId | 忽略提案，不修改正式数据 |

四边端口值使用 `in-left/out-left/in-top/out-top/in-right/out-right/in-bottom/out-bottom`。连接的 source/target 和 handle 都必须持久化。

## 5. 搜索与 AI 接口

- `search(query)`：返回 `SearchHit[]`，FTS 优先，可选 hybrid。
- `ai:ask(question)`：返回 `GroundedAnswer`；区分 `workspace`、`general` 和 `action`，并返回实际模型及工具调用记录。
- `ai:explainRelation(relationId)`：返回 `RelationAiExplanation`，仅解释该关系，不写入或修改正式关系。
- `ai:tools:list` / `ai:tools:call`：列出或调用受限 Material Map 工具；API Key 和数据库句柄不进入 renderer。

## 6. stdio MCP

`npm run mcp -- /path/to/workspace` 启动 JSON-RPC stdio 服务，支持 `initialize`、`tools/list` 和 `tools/call`。工具按能力模块组织：材料目录/检索/读取、关系/证据、主题上下文，以及画板提案。MCP 与应用内 Agent 共用 `MaterialMapMcpServer` 的参数校验、返回预算和提案安全边界；`propose_topic_changes` 永远不会直接写正式关系、卡片或位置。用户只需用自然语言提问，由模型自行选择最少的相关模块。

## 7. 测试契约

每新增 channel 至少测试：preload 暴露、main handler 到 service 调用、非法 ID/枚举拒绝、旧工作区和未配置模型的失败路径。E2E 至少验证 create workspace、导入两份相关材料、读取关系、隐藏/固定关系。
