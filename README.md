<p align="center">
  <img src="docs/logo.svg" alt="Material Map" width="120" />
</p>

<h1 align="center">Material Map</h1>

<p align="center">
  <strong>本地优先 · 证据驱动 · 可解释的材料关系探索器</strong>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-Windows%2010%2B-lightgrey" alt="Platform" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/electron-33%2B-47848f?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61dafb?logo=react" alt="React" />
</p>

<p align="center">
  <em>打开一份材料，1 秒内看清它和什么有关、证据在哪。</em>
</p>

---

> **⚠️ 当前状态：0.1 MVP 开发中。** 核心闭环（导入 → 探索 → 固定 → 画板编辑）已可运行，部分功能仍在完善。详见 [发布路线图](#发布路线图)。

## 为什么需要 Material Map？

当本地材料积累到几十上百份时，你会遇到这些困境：

- 🔍 **全文检索只能找到关键词，看不到关联** — 搜索 "支付" 找到 30 篇文档，但它们之间什么关系？
- 🤔 **相似度推荐缺少证据** — 算法告诉你 A 和 B 相关，但不告诉你为什么
- 💸 **AI 全量分析太慢、太贵、噪声太多** — 一次性分析所有材料既费时费钱，又容易产生虚假关联
- 🎛️ **你整理的关系应该由你掌控** — 手动确认过的连线不该被系统悄悄覆盖

Material Map 不做一个「全自动知识图谱」，而是做一个**探索工具**：你打开材料，它告诉你证据充分的关联，你可以选择固定、隐藏或继续深入，最后把确认的关系沉淀到主题画板中。

## 与同类产品的区别

| | Material Map | Obsidian | Logseq | NotebookLM |
|---|---|---|---|---|
| **核心交互** | 以材料为中心探索关系 | 以笔记为中心双向链接 | 以大纲为中心块引用 | 以聊天为中心的 RAG |
| **关系发现** | 显式引用 + 受控实体，每条关系带证据 | 手动 `[[link]]` | 手动 `[[link]]` + 块引用 | AI 自动生成 |
| **离线可用** | ✅ 无需网络 | ✅ | ✅ | ❌ 需要云端 |
| **AI 角色** | 按需解释单条关系 | 社区插件 | 社区插件 | 核心依赖 AI |
| **数据存储** | 本地 SQLite | 本地 Markdown 文件 | 本地 Markdown 文件 | 云端 |
| **目标场景** | 技术文档、代码、项目资料的关系探索 | 个人知识管理 | 大纲式笔记 | 文档对话 |

## 核心功能

### 📥 材料导入与管理
- 支持 **Markdown、TXT、CSV、JSON、HTML、PDF、DOCX** 格式
- 文件夹监听：新增、修改、删除自动增量同步
- 材料失联后保留快照，不丢数据
- 工作区导出/恢复，支持可选加密

### 🔗 可解释的关系发现
- **显式引用优先**：自动识别 Markdown 链接、相对路径、代码 import 等文件引用
- **实体共现分析**：提取受控技术实体（项目名、模块名、框架等），找出真正相关的材料
- **每条关系都有证据**：展开即见原文引用与可跳转位置
- **反噪声机制**：通用高频词不产生关系，最多展示 5 条结果

### 🎨 主题画板
- 基于 React Flow 的交互式画布
- 四边端口任意组合创建正式关系
- 编辑关系标签、方向、颜色、线型
- DAG 自动层级布局

### 🤖 可选 AI 增强
- AI **默认关闭**，你完全掌控何时调用
- 单条关系请求解释时，仅发送该关系的紧凑证据窗口
- AI 失败不影响本地探索、阅读和画板操作
- 实验性材料问答（基于本地检索 + 引用回答）

## 快速开始

### 下载安装

从 [Releases](https://github.com/your-org/material-map/releases) 页面下载最新安装包：

- **NSIS 安装版** (`Material-Map-Setup-x.x.x.exe`)：标准安装，支持自定义安装路径
- **Portable 便携版** (`Material-Map-x.x.x.exe`)：解压即用，无需安装

> 当前仅支持 Windows 10/11。macOS 和 Linux 支持在后续版本规划中。

### 基本使用

```
1. 启动应用 → 创建或打开工作区
2. 导入本地文件夹或拖入文件
3. 在工作台点击任意材料 → 进入「探索」
4. 右侧查看关联材料及证据 → 固定感兴趣的、隐藏不相关的
5. 固定的关系进入「主题画板」→ 手动编辑、连线、布局
```

## 开发指南

### 环境要求

- **Node.js** 24+
- **操作系统** Windows 10/11（开发可在 macOS/Linux 进行，但打包仅支持 Windows）

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/your-org/material-map.git
cd material-map

# 安装依赖
npm install

# 启动开发模式（热重载）
npm run dev
```

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Electron 开发模式 |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm test` | 运行单元测试（Vitest） |
| `npm run test:e2e` | 端到端测试（需先构建） |
| `npm run build` | 生产构建 |
| `npm run package` | 构建 + 打包 Windows 安装包 |

## 技术栈

| 层 | 技术 |
|---|---|
| **桌面框架** | Electron 33+ |
| **前端** | React 19 + TypeScript |
| **画布** | @xyflow/react (React Flow) |
| **布局算法** | @dagrejs/dagre |
| **数据库** | SQLite + FTS5 全文检索 |
| **向量检索（可选）** | sqlite-vec |
| **文件监听** | chokidar |
| **文档解析** | mammoth (DOCX)、pdf-parse (PDF)、papaparse (CSV) |
| **Markdown 渲染** | react-markdown + remark-gfm + rehype-highlight |
| **测试** | Vitest + Playwright |
| **构建** | electron-vite + electron-builder |

## 架构概览

```
┌─────────────────────────────────┐
│  Renderer (React / React Flow)  │
│  ├─ Workbench    工作台          │
│  ├─ Explorer     关系探索        │
│  ├─ Topic Canvas 主题画板        │
│  └─ Q&A          实验问答        │
└────────────┬────────────────────┘
             │  typed preload IPC
┌────────────▼────────────────────┐
│  Main Process                   │
│  ├─ WorkspaceService            │
│  │   └─ SQLite · FTS5 · Entity · Relation · Evidence
│  ├─ AiService                   │
│  │   └─ 问答 · 单条关系解释     │
│  ├─ AppStore (模型配置 & 密钥)  │
│  └─ chokidar (文件夹监听)       │
└─────────────────────────────────┘
```

关键模块：

- `src/main/workspace-service.ts` — 工作区、迁移、索引、关系数据主服务
- `src/main/ai-service.ts` — 带证据问答与单条关系解释
- `src/shared/topic-topology.ts` — 主进程与画布共用的稳定排序与系统布局
- `src/renderer/src/features/topics/` — 主题画板与关系交互
- `src/renderer/src/features/workbench/` — 材料工作台
- `src/e2e/` — 真实 Electron 进程端到端测试

## 产品原则

1. **本地优先**：原始文件留在用户文件夹，工作区只保存元数据、索引和关系
2. **无 AI 可用**：索引、检索、关系发现和画板不依赖网络或 API Key
3. **证据优先**：每条自动关系必须展示材料或段落证据；证据不足明确拒答
4. **用户优先**：手动关系和手动位置永不被他方覆盖
5. **可恢复**：工作区可导出、导入和可选加密；失联文件保留快照

## 文档

完整的产品与技术文档见 [`ai-docs/`](./ai-docs/)：

| 文档 | 说明 |
|---|---|
| [PRD](./ai-docs/01_PRD.md) | 产品愿景、用户与功能边界 |
| [技术架构](./ai-docs/02_TDD_技术架构设计.md) | Electron 本地架构与运行时边界 |
| [Graph 模型](./ai-docs/03_Graph模型设计.md) | Material、Entity、Relation 与 Topic 模型 |
| [数据库 Schema](./ai-docs/04_数据库Schema设计.md) | SQLite 表、索引、迁移与导入导出 |
| [AI Pipeline](./ai-docs/05_AI_Pipeline设计.md) | 按需解释、问答与隐私约束 |
| [API 接口](./ai-docs/06_API接口设计.md) | preload IPC 类型契约 |
| [UI 交互](./ai-docs/07_UI交互设计.md) | 工作台、Explorer、画板和问答交互 |
| [MVP 计划](./ai-docs/08_MVP开发计划.md) | 0.1 里程碑、验收与性能目标 |

## 发布路线图

### v0.1 MVP（当前）

- [x] 工作区创建、打开、导入导出与加密
- [x] 材料导入与多格式解析（Markdown/PDF/DOCX/CSV 等）
- [x] SQLite FTS5 全文检索 + 可选 sqlite-vec 向量增强
- [x] 显式引用与实体共现关系发现
- [x] Explorer 三栏探索（材料列表 / 阅读器 / 关联与证据）
- [x] 主题画板（React Flow + 四边端口 + 手动连线）
- [x] 可选 AI 解释与实验问答
- [x] 文件夹监听增量同步
- [x] 加密工作区 UI 接入
- [ ] Windows NSIS/portable 安装包验收
- [ ] 旧组件清理与 `App.tsx` 拆分
- [ ] 大图性能压测与路由优化

### 未来版本

- 阅读路径自动生成
- macOS / Linux 支持
- 跨工作区关系查询
- 受限 Agent 自动补全（需用户确认）

## 贡献指南

欢迎提交 Issue 和 Pull Request！提交前请注意：

1. **不要提交** API Key、工作区数据库、导出包、用户材料、`release/` 或 `out/` 目录
2. 修改核心服务时补充或更新对应测试
3. 每项变更至少通过 `npx tsc --noEmit`、`npm test` 和 `npm run build`
4. 核心流程变更额外执行 `npm run test:e2e`
5. AI 行为必须有明确的用户触发点、云端同意检查和失败回退

推荐提交格式：

```text
feat(explorer): add evidence highlight and jump-to-source
fix(search): retain snapshot citations for unavailable files
test(workspace): cover encrypted migration fallback
```

## 数据与隐私

- 所有 SQLite 工作区、解析文本、索引和关系**默认保存在本地**
- 云端模型**仅在用户启用并明确同意后**接收本次请求必要的文本片段
- 项目不提供云同步、多人协作或托管后端
- 建议定期通过工作区导出功能备份数据

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ for people who want to understand their materials, not just search them.</sub>
</p>
