import { AlertCircle, Archive, BookOpen, Bot, Check, ChevronDown, Clock3, Plus, Send, Settings, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { GroundedAnswer, GroundedCitation, KnowledgeChatTurn } from '../../types'
import { useI18n } from '../../i18n'
import './knowledge-chat.css'

export type KnowledgeChatMessage =
  | { id: string; role: 'user'; content: string; createdAt: string }
  | { id: string; role: 'assistant'; answer: GroundedAnswer; createdAt: string }
  | { id: string; role: 'error'; content: string; createdAt: string }

const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
const sessionDate = (value: string, locale: string): string => new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(new Date(value))

export function KnowledgeChat({ messages, aiStatus, sessions, activeSessionId, onSelectSession, onNewConversation, onMessagesChange, onClear, onConfigure, onOpenCitation }: {
  messages: KnowledgeChatMessage[]
  aiStatus: 'loading' | 'ready' | 'missing'
  sessions: Array<{ id: string; title: string; updatedAt: string; archived: boolean }>
  activeSessionId: string
  onSelectSession(sessionId: string): void
  onNewConversation(): void
  onMessagesChange(update: (messages: KnowledgeChatMessage[]) => KnowledgeChatMessage[]): void
  onClear(): void
  onConfigure(): void
  onOpenCitation(citation: GroundedCitation): void
}): React.ReactElement {
  const { t, locale } = useI18n()
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const recentSessions = sessions.filter((session) => !session.archived)
  const archivedSessions = sessions.filter((session) => session.archived)

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length, loading])
  useEffect(() => { textareaRef.current?.focus() }, [])
  useEffect(() => {
    if (!historyOpen) return
    const close = (event: PointerEvent): void => { if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setHistoryOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [historyOpen])

  const resizeInput = (): void => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`
  }
  const submit = async (value = question): Promise<void> => {
    const nextQuestion = value.trim()
    if (!nextQuestion || loading || aiStatus !== 'ready') return
    const history: KnowledgeChatTurn[] = messages.flatMap((message): KnowledgeChatTurn[] => {
      if (message.role === 'user') return [{ role: 'user', content: message.content }]
      if (message.role === 'assistant') return [{ role: 'assistant', content: message.answer.answer }]
      return []
    }).slice(-8)
    const userMessage: KnowledgeChatMessage = { id: newId(), role: 'user', content: nextQuestion, createdAt: new Date().toISOString() }
    onMessagesChange((messages) => [...messages, userMessage])
    setQuestion('')
    setLoading(true)
    if (textareaRef.current) textareaRef.current.style.height = '44px'
    try {
      const answer = await window.materialMap.ask({ question: nextQuestion, history }) as GroundedAnswer
      onMessagesChange((messages) => [...messages, { id: newId(), role: 'assistant', answer, createdAt: new Date().toISOString() }])
    } catch (reason) {
      onMessagesChange((messages) => [...messages, { id: newId(), role: 'error', content: reason instanceof Error ? reason.message : 'Material chat is temporarily unavailable. Please try again later.', createdAt: new Date().toISOString() }])
    } finally {
      setLoading(false)
      window.setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }

  return (
    <section className="knowledge-chat" aria-label={t('chat.aria')}>
      <header className="knowledge-chat-header">
        <span className="knowledge-chat-kb-status"><span className={`knowledge-chat-status-dot ${aiStatus}`}/>{aiStatus === 'ready' ? t('chat.readyStatus') : aiStatus === 'loading' ? t('chat.checking') : t('chat.missingStatus')}</span>
        <div className="knowledge-chat-header-actions">
          <div className="knowledge-chat-history" ref={historyRef}>
            <button className="knowledge-chat-tool" type="button" title={t('chat.history')} aria-label={t('chat.history')} aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><Clock3 size={16}/></button>
            {historyOpen && (
              <div className="knowledge-chat-history-menu" role="menu">
                <header><strong>{t('chat.history')}</strong><span>{recentSessions.length}/10</span></header>
                <div className="knowledge-chat-history-list">
                  {recentSessions.map((session) => (
                    <button type="button" role="menuitem" className={session.id === activeSessionId ? 'active' : ''} key={session.id} onClick={() => { onSelectSession(session.id); setHistoryOpen(false) }}>
                      <span><strong>{session.title}</strong><small>{sessionDate(session.updatedAt, locale)}</small></span>{session.id === activeSessionId && <Check size={14}/>}
                    </button>
                  ))}
                  {archivedSessions.length > 0 && <div className="knowledge-chat-history-section"><Archive size={13}/>{t('chat.archived', { count: archivedSessions.length })}</div>}
                  {archivedSessions.map((session) => (
                    <button type="button" role="menuitem" className={session.id === activeSessionId ? 'active archived' : 'archived'} key={session.id} onClick={() => { onSelectSession(session.id); setHistoryOpen(false) }}>
                      <span><strong>{session.title}</strong><small>{sessionDate(session.updatedAt, locale)}</small></span>{session.id === activeSessionId && <Check size={14}/>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="knowledge-chat-tool" type="button" title={t('chat.newConversation')} aria-label={t('chat.newConversation')} onClick={onNewConversation}><Plus size={16}/></button>
          <button className="knowledge-chat-tool" type="button" title={t('chat.configure')} aria-label={t('chat.configure')} onClick={onConfigure}><Settings size={16}/></button>
          <button className="knowledge-chat-tool" type="button" title={t('chat.clear')} aria-label={t('chat.clear')} disabled={!messages.length || loading} onClick={onClear}><Trash2 size={16}/></button>
        </div>
      </header>

      <div className="knowledge-chat-messages" aria-live="polite">
        {!messages.length && !loading && aiStatus === 'loading' && (
          <div className="knowledge-chat-empty"><span className="knowledge-chat-empty-icon"><Bot size={23}/></span><h2>{t('chat.checking')}</h2></div>
        )}
        {!messages.length && !loading && aiStatus === 'missing' && (
          <div className="knowledge-chat-empty knowledge-chat-setup">
            <span className="knowledge-chat-empty-icon"><Bot size={23}/></span>
            <h2>{t('chat.configureFirst')}</h2>
            <p>{t('chat.configureCopy')}</p>
            <button type="button" className="primary-button" onClick={onConfigure}><Settings size={15}/>{t('chat.configure')}</button>
          </div>
        )}
        {!messages.length && !loading && aiStatus === 'ready' && (
          <div className="knowledge-chat-empty">
            <span className="knowledge-chat-empty-icon"><Bot size={23}/></span>
            <h2>{t('chat.readyTitle')}</h2>
            <p>{t('chat.readyCopy')}</p>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === 'user') return <div className="knowledge-chat-row user" key={message.id}><div className="knowledge-chat-user-message">{message.content}</div></div>
          if (message.role === 'error') return <div className="knowledge-chat-row assistant error" key={message.id}><span className="knowledge-chat-avatar"><AlertCircle size={16}/></span><div className="knowledge-chat-assistant-message"><p>{message.content}</p></div></div>
          return (
            <div className="knowledge-chat-row assistant" key={message.id}>
              <span className="knowledge-chat-avatar"><Bot size={16}/></span>
              <div className="knowledge-chat-assistant-message">
                <div className="knowledge-chat-answer"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{message.answer.answer}</ReactMarkdown></div>
                <div className="knowledge-chat-answer-meta">
                  <span>{message.answer.confidence !== 'grounded' ? t('chat.insufficientEvidence') : message.answer.answerScope === 'general' ? t('chat.generalAnswer') : message.answer.answerScope === 'action' ? t('chat.reviewAction') : t('chat.localEvidence')}</span>
                  {message.answer.answerScope !== 'general' && message.answer.retrievedChunks !== undefined && <span>{message.answer.retrievalMode === 'hybrid' ? t('chat.hybridSearch') : message.answer.retrievalMode === 'fts' ? t('chat.keywordSearch') : t('chat.directoryFallback')} · {message.answer.retrievedChunks}</span>}
                  {message.answer.toolCalls && message.answer.toolCalls.length > 0 && <span title={t('chat.aiConsulted', { count: message.answer.toolCalls.length })}>{t('chat.aiConsulted', { count: message.answer.toolCalls.length })}</span>}
                  {message.answer.answerMode === 'local-fallback' && <span>{t('chat.localFallback')}</span>}
                  <span aria-label="AI model">{message.answer.model ? t('chat.model', { model: message.answer.model }) : message.answer.model === null ? t('chat.notCalled') : t('chat.modelInfoMissing')}</span>
                </div>
                {message.answer.citations.length > 0 && (
                  <details className="knowledge-chat-citations">
                    <summary><BookOpen size={14}/>{t('chat.sources', { count: message.answer.citations.length })}<ChevronDown size={14}/></summary>
                    <div className="knowledge-chat-citation-list">
                      {message.answer.citations.map((citation, index) => (
                        <button type="button" key={`${citation.materialId}:${citation.chunkId ?? index}`} onClick={() => onOpenCitation(citation)}>
                          <span className="knowledge-chat-citation-index">{index + 1}</span>
                          <span><strong>{citation.title}</strong>{citation.heading && <small>{citation.heading}</small>}<p>{citation.excerpt}</p></span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          )
        })}
        {loading && <div className="knowledge-chat-row assistant loading"><span className="knowledge-chat-avatar"><Bot size={16}/></span><div className="knowledge-chat-assistant-message"><span/><span/><span/><small>{t('chat.searching')}</small></div></div>}
        <div ref={bottomRef}/>
      </div>

      <footer className="knowledge-chat-composer">
        <div className="knowledge-chat-input">
          <textarea
            ref={textareaRef}
            rows={1}
            value={question}
            disabled={loading || aiStatus !== 'ready'}
            onChange={(event) => { setQuestion(event.target.value); window.requestAnimationFrame(resizeInput) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={aiStatus === 'ready' ? t('chat.askPlaceholder') : t('chat.configurePlaceholder')}
            aria-label={t('chat.askLabel')}
          />
          <button type="button" className="knowledge-chat-send" title={t('chat.send')} aria-label={t('chat.send')} disabled={!question.trim() || loading || aiStatus !== 'ready'} onClick={() => void submit()}><Send size={17}/></button>
        </div>
        <small>{aiStatus === 'ready' ? t('chat.enterHint') : t('chat.configureHint')}</small>
      </footer>
    </section>
  )
}
