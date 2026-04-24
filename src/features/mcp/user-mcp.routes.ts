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
  DeletePageToolArgsSchema,
  ReorderPagesToolArgsSchema,
} from './mcp.schema.js'
import {
  findActiveTokenByValue,
  findTokenByValueAnyState,
  touchTokenLastUsed,
} from './mcp.repository.js'
import type { McpAuthContext, McpScope } from './mcp.types.js'

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

/** Grab the client IP without trusting the proxy chain blindly. Express gives
 *  us `req.ip` when `trust proxy` is set, otherwise we fall back to the raw
 *  socket address. Only the first hop of X-Forwarded-For is used — returning
 *  null is acceptable (the column is nullable). */
function extractClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return req.ip ?? req.socket?.remoteAddress ?? null
}

/** Capability matrix: which scope is required to invoke each tool. `read` is
 *  the floor — every tool that takes a token needs at least that. `write`
 *  gates any mutation that an RAG integration shouldn't be able to do.
 *  `admin` gates destructive ops that you want to keep out of a token that
 *  might be pasted into a less trusted client. */
const TOOL_SCOPE_REQUIREMENT: Record<string, McpScope> = {
  list_projects: 'read',
  list_pages: 'read',
  get_page: 'read',
  search_documentation: 'read',
  create_project: 'write',
  create_page: 'write',
  update_page: 'write',
  reorder_pages: 'write',
  delete_page: 'admin',
}

function scopeCovers(actual: McpScope, required: McpScope): boolean {
  const rank: Record<McpScope, number> = { read: 0, write: 1, admin: 2 }
  return rank[actual] >= rank[required]
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
        // Disambiguate so the user can act: a revoked token means "regenerate",
        // an expired token means "create a new one (or turn off expiry)",
        // an unknown token means "wrong paste". One extra round-trip, but
        // only on the unhappy path.
        const probe = await findTokenByValueAnyState(tokenValue)
        const message =
          !probe ? 'Invalid token'
          : probe.revokedAt ? 'Token revoked'
          : probe.expiresAt && probe.expiresAt.getTime() <= Date.now() ? 'Token expired'
          : 'Invalid or revoked token'
        res.status(401).json(jsonRpcError(rpcId, -32001, message))
        return
      }
      const ctx: McpAuthContext = {
        userId: token.userId,
        teamId: token.teamId,
        tokenId: token.id,
        scope: token.scope,
      }

      if (!body || body.jsonrpc !== '2.0' || !body.method) {
        res.json(jsonRpcError(rpcId, -32600, 'Invalid JSON-RPC request'))
        return
      }

      // Capture the client IP for audit — falls back to null when we can't
      // determine it (no trust-proxy, missing forwarded header). Never blocks
      // the request: `touchTokenLastUsed` is fire-and-forget.
      const clientIp = extractClientIp(req)
      void touchTokenLastUsed(ctx.tokenId, clientIp)

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
      'List every documentation project in the authorized workspace. Each item includes id, name, baseUrl, and description. Use before any other project-scoped tool to discover available projects.\n\nCompanion tools: `create_project`, `list_pages`, `get_page`, `search_documentation`, `create_page`, `update_page`, `delete_page`, `reorder_pages`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description:
      'Create a new documentation project in the authorized workspace. Returns the created project (with id) ready to be populated with pages.\n\nCompanion tools: `list_projects`, `list_pages`, `create_page`.',
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
      'List all pages of a project with slug, title, status and a short content preview. Use this to discover pages before calling get_page, create_page, update_page, delete_page, or reorder_pages.\n\nCompanion tools: `get_page`, `create_page`, `update_page`, `delete_page`, `reorder_pages`, `search_documentation`.',
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
      `Fetch everything needed to round-trip a page: markdown content, breadcrumb, parent slug, status, public-visibility, sort order, and briefing (objective / knowledge / resources). Image links inside the markdown are absolute public URLs — they keep working even when pasted into another project.

Use before a partial update so you can edit locally and send the whole new content back via \`update_page\`. Also use to export a page: read it here, then \`create_page\` in another project with the same fields.

Companion tools: \`list_pages\`, \`update_page\`, \`delete_page\`, \`search_documentation\`, \`create_page\` (for export → import).`,
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
      'Semantic search across the project documentation using RAG. Returns the most relevant chunks with their location in the hierarchy. Use natural-language questions, not just keywords.\n\nCompanion tools: `list_pages`, `get_page` (fetch the full page behind a returned chunk), `update_page`.',
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
      `Create a new documentation page in a project. Provide a title; a slug is auto-generated from it when omitted. Optional parentSlug nests the page under another one. Optional content is stored as markdown and auto-indexed for chat / search.

Markdown guidelines:
- The \`title\` is rendered separately as the page H1 — DO NOT repeat it as \`# Title\` at the top of \`content\`. If you do, the server silently strips the duplicate and returns a note in the response.
- Structure \`content\` with section headings: \`## Section\`, \`### Subsection\`. Don't dump a single wall of text.
- Use bullet lists, numbered steps, fenced code blocks, bold / italic where appropriate. GitHub-flavored markdown (\`> [!TIP]\`, \`> [!WARNING]\` …) is supported and renders as styled callouts.

Slug collisions: if the slug is already taken, the server auto-appends \`-2\`, \`-3\`, … and surfaces the adjustment in the response so you can inform the user.

Companion tools: \`list_pages\`, \`get_page\`, \`update_page\`, \`delete_page\`, \`reorder_pages\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        title: { type: 'string', description: 'Human-readable page title (rendered as H1 above the content — do not duplicate it in content).' },
        slug: {
          type: 'string',
          description: 'Lowercase URL slug (a-z, 0-9, -). Auto-generated from the title when omitted.',
        },
        parentSlug: {
          type: 'string',
          description: 'Optional slug of the parent page to nest this one under.',
        },
        content: {
          type: 'string',
          description: 'Optional initial markdown body. Do NOT start with an H1 matching the title — use ## for top-level sections instead.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'exploring', 'published'],
          description: 'Lifecycle status. Defaults to "draft" when omitted.',
        },
        isPublic: {
          type: 'boolean',
          description: 'When true, the page is visible on the public docs site. Defaults to false.',
        },
        briefing: {
          type: 'object',
          description: 'Per-page briefing (objective, knowledge, typed resources). Pass as-is when importing a page exported via get_page.',
          properties: {
            objective: { type: 'string' },
            knowledge: { type: 'string' },
            resources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['url', 'credential', 'endpoint', 'file', 'note'] },
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['type', 'label', 'value'],
              },
            },
          },
        },
        sortOrder: {
          type: 'integer',
          minimum: 0,
          description: '0-based order among siblings. Auto-assigned (max+1) when omitted.',
        },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'update_page',
    description:
      `Edit an existing page by slug. This is the primary editing tool — use it to fix typos, rewrite sections, add content, rename, or change the slug. Pass any subset of \`title\`, \`newSlug\`, \`content\`, or \`contentAppend\`.

Editing patterns:
- **Full rewrite**: pass \`content\` with the complete new markdown body (replaces existing).
- **Incremental addition**: pass \`contentAppend\` with the markdown to add — it's concatenated at the end of the existing content. Faster and safer than a full rewrite when you only want to add a section.
- **Partial edit of existing sections**: call \`get_page\` first to read current content, edit locally, then \`update_page\` with the full \`content\`. (\`contentAppend\` is only for additions.)
- \`content\` and \`contentAppend\` are mutually exclusive — pick one.

Any content change is auto re-indexed for chat / search and resets the rich-editor state so the UI picks up the fresh markdown.

Markdown guidelines (same as create_page):
- The \`title\` is rendered separately as the page H1 — DO NOT repeat it as \`# Title\` at the top of \`content\`.
- Structure with \`## Section\` / \`### Subsection\` headings.
- Use GitHub-flavored markdown (lists, code blocks, callouts like \`> [!TIP]\` / \`> [!WARNING]\`).

Companion tools: \`get_page\` (read before partial edit), \`create_page\`, \`delete_page\`, \`reorder_pages\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Current slug of the page to update.' },
        title: { type: 'string', description: 'New title (rendered as H1 above the content — do not duplicate it in content).' },
        newSlug: { type: 'string', description: 'New slug (lowercase a-z 0-9 -).' },
        content: {
          type: 'string',
          description: 'Full new markdown body — REPLACES the existing content entirely. Do NOT start with an H1 matching the title. Mutually exclusive with contentAppend.',
        },
        contentAppend: {
          type: 'string',
          description: 'Markdown to add at the end of the existing content. Use this for incremental additions (new section, extra note) without rewriting the whole page. Mutually exclusive with content.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'exploring', 'published'],
          description: 'New lifecycle status.',
        },
        isPublic: {
          type: 'boolean',
          description: 'Toggle public-docs visibility.',
        },
        briefing: {
          type: 'object',
          description: 'Replaces the full briefing object when provided.',
          properties: {
            objective: { type: 'string' },
            knowledge: { type: 'string' },
            resources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['url', 'credential', 'endpoint', 'file', 'note'] },
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['type', 'label', 'value'],
              },
            },
          },
        },
      },
      required: ['projectId', 'slug'],
    },
  },
  {
    name: 'delete_page',
    description:
      `Permanently delete a page by slug. This is IRREVERSIBLE — there is no trash / undo. Embeddings are removed automatically, and markdown links to the deleted page are stripped from sibling pages so stale references disappear from the public docs and chat.

Use with care — prefer \`update_page\` if you only want to rename or rewrite. Typical use case: cleaning up draft / experimental pages that the user no longer wants.

Companion tools: \`list_pages\` (discover slugs first), \`update_page\`, \`reorder_pages\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Slug of the page to delete.' },
      },
      required: ['projectId', 'slug'],
    },
  },
  {
    name: 'reorder_pages',
    description:
      `Change the order of pages and/or re-parent them within a project. Accepts a batch of \`{ id, parentId, sortOrder }\` tuples — apply them all in one call to avoid intermediate inconsistent states.

Typical flow:
1. Call \`list_pages\` to get current ids / slugs.
2. Build a new desired order. \`sortOrder\` is 0-based; top-level pages have \`parentId = null\`.
3. Pass the full set you want to move. Pages not in the payload keep their current position.

Companion tools: \`list_pages\`, \`create_page\`, \`update_page\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        items: {
          type: 'array',
          description: 'Array of pages to move. Each item sets the new parent and position.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Page UUID.' },
              parentId: { type: ['string', 'null'], description: 'New parent page UUID, or null for top-level.' },
              sortOrder: { type: 'integer', description: '0-based position among siblings.' },
            },
            required: ['id', 'parentId', 'sortOrder'],
          },
        },
      },
      required: ['projectId', 'items'],
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
  // Scope check happens before arg parsing — no need to validate a payload
  // the caller isn't allowed to send in the first place.
  const required = TOOL_SCOPE_REQUIREMENT[name]
  if (required && !scopeCovers(ctx.scope, required)) {
    return toolText(
      `This token's scope (${ctx.scope}) doesn't allow \`${name}\`. Required: ${required}. Ask the workspace owner to create a token with a higher scope.`,
    )
  }

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
    case 'delete_page':
      return handleDeletePage(rawArgs, ctx)
    case 'reorder_pages':
      return handleReorderPages(rawArgs, ctx)
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
  const parentSlug = page.parentId ? pages.find((p) => p.id === page.parentId)?.slug ?? null : null

  // Everything needed for a lossless round-trip into another project via
  // create_page — status, isPublic, sortOrder, briefing. Markdown image URLs
  // stay absolute (they point to the public artifacts bucket) so they keep
  // rendering regardless of which project re-imports the page.
  const meta = {
    slug: page.slug,
    title: page.title,
    parentSlug,
    status: page.status,
    isPublic: page.isPublic,
    sortOrder: page.sortOrder,
    briefing: page.briefing,
  }

  const text =
    `# ${crumb || page.title} (/${page.slug})\n\n` +
    `${bodyText}\n\n` +
    `---\n\n` +
    `**Metadata (for round-trip import via create_page):**\n\n` +
    '```json\n' +
    JSON.stringify(meta, null, 2) +
    '\n```'
  return toolText(text)
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

/** Normalize a string for a forgiving equality check: lowercase, strip
 *  punctuation edge cases, collapse whitespace. Good enough to catch
 *  "Getting Started" vs "Getting  started " as the same header. */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface H1Processing {
  content: string
  /** True when a leading `# <title>` matching the page title was removed. */
  stripped: boolean
  /** Present when the leading H1 doesn't match the title — the content stays
   *  untouched (we only strip what's clearly redundant) but we surface the
   *  ambiguity so Claude can tell the user "this page may render two H1s". */
  warning?: string
}

/** Strip a redundant leading H1 that matches the page title. The page title
 *  is already rendered as H1 by the frontend, so repeating it in content is
 *  what Claude called out as "des H1 dupliqués à cause de moi". We only touch
 *  the content when the H1 clearly matches — otherwise we leave it and warn. */
function processLeadingH1(content: string, title: string): H1Processing {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  if (i >= lines.length) return { content, stripped: false }

  const firstLine = lines[i] ?? ''
  const match = firstLine.match(/^#\s+(.+?)\s*$/)
  if (!match) return { content, stripped: false }

  const h1 = match[1] ?? ''
  if (normalizeForCompare(h1) === normalizeForCompare(title)) {
    // Drop the H1 line AND any trailing blank lines that would otherwise
    // leave a gap at the top of the document.
    lines.splice(i, 1)
    while (i < lines.length && (lines[i] ?? '').trim() === '') lines.splice(i, 1)
    return { content: lines.join('\n'), stripped: true }
  }

  return {
    content,
    stripped: false,
    warning: `Content starts with H1 "${h1}" which doesn't match the page title "${title}". The title is rendered as the page H1 automatically, so this may display as two H1s. Consider removing the \`# ${h1}\` line from the content.`,
  }
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
  // by suffixing -2, -3… on collision. We remember the requested slug so we
  // can surface the adjustment to the caller (Claude) — previously the dedup
  // was silent and Claude kept building docs around slugs that didn't exist.
  const baseSlug = parsed.data.slug ?? slugify(parsed.data.title)
  const existing = new Set(pages.map((p) => p.slug))
  let slug = baseSlug
  let n = 2
  while (existing.has(slug)) {
    slug = `${baseSlug}-${n++}`
  }
  const slugAdjusted = slug !== baseSlug

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

  const sortOrder = parsed.data.sortOrder ?? pages.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1

  const { createPage } = await import('../page/page.service.js')
  const page = await createPage({
    projectId: parsed.data.projectId,
    parentId,
    title: parsed.data.title,
    slug,
    sortOrder,
  })

  // If content was provided, update it through the service so embeddings
  // get re-indexed (same code path as the UI editor). We also null out
  // contentBlocks — the BlockNote editor treats contentBlocks as the source
  // of truth when present, so forgetting to wipe it would make the editor
  // ignore the markdown we just wrote.
  let h1 = { stripped: false, warning: undefined as string | undefined }
  const hasContent = parsed.data.content !== undefined
  const hasMeta =
    parsed.data.status !== undefined ||
    parsed.data.isPublic !== undefined ||
    parsed.data.briefing !== undefined
  if (hasContent || hasMeta) {
    const { updatePage } = await import('../page/page.service.js')
    const update: {
      content?: string
      contentBlocks?: unknown
      status?: 'draft' | 'exploring' | 'published'
      isPublic?: boolean
      briefing?: { objective: string; knowledge: string; resources: { type: 'url' | 'credential' | 'endpoint' | 'file' | 'note'; label: string; value: string }[] }
    } = {}
    if (hasContent && parsed.data.content !== undefined) {
      const processed = processLeadingH1(parsed.data.content, parsed.data.title)
      h1 = { stripped: processed.stripped, warning: processed.warning }
      update.content = processed.content
      update.contentBlocks = null
    }
    if (parsed.data.status !== undefined) update.status = parsed.data.status
    if (parsed.data.isPublic !== undefined) update.isPublic = parsed.data.isPublic
    if (parsed.data.briefing !== undefined) update.briefing = parsed.data.briefing
    await updatePage(page.id, update, ctx.userId)
  }

  const notes: string[] = []
  if (slugAdjusted) {
    notes.push(
      `ℹ️ Requested slug "${baseSlug}" was already taken — created with slug "${slug}" instead.`,
    )
  }
  if (h1.stripped) {
    notes.push(
      'ℹ️ Stripped a duplicate `# Title` from the top of content — the page title is rendered as H1 automatically.',
    )
  }
  if (h1.warning) notes.push(`⚠️ ${h1.warning}`)

  const summary = `Created page **${page.title}** (slug: ${page.slug}, id: ${page.id}).`
  return toolText(notes.length > 0 ? `${summary}\n\n${notes.join('\n')}` : summary)
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

  // Resolve the effective new content:
  //   - `content` → full replace
  //   - `contentAppend` → concat at end of existing, with a blank line separator
  //     so we don't accidentally glue the append onto the last paragraph.
  let nextContent: string | undefined
  if (parsed.data.content !== undefined) {
    nextContent = parsed.data.content
  } else if (parsed.data.contentAppend !== undefined) {
    const existing = page.content?.trimEnd() ?? ''
    const toAppend = parsed.data.contentAppend.trimStart()
    nextContent = existing ? `${existing}\n\n${toAppend}` : toAppend
  }

  // Strip a duplicate leading H1 that matches the (possibly new) title —
  // same rule as create_page. Only applies to full-replace mode: a content
  // append is expected to be a mid-document addition, not a document head.
  let h1Processing: H1Processing | null = null
  if (parsed.data.content !== undefined && nextContent !== undefined) {
    const effectiveTitle = parsed.data.title ?? page.title
    h1Processing = processLeadingH1(nextContent, effectiveTitle)
    nextContent = h1Processing.content
  }

  const { updatePage } = await import('../page/page.service.js')
  // Wipe contentBlocks whenever we write content — the BlockNote editor
  // treats content_blocks as the source of truth when present, so leaving
  // it stale would make the MCP edit look like a no-op in the UI.
  const input: {
    title?: string
    slug?: string
    content?: string
    contentBlocks?: unknown
    status?: 'draft' | 'exploring' | 'published'
    isPublic?: boolean
    briefing?: { objective: string; knowledge: string; resources: { type: 'url' | 'credential' | 'endpoint' | 'file' | 'note'; label: string; value: string }[] }
  } = {
    title: parsed.data.title,
    slug: parsed.data.newSlug,
    content: nextContent,
  }
  if (nextContent !== undefined) input.contentBlocks = null
  if (parsed.data.status !== undefined) input.status = parsed.data.status
  if (parsed.data.isPublic !== undefined) input.isPublic = parsed.data.isPublic
  if (parsed.data.briefing !== undefined) input.briefing = parsed.data.briefing
  const updated = await updatePage(page.id, input, ctx.userId)

  const mode = parsed.data.content !== undefined ? 'replaced' : parsed.data.contentAppend !== undefined ? 'appended to' : 'updated'
  const notes: string[] = []
  if (h1Processing?.stripped) {
    notes.push(
      'ℹ️ Stripped a duplicate `# Title` from the top of content — the page title is rendered as H1 automatically.',
    )
  }
  if (h1Processing?.warning) notes.push(`⚠️ ${h1Processing.warning}`)

  const summary = `Updated page **${updated.title}** (slug: ${updated.slug}, ${mode}).`
  return toolText(notes.length > 0 ? `${summary}\n\n${notes.join('\n')}` : summary)
}

async function handleDeletePage(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = DeletePageToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)

  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)
  const page = pages.find((p) => p.slug === parsed.data.slug)
  if (!page) return toolText(`No page with slug "${parsed.data.slug}". Call list_pages to see available slugs.`)

  const { deletePage } = await import('../page/page.service.js')
  await deletePage(page.id)
  return toolText(
    `Deleted page **${page.title}** (slug: ${page.slug}). Embeddings removed, markdown links to this page stripped from siblings.`,
  )
}

async function handleReorderPages(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = ReorderPagesToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)
  await assertProjectInTeam(parsed.data.projectId, ctx.teamId)

  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(parsed.data.projectId)

  // Every id in the payload must belong to the target project — stops a
  // leaked token from reparenting pages across workspaces via a crafted
  // UUID list.
  const projectPageIds = new Set(pages.map((p) => p.id))
  const stray = parsed.data.items.filter((i) => !projectPageIds.has(i.id))
  if (stray.length > 0) {
    return toolText(
      `${stray.length} id(s) do not belong to this project: ${stray.map((s) => s.id).join(', ')}. Call list_pages to see valid ids.`,
    )
  }
  // parentId must also be a page in this project (or null for top-level).
  const invalidParents = parsed.data.items.filter(
    (i) => i.parentId !== null && !projectPageIds.has(i.parentId),
  )
  if (invalidParents.length > 0) {
    return toolText(
      `${invalidParents.length} item(s) reference a parent id outside this project. Use null for top-level pages.`,
    )
  }

  const { reorderPages } = await import('../page/page.service.js')
  await reorderPages(parsed.data.items)
  return toolText(`Reordered ${parsed.data.items.length} page(s).`)
}
