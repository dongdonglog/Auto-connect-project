# 05 AI Pipeline 设计

状态：AI 为可选增强。默认导入、实体提取、关系发现和 Explorer 排序不调用模型。

## 1. 触发点

| 场景 | 用户动作 | 输入 | 输出 |
| --- | --- | --- |
| 材料问答 | 在实验问答输入问题 | 工作台材料目录 + FTS/hybrid 的相关 chunk | 带引用回答或证据不足 |
| 关系解释 | Explorer 点击单条关系的 AI 图标 | 该关系证据 + 两侧最多 2 段、每段 500 字符 | 是否支持、语义、标签、说明、置信度 |

## 2. 关系解释流程

```text
selected relation
 -> load relation evidence
 -> materialEvidenceWindow(source, target)
 -> compact prompt + strict JSON schema
 -> validate material IDs, direction, enum and length
 -> return explanation to UI only
```

模型不得创建关系、修改关系状态或覆盖手动方向。用户决定是否固定或在画板修改正式关系。

## 3. 上下文与预算

- 材料问答每次都读取当前工作区的材料总数与目录；搜索、排序或当前可见卡片不改变问答范围。
- 目录包含标题、类型、状态和短摘要，按 24,000 字符预算截断；总数始终准确，并告知模型未展开的材料数。
- FTS/hybrid 命中时追加最多 6 个原文 chunk，内容性结论必须引用命中证据。未命中时仍调用模型，但只允许根据目录和摘要回答。
- 每侧最多 2 个 chunk，每个最多 500 字符。
- 结构化输出上限 450 tokens，温度 0.1。
- 提示词只接受关联两端的材料 ID；响应中其他 ID 一律拒绝。
- 本地证据文本优先，模型摘要只作为说明，不可替代证据。

## 4. Provider 与隐私

支持 Ollama、本地兼容 endpoint、Anthropic、Gemini 与 OpenAI-compatible。非 Ollama provider 必须检查 `allowCloud`；无 profile、模型、网络或超时时返回明确错误，Explorer 本地结果保持可用。API Key 仅由 `AppStore` 处理，不经过 renderer。

## 5. 失败与可观察性

- 90 秒请求超时；问答和单条解释均不落库。
- 解析 JSON 失败时最多进行一次格式修复；仍失败则返回错误，不猜测结构。
- `jobs` 与 `topic_analysis_runs` 仍可存在于旧工作区；0.1 主路径只记录单条解释的耗时/错误，且不把内容写入工作区数据库。

## 6. 后续替换策略

旧 `runTopicAnalysisV2`、`topic_relation_candidates` 和全主题批量精炼仅用于旧工作区数据兼容，不是 0.1 主路径。它们没有 renderer、preload 或公开 IPC 入口；0.1 仅公开实验问答和单条关系解释。
