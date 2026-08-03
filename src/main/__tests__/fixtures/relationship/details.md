---
# 预期关系（供测试断言）：
# explicit_reference <- overview.md       (被 overview.md 引用)
# entity_overlap     -> overview.md       (共享实体: SQLite, React Flow, TypeScript)
# entity_overlap     -> 中文文档.md        (共享实体: SQLite)
---

# 架构细节

## 术语表

- SQLite：嵌入式数据库，本项目的本地存储引擎。
- React Flow：用于渲染节点与边的图谱组件库。
- TypeScript：全项目统一使用 TypeScript 严格模式。

存储层使用 SQLite，前端画布使用 React Flow，二者通过 IPC 通信。
