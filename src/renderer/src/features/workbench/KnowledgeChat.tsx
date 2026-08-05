import { AlertCircle, Archive, BookOpen, Bot, Check, ChevronDown, Clock3, Plus, Send, Settings, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { GroundedAnswer, GroundedCitation, KnowledgeChatTurn } from '../../types'
import './knowledge-chat.css'

export type KnowledgeChatMessage =
  | { id: string; role: 'user'; content: string; createdAt: string }
  | { id: string; role: 'assistant'; answer: GroundedAnswer; createdAt: string }
  | { id: string; role: 'error'; content: string; createdAt: string }

const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
const sessionDate = (value: string): string => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value))

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
      onMessagesChange((messages) => [...messages, { id: newId(), role: 'error', content: reason instanceof Error ? reason.message : '材料问答暂时不可用，请稍后重试。', createdAt: new Date().toISOString() }])
    } finally {
      setLoading(false)
      window.setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }

  return (
    <section className="knowledge-chat" aria-label="材料问答">
      <header className="knowledge-chat-header">
        <span className="knowledge-chat-kb-status"><span className={`knowledge-chat-status-dot ${aiStatus}`}/>{aiStatus === 'ready' ? 'AI 已配置' : aiStatus === 'loading' ? '正在检查 AI 配置' : 'AI 未配置'}</span>
        <div className="knowledge-chat-header-actions">
          <div className="knowledge-chat-history" ref={historyRef}>
            <button className="knowledge-chat-tool" type="button" title="会话记录" aria-label="会话记录" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><Clock3 size={16}/></button>
            {historyOpen && (
              <div className="knowledge-chat-history-menu" role="menu">
                <header><strong>会话记录</strong><span>{recentSessions.length}/10</span></header>
                <div className="knowledge-chat-history-list">
                  {recentSessions.map((session) => (
                    <button type="button" role="menuitem" className={session.id === activeSessionId ? 'active' : ''} key={session.id} onClick={() => { onSelectSession(session.id); setHistoryOpen(false) }}>
                      <span><strong>{session.title}</strong><small>{sessionDate(session.updatedAt)}</small></span>{session.id === activeSessionId && <Check size={14}/>}
                    </button>
                  ))}
                  {archivedSessions.length > 0 && <div className="knowledge-chat-history-section"><Archive size={13}/>已归档 · {archivedSessions.length}</div>}
                  {archivedSessions.map((session) => (
                    <button type="button" role="menuitem" className={session.id === activeSessionId ? 'active archived' : 'archived'} key={session.id} onClick={() => { onSelectSession(session.id); setHistoryOpen(false) }}>
                      <span><strong>{session.title}</strong><small>{sessionDate(session.updatedAt)}</small></span>{session.id === activeSessionId && <Check size={14}/>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="knowledge-chat-tool" type="button" title="新建对话" aria-label="新建对话" onClick={onNewConversation}><Plus size={16}/></button>
          <button className="knowledge-chat-tool" type="button" title="配置 AI" aria-label="配置 AI" onClick={onConfigure}><Settings size={16}/></button>
          <button className="knowledge-chat-tool" type="button" title="清空问答" aria-label="清空问答" disabled={!messages.length || loading} onClick={onClear}><Trash2 size={16}/></button>
        </div>
      </header>

      <div className="knowledge-chat-messages" aria-live="polite">
        {!messages.length && !loading && aiStatus === 'loading' && (
          <div className="knowledge-chat-empty"><span className="knowledge-chat-empty-icon"><Bot size={23}/></span><h2>正在检查 AI 配置</h2></div>
        )}
        {!messages.length && !loading && aiStatus === 'missing' && (
          <div className="knowledge-chat-empty knowledge-chat-setup">
            <span className="knowledge-chat-empty-icon"><Bot size={23}/></span>
            <h2>先配置 AI</h2>
            <p>添加并启用你自己的 AI 服务后才能向材料提问。</p>
            <button type="button" className="primary-button" onClick={onConfigure}><Settings size={15}/>配置 AI</button>
          </div>
        )}
        {!messages.length && !loading && aiStatus === 'ready' && (
          <div className="knowledge-chat-empty">
            <span className="knowledge-chat-empty-icon"><Bot size={23}/></span>
            <h2>询问你的材料</h2>
            <p>回答只使用当前工作区中的内容。</p>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === 'user') return <div className="knowledge-chat-row user" key={message.id}><div className="knowledge-chat-user-message">{message.content}</div></div>
          if (message.role === 'error') return <div className="knowledge-chat-row assistant error" key={message.id}><span className="knowledge-chat-avatar"><AlertCircle size={16}/></span><div className="knowledge-chat-assistant-message"><p>{message.content}</p></div></div>
          return (
            <div className="knowledge-chat-row assistant" key={message.id}>
              <span className="knowledge-chat-avatar"><Bot size={16}/></span>
              <div className="knowledge-chat-assistant-message">
                <p className="knowledge-chat-answer">{message.answer.answer}</p>
                <div className="knowledge-chat-answer-meta">
                  <span>{message.answer.confidence === 'grounded' ? '基于材料回答' : '证据不足'}</span>
                  <span aria-label="AI 模型">{message.answer.model ? `模型 · ${message.answer.model}` : message.answer.model === null ? '未调用 AI' : '模型信息未记录'}</span>
                </div>
                {message.answer.citations.length > 0 && (
                  <details className="knowledge-chat-citations">
                    <summary><BookOpen size={14}/>{message.answer.citations.length} 个来源<ChevronDown size={14}/></summary>
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
        {loading && <div className="knowledge-chat-row assistant loading"><span className="knowledge-chat-avatar"><Bot size={16}/></span><div className="knowledge-chat-assistant-message"><span/><span/><span/><small>正在检索材料</small></div></div>}
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
            placeholder={aiStatus === 'ready' ? '询问当前工作区中的材料' : '请先配置 AI 后再提问'}
            aria-label="询问材料"
          />
          <button type="button" className="knowledge-chat-send" title="发送" aria-label="发送" disabled={!question.trim() || loading || aiStatus !== 'ready'} onClick={() => void submit()}><Send size={17}/></button>
        </div>
        <small>{aiStatus === 'ready' ? 'Enter 发送，Shift + Enter 换行' : '配置并启用 AI 后可以开始提问'}</small>
      </footer>
    </section>
  )
}
