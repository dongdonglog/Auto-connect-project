import { CheckCircle2 } from 'lucide-react'
import type { TopicMap } from '../../types'

const steps = ['浏览 7 张学习路径卡片', '双击“下一步”修改关系名称', '在关系标签调整箭头与线型', '显示并处理一条 AI 建议', '打开卡片详情设置颜色、标签和顺序', '点击自动排版整理路径', '回到工作台多选材料创建主题']

export function DemoChecklist({ map, onReset }: { map: TopicMap; onReset(): void }): React.ReactElement | null {
  if (map.topic.name !== '学习路径演示') return null
  return <aside className="demo-checklist"><header><strong>学习路径演示</strong><button onClick={onReset}>重置演示</button></header><p>按下面步骤体验完整流程。重置会恢复完整的 1→2→…→7 主路径。</p>{steps.map((step, index) => <span key={step}><CheckCircle2 size={14} />{index + 1}. {step}</span>)}</aside>
}
