import { createInterface } from 'node:readline'
import { MaterialMapMcpServer } from '../src/main/material-mcp'
import { WorkspaceService } from '../src/main/workspace-service'

type JsonRpcRequest = { id?: string | number | null; method?: string; params?: Record<string, unknown> }

async function main(): Promise<void> {
  const workspaceRoot = process.argv[2]
  const password = process.argv[3]
  if (!workspaceRoot) {
    process.stderr.write('Usage: material-map-mcp <workspace-root> [password]\n')
    process.exitCode = 2
    return
  }

  const workspace = new WorkspaceService()
  await workspace.open(workspaceRoot, password)
  const tools = new MaterialMapMcpServer(workspace)
  const reply = (id: JsonRpcRequest['id'], result: unknown): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })}\n`) }
  const failure = (id: JsonRpcRequest['id'], message: string, code = -32000): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`) }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of input) {
      if (!line.trim()) continue
      let request: JsonRpcRequest
      try { request = JSON.parse(line) as JsonRpcRequest } catch { failure(null, 'Invalid JSON.', -32700); continue }
      if (!request.method || request.id === undefined) continue
      try {
        if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'material-map', version: '0.1.0' } })
        else if (request.method === 'tools/list') reply(request.id, { tools: tools.listTools() })
        else if (request.method === 'tools/call') {
          const name = String(request.params?.name ?? '')
          const args = request.params?.arguments && typeof request.params.arguments === 'object' && !Array.isArray(request.params.arguments) ? request.params.arguments as Record<string, unknown> : {}
          const result = await tools.call(name, args)
          reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false })
        } else if (request.method === 'ping') reply(request.id, {})
        else failure(request.id, `Unsupported method: ${request.method}`, -32601)
      } catch (error) { failure(request.id, error instanceof Error ? error.message : 'Tool request failed.') }
    }
  } finally { workspace.close() }
}

void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
