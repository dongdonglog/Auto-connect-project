import { Check, Eye, MessageSquare, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Relation, TopicMap, TopicProposal } from '../../types'
import { ipc } from '../../lib/ipc'

type Proposal = TopicProposal

export function AiSuggestionPanel({ map, visible, onToggle, onRefresh, onMessage }: { map: TopicMap; visible: boolean; onToggle(): void; onRefresh(): Promise<void>; onMessage(message: string): void }): React.ReactElement {
  const suggestions = map.relations.filter((relation) => relation.createdBy === 'ai' && !relation.archived)
  const [message, setMessage] = useState('')
  const [planning, setPlanning] = useState(false)
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [analysisStage, setAnalysisStage] = useState('')
  const [answer, setAnswer] = useState('')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const proposalApi = useMemo(() => window.materialMap.topicProposals ?? { list: async (): Promise<TopicProposal[]> => [], updateStatus: async (): Promise<null> => null }, [])
  const loadProposals = async (): Promise<Proposal[]> => { try { const items = await proposalApi.list(map.topic.id); setProposals(items); return items } catch { setProposals([]); return [] } }
  useEffect(() => { void loadProposals() }, [map.topic.id, proposalApi])
  const title = (id: string): string => map.materials.find((material) => material.id === id)?.title ?? 'Unknown material'
  const archive = async (relation: Relation): Promise<void> => { await window.materialMap.topics.updateRelationStyle(map.topic.id, relation.id, { archived: true }); await onRefresh(); onMessage('AI suggestion archived.') }
  const accept = async (relation: Relation): Promise<void> => {
    try {
      await ipc.relation.create({ sourceMaterialId: relation.sourceMaterialId, targetMaterialId: relation.targetMaterialId, label: relation.label, relationType: relation.relationType, evidenceText: relation.evidenceText, evidenceMaterialId: relation.evidenceMaterialId, confidence: relation.confidence, createdBy: 'manual' })
      await ipc.relation.remove(relation.id); await onRefresh(); onMessage('Accepted as a manual relationship.')
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not accept this suggestion.') }
  }
  const runSupplement = async (): Promise<void> => {
    setAnalysisRunning(true); setAnalysisStage('Preparing material cards...')
    const startedAt = Date.now()
    const stageNames: Record<string, string> = { preparing: 'Preparing material cards', candidates: 'Generating relationship candidates', verifying: 'Verifying evidence', applying: 'Applying verified relationships' }
    const poll = window.setInterval(() => { void window.materialMap.analysis.run(map.topic.id).then((run: { stage: string; completed: number; total: number; rejectedCandidates?: number } | null) => {
      if (!run) return
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAt) / 1000))
      const prefix = stageNames[run.stage] ?? run.stage
      setAnalysisStage(run.stage === 'candidates' ? `${prefix}: ${run.completed}/${run.total} batches, ${elapsed}s` : `${prefix}: ${run.completed}/${run.total}; rejected ${run.rejectedCandidates ?? 0}`)
    }).catch(() => undefined) }, 500)
    try {
      const result = await window.materialMap.analysis.topic(map.topic.id) as { addedRelations: number }
      await onRefresh(); const created = await loadProposals()
      setAnalysisStage(created.length ? `Complete: ${created.length} review proposals.` : result.addedRelations ? `Complete: ${result.addedRelations} evidence relationships added.` : 'Complete: no additional evidence relationship found.')
      if (!created.length && !result.addedRelations) onMessage('No reliable additional relationship was found. The default topology remains unchanged.')
    } catch (error) { setAnalysisStage('AI supplement stopped.'); onMessage(error instanceof Error ? error.message : 'AI supplement failed.') }
    finally { window.clearInterval(poll); setAnalysisRunning(false) }
  }
  const plan = async (): Promise<void> => { if (!message.trim()) return; setPlanning(true); try { const result = await ipc.ai.plan(map.topic.id, message); setAnswer(result.answer); await loadProposals() } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not create proposals.') } finally { setPlanning(false) } }
  const apply = async (proposal: Proposal): Promise<void> => {
    try {
      if (proposal.kind === 'create_relation') {
        const input = proposal.payload ?? {}; const source = String(input.sourceMaterialId ?? ''); const target = String(input.targetMaterialId ?? '')
        if (!map.materials.some((item) => item.id === source) || !map.materials.some((item) => item.id === target) || source === target) throw new Error('The proposed materials are not in this topic.')
        if (map.relations.some((item) => item.sourceMaterialId === source && item.targetMaterialId === target)) {
          await proposalApi.updateStatus(proposal.id, 'accepted'); setProposals((items) => items.filter((item) => item.id !== proposal.id)); await onRefresh(); onMessage('Relationship is already in the graph; this proposal was marked handled.'); return
        }
        await ipc.relation.create({ sourceMaterialId: source, targetMaterialId: target, label: String(input.label ?? 'Related').slice(0, 48), relationType: String(input.relationType ?? 'related'), evidenceText: proposal.evidence, evidenceMaterialId: source, confidence: typeof input.confidence === 'number' ? input.confidence : null, createdBy: 'manual' })
      } else if (proposal.kind === 'create_workstream') {
        const name = String(proposal.payload?.name ?? '').trim(); const ids = Array.isArray(proposal.payload?.materialIds) ? proposal.payload.materialIds.map(String) : []
        if (!name || !ids.length || ids.some((id) => !map.materials.some((item) => item.id === id))) throw new Error('The proposed workstream is invalid.')
        const workstream = await ipc.workstream.create(map.topic.id, name) as { id: string }; for (const materialId of ids) await ipc.workstream.move(map.topic.id, materialId, workstream.id)
      } else if (proposal.kind === 'delete_ai_relation') { const relation = map.relations.find((item) => item.id === proposal.relationId && item.createdBy === 'ai'); if (!relation) throw new Error('The AI relationship no longer exists.'); await archive(relation) }
      else if (proposal.kind === 'rename_relation') { const relation = map.relations.find((item) => item.id === proposal.relationId); const label = String(proposal.payload?.label ?? '').trim(); if (!relation || !label) throw new Error('The relation or label is invalid.'); await ipc.relation.update(relation.id, label.slice(0, 48)) }
      else if (proposal.kind === 'set_sequence') { const material = map.materials.find((item) => item.id === proposal.materialId); const sequence = Number(proposal.payload?.sequence); if (!material || !Number.isInteger(sequence) || sequence < 1) throw new Error('The sequence is invalid.'); await ipc.cardOrder.update(map.topic.id, material.id, sequence) }
      else if (proposal.kind === 'layout') { const positions = Array.isArray(proposal.payload?.positions) ? proposal.payload.positions : []; if (!positions.length) throw new Error('The layout has no valid positions.'); await ipc.topic.layout(map.topic.id, positions.map((position) => ({ materialId: String((position as Record<string, unknown>).materialId), x: Number((position as Record<string, unknown>).x), y: Number((position as Record<string, unknown>).y) }))) }
      else if (proposal.kind === 'set_card_style') { const material = map.materials.find((item) => item.id === proposal.materialId); if (!material) throw new Error('The proposed card is not in this topic.'); await ipc.topic.cardStyle(map.topic.id, material.id, { color: typeof proposal.payload?.color === 'string' ? proposal.payload.color : undefined, tags: Array.isArray(proposal.payload?.tags) ? proposal.payload.tags.map(String) : undefined, note: typeof proposal.payload?.note === 'string' ? proposal.payload.note : undefined }) }
      else throw new Error('This proposal cannot be applied.')
      await proposalApi.updateStatus(proposal.id, 'accepted'); setProposals((items) => items.filter((item) => item.id !== proposal.id)); await onRefresh(); onMessage('AI proposal applied.')
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not apply this proposal.') }
  }
  return <section className="ai-suggestion-panel"><button className="secondary-button" onClick={onToggle}><Eye size={15} />{visible ? 'Hide AI suggestions' : `AI suggestions${suggestions.length ? ` (${suggestions.length})` : ''}`}</button>
    {visible && <div className="ai-suggestions"><p>Default topology is generated without AI. AI only proposes additional evidence relationships.</p><button className="secondary-button" disabled={analysisRunning || map.materials.length < 2} onClick={() => void runSupplement()}><Sparkles size={14} />{analysisRunning ? 'Analyzing...' : 'AI supplement relationships'}</button>{analysisStage && <p>{analysisStage}</p>}
      <div className="ai-board-chat"><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the relationship you want AI to inspect." /><button disabled={planning || !message.trim()} onClick={() => void plan()}><MessageSquare size={14} />{planning ? 'Generating...' : 'Generate conversation proposal'}</button></div>
      {answer && <p className="ai-answer">{answer}</p>}{proposals.map((proposal) => <article key={proposal.id}><strong>{proposal.kind}</strong><span>{proposal.reason}</span><small>{proposal.evidence}</small><div><button onClick={() => void apply(proposal)}><Check size={14} />Apply</button><button onClick={() => void proposalApi.updateStatus(proposal.id, 'archived').then(() => setProposals((items) => items.filter((item) => item.id !== proposal.id)))}><Trash2 size={14} />Archive</button></div></article>)}
      {suggestions.map((relation) => <article key={relation.id}><strong>{relation.label}</strong><span>{title(relation.sourceMaterialId)} to {title(relation.targetMaterialId)}</span><small>{relation.evidenceText || 'Generated from the current topic materials.'}</small><div><button onClick={() => void accept(relation)}><Check size={14} />Accept</button><button onClick={() => void archive(relation)}><Trash2 size={14} />Archive</button></div></article>)}</div>}
  </section>
}
