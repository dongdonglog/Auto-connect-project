import { describe, expect, it } from 'vitest'
import type { KnowledgeChatMessage } from './KnowledgeChat'
import { CHAT_SESSION_LIMIT, normalizeChatSessions, updateChatSession, type KnowledgeChatSession } from './knowledge-chat-state'

const session = (index: number): KnowledgeChatSession => ({
  id: `session-${index}`,
  title: `Question ${index}`,
  messages: [],
  createdAt: new Date(index * 1000).toISOString(),
  updatedAt: new Date(index * 1000).toISOString(),
  archivedAt: null
})

describe('knowledge chat session retention', () => {
  it('keeps ten recent conversations and archives the oldest overflow', () => {
    const result = normalizeChatSessions(Array.from({ length: 11 }, (_, index) => session(index)), '2026-08-05T00:00:00.000Z')
    expect(result.filter((item) => !item.archivedAt)).toHaveLength(CHAT_SESSION_LIMIT)
    expect(result.find((item) => item.id === 'session-0')?.archivedAt).toBe('2026-08-05T00:00:00.000Z')
  })

  it('restores an archived conversation when it receives a new message', () => {
    const initial = normalizeChatSessions(Array.from({ length: 11 }, (_, index) => session(index)), '2026-08-05T00:00:00.000Z')
    const messages: KnowledgeChatMessage[] = [{ id: 'message-1', role: 'user', content: '继续这个问题', createdAt: '2026-08-06T00:00:00.000Z' }]
    const result = updateChatSession(initial, 'session-0', messages, '2026-08-06T00:00:00.000Z')
    expect(result.filter((item) => !item.archivedAt)).toHaveLength(CHAT_SESSION_LIMIT)
    expect(result.find((item) => item.id === 'session-0')).toMatchObject({ archivedAt: null, title: '继续这个问题' })
    expect(result.find((item) => item.id === 'session-1')?.archivedAt).toBe('2026-08-06T00:00:00.000Z')
  })
})
