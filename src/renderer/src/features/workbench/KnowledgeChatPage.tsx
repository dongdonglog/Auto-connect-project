import { useEffect, useState } from 'react'
import type { GroundedCitation, ModelSettings, ProviderProfile } from '../../types'
import { KnowledgeChat, type KnowledgeChatMessage } from './KnowledgeChat'
import { createChatSession, normalizeChatSessions, sessionTitle, updateChatSession, type KnowledgeChatSession } from './knowledge-chat-state'

interface StoredChatState {
  activeSessionId: string
  sessions: KnowledgeChatSession[]
}

const storageKey = (workspaceId: string): string => `material-map:knowledge-chat:${workspaceId}`

function isMessage(value: unknown): value is KnowledgeChatMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<KnowledgeChatMessage>
  if (typeof message.id !== 'string' || typeof message.createdAt !== 'string') return false
  if (message.role === 'user' || message.role === 'error') return typeof message.content === 'string'
  return message.role === 'assistant' && Boolean(message.answer) && typeof message.answer?.answer === 'string' && Array.isArray(message.answer.citations)
}

function sessionFrom(value: Partial<KnowledgeChatSession>, index: number): KnowledgeChatSession | null {
  if (!Array.isArray(value.messages)) return null
  const timestamp = typeof value.updatedAt === 'string' ? value.updatedAt : new Date(Date.now() - index).toISOString()
  const messages = value.messages.filter(isMessage).slice(-80)
  return {
    id: typeof value.id === 'string' ? value.id : `legacy-${index}`,
    title: typeof value.title === 'string' ? value.title : sessionTitle(messages),
    messages,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: timestamp,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : null
  }
}

function readChatState(workspaceId: string): StoredChatState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? 'null') as { activeSessionId?: unknown; sessions?: Array<Partial<KnowledgeChatSession>>; messages?: KnowledgeChatMessage[] } | null
    const storedSessions = Array.isArray(value?.sessions) ? value.sessions.map(sessionFrom).filter((session): session is KnowledgeChatSession => Boolean(session)) : []
    const simpleSession = Array.isArray(value?.messages) ? sessionFrom({ messages: value.messages }, 0) : null
    const sessions = normalizeChatSessions(storedSessions.length ? storedSessions : simpleSession ? [simpleSession] : [])
    if (sessions.length) {
      const requested = typeof value?.activeSessionId === 'string' ? value.activeSessionId : ''
      return { activeSessionId: sessions.some((session) => session.id === requested) ? requested : sessions[0].id, sessions }
    }
  } catch { /* Ignore malformed local chat state. */ }
  const session = createChatSession()
  return { activeSessionId: session.id, sessions: [session] }
}

export function KnowledgeChatPage({ workspaceId, settingsRevision, onConfigure, onOpenCitation }: { workspaceId: string; settingsRevision: number; onConfigure(): void; onOpenCitation(citation: GroundedCitation): void }): React.ReactElement {
  const [state, setState] = useState<StoredChatState>(() => readChatState(workspaceId))
  const [aiStatus, setAiStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0]

  useEffect(() => {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state))
  }, [state, workspaceId])
  useEffect(() => {
    let active = true
    setAiStatus('loading')
    void Promise.all([window.materialMap.settings.get(), window.materialMap.profiles.list()]).then(([settings, profiles]) => {
      if (!active) return
      const profile = (profiles as ProviderProfile[]).find((item) => item.id === (settings as ModelSettings).profileId)
      const configured = Boolean(settings.enabled && settings.chatModel && profile && (profile.provider === 'ollama' || (profile.hasApiKey && settings.allowCloud)))
      setAiStatus(configured ? 'ready' : 'missing')
    }).catch(() => { if (active) setAiStatus('missing') })
    return () => { active = false }
  }, [settingsRevision, workspaceId])

  const createConversation = (): void => {
    if (!activeSession.messages.length && !activeSession.archivedAt) return
    const session = createChatSession()
    setState((old) => ({ activeSessionId: session.id, sessions: normalizeChatSessions([session, ...old.sessions]) }))
  }
  const updateMessages = (sessionId: string, update: (messages: KnowledgeChatMessage[]) => KnowledgeChatMessage[]): void => {
    setState((old) => {
      const session = old.sessions.find((item) => item.id === sessionId)
      if (!session) return old
      return { ...old, sessions: updateChatSession(old.sessions, sessionId, update(session.messages)) }
    })
  }

  return (
    <section className="knowledge-chat-page">
      <KnowledgeChat
        key={activeSession.id}
        messages={activeSession.messages}
        aiStatus={aiStatus}
        sessions={state.sessions.map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt, archived: Boolean(session.archivedAt) }))}
        activeSessionId={activeSession.id}
        onSelectSession={(sessionId) => setState((old) => ({ ...old, activeSessionId: sessionId }))}
        onNewConversation={createConversation}
        onMessagesChange={(update) => updateMessages(activeSession.id, update)}
        onClear={() => updateMessages(activeSession.id, () => [])}
        onConfigure={onConfigure}
        onOpenCitation={onOpenCitation}
      />
    </section>
  )
}
