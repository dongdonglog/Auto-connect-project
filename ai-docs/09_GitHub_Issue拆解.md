# 09 GitHub Issue 拆解

标签：`area:graph`、`area:explorer`、`area:ai`、`area:desktop`、`area:test`、`type:cleanup`、`priority:p0/p1/p2`。每个 Issue 必须列出复现样本、验收命令和不在范围内的行为。

## Epic：0.1 可解释探索

### P0-01：完善显式文件引用解析

- 标签：`area:graph`, `priority:p0`
- 范围：Markdown link、相对路径、代码 import/require 解析到内部 material ID。
- 验收：两材料间的显式引用产生 `references` 关系和至少一条 offset 证据；无效外部链接不产生工作区关系。
- 依赖：无。

### P0-02：关系重算保留用户状态

- 标签：`area:graph`, `area:test`, `priority:p0`
- 范围：重索引时以无向 pair 恢复 `hidden` 与 `fixed`，清理证据但不丢用户选择。
- 验收：隐藏/固定后编辑源材料、重新打开工作区和导入导出均保持状态。
- 依赖：P0-01。

### P0-03：Explorer 证据定位与完整空态

- 标签：`area:explorer`, `priority:p0`
- 范围：点击证据定位正文区段；为 loading、无关系、失联、解析失败提供状态。
- 验收：E2E 验证从关系卡跳到目标材料及证据位置，不出现空白面板。
- 依赖：P0-01。

### P0-04：清理旧候选建图主路径

- 标签：`area:ai`, `type:cleanup`, `priority:p0`
- 范围：移除旧主题候选虚线和批量 AI 精炼的主 UI 入口；保留旧工作区读取。
- 验收：新主题不会自动出现 `topic_relation_candidates` 边；Explorer 固定关系可进入画板。
- 依赖：P0-02。

### P1-01：单条 AI 解释可观察性

- 标签：`area:ai`, `area:test`, `priority:p1`
- 范围：记录耗时和失败原因，覆盖 provider、JSON 失败、云端同意和超时。
- 验收：AI 失败后 UI 保留关系卡；测试不访问真实网络。

### P1-02：主题画板多端口和真实 DAG 布局回归

- 标签：`area:desktop`, `area:test`, `priority:p1`
- 范围：四边任意组合端口持久化；布局只使用正式关系。
- 验收：刷新后 source/target handle 不变；无关系材料网格显示。

### P1-03：加密工作区 UI 完整流程

- 标签：`area:desktop`, `priority:p1`
- 范围：创建、打开、导入时输入密码与错误反馈。
- 验收：E2E 覆盖正确密码、错误密码和导出后恢复。

### P2-01：关系引擎性能基准

- 标签：`area:graph`, `area:test`, `priority:p2`
- 范围：20、50、200 份合成材料的索引和查询基准。
- 验收：记录 P50/P95，20-50 份材料关系查询 P95 < 1 秒。

### P2-02：Windows 发布验收

- 标签：`area:desktop`, `priority:p2`
- 范围：干净 Windows 虚拟机上的 NSIS、portable、SQLite、监听和导入导出。
- 验收：附安装版本、步骤、截图和已知问题。
