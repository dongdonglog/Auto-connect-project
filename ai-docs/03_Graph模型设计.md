# 03 Graph 模型设计

状态：0.1 实施基线。

## 1. 模型边界

图谱的主节点是 Material，不是抽象 Topic。Entity 用于解释与聚合关系；Topic 是用户保存的画板视图，不是自动发现的前提。

```text
Material --[mentions]--> Entity
Material --[evidence-backed relation]--> Material
Topic --[contains]--> Material
Topic --[style/position]--> Relation
```

## 2. 节点

| 节点 | 身份 | 0.1 属性 |
| --- | --- | --- |
| Material | 文件、笔记、文档或链接 | 标题、来源、解析文本、hash、状态、可用性 |
| Entity | 规范化技术或项目概念 | `text`、`normalized`、`type`、`weight` |
| Topic | 用户组织的画板 | 名称、描述、颜色、revision |

Entity 类型只允许 `file_reference`、`technology`、`project`。人名、公司、泛化中文短语不在 0.1 自动抽取范围内。

## 3. 边与证据

### 自动材料关系

`material_relations` 的状态为 `visible`、`hidden`、`fixed`：

- `visible`：Explorer 默认显示，最多显示当前材料的前 5 条。
- `hidden`：用户明确排除，不因重新索引重新出现。
- `fixed`：用户确认，同时创建一条现有 `relations` 手动边，供主题画板展示。

关系类型：`references`、`shares_entities`、`nearby`。0.1 中不允许仅凭 `nearby` 单独建边。

### 证据

每条关系至少有一条 `relationship_evidence`：

| 类型 | 分数范围 | 产生条件 |
| --- | --- | --- |
| `explicit_reference` | 0.92-1.0 | Markdown 链接、相对路径、代码 import/require 命中工作区材料 |
| `entity_overlap` | 0.42-0.75 | 两材料命中同一低频受控实体 |
| `structural` | <=0.1 | 同目录或相邻时间，仅可做已有证据的加分 |

证据包含源/目标材料、实体 ID、偏移、可显示文本和创建时间。关系的 `score` 由证据聚合而来，UI 不将其表述为“事实概率”。

## 4. 方向规则

显式引用由引用方指向被引用方；实体共现没有语义方向，存储时按稳定 ID 排序。用户固定为正式关系后，可在画板修改标签、方向、箭头和端口；自动关系本身不覆盖人工编辑。

## 5. 反噪声规则

- 标题、章节优先；正文只补充少量受控词。
- 在 >=60% 材料中出现的实体视为通用词，不生成重叠关系。
- 一次关系最多保留 4 条最高分证据；每个材料的默认结果最多 5 条。
- 用户隐藏优先级最高，重算不复活。

## 6. 可视化规则

Explorer 是关系发现主入口。主题画板只读取手动关系和由 `fixed` 自动关系生成的手动边；不自动绘制全连接图。无关系材料保持网格，存在正式 DAG 关系时才按关系层级布局。
