import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import Papa from 'papaparse'
import 'highlight.js/styles/github.css'
import type { Material } from './types'

const extensionFor = (material: Material) => (material.sourcePath ?? material.storedPath ?? '').split('.').pop()?.toLowerCase()

function CsvPreview({ text }: { text: string }): React.ReactElement {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
  if (parsed.errors.length) return <pre className="preview-error">{text}</pre>
  const [header = [], ...rows] = parsed.data
  return <div className="csv-preview"><table><thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_cell, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ''}</td>)}</tr>)}</tbody></table></div>
}

export function MaterialPreview({ material, text }: { material: Material; text: string }): React.ReactElement {
  const extension = extensionFor(material)
  if (extension === 'json') {
    try { return <pre className="structured-preview">{JSON.stringify(JSON.parse(text || '{}'), null, 2)}</pre> }
    catch { return <pre className="preview-error">{text}</pre> }
  }
  if (extension === 'csv') return <CsvPreview text={text}/>
  if (extension === 'md' || extension === 'markdown' || extension === 'html' || extension === 'htm' || material.mimeType === 'text/markdown' || material.mimeType === 'text/html') {
    return <article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}>{text}</ReactMarkdown></article>
  }
  return <pre className="structured-preview">{text}</pre>
}
