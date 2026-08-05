# 04 数据库 Schema 设计

状态：SQLite 为 0.1 唯一权威存储。工作区打包直接包含 SQLite 和材料副本，无独立 `graph.json`。

## 1. 表分组

| 领域 | 表 |
| --- | --- |
| 工作区与材料 | `materials`、`material_index_state`、`material_chunks`、`material_chunks_fts`、`folder_sources`、`jobs` |
| 知识图谱 | `entities`、`entity_mentions`、`material_relations`、`relationship_evidence` |
| 用户画板 | `topics`、`topic_materials`、`relations`、`topic_relation_styles`、`workstreams` |
| AI 与设置 | `settings`、`material_analysis_cards`、`topic_analysis_runs`、`topic_proposals` |
| 兼容旧数据 | `material_tags`、`topic_relation_candidates` |

## 2. 图谱表

```sql
entities(
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  weight REAL NOT NULL
);

entity_mentions(
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  source TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  excerpt TEXT NOT NULL
);

material_relations(
  id TEXT PRIMARY KEY,
  source_material_id TEXT NOT NULL,
  target_material_id TEXT NOT NULL,
  score REAL NOT NULL,
  relation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  updated_at TEXT NOT NULL,
  UNIQUE(source_material_id, target_material_id)
);

relationship_evidence(
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  score REAL NOT NULL,
  source_material_id TEXT NOT NULL,
  target_material_id TEXT NOT NULL,
  source_entity_id TEXT,
  target_entity_id TEXT,
  source_offset INTEGER,
  target_offset INTEGER,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

索引：`entity_mentions(material_id)`、`entity_mentions(entity_id)`、`material_relations(source_material_id,status,score DESC)`、`relationship_evidence(relation_id)`。

## 3. 约束和生命周期

- ID 为 UUID 文本；时间为 ISO-8601 UTC 文本。
- 删除 Material 时在同一服务操作中删除其 mention、自动关系和证据；不删除用户原始源文件。
- 删除 Entity 不在 0.1 自动执行，可在后续维护任务中清理零 mention 的孤儿实体。
- `material_relations.status` 是用户偏好，重新索引时必须按无向材料对恢复。
- `fixed` 不替代 `relations`：固定操作创建或复用 `created_by='manual'` 的正式关系。

## 4. 迁移策略

`WorkspaceService.initializeSchema()` 必须以 `CREATE TABLE IF NOT EXISTS` 和列存在检测执行增量迁移。旧工作区没有图谱表时：打开后先完成 schema，再为已有完整材料补 entity/mention/relation；补建失败只记录材料错误，不阻止工作区打开。

## 5. 备份兼容

`exportPackage()` 打包工作区根目录，因此新表天然进入备份。导入旧包时没有新表也必须正常打开；导入后通过迁移与回填生成新索引。不得把 API Key、系统临时 SQLite 文件或向量缓存当作可迁移用户数据。
