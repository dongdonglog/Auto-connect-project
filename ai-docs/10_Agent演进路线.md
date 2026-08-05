# 10 Agent 演进路线

原则：Agent 只能在可检索、可解释、可审阅的本地知识层之上工作。0.1 不让 Agent 自动修改文件、实体或正式关系。

## Stage 0：工具化知识访问（0.1）

能力：本地 FTS/hybrid 检索、材料读取、关系与证据查询、带引用问答、单条关系解释。

接口形态：现有 IPC；未来抽取为只读 MCP tools：`search_materials`、`read_material_chunk`、`list_material_relations`、`get_relation_evidence`。

安全：只读、返回紧凑 metadata 后按需展开，所有答案附 citation。

## Stage 1：受限提案 Agent（0.2）

能力：对当前主题提出创建关系、重命名、分组、布局或阅读路径建议。

实现：复用 `topic_proposals`。Agent 只能写 proposal，用户逐条接受或归档；每项必须包含理由、证据和受影响材料 ID。

安全：禁止文件写入、禁止删除、禁止绕过 `allowCloud`、禁止覆盖 `manual` 关系。

## Stage 2：工作区研究 Agent（0.3）

能力：围绕用户问题规划“检索 -> 展开证据 -> 比较 -> 总结”，生成临时研究报告和阅读清单。

实现：为每轮保留短期 run log，不把对话原文默认写入材料库；Agent 通过结构化 tool 输出选择下一步，设定检索次数和 token 预算上限。

安全：可取消、可回放、每个结论可追溯到 chunk；没有证据时停止而非补全。

## Stage 3：受控行动 Agent（后续）

能力：在用户预览后批量固定关系、创建主题、生成笔记草稿或维护实体别名。

实现：所有副作用先生成 transaction plan，显示 diff、影响范围和回滚操作；用户确认后在 main process 原子执行。

安全：无隐式确认、无后台持续执行、无自动上传；工作区导出前记录审计日志。

## 成功标准

- Agent 使用图谱减少检索范围，而不是扩大上下文。
- 每个建议可解释、可拒绝、可恢复。
- 任何模型不可用时，用户仍可浏览和编辑自己的知识资产。
