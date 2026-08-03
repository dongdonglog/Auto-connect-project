# 05 AI Pipeline 设计

状态：AI 为可选增强。默认导入、实体提取、关系发现和 Explorer 排序不调用模型。

## 1. 触发点

| 场景 | 用户动作 | 输入 | 输出 |
| --- | --- | --- |
| 材料问答 | 在实验问答输入问题 | FTS/hybrid 的前 8 个 chunk | 带引用回答或证据不足 |
| 关系解释 | Explorer 点击单条关系的 AI 图标 | 该关系证据 + 两侧最多 2 段、每段 500 字符 | 是否支持、语义、标签、说明、置信度 |
| 主题提案 | 用户在画板提出操作 | 当前主题紧凑上下文 | 可审阅 proposal，不直接覆盖人工数据 |

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

- 每侧最多 2 个 chunk，每个最多 500 字符。
- 结构化输出上限 450 tokens，温度 0.1。
- 提示词只接受关联两端的材料 ID；响应中其他 ID 一律拒绝。
- 本地证据文本优先，模型摘要只作为说明，不可替代证据。

## 4. Provider 与隐私

支持 Ollama、本地兼容 endpoint、Anthropic、Gemini 与 OpenAI-compatible。非 Ollama provider 必须检查 `allowCloud`；无 profile、模型、网络或超时时返回明确错误，Explorer 本地结果保持可用。API Key 仅由 `AppStore` 处理，不经过 renderer。

## 5. 失败与可观察性

- 90 秒请求超时；topic 批处理可取消，单条解释不落库。
- 解析 JSON 失败时最多进行一次格式修复；仍失败则返回错误，不猜测结构。
- `jobs` 与 `topic_analysis_runs` 记录旧主题 AI 流程；0.1 主路径应增加单条解释的耗时/错误日志，且不把内容写入工作区数据库。

## 6. 后续替换策略

旧 `runTopicAnalysisV2`、`topic_relation_candidates` 和全主题批量精炼是兼容功能，不是 0.1 主路径。清理前必须先将 UI 入口、IPC 和测试迁移到“单条解释 + proposal”模型。
