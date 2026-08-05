import type { KnowledgeChatMessage } from './KnowledgeChat'

export const CHAT_SESSION_LIMIT = 10

export interface KnowledgeChatSession {
  id: string
  title: string
  messages: KnowledgeChatMessage[]
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

export function createChatSession(timestamp = new Date().toISOString()): KnowledgeChatSession {
  return { id: newId(), title: '新对话', messages: [], createdAt: timestamp, updatedAt: timestamp, archivedAt: null }
}

export function sessionTitle(messages: KnowledgeChatMessage[]): string {
  const question = messages.find((message) => message.role === 'user')
  if (!question || question.role !== 'user') return '新对话'
  return question.content.replace(/\s+/g, ' ').trim().slice(0, 28) || '新对话'
}

export function normalizeChatSessions(sessions: KnowledgeChatSession[], timestamp = new Date().toISOString()): KnowledgeChatSession[] {
  const recent = sessions.filter((session) => !session.archivedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const overflow = recent.slice(CHAT_SESSION_LIMIT).map((session) => ({ ...session, archivedAt: timestamp }))
  const archived = [...overflow, ...sessions.filter((session) => session.archivedAt)].sort((left, right) => String(right.archivedAt).localeCompare(String(left.archivedAt)))
  return [...recent.slice(0, CHAT_SESSION_LIMIT), ...archived]
}

export function updateChatSession(sessions: KnowledgeChatSession[], sessionId: string, messages: KnowledgeChatMessage[], timestamp = new Date().toISOString()): KnowledgeChatSession[] {
  return normalizeChatSessions(sessions.map((session) => session.id === sessionId ? { ...session, messages: messages.slice(-80), title: sessionTitle(messages), updatedAt: timestamp, archivedAt: null } : session), timestamp)
}
