import { Router, json } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createLimiter } from '../../shared/rate-limit/rate-limit.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { AppError } from '../../shared/middleware/error.middleware.js'
import {
  CreateProjectToolArgsSchema,
  ListPagesToolArgsSchema,
  GetPageToolArgsSchema,
  SearchDocumentationToolArgsSchema,
  CreatePageToolArgsSchema,
  UpdatePageToolArgsSchema,
} from './mcp.schema.js'
import { findActiveTokenByValue, touchTokenLastUsed } from './mcp.repository.js'
import type { McpAuthContext } from './mcp.types.js'

export const userMcpRouter = Router()
userMcpRouter.use(json({ limit: '1mb' }))

// Rate limiter keyed by the token string — a single leaked token gets one
// bucket, independent of IP. Slightly more generous than the project MCP
// (60 vs 30) because authors make more calls than end-users.
const userMcpLimiter = createLimiter('mcp-user', { limit: 60, windowSec: 60 })

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

function toolText(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

/** Defense in depth — even though the token encodes teamId, every tool that
 *  takes a projectId argument re-asserts the project belongs to that team. */
async function assertProjectInTeam(projectId: string, teamId: string): Promise<void> {
  const { findProjectById } = await import('../project/project.repository.js')
  const project = await findProjectById(projectId)
  if (!project || project.teamId !== teamId) {
    throw new AppError('Project not found in authorized workspace', 'PROJECT_NOT_IN_TEAM', 404)
  }
}

/** Builds `Parent > Child > Leaf` from a flat page list. Copied from the
 *  project MCP — simple enough that duplication beats an extra shared file. */
function breadcrumbOf(pageId: string, byId: Map<string, { id: string; title: string; parentId: string | null }>): string {
  const trail: string[] = []
  const seen = new Set<string>()
  let current = byId.get(pageId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    trail.unshift(current.title)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return trail.join(' > ')
}

userMcpRouter.post('/:token', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const body = req.body as JsonRpcRequest | undefined
    const rpcId = body?.id
    try {
      const tokenValue = req.params.token as string
      if (!tokenValue) {
        res.json(jsonRpcError(rpcId, -32600, 'Token is required'))
        return
      }

      await userMcpLimiter.checkOrThrow(tokenValue)

      const token = await findActiveTokenByValue(tokenValue)
      if (!token) {
        res.status(401).json(jsonRpcError(rpcId, -32001, 'Invalid or revoked token'))
        return
      }
      const ctx: McpAuthContext = { userId: token.userId, teamId: token.teamId, tokenId: token.id }

      if (!body || body.jsonrpc !== '2.0' || !body.method) {
        res.json(jsonRpcError(rpcId, -32600, 'Invalid JSON-RPC request'))
        return
      }

      // Touch last_used_at — fire-and-forget, never blocks the response.
      void touchTokenLastUsed(ctx.tokenId)

      switch (body.method) {
        case 'initialize': {
          res.json(jsonRpcResponse(rpcId, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'doclee-user', version: '1.0.0' },
          }))
          return
        }

        case 'notifications/initialized':
        case 'ping': {
          res.json(jsonRpcResponse(rpcId, {}))
          return
        }

        case 'tools/list': {
          res.json(jsonRpcResponse(rpcId, { tools: TOOL_DEFINITIONS }))
          return
        }

        case 'tools/call': {
          const toolName = String(body.params?.name ?? '')
          const rawArgs = (body.params?.arguments ?? {}) as Record<string, unknown>
          const result = await dispatchTool(toolName, rawArgs, ctx)
          res.json(jsonRpcResponse(rpcId, result))
          return
        }

        default: {
          res.json(jsonRpcError(rpcId, -32601, `Unknown method: ${body.method}`))
        }
      }
    } catch (err) {
      // Keep JSON-RPC envelope intact even for AppErrors — MCP clients expect
      // a parseable response, not a raw 4xx body.
      if (err instanceof AppError) {
        const code = err.statusCode === 429 ? -32002 : err.statusCode === 402 ? -32003 : -32000
        res.status(err.statusCode).json(jsonRpcError(rpcId, code, err.message))
        return
      }
      next(err)
    }
  })()
})

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description:
      'List every documentation project in the authorized workspace. Each item includes id, name, baseUrl, and description. Use before any other project-scoped tool to discover available projects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description:
      'Create a new documentation project in the authorized workspace. Returns the created project (with id) ready to be populated with pages.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name shown in the dashboard.' },
        baseUrl: { type: 'string', description: 'URL of the product being documented.' },
        description: { type: 'string', description: 'Optional one-line description.' },
      },
      required: ['name', 'baseUrl'],
    },
  },
  {
    name: 'list_pages',
    description:
      'List all pages of a project with slug, title, status and a short content preview. Use this to discover pages before calling get_page, create_page, or update_page.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID returned by list_projects.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_page',
    description:
      'Fetch the full markdown content of a page by slug, including its breadcrumb in the page hierarchy.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Page slug (e.g. "getting-started").' },
      },
      required: ['projectId', 'slug'],
    },
  },
  {
    name: 'search_documentation',
    description:
      'Semantic search across the project documentation using RAG. Returns the most relevant chunks with their location in the hierarchy. Use natural-language questions, not just keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        query: { type: 'string', description: 'Natural-language question about the product.' },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'create_page',
    description:
      'Create a new documentation page in a project. Provide a title; a slug is auto-generated from it when omitted. Optional parentSlug nests the page under another one. Optional content is stored as markdown and auto-indexed for chat / search.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        title: { type: 'string', description: 'Human-readable page title.' },
        slug: {
          type: 'string',
          description: 'Lowercase URL slug (a-z, 0-9, -). Auto-generated from the title when omitted.',
        },
        parentSlug: {
          type: 'string',
          description: 'Optional slug of the parent page to nest this one under.',
        },
        content: { type: 'string', description: 'Optional initial markdown body.' },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'update_page',
    description:
      'Update an existing page by slug. Pass any subset of title, newSlug, content. Content changes are auto re-indexed for chat / search.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Current slug of the page to update.' },
        title: { type: 'string', description: 'New title.' },
        newSlug: { type: 'string', description: 'New slug (lowercase a-z 0-9 -).' },
        content: { type: 'string', description: 'New markdown body (replaces existing).' },
      },
      required: ['projectId', 'slug'],
    },
  },
]

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  switch (name) {
    case 'list_projects':
      return handleListProjects(ctx)
    case 'create_project':
      return handleCreateProject(rawArgs, ctx)
    case 'list_pages':
      return handleListPages(rawArgs, ctx)
    case 'get_page':
      return handleGetPage(rawArgs, ctx)
    case 'search_documentation':
      return handleSearchDocumentation(rawArgs, ctx)
    case 'create_page':
      return handleCreatePage(rawArgs, ctx)
    case 'update_page':
      return handleUpdatePage(rawArgs, ctx)
    default:
      return toolText(`Unknown tool: ${name}`)
  }
}

// --- Tool implementations ---

async function handleListProjects(ctx: McpAuthContext): Promise<ReturnType<typeof toolText>> {
  const { listProjectsForUser } = await import('../project/project.repository.js')
  const all = await listProjectsForUser(ctx.userId, ctx.teamId)
  if (all.length === 0) return toolText('No projects in this workspace yet. Call create_project to add one.')
  const text = all
    .map((p) => `- **${p.name}** (id: ${p.id})\n  ${p.baseUrl}${p.description ? `\n  ${p.description}` : ''}`)
    .join('\n')
  return toolText(text)
}

async function handleCreateProject(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = CreateProjectToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await enforceQuotaOrThrow(ctx.teamId)
  const { createProject } = await import('../project/project.service.js')
  const project = await createProject(ctx.userId, ctx.teamId, {
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    description: parsed.data.description,
  })
  return toolText(
    `Created project **${project.name}** (id: ${project.id}). It has a starter "Getting Started" page.`,
  )
}

async function handleListPages(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = ListPagesToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)
  if (pages.length === 0) return toolText('No pages yet. Call create_page to add one.')

  const byId = new Map(pages.map((p) => [p.id, { id: p.id, title: p.title, parentId: p.parentId }]))
  const lines = pages.map((p) => {
    const crumb = breadcrumbOf(p.id, byId) || p.title
    const preview = p.content?.trim()
      ? ` — ${p.content.trim().replace(/\s+/g, ' ').slice(0, 100)}${p.content.length > 100 ? '…' : ''}`
      : ' — (empty)'
    return `- **${crumb}** (slug: ${p.slug}, status: ${p.status})${preview}`
  })
  return toolText(lines.join('\n'))
}

async function handleGetPage(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = GetPageToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)
  const page = pages.find((p) => p.slug === parsed.data.slug)
  if (!page) return toolText(`No page with slug "${parsed.data.slug}". Call list_pages to see available slugs.`)

  const byId = new Map(pages.map((p) => [p.id, { id: p.id, title: p.title, parentId: p.parentId }]))
  const crumb = breadcrumbOf(page.id, byId)
  const bodyText = page.content?.trim() || '_(This page has no content yet.)_'
  return toolText(`# ${crumb || page.title} (/${page.slug})\n\n${bodyText}`)
}

async function handleSearchDocumentation(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = SearchDocumentationToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)

  const { embedText } = await import('../../shared/ai/gemini.client.js')
  const { searchChunks } = await import('../chat/chat.repository.js')
  const { findPagesByProjectId } = await import('../page/page.repository.js')

  const embedding = await embedText(parsed.data.query)
  const [chunks, pages] = await Promise.all([
    searchChunks(parsed.data.projectId, embedding, 20, 0.15),
    findPagesByProjectId(parsed.data.projectId),
  ])

  if (chunks.length === 0) return toolText('No relevant documentation found for this query.')

  const byId = new Map(pages.map((p) => [p.id, { id: p.id, title: p.title, parentId: p.parentId }]))
  const text = chunks
    .map((c) => `## ${breadcrumbOf(c.pageId, byId) || c.pageTitle} (/${c.pageSlug})\n${c.chunkText}`)
    .join('\n\n---\n\n')
  return toolText(text)
}

function slugify(title: string): string {
  const cleaned = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned || 'page'
}

async function handleCreatePage(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = CreatePageToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)
  await enforceQuotaOrThrow(ctx.teamId)

  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)

  // Slug — use provided, else derive. Ensure it's unique within the project
  // by suffixing -2, -3… on collision.
  const baseSlug = parsed.data.slug ?? slugify(parsed.data.title)
  const existing = new Set(pages.map((p) => p.slug))
  let slug = baseSlug
  let n = 2
  while (existing.has(slug)) {
    slug = `${baseSlug}-${n++}`
  }

  // Optional parent lookup by slug.
  let parentId: string | undefined
  if (parsed.data.parentSlug) {
    const parent = pages.find((p) => p.slug === parsed.data.parentSlug)
    if (!parent) {
      return toolText(
        `No parent page with slug "${parsed.data.parentSlug}". Call list_pages to see available slugs, or omit parentSlug for a top-level page.`,
      )
    }
    parentId = parent.id
  }

  const sortOrder = pages.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1

  const { createPage } = await import('../page/page.service.js')
  const page = await createPage({
    projectId: parsed.data.projectId,
    parentId,
    title: parsed.data.title,
    slug,
    sortOrder,
  })

  // If content was provided, update it through the service so embeddings
  // get re-indexed (same code path as the UI editor).
  if (parsed.data.content) {
    const { updatePage } = await import('../page/page.service.js')
    await updatePage(page.id, { content: parsed.data.content }, ctx.userId)
  }

  return toolText(`Created page **${page.title}** (slug: ${page.slug}, id: ${page.id}).`)
}

async function handleUpdatePage(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = UpdatePageToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)
  await enforceQuotaOrThrow(ctx.teamId)

  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)
  const page = pages.find((p) => p.slug === parsed.data.slug)
  if (!page) return toolText(`No page with slug "${parsed.data.slug}". Call list_pages to see available slugs.`)

  // Guard against newSlug collisions within the same project.
  if (parsed.data.newSlug && parsed.data.newSlug !== parsed.data.slug) {
    const taken = pages.some((p) => p.slug === parsed.data.newSlug && p.id !== page.id)
    if (taken) return toolText(`Slug "${parsed.data.newSlug}" is already taken by another page.`)
  }

  const { updatePage } = await import('../page/page.service.js')
  const updated = await updatePage(
    page.id,
    {
      title: parsed.data.title,
      slug: parsed.data.newSlug,
      content: parsed.data.content,
    },
    ctx.userId,
  )

  return toolText(`Updated page **${updated.title}** (slug: ${updated.slug}).`)
}
