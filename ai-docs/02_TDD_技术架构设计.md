# 02 TDD：技术架构设计

状态：0.1 实施基线。本文描述现有 Electron 应用及其下一步收敛目标，不引入 Go、Python 或远程后端。

## 1. 架构目标

- 本地优先：文件、解析文本、索引、关系和模型密钥均由本机工作区管理。
- 可解释：任何自动关系都必须能返回结构化证据与原文位置。
- 可降级：没有模型、向量索引或网络时，导入、FTS、探索和手动图谱仍可使用。
- 可迁移：SQLite schema 只增不破坏，旧工作区打开时自动补齐表和列。

## 2. 运行时边界

```text
React renderer
  |  typed preload IPC
Electron main
  |- WorkspaceService: workspace / import / parser / FTS / graph
  |- AiService: cited Q&A / one-relation explanation / proposals
  |- AppStore: model profiles and encrypted API keys
  |- chokidar: folder source watcher
  `- SQLite + FTS5 + optional sqlite-vec
```

renderer 不得直接读取 SQLite、文件系统、密钥或模型 endpoint。所有写入经 main process，所有 IPC 在 `src/preload/index.ts` 与 `index.d.ts` 同步声明。

## 3. 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `parsers.ts` | 解析 PDF、DOCX、Markdown、文本和链接元数据 | 关系判断 |
| `indexer.ts` | 分块、hash、token 化 | 业务持久化 |
| `WorkspaceService` | material、chunk、entity、relation、topic 与备份 | 模型推理 |
| `AiService` | 按需问答、解释、提案和 provider 适配 | 默认建图 |
| renderer Explorer | 阅读、相关材料、证据、隐藏/固定操作 | 计算关系分数 |
| TopicCanvas | 手动关系和已固定关系的编辑展示 | 自动全库候选 |

## 4. 导入到探索的数据流

```text
file/folder change
 -> parser extraction
 -> material + chunks + FTS update
 -> entity/mention extraction
 -> affected material relations + evidence recompute
 -> renderer query by selected material
```

索引按材料增量执行。关系重算只清理和重建该材料涉及的边，并保留原边的 `hidden` / `fixed` 状态。目录监听的短时间连续事件应去抖；解析失败应保留旧快照和错误状态。

## 5. 已实现与待完成

已实现：Electron/React、SQLite、FTS5、可选 sqlite-vec、解析器、文件夹监听、工作区包、实体/关系/证据表、Explorer、四边端口。

0.1 待完成：将旧主题候选和批量 AI 精炼从主路径移除；压测 20-50 份和高频变更目录；完成加密工作区 UI；拆分 `App.tsx` 遗留组件；完成 Windows 安装验收。

## 6. 非目标

- 不提供 HTTP REST server、多用户、云同步或协作权限。
- 不引入 Neo4j、Elasticsearch、Kafka、Milvus。
- 不在导入时调用 LLM，也不以 embedding 相似度单独生成正式关系。

## 7. 质量门槛

每次涉及主进程、IPC、schema 或关系计算的变更必须执行：`npx tsc --noEmit`、`npm test`、`npm run build`；核心流程变更额外执行 `npm run test:e2e`。
