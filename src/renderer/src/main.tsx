import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './app/ErrorBoundary'
import { I18nProvider } from './i18n'
import './styles.css'
import './answer.css'
import './map.css'
import './workspace.css'
import './modal.css'

window.addEventListener('paste', (event) => {
  if (event.clipboardData?.getData('text/plain')) return
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable))) return
  event.preventDefault()
  void window.materialMap.clipboard.readText().then((text: string) => {
    if (!text) return
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length; const end = target.selectionEnd ?? start
      target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`
      target.setSelectionRange(start + text.length, start + text.length)
      target.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    document.execCommand('insertText', false, text)
  })
})
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider><ErrorBoundary><App /></ErrorBoundary></I18nProvider></React.StrictMode>)
