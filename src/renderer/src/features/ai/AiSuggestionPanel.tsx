import { Check, Eye, MessageSquare, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Relation, TopicMap } from '../../types'
import { ipc } from '../../lib/ipc'

type Proposal = { id: string; kind: string; reason: string; evidence: string; materialId?: string; relationId?: string; payload?: Record<string, unknown> }

export function AiSuggestionPanel({ map, visible, onToggle, onRefresh, onMessage }: { map: TopicMap; visible: boolean; onToggle(): void; onRefresh(): Promise<void>; onMessage(message: string): void }): React.ReactElement {
  const suggestions = map.relations.filter((relation) => relation.createdBy === 'ai' && !relation.archived)
  const [message, setMessage] = useState(''); const [planning, setPlanning] = useState(false); const [autoRunning, setAutoRunning] = useState(false); const [fallback, setFallback] = useState(false); const [answer, setAnswer] = useState(''); const [proposals, setProposals] = useState<Proposal[]>([])
  const title = (id: string): string => map.materials.find((material) => material.id === id)?.title ?? '未知材料'
  const accept = async (relation: Relation): Promise<void> => {
    try { await ipc.relation.create({ sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, label: relation.label, relationType: relation.relationType, evidenceText: relation.evidenceText, evidenceMaterialId: relation.evidenceMaterialId, confidence: relation.confidence, createdBy: 'manual' }); await ipc.relation.remove(relation.id); await onRefresh(); onMessage('已接受为正式关系。') }
    catch (error) { onMessage(error instanceof Error ? error.message : '无法接受这条建议。') }
  }
  const archive = async (relation: Relation): Promise<void> => { await window.materialMap.topics.updateRelationStyle(map.topic.id, relation.id, { archived: true }); await onRefresh(); onMessage('AI 建议已归档，未删除数据。') }
  const open = async (): Promise<void> => {
    if (visible) { onToggle(); return }
    onToggle(); if (suggestions.length) return
    setAutoRunning(true); setFallback(false)
    try {
      // The first action always invokes the packaged topic-connection skill.
      const result = await window.materialMap.analysis.topic(map.topic.id) as { addedRelations: number }
      await onRefresh()
      if (!result.addedRelations) { setFallback(true); onMessage('内置连接 skill 没有足够证据，可改用对话描述。') }
    } catch (error) { setFallback(true); onMessage(error instanceof Error ? `${error.message}，可改用对话方式。` : '内置连接 skill 不可用，可改用对话方式。') }
    finally { setAutoRunning(false) }
  }
  const plan = async (): Promise<void> => { if (!message.trim()) return; setPlanning(true); try { const result = await ipc.ai.plan(map.topic.id, message); setAnswer(result.answer); setProposals(result.proposedActions) } catch (error) { onMessage(error instanceof Error ? error.message : '无法生成画板建议。') } finally { setPlanning(false) } }
  const apply = async (proposal: Proposal): Promise<void> => {
    try {
      if (proposal.kind === 'create_relation') { const input = proposal.payload ?? {}; const source = String(input.sourceMaterialId ?? ''); const target = String(input.targetMaterialId ?? ''); if (!map.materials.some((item) => item.id === source) || !map.materials.some((item) => item.id === target) || source === target) throw new Error('建议的材料不属于当前主题。'); await ipc.relation.create({ sourceMaterialId: source, targetMaterialId: target, label: String(input.label ?? '关联').slice(0, 48), relationType: 'related', evidenceText: proposal.evidence, evidenceMaterialId: source, confidence: null, createdBy: 'manual' }) }
      else if (proposal.kind === 'delete_ai_relation') { const relation = map.relations.find((item) => item.id === proposal.relationId && item.createdBy === 'ai'); if (!relation) throw new Error('该 AI 建议已不存在。'); await archive(relation) }
      else if (proposal.kind === 'rename_relation') { const relation = map.relations.find((item) => item.id === proposal.relationId); const label = String(proposal.payload?.label ?? '').trim(); if (!relation || !label) throw new Error('关系或新名称无效。'); await ipc.relation.update(relation.id, label.slice(0, 48)) }
      else if (proposal.kind === 'set_sequence') { const material = map.materials.find((item) => item.id === proposal.materialId); const sequence = Number(proposal.payload?.sequence); if (!material || !Number.isInteger(sequence) || sequence < 1) throw new Error('卡片顺序无效。'); await ipc.cardOrder.update(map.topic.id, material.id, sequence) }
      else throw new Error('不允许应用此类建议。')
      setProposals((items) => items.filter((item) => item.id !== proposal.id)); await onRefresh(); onMessage('已应用一项 AI 建议。')
    } catch (error) { onMessage(error instanceof Error ? error.message : '无法应用这项建议。') }
  }
  return <section className="ai-suggestion-panel"><button className="secondary-button" onClick={() => void open()}><Eye size={15} />{visible ? '隐藏 AI 建议' : `AI 建议${suggestions.length ? ` (${suggestions.length})` : ''}`}</button>
    {visible && <div className="ai-suggestions">{autoRunning && <p>正在按内置连接 skill 分析当前主题…</p>}{fallback && <div className="ai-board-chat"><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="描述希望调整的范围；AI 仅会返回当前主题内的可审阅建议。" /><button disabled={planning || !message.trim()} onClick={() => void plan()}><MessageSquare size={14} />{planning ? '生成中…' : '生成对话建议'}</button></div>}{!autoRunning && !fallback && suggestions.length === 0 && proposals.length === 0 && <button className="secondary-button" onClick={() => setFallback(true)}>改用对话描述</button>}{answer && <p className="ai-answer">{answer}</p>}{proposals.map((proposal) => <article key={proposal.id}><strong>{proposal.kind}</strong><span>{proposal.reason}</span><small>{proposal.evidence}</small><div><button onClick={() => void apply(proposal)}><Check size={14} />应用</button><button onClick={() => setProposals((items) => items.filter((item) => item.id !== proposal.id))}><Trash2 size={14} />归档</button></div></article>)}{suggestions.map((relation) => <article key={relation.id}><strong>{relation.label}</strong><span>{title(relation.sourceMaterialId)} → {title(relation.targetMaterialId)}</span><small>{relation.evidenceText || '基于当前主题材料生成。'}</small><div><button onClick={() => void accept(relation)}><Check size={14} />接受</button><button onClick={() => void archive(relation)}><Trash2 size={14} />归档</button></div></article>)}</div>}
  </section>
}
