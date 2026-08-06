import { CheckCircle2 } from 'lucide-react'
import type { TopicMap } from '../../types'
import { useI18n } from '../../i18n'

export function DemoChecklist({ map, onReset }: { map: TopicMap; onReset(): void }): React.ReactElement | null {
  const { t } = useI18n()
  if (map.topic.name !== '学习路径演示' && map.topic.name !== 'Learning path demo') return null
  const steps = [t('demo.step1'), t('demo.step2'), t('demo.step3'), t('demo.step4'), t('demo.step5'), t('demo.step6'), t('demo.step7')]
  return <aside className="demo-checklist"><header><strong>{t('demo.title')}</strong><button onClick={onReset}>{t('demo.reset')}</button></header><p>{t('demo.copy')}</p>{steps.map((step, index) => <span key={step}><CheckCircle2 size={14} />{index + 1}. {step}</span>)}</aside>
}
