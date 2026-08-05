import { useCallback } from 'react'
import type { Connection } from '@xyflow/react'
import type { Relation } from '../../types'
import { ipc } from '../../lib/ipc'

export function useTopicConnections(topicId: string, relations: Relation[], onRefresh: () => Promise<void>, onNotice: (message: string) => void, executeCommand?: (command: { kind: string; payload: Record<string, unknown> }) => Promise<void>): { validate(connection: Pick<Connection, 'source' | 'target'>): string | null; create(connection: Connection): Promise<void> } {
  const validate = useCallback((connection: Pick<Connection, 'source' | 'target'>): string | null => {
    const source = connection.source ?? ''; const target = connection.target ?? ''
    if (!source || !target) return '请从卡片的输出端口拖到另一张卡片的输入端口。'
    if (source === target) return '卡片不能连接到自身。'
    if (relations.some((relation) => relation.createdBy === 'manual' && relation.sourceMaterialId === source && relation.targetMaterialId === target)) return '这两个方向已有正式连接。'
    return null
  }, [relations])
  const create = useCallback(async (connection: Connection): Promise<void> => {
    const error = validate(connection); if (error) { onNotice(error); return }
    try {
      if (executeCommand) await executeCommand({ kind: 'createRelation', payload: { relation: { sourceMaterialId: connection.source!, targetMaterialId: connection.target!, label: '', relationType: 'related', evidenceMaterialId: connection.source!, confidence: null, style: { sourceHandle: connection.sourceHandle ?? null, targetHandle: connection.targetHandle ?? null, sourceArrowStyle: 'none', targetArrowStyle: 'triangle', lineDash: 'solid', animated: false } } } })
      else {
        const relation = await ipc.relation.create({ sourceMaterialId: connection.source!, targetMaterialId: connection.target!, label: '', relationType: 'related', evidenceText: null, evidenceMaterialId: connection.source!, confidence: null, createdBy: 'manual' }) as Relation
        await ipc.topic.relationStyle(topicId, relation.id, { sourceHandle: connection.sourceHandle ?? null, targetHandle: connection.targetHandle ?? null, sourceArrowStyle: 'none', targetArrowStyle: 'triangle', lineDash: 'solid', animated: false })
        await onRefresh()
      }
      onNotice('已创建正式连接。')
    } catch (reason) { onNotice(reason instanceof Error ? reason.message : '无法创建连接。') }
  }, [executeCommand, onNotice, onRefresh, topicId, validate])
  return { validate, create }
}
