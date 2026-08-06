# 05 AI Pipeline 设计

状态：AI 为可选增强。默认导入、实体提取、关系发现和 Explorer 排序不调用模型。

## 1. 触发点

| 场景 | 用户动作 | 输入 | 输出 |
| --- | --- | --- |
| 材料问答 | 在知识库问答输入问题 | 工作台材料目录 + 混合召回的相关 chunk + 邻近证据窗口 | 带可核验来源回答或证据不足 |
| 通用问答 | 提出与工作区无关的问题 | 会话上下文 + 模型通用知识 | 标记为“模型通用回答”，不附本地来源 |
| 工作区操作 | 明确要求整理主题、关系、顺序、样式或布局 | 材料工具 + 主题上下文工具 | 持久化待审核提案，不直接修改正式数据 |
| 关系解释 | Explorer 点击单条关系的 AI 图标 | 该关系证据 + 两侧最多 2 段、每段 500 字符 | 是否支持、语义、标签、说明、置信度 |

问答采用最多 6 轮的结构化工具循环。模型可调用 `list_topics`、`list_materials`、`search_materials`、`read_material`、`list_material_relations`、`get_relation_evidence`、`get_topic_context` 和 `propose_topic_changes`；每次调用都在 main process 校验并限制返回规模。

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
- 本地检索先扩大候选，再按问题短语、标题、章节和正文重排，并限制同一材料最多占两个结果；配置 embedding 时用 Reciprocal Rank Fusion 融合关键词和向量召回。
- 命中后为每个结果补充前后相邻 chunk，最多发送 10 段连续证据窗口，避免把一个章节截成孤立句子。未命中时仍调用模型，但只允许根据目录和摘要回答。
- 来源绑定由应用负责：模型可返回 `{"answer":"...","sources":["materialId:chunkId"]}`，也兼容普通文本；模型漏写或写错 marker 时，应用从真实召回结果推断最多 3 个来源，绝不因为格式问题丢弃有效回答。
- 每侧最多 2 个 chunk，每个最多 500 字符。
- 结构化输出上限 450 tokens，温度 0.1。
- 提示词只接受关联两端的材料 ID；响应中其他 ID 一律拒绝。
- 本地证据文本优先，模型摘要只作为说明，不可替代证据。

## 4. Provider 与隐私

支持 Ollama、本地兼容 endpoint、Anthropic、Gemini 与 OpenAI-compatible。非 Ollama provider 必须检查 `allowCloud`；无 profile、模型、网络或超时时返回明确错误，Explorer 本地结果保持可用。API Key 仅由 `AppStore` 处理，不经过 renderer。

## 5. 失败与可观察性

- 90 秒请求超时；问答和单条解释均不落库。
- 解析 JSON 失败时最多进行一次格式修复；仍失败则返回错误，不猜测结构。
- 问答界面显示本轮检索方式、召回段数、实际模型名和可点击来源；来源点击回到材料阅读器的原文定位。
- 界面额外显示回答范围和工具调用次数：本地材料、模型通用回答或待审核操作。通用回答不得伪装成本地证据。
- `propose_topic_changes` 只写 `topic_proposals`。用户在主题画板逐条应用或忽略；应用操作走持久化命令历史，可撤销和重做。
- `jobs` 与 `topic_analysis_runs` 仍可存在于旧工作区；0.1 主路径只记录单条解释的耗时/错误，且不把内容写入工作区数据库。

## 6. 后续替换策略

旧 `runTopicAnalysisV2`、`topic_relation_candidates` 和全主题批量精炼仅用于旧工作区数据兼容，不是 0.1 主路径。当前主路径是按问题检索、按需工具调用、带范围标记的回答，以及用户审核后的画板操作。
