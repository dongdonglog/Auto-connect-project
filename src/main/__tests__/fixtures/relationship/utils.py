# 预期关系（供测试断言）：
# explicit_reference <- api-spec.ts   (被 api-spec.ts import)
# explicit_reference -> api-spec.ts   (Python import 引用 api_spec 模块)
# entity_overlap     -> 无（Python 为通用受控词，单独不足以建边时验证阈值）

"""工具模块示例。"""

import json
from api_spec import parse_references


def helper(text: str) -> list:
    """调用 api_spec 模块中的解析函数。"""
    return parse_references(json.dumps(text))
