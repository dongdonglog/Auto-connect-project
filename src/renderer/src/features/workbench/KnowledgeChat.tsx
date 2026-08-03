import { Bot, Send } from 'lucide-react'
import { useState } from 'react'
import type { GroundedAnswer } from '../../types'
import './knowledge-chat.css'

export function KnowledgeChat(): React.ReactElement {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<GroundedAnswer | null>(null)
  const [loading, setLoading] = useState(false)
  const ask = async (): Promise<void> => {
    if (!question.trim() || loading) return
    setLoading(true)
    try { setAnswer(await window.materialMap.ask(question.trim()) as GroundedAnswer) } finally { setLoading(false) }
  }
  return <section className="knowledge-chat"><header><span><Bot size={17} />材料问答 <em>实验功能</em></span><small>仅基于当前工作区已索引的材料回答，不参与关系发现。</small></header>{answer && <article className={answer.confidence}><p>{answer.answer}</p><div>{answer.confidence === 'grounded' ? '已核对本地引用' : '证据不足'} · {answer.citations.length} 条相关材料片段</div>{answer.citations.length > 0 && <ul>{answer.citations.slice(0, 5).map((citation) => <li key={`${citation.materialId}:${citation.chunkId ?? ''}`}>{citation.title}{citation.heading ? ` · ${citation.heading}` : ''}</li>)}</ul>}</article>}<div className="knowledge-chat-input"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask() } }} placeholder="向这批材料提问，例如：这些文档的前提条件和验证方式是什么？"/><button className="primary-button" disabled={!question.trim() || loading} onClick={() => void ask()}><Send size={15} />{loading ? '查询中' : '发送'}</button></div></section>
}
