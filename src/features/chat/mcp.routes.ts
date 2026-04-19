import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'

export const mcpRouter = Router()
mcpRouter.use(json())

// Rate limiter: 30 requests per minute per API key
const mcpRateMap = new Map<string, { count: number; resetAt: number }>()
function checkMcpRateLimit(key: string): void {
  const now = Date.now()
  let entry = mcpRateMap.get(key)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 }
    mcpRateMap.set(key, entry)
  }
  entry.count++
  if (entry.count > 30) throw new NotFoundError('Rate limit exceeded')
}
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of mcpRateMap) { if (now > v.resetAt) mcpRateMap.delete(k) }
}, 300_000)

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

function jsonRpcResponse(id: string | number | undefined, result: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function jsonRpcError(id: string | number | undefined, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

// MCP endpoint — API key auth (same as widget)
// Usage in Claude: add as MCP server with URL https://app.doclee.tech/api/mcp/:widgetKey
mcpRouter.post('/:widgetKey', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const widgetKey = req.params.widgetKey as string
      if (!widgetKey) {
        res.json(jsonRpcError(undefined, -32600, 'Widget key is required'))
        return
      }

      checkMcpRateLimit(widgetKey)

      const { findProjectByMcpKey } = await import('../project/project.repository.js')
      const project = await findProjectByMcpKey(widgetKey)
      if (!project) throw new NotFoundError('MCP endpoint not found or disabled')

      const body = req.body as JsonRpcRequest
      if (body.jsonrpc !== '2.0' || !body.method) {
        res.json(jsonRpcError(body?.id, -32600, 'Invalid JSON-RPC request'))
        return
      }

      switch (body.method) {
        case 'initialize': {
          res.json(jsonRpcResponse(body.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: `doclee-${project.name}`, version: '1.0.0' },
          }))
          return
        }

        case 'tools/list': {
          res.json(jsonRpcResponse(body.id, {
            tools: [
              {
                name: 'search_documentation',
                description: `Search the documentation for "${project.name}". Returns relevant passages from the product documentation.`,
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'The search query or question about the product' },
                  },
                  required: ['query'],
                },
              },
              {
                name: 'list_pages',
                description: `List all documentation pages for "${project.name}".`,
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }))
          return
        }

        case 'tools/call': {
          const toolName = (body.params?.name ?? '') as string
          const args = (body.params?.arguments ?? {}) as Record<string, unknown>

          if (toolName === 'search_documentation') {
            const query = (args.query ?? '') as string
            if (query.length > 2000) {
              res.json(jsonRpcResponse(body.id, { content: [{ type: 'text', text: 'Query too long (max 2000 characters).' }] }))
              return
            }
            if (!query.trim()) {
              res.json(jsonRpcResponse(body.id, { content: [{ type: 'text', text: 'Please provide a search query.' }] }))
              return
            }

            const { embedText } = await import('../../shared/ai/gemini.client.js')
            const { searchChunks } = await import('./chat.repository.js')

            const embedding = await embedText(query)
            const chunks = await searchChunks(project.id, embedding, 8, 0.25)

            if (chunks.length === 0) {
              res.json(jsonRpcResponse(body.id, {
                content: [{ type: 'text', text: 'No relevant documentation found for this query.' }],
              }))
              return
            }

            const text = chunks.map((c) =>
              `## ${c.pageTitle} (/${c.pageSlug})\n${c.chunkText}`,
            ).join('\n\n---\n\n')

            res.json(jsonRpcResponse(body.id, {
              content: [{ type: 'text', text }],
            }))
            return
          }

          if (toolName === 'list_pages') {
            const { findPagesByProjectId } = await import('../page/page.repository.js')
            const pages = await findPagesByProjectId(project.id)

            const text = pages
              .filter((p) => p.content?.trim())
              .map((p) => `- **${p.title}** (/${p.slug})${p.content ? ` — ${p.content.slice(0, 100)}...` : ''}`)
              .join('\n')

            res.json(jsonRpcResponse(body.id, {
              content: [{ type: 'text', text: text || 'No pages with content found.' }],
            }))
            return
          }

          res.json(jsonRpcError(body.id, -32601, `Unknown tool: ${toolName}`))
          return
        }

        case 'notifications/initialized':
        case 'ping': {
          res.json(jsonRpcResponse(body.id, {}))
          return
        }

        default: {
          res.json(jsonRpcError(body.id, -32601, `Unknown method: ${body.method}`))
        }
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json(jsonRpcError(undefined, -32000, err.message))
      } else {
        next(err)
      }
    }
  })()
})
