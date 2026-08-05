---
# 预期关系（供测试断言）：
# explicit_reference -> details.md        (markdown_link, 行内链接)
# explicit_reference -> implementation.md (markdown_link, 带 anchor)
# entity_overlap     -> details.md        (共享实体: SQLite, React Flow)
# 不产生 -> external-link.md / noise.md / common-words.md
---

# Material Map 概览

本项目是一个本地关系发现引擎，基于 SQLite 存储工作区材料，
使用 React Flow 渲染关系图谱。

详细设计见 [架构细节](./details.md)，
核心算法的落地方式见 [实现方案](./implementation.md#核心算法)。

更多背景可以参考 [细节文档](details.md) 中的术语表一节。
