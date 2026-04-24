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
  GenerateDocToolArgsSchema,
  GenerateVoiceoverToolArgsSchema,
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
  generate_doc: 'write',
  generate_voiceover: 'write',
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
      `Fetch everything needed to round-trip a page: markdown content, breadcrumb, parent slug, status, public-visibility, sort order, briefing (objective / knowledge / resources), and recorded media. Image links inside the markdown are absolute public URLs — they keep working even when pasted into another project.

The metadata block includes \`media.video.url\`: when the page has both a screen recording and a voice-over, this is a single MP4 with the narration already muxed in (\`muxed: true\`). Ideal for creating a single video embed block when transferring the page to Notion / Confluence / any other MCP target. If the mux is unavailable, \`media.video\` (raw) and \`media.voiceover\` may be returned separately so you can still surface them.

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
  {
    name: 'generate_doc',
    description:
      `Generate the markdown documentation for a page from its attached screen-recording video using Gemini 2.5 Flash. The page must already have a latest run with a video attached (uploaded via the UI or the Try Doc / Record flow).

This is a long-running call — Gemini analyzes every frame, extracts step-level screenshots, and produces a structured doc. Typical duration: 30–120 seconds depending on video length. The agent calling this should be patient and not retry early.

Side effects:
- Writes the markdown to \`doc_pages.content\` (overwrites any existing content after snapshotting the previous version for undo).
- Stores the immutable AI output under \`generated_docs.markdown_content\` against the run.
- Sets \`doc_pages.status = 'published'\`.
- Re-indexes the page embeddings for chat / search.
- Counts one \`doc_run\` against the monthly token quota — fails with \`QUOTA_EXCEEDED\` on hard-cap plans.

Companion tools: \`get_page\` (read the result), \`update_page\` (manual tweaks), \`generate_voiceover\` (next step).`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Page slug — the target page must already have a run with a video attached.' },
      },
      required: ['projectId', 'slug'],
    },
  },
  {
    name: 'generate_voiceover',
    description:
      `Produce a voice-over narration (ElevenLabs multilingual TTS) synchronized to the video timestamps of the page's latest run. Uses the page's current \`content\` as the source script — call \`generate_doc\` first if the page has no doc yet.

Long-running (typically 15–60 seconds). Requires \`ELEVENLABS_API_KEY\` on the server and a page that already has (a) a video with step timestamps and (b) some markdown content.

Side effects:
- Uploads per-step segment mp3s and a concatenated \`voiceover.mp3\` to the artifacts bucket.
- Stores the result on \`run.summary_json.voiceover\` and clears any stale video+voiceover mux cache.
- Kicks off a background mux so the full narrated MP4 is ready for export / \`get_page\` without delay.
- Counts one \`voiceover\` against the monthly token quota.

Optional voice controls (\`voiceId\`, \`language\`) override the project defaults — omit both to use whatever the project is configured for.

Companion tools: \`generate_doc\` (prerequisite when no content exists), \`get_page\` (read media.video URL after), \`update_page\` (edit script before re-running).`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Page slug — must already have a run with video timestamps.' },
        voiceId: { type: 'string', description: 'Optional ElevenLabs voice ID. Defaults to the project-level voice.' },
        language: { type: 'string', description: 'Optional BCP-47 language tag (e.g. "en", "fr"). Defaults to the project-level language.' },
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
    case 'generate_doc':
      return handleGenerateDoc(rawArgs, ctx)
    case 'generate_voiceover':
      return handleGenerateVoiceover(rawArgs, ctx)
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

  // Resolve the page's media so an agent pushing this doc into Notion / any
  // other MCP target can create matching video/audio blocks — markdown only
  // carries screenshot URLs, never the full recording or the narration.
  //
  // When both a video and a voice-over exist we return a single URL pointing
  // to the muxed MP4 (`runs/<id>/video-with-voiceover.mp4`) so the agent
  // creates one embed with narration baked in, rather than two parallel
  // tracks the user would have to sync manually. The mux path is cached in
  // `run.summary_json.muxedVideoPath` after the first successful call — later
  // get_page hits return instantly. Mux failures silently fall back to the
  // raw video + voiceover URLs so the tool call stays useful.
  const media = await resolvePageMedia(page.id).catch((err: unknown) => {
    console.warn('[mcp] get_page media resolve failed:', (err as Error).message)
    return null
  })

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
    media,
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

interface PageMediaPayload {
  video: { url: string; muxed: boolean } | null
  voiceover: { url: string } | null
}

/** Look up the page's latest recording run and expose its media as public
 *  URLs. If a video + voice-over are both present we mux them on the fly
 *  (cached via `run.summary_json.muxedVideoPath`) so a single URL carries
 *  the full narrated recording. Graceful fallback to raw tracks whenever
 *  the video-service isn't configured or the mux call throws. */
async function resolvePageMedia(pageId: string): Promise<PageMediaPayload | null> {
  const { findLatestRunByPageId, updateRunSummary } = await import('../run/run.repository.js')
  const { getPublicUrl } = await import('../../shared/db/storage.repository.js')
  const { isVideoServiceConfigured, muxVideoWithAudio } = await import('../../shared/video/video.client.js')

  const run = await findLatestRunByPageId(pageId).catch(() => null)
  if (!run) return null

  // `summary.voiceover = { audioPath, audioUrl, segments }` is how the
  // voice-over route stores its output — there's no flat `voiceoverPath`.
  // Reading the wrong key previously meant we never muxed and always fell
  // back to the raw (silent) video URL.
  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const videoPath = typeof summary.videoPath === 'string' ? summary.videoPath : null
  const voiceoverBlock = summary.voiceover && typeof summary.voiceover === 'object'
    ? summary.voiceover as Record<string, unknown>
    : null
  const voiceoverPath = voiceoverBlock && typeof voiceoverBlock.audioPath === 'string'
    ? voiceoverBlock.audioPath
    : null
  const cachedMuxedPath = typeof summary.muxedVideoPath === 'string' ? summary.muxedVideoPath : null

  if (!videoPath && !voiceoverPath) return null

  let muxedUrl: string | null = null
  if (cachedMuxedPath) {
    muxedUrl = getPublicUrl('artifacts', cachedMuxedPath)
  } else if (videoPath && voiceoverPath && isVideoServiceConfigured()) {
    try {
      const muxedPath = await muxVideoWithAudio(videoPath, voiceoverPath, run.id)
      muxedUrl = getPublicUrl('artifacts', muxedPath)
      // Persist the cached path so subsequent get_page calls skip the mux.
      // Fire-and-forget — a DB hiccup here just means we re-mux next time.
      void updateRunSummary(run.id, { ...summary, muxedVideoPath: muxedPath }).catch(() => {})
    } catch (err) {
      console.warn('[mcp] mux failed, returning raw tracks:', (err as Error).message)
    }
  }

  if (muxedUrl) {
    return { video: { url: muxedUrl, muxed: true }, voiceover: null }
  }

  const rawVideoUrl = videoPath ? getPublicUrl('artifacts', videoPath) : null
  const rawVoiceoverUrl = voiceoverPath ? getPublicUrl('artifacts', voiceoverPath) : null
  return {
    video: rawVideoUrl ? { url: rawVideoUrl, muxed: false } : null,
    voiceover: rawVoiceoverUrl ? { url: rawVoiceoverUrl } : null,
  }
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

/** Locate a page by projectId + slug for the tools that work on a single
 *  page (generate_doc, generate_voiceover). Centralises the "wrong slug"
 *  error message and the team-scope check so both tools stay consistent. */
async function resolvePageBySlug(
  projectId: string,
  slug: string,
  ctx: McpAuthContext,
): Promise<{ id: string; title: string; content: string | null; projectId: string }> {
  await assertProjectInTeam(projectId, ctx.teamId)
  const { findPagesByProjectId } = await import('../page/page.repository.js')
  const pages = await findPagesByProjectId(projectId)
  const page = pages.find((p) => p.slug === slug)
  if (!page) throw new AppError(`No page with slug "${slug}". Call list_pages to see available slugs.`, 'PAGE_NOT_FOUND', 404)
  return { id: page.id, title: page.title, content: page.content, projectId: page.projectId }
}

async function handleGenerateDoc(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = GenerateDocToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)

  let page
  try {
    page = await resolvePageBySlug(parsed.data.projectId, parsed.data.slug, ctx)
  } catch (err) {
    if (err instanceof AppError) return toolText(err.message)
    throw err
  }

  const { findLatestRunByPageId } = await import('../run/run.repository.js')
  const run = await findLatestRunByPageId(page.id)
  if (!run) return toolText(`No run attached to "${parsed.data.slug}". Record a screen capture or upload a video via the UI first.`)
  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const videoPath = typeof summary.videoPath === 'string' ? summary.videoPath : null
  if (!videoPath) return toolText(`Latest run for "${parsed.data.slug}" has no video attached. Upload a video before generating the doc.`)

  // Quota: doc-gen is metered (doc_run). Fails with 402 on hard-cap plans.
  await enforceQuotaOrThrow(ctx.teamId)

  try {
    const runService = await import('../run/run.service.js')
    await runService.analyzeVideo(run.id, videoPath)
    await runService.generateDoc(run.id, null)
    const { updatePage } = await import('../page/page.repository.js')
    await updatePage(page.id, { status: 'published' })
  } catch (err) {
    return toolText(`Doc generation failed: ${(err as Error).message}`)
  }

  return toolText(
    `Documentation generated for "${page.title}" (/${parsed.data.slug}).\n\n` +
    `The markdown is now on the page and has been indexed for chat / search. ` +
    `Call \`get_page\` with slug "${parsed.data.slug}" to read the result, ` +
    `or \`generate_voiceover\` to produce the narration next.`,
  )
}

async function handleGenerateVoiceover(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = GenerateVoiceoverToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)

  let page
  try {
    page = await resolvePageBySlug(parsed.data.projectId, parsed.data.slug, ctx)
  } catch (err) {
    if (err instanceof AppError) return toolText(err.message)
    throw err
  }

  const { isElevenLabsConfigured } = await import('../../shared/ai/elevenlabs.client.js')
  if (!isElevenLabsConfigured()) {
    return toolText('Voice-over requires ELEVENLABS_API_KEY on the server — ask an operator to configure it.')
  }

  const { findLatestRunByPageId, updateRunSummary } = await import('../run/run.repository.js')
  const run = await findLatestRunByPageId(page.id)
  if (!run) return toolText(`No run attached to "${parsed.data.slug}". Record a screen capture or upload a video via the UI first.`)
  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const timestamps = Array.isArray(summary.stepTimestamps) ? summary.stepTimestamps as number[] : []
  if (timestamps.length === 0) {
    return toolText(`Latest run for "${parsed.data.slug}" has no step timestamps — run a video analysis first (via \`generate_doc\` or the UI).`)
  }

  // Prefer the immutable generated doc, fall back to the editable page content.
  const { findDocByRunId } = await import('../documentation/documentation.repository.js')
  const doc = await findDocByRunId(run.id)
  const sourceMarkdown = (doc?.markdownContent ?? page.content ?? '').trim()
  if (!sourceMarkdown) {
    return toolText(`"${parsed.data.slug}" has no documentation to narrate yet. Call \`generate_doc\` first, or write content via \`update_page\`.`)
  }

  await enforceQuotaOrThrow(ctx.teamId)

  // MCP-flavoured voice-over: split the markdown into one section per
  // timestamp (H2 boundaries when present, even splits otherwise). The UI
  // route has a richer pipeline (short-section merging, Gemini-generated
  // farewells, tone presets) — MCP users who need that should generate via
  // the UI; this tool covers the "produce a decent narration from the doc"
  // case with a lot less surface area.
  const steps = splitMarkdownIntoSteps(sourceMarkdown, timestamps.length)

  try {
    const { generateVoiceover } = await import('../documentation/voiceover.service.js')
    const videoEnd = typeof summary.videoDurationSec === 'number'
      ? summary.videoDurationSec
      : (timestamps[timestamps.length - 1] ?? 0) + 5
    const result = await generateVoiceover(run.id, steps, [...timestamps, videoEnd], {
      voiceId: parsed.data.voiceId,
      language: parsed.data.language,
    })

    // Mirror the HTTP route's persistence: drop any stale mux, save the
    // voice-over, fire-and-forget usage + background mux.
    const freshSummary = (run.summaryJson ?? {}) as Record<string, unknown>
    await updateRunSummary(run.id, {
      ...freshSummary,
      voiceover: result,
      muxedVideoPath: null,
    })

    void (async () => {
      try {
        const { findTeamIdByRunId, incrementUsage } = await import('../../shared/usage/usage.repository.js')
        const teamId = await findTeamIdByRunId(run.id)
        if (teamId) await incrementUsage(teamId, 'voiceover')
      } catch { /* billing glitch never fails the op */ }
    })()

    void (async () => {
      try {
        const videoPath = typeof freshSummary.videoPath === 'string' ? freshSummary.videoPath : null
        if (!videoPath) return
        const { isVideoServiceConfigured, muxVideoWithAudio } = await import('../../shared/video/video.client.js')
        if (!isVideoServiceConfigured()) return
        const muxedPath = await muxVideoWithAudio(videoPath, result.audioPath, run.id)
        const latest = await (await import('../run/run.repository.js')).findRunById(run.id)
        const latestSummary = (latest?.summaryJson ?? {}) as Record<string, unknown>
        await updateRunSummary(run.id, { ...latestSummary, muxedVideoPath: muxedPath })
      } catch (err) {
        console.warn('[mcp generate_voiceover] post-gen mux failed:', (err as Error).message)
      }
    })()

    return toolText(
      `Voice-over generated for "${page.title}" (/${parsed.data.slug}) — ${result.segments.length} segments, ` +
      `final file: ${result.audioUrl}.\n\n` +
      `Call \`get_page\` with slug "${parsed.data.slug}" to read \`media.video.url\` — the narrated MP4 will be ` +
      `muxed in the background and available within a few seconds.`,
    )
  } catch (err) {
    return toolText(`Voice-over generation failed: ${(err as Error).message}`)
  }
}

/** Split markdown into N sections for voice-over narration. Prefers H2
 *  boundaries; falls back to an even character-count split when the markdown
 *  has fewer / more sections than timestamps. Crude on purpose — the UI has
 *  the sophisticated pipeline; this just produces usable narration from MCP. */
function splitMarkdownIntoSteps(markdown: string, targetCount: number): { stepIndex: number; text: string }[] {
  if (targetCount <= 0) return []
  const trimmed = markdown.trim()
  const h2Sections = trimmed.split(/(?=^##\s)/m).map((s) => s.trim()).filter(Boolean)

  let sections: string[]
  if (h2Sections.length >= targetCount) {
    // Merge trailing sections into the last bucket so we end up with exactly targetCount entries.
    sections = h2Sections.slice(0, targetCount - 1)
    sections.push(h2Sections.slice(targetCount - 1).join('\n\n'))
  } else if (h2Sections.length === 1) {
    // No H2 boundaries → even char split.
    const step = Math.ceil(trimmed.length / targetCount)
    sections = Array.from({ length: targetCount }, (_, i) => trimmed.slice(i * step, (i + 1) * step))
  } else {
    // Pad with empty strings — voice-over service handles zero-text slots gracefully.
    sections = [...h2Sections, ...Array<string>(targetCount - h2Sections.length).fill('')]
  }

  return sections.map((text, stepIndex) => ({ stepIndex, text: text.trim() }))
}
