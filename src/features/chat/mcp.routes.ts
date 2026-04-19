import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import { createLimiter } from '../../shared/rate-limit/rate-limit.js'

export const mcpRouter = Router()
mcpRouter.use(json())

// Rate limiter: 30 requests per minute per widget key (MCP shares the key).
const mcpLimiter = createLimiter('mcp', { limit: 30, windowSec: 60 })

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

      await mcpLimiter.checkOrThrow(widgetKey)

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
                description: `Search the documentation for "${project.name}". Returns the most relevant passages with their location in the page hierarchy. Use a natural-language query describing what you're looking for — not just keywords.`,
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
                description: `List all documentation pages for "${project.name}" with their slug and a short preview. Use this to discover what sections exist before calling get_page for any of them.`,
                inputSchema: { type: 'object', properties: {} },
              },
              {
                name: 'get_page',
                description: `Fetch the full content of a single documentation page by its slug. Use this after search_documentation or list_pages when you need the entire page, not just the matched excerpt. When the page has a screen-recorded walkthrough, the response also includes the video URL + ElevenLabs voice-over URL — suggest them to the user when a visual walkthrough would help.`,
                inputSchema: {
                  type: 'object',
                  properties: {
                    slug: { type: 'string', description: 'The page slug as returned by list_pages or search_documentation (e.g. "create-your-first-project")' },
                  },
                  required: ['slug'],
                },
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
            const { findPagesByProjectId } = await import('../page/page.repository.js')

            // Retrieve generously like the chat pipeline does (top-20 at a
            // low threshold). Claude will filter down on its side — it's
            // cheaper for Claude to see more context than to call back.
            const embedding = await embedText(query)
            const [chunks, pages] = await Promise.all([
              searchChunks(project.id, embedding, 20, 0.15),
              findPagesByProjectId(project.id),
            ])

            if (chunks.length === 0) {
              res.json(jsonRpcResponse(body.id, {
                content: [{ type: 'text', text: 'No relevant documentation found for this query.' }],
              }))
              return
            }

            // Build breadcrumb ("Parent > Page") so Claude understands how
            // a chunk relates to the overall sidebar structure.
            const byId = new Map(pages.map((p) => [p.id, p]))
            const breadcrumbOf = (pageId: string): string => {
              const trail: string[] = []
              let current = byId.get(pageId)
              const seen = new Set<string>()
              while (current && !seen.has(current.id)) {
                seen.add(current.id)
                trail.unshift(current.title)
                current = current.parentId ? byId.get(current.parentId) : undefined
              }
              return trail.join(' > ')
            }

            const text = chunks.map((c) =>
              `## ${breadcrumbOf(c.pageId) || c.pageTitle} (/${c.pageSlug})\n${c.chunkText}`,
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

          if (toolName === 'get_page') {
            const slug = (args.slug ?? '') as string
            if (!slug.trim()) {
              res.json(jsonRpcResponse(body.id, { content: [{ type: 'text', text: 'Please provide a page slug.' }] }))
              return
            }

            const { findPagesByProjectId } = await import('../page/page.repository.js')
            const pages = await findPagesByProjectId(project.id)
            const page = pages.find((p) => p.slug === slug)

            if (!page) {
              res.json(jsonRpcResponse(body.id, {
                content: [{ type: 'text', text: `No page found with slug "${slug}". Call list_pages to see available slugs.` }],
              }))
              return
            }

            const byId = new Map(pages.map((p) => [p.id, p]))
            const trail: string[] = []
            let cur = byId.get(page.id)
            const seen = new Set<string>()
            while (cur && !seen.has(cur.id)) {
              seen.add(cur.id)
              trail.unshift(cur.title)
              cur = cur.parentId ? byId.get(cur.parentId) : undefined
            }
            const breadcrumb = trail.join(' > ')

            // Resolve video + voice-over URLs for this page when a completed
            // run produced them. Gives Claude a concrete \"watch the
            // walkthrough\" link it can suggest to the user.
            let mediaBlock = ''
            try {
              const { findLatestRunByPageId } = await import('../run/run.repository.js')
              const { getPublicUrl } = await import('../../shared/db/storage.repository.js')
              const run = await findLatestRunByPageId(page.id)
              const summary = run?.summaryJson as Record<string, unknown> | null
              const videoPath = summary?.videoPath as string | undefined
              const voiceover = summary?.voiceover as Record<string, unknown> | null
              const videoUrl = videoPath ? getPublicUrl('artifacts', videoPath) : null
              const audioUrl = (voiceover?.audioUrl as string | undefined)
                ?? (voiceover?.audioPath ? getPublicUrl('artifacts', voiceover.audioPath as string) : null)
              if (videoUrl || audioUrl) {
                const lines = ['## Walkthrough media']
                if (videoUrl) lines.push(`- Video: ${videoUrl}`)
                if (audioUrl) lines.push(`- Voice-over (ElevenLabs narration): ${audioUrl}`)
                lines.push('The video\'s original audio track is muted in the public docs; the voice-over is the intended audio. Play them in sync if the user wants the full experience.')
                mediaBlock = '\n\n' + lines.join('\n')
              }
            } catch {
              // Best-effort — never fail get_page on media lookup issues.
            }

            const pageBody = page.content?.trim() || '_(This page has no content yet.)_'
            const text = `# ${breadcrumb || page.title} (/${page.slug})\n\n${pageBody}${mediaBlock}`

            res.json(jsonRpcResponse(body.id, {
              content: [{ type: 'text', text }],
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
