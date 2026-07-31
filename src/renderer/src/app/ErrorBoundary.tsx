import { Component, type ErrorInfo, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (error: Error, retry: () => void) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Material Map render failure', error, info) }
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const retry = (): void => this.setState({ error: null })
    if (this.props.fallback) return this.props.fallback(this.state.error, retry)
    return <main className="app-error"><h1>页面暂时无法显示</h1><p>{this.state.error.message || '发生了未知错误。'}</p><button onClick={retry}>重试</button><button onClick={() => window.location.reload()}>重新加载应用</button></main>
  }
}
