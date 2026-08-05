import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import Papa from 'papaparse'
import { useEffect, useRef } from 'react'
import 'highlight.js/styles/github.css'
import type { Material } from './types'
import { buildEvidenceSnippet, type EvidenceFocus } from './lib/evidence-focus'

const extensionFor = (material: Material) => (material.sourcePath ?? material.storedPath ?? '').split('.').pop()?.toLowerCase()

function CsvPreview({ text }: { text: string }): React.ReactElement {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
  if (parsed.errors.length) return <pre className="preview-error">{text}</pre>
  const [header = [], ...rows] = parsed.data
  return <div className="csv-preview"><table><thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_cell, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ''}</td>)}</tr>)}</tbody></table></div>
}

export function MaterialPreview({ material, text, focus = null }: { material: Material; text: string; focus?: EvidenceFocus | null }): React.ReactElement {
  const extension = extensionFor(material)
  const highlightRef = useRef<HTMLElement | null>(null)
  const snippet = focus ? buildEvidenceSnippet(text, focus.startOffset, focus.endOffset) : null
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() => highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [focus?.key, material.id])
  const locator = focus && snippet ? <aside className="evidence-locator" role="status" ref={snippet.highlight ? undefined : highlightRef}>
    <header><strong>已定位到原文</strong><span>{[focus.pageNumber ? `第 ${focus.pageNumber} 页` : '', focus.heading ?? '', focus.startOffset != null ? `位置 ${focus.startOffset}` : ''].filter(Boolean).join(' · ')}</span></header>
    <pre>{snippet.truncatedBefore ? '…' : ''}{snippet.before}<mark ref={highlightRef} data-evidence-highlight>{snippet.highlight}</mark>{snippet.after}{snippet.truncatedAfter ? '…' : ''}</pre>
  </aside> : null
  if (extension === 'json') {
    try { return <>{locator}<pre className="structured-preview">{JSON.stringify(JSON.parse(text || '{}'), null, 2)}</pre></> }
    catch { return <>{locator}<pre className="preview-error">{text}</pre></> }
  }
  if (extension === 'csv') return <>{locator}<CsvPreview text={text}/></>
  if (extension === 'md' || extension === 'markdown' || extension === 'html' || extension === 'htm' || material.mimeType === 'text/markdown' || material.mimeType === 'text/html') {
    return <>{locator}<article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}>{text}</ReactMarkdown></article></>
  }
  if (!snippet?.highlight) return <>{locator}<pre className="structured-preview">{text}</pre></>
  return <pre className="structured-preview evidence-text-preview">{text.slice(0, snippet.start)}<mark ref={highlightRef} data-evidence-highlight>{text.slice(snippet.start, snippet.end)}</mark>{text.slice(snippet.end)}</pre>
}
