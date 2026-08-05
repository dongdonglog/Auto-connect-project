---
# 预期关系（供测试断言）：
# explicit_reference <- overview.md       (被 overview.md 引用，带 anchor)
# explicit_reference -> api-spec.ts       (代码 import 引用 ./api-spec)
# entity_overlap     -> api-spec.ts       (共享实体: TypeScript)
---

# 实现方案

## 核心算法

关系引擎的核心入口如下：

```ts
import { parseReferences } from './api-spec'
import { RelationshipEngine } from './relationship-engine'
```

`parseReferences` 负责把 TypeScript 源码中的 import 语句解析为结构化引用。
