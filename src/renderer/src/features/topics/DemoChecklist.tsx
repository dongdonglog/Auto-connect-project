import { CheckCircle2 } from 'lucide-react'
import type { TopicMap } from '../../types'

const steps = ['浏览 7 张学习路径卡片', '点击连线打开关系属性', '修改关系名称、箭头或线型', '从端口拖拽创建单向关系', '左键框选后右键删除所选内容', '点击自动排版整理路径', '回到工作台多选材料创建主题']

export function DemoChecklist({ map, onReset }: { map: TopicMap; onReset(): void }): React.ReactElement | null {
  if (map.topic.name !== '学习路径演示') return null
  return <aside className="demo-checklist"><header><strong>学习路径演示</strong><button onClick={onReset}>重置演示</button></header><p>按下面步骤体验当前画板交互。重置会恢复完整学习路径。</p>{steps.map((step, index) => <span key={step}><CheckCircle2 size={14} />{index + 1}. {step}</span>)}</aside>
}
