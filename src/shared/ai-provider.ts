/** Returns true when a provider endpoint should require explicit cloud consent. */
export function requiresCloudConsent(provider: string, baseUrl: string): boolean {
  if (provider === 'ollama') return false
  if (provider !== 'compatible') return true
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === 'host.docker.internal' || hostname === '::1' || hostname.endsWith('.local')) return false
    if (/^127\./u.test(hostname) || hostname === '0.0.0.0') return false
    const privateIp = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u)
    if (privateIp) {
      const [, first, second] = privateIp.map(Number)
      if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return false
    }
  } catch { /* Invalid endpoints are rejected by the provider request itself. */ }
  return true
}
