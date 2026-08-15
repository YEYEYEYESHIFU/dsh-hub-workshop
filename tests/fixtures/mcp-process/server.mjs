import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

function buildServer() {
  const server = new McpServer({ name: 'omdsh-harness-mcp-probe', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('harness-echo', { description: 'Return a deterministic local fixture result.' }, async () => ({
    content: [{ type: 'text', text: 'fixture-ok' }],
  }))
  server.registerTool('harness-fail', { description: 'Terminate this isolated fixture process.' }, async () => {
    process.exit(23)
  })
  return server
}

serveStdio(buildServer, { legacy: 'reject' })
