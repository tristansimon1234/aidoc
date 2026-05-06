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
  GenerateVoiceoverToolArgsSchema,
  GenerateMarketingVideoToolArgsSchema,
  GetMarketingVideoToolArgsSchema,
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
  get_marketing_video: 'read',
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
    name: 'generate_voiceover',
    description:
      `Produce a voice-over narration (ElevenLabs multilingual TTS) synchronized to the video timestamps of the page's latest run. Uses the page's current \`content\` as the source script — call \`generate_doc\` first if the page has no doc yet.

Long-running (typically 15–60 seconds). Requires \`ELEVENLABS_API_KEY\` on the server and a page that already has (a) a video with step timestamps and (b) some markdown content.

This tool runs the **same pipeline** as the Video tab in the UI — timestamp merging, Gemini narration that watches the video, tone-aware scripting, farewell top-up, per-section word budgeting, ElevenLabs synthesis, and the background video+voice-over mux. MCP callers and UI users get identical audio from the same page.

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
  {
    name: 'get_marketing_video',
    description:
      `Fetch the full manifest of the latest marketing video attached to a page — script (hook + scenes + cta), per-scene mockCode TSX, styleSeed, language, voice tone, music settings, and the rendered video / thumbnail URLs.

Use this BEFORE iterating on a marketing video so you can edit ONE scene (or just the hook voiceover, or the CTA button label) and resubmit the full script via \`generate_marketing_video\` — instead of rewriting all 45 seconds from scratch every time. The returned shape matches exactly what \`generate_marketing_video\` accepts as \`script\`.

Returns:
- \`script\`: the full MarketingScript (hook, scenes[], cta, totalDurationSeconds, language, styleSeed). Each scene includes \`mockCode\` (your TSX source). \`mockCompiledCode\` (esbuild output) is omitted by default — it's derived and recomputed on resubmit; pass \`includeCompiledCode: true\` for diagnostics.
- \`branding\`: the productName / colors / logo / fontFamily Doclee bound to the last render. Read-only here (drive it from project settings).
- \`options\`: tone, withVoiceover, musicTrackId, musicVolume, aiMusicPrompt — pass them straight back in your next \`generate_marketing_video\` call to keep the same audio direction.
- \`render\`: \`videoUrl\`, \`thumbnailUrl\`, \`renderStatus\`, \`renderError\`, \`generatedAt\` — for diagnostics and to confirm which version you're editing.

Returns a "no marketing video yet" message when the page has no manifest. In that case start fresh with \`generate_marketing_video\`.

Companion tools: \`generate_marketing_video\` (resubmit edits), \`get_page\` (read the source doc the video pitches).`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Page slug — must already have a marketing video manifest.' },
        includeCompiledCode: {
          type: 'boolean',
          description: 'Include each scene\'s esbuild-compiled code (~25 kB/scene). Default false — the source mockCode is enough for editing.',
        },
      },
      required: ['projectId', 'slug'],
    },
  },
  {
    name: 'generate_marketing_video',
    description:
      `Submit a fully-authored 45-second marketing video for the page and have Doclee compile, narrate, score, and render it. **You author the script AND the per-scene TSX animations** — Doclee runs the build pipeline (esbuild → ElevenLabs voice + music → Remotion render) but does NO LLM call of its own on this path. The video URL comes back when render finishes (~2-3 min total).

Long-running. Counts one \`marketing_video\` against the monthly token quota. Requires \`ELEVENLABS_API_KEY\` for voice-over and (when \`musicTrackId\` is 'ai*') AI music generation.

## How to author a great script

The video is **45 seconds**, three acts:
- **HOOK** (4-6s): one strong opening line that makes the viewer pause.
- **SCENES** (3-4 scenes, 7-12s each): each scene shows ONE benefit. Headline reinforces what the narrator says.
- **CTA** (4-6s): clear call-to-action with a short button label.

Total target: **\`hook.durationSeconds + sum(scenes[].durationSeconds) + cta.durationSeconds ≈ 45s\`**. \`totalDurationSeconds\` is OPTIONAL in input — Doclee derives it from the parts. If you pass an inconsistent value it's overridden (with a warning logged) rather than rejected.

Voice-over budget: **~85 words total** across all parts. Audio tags + em-dashes + ellipses each add real silence. ElevenLabs v3 reads the concatenated voiceover — embed delivery cues:
- \`[excited]\`, \`[calm]\`, \`[short pause]\`, \`[laughs]\`, \`[whispers]\`, \`[building]\`, \`[happy gasp]\`
- Em dash (—) = punchy pause. Ellipsis (...) = trailing silence (use SPARINGLY, max once).
- CAPS for one or two key words = vocal stress. NOT whole sentences.

## Required output shape

\`\`\`ts
{
  hook: { voiceover: string; headline: string; durationSeconds: number },
  scenes: Array<{
    voiceover: string;
    headline: string;          // big on-screen text; the composition layer draws this in a panel beside the mock
    subhead?: string;          // optional supporting line under headline
    screenshotIndex: number | null;  // null when you write a mock
    durationSeconds: number;
    visualMode?: string;       // 'hero-stat' | 'bento' | 'chat' | 'chart' | 'cursor-click' | 'flow-diagram' | 'logo-hero' | 'custom'
    visualBrief?: string;      // your own design brief (optional, persisted for diagnostics)
    framing?: string;          // optional cadrage override: 'browser' | 'mobile' | 'terminal' | 'fullbleed' | 'fullbleed-total' | 'split'
    mockCode?: string;         // TSX — see rules below
  }>,
  cta: { voiceover: string; headline: string; buttonLabel: string; durationSeconds: number },
  totalDurationSeconds?: number,  // OPTIONAL — derived from parts when omitted
  language: string,            // 'en' | 'fr' | …
  // Optional aesthetic seed for the whole video. Either a known catalog
  // label (editorial / brutalist / data-density / metric-driven /
  // product-tour / brand-first / conversational / high-contrast / process-flow)
  // OR a free-text architect-written brief (1-3 sentences naming the
  // typography, color treatment, motion vocabulary, texture cues for
  // this video). Free-text gives access to aesthetics outside the catalog
  // — "monochrome editorial with risograph noise + serif XL headlines",
  // "brutalist swiss grid with stutter-tick numbers", etc. Cap 600 chars.
  styleSeed?: string
}
\`\`\`

## Critical: the headline panel + the mock are TWO things

The composition layer ALWAYS draws the scene's \`headline\` in a separate panel beside your mock visual. So the mock MUST NOT render the headline text again — that produces two titles glued together. The mock illustrates the IDEA of the headline (a counter for a metric headline, a flow for a process headline, a chat UI for a Q&A headline), NOT a giant copy of the same words.

Canvas the mock renders in: **920 × 580** (the visual half of the scene; the headline sits in the OTHER half). Position relative to that, not 1920×1080.

**Exception — \`framing: 'fullbleed-total'\`**: when this is set, the composition layer DOES NOT draw a headline panel and your mock owns the full **1920 × 1080** canvas. Position relative to 1920×1080, and feel free to render large on-screen copy inside the mock itself (no clash with a separate headline panel because there isn't one). The voice-over carries the narrative on these scenes.

## mockCode TSX — sandbox rules

The TSX runs inside \`new Function(...)\` with React + Remotion + branding bound. **Creative latitude is the default.** Any palette, any glow intensity, any background (on a child div), any inline fontFamily, inline SVG when you need shapes the icons can't express — all fine. The rules below are RUNTIME / PERCEPTUAL invariants only; aesthetic choices are yours to compose.

1. **Function name MUST be \`MockScene\`.** Signature: \`function MockScene({ branding }) { ... return <Remotion.AbsoluteFill ...>...</Remotion.AbsoluteFill> }\`. Wrong name = scene doesn't render.
2. **Outer \`<Remotion.AbsoluteFill>\` MUST be transparent.** Use ONLY \`<Remotion.AbsoluteFill className='flex items-center justify-center p-10'>\`. NO \`style={{ background: ... }}\` on the outer, NO \`bg-*\` Tailwind utility on the outer, NO \`overflow-hidden\` on the outer. To paint a backdrop (dark panel, gradient, particle field — any look the scene calls for), put it on a CHILD div directly inside the outer. The outer-must-be-transparent rule is a runtime invariant about how the canvas is composed — not a constraint on the visual.
3. **No imports, no require, no fetch, no XMLHttpRequest, no eval, no new Function, no document.write, no window.open.** \`React\`, \`Remotion\`, and \`branding\` are passed as parameters; everything you need lives on those.
4. **Never use \`<Remotion.AccentGlow>\`** — deprecated, the halo bleeds onto the canvas.
5. **\`<Remotion.AnimatedCursor>\` takes \`leftPct\` + \`topPct\` numbers (0-100), NOT a path array.**
6. **Branding fields available:** \`productName\`, \`accentColor\`, \`bgColor\`, \`textColor\`, \`fontFamily\`, \`logoUrl\`, \`websiteUrl\` (string | null), \`accentSecondary\` (string | undefined), \`radius\` (number | undefined, default 14). Nothing else.
7. **Layout stability — entries NEVER displace siblings.** Reserve the full layout from frame 0; animate ONLY \`opacity\` and \`transform\`. Never animate \`width\`/\`height\`/\`padding\`/\`margin\`. Never use conditional \`{cond && <div>}\` for elements that mount mid-scene. Pre-allocate slots; cross-fade content within them. (Perceptual invariant — animated layout shifts read as render bugs.)
8. **Smooth motion floors** (perceptual): 12 frames minimum for any opacity / position interpolate (\`[0, 4]\` snaps, \`[0, 12]\` is smooth). Spring damping 14-18. Sin frequency \`f / 14-22\` for ambient pulses (\`f / 6\` reads nervous). Stagger entries 6-12 frames apart. Hard \`(f%30)<15\` step blinks: OK on a tiny cursor caret or live-indicator dot, distracting on big elements — use the smooth \`opacity: 0.6 + 0.4 * Math.sin(f/14)\` form there.
9. **Tailwind className for static styling**, inline \`style={{}}\` for animated values. Twind is installed; every Tailwind utility works at runtime. Inline \`fontFamily\` is fine when typography is part of the visual move.
10. **Inline \`<svg>\` is allowed** when you need paths / curves / organic shapes the icon set + rotated divs can't express. **Always include \`viewBox\`** — viewBox-less SVGs collapse to 0×0 and are rejected by the lint. For simple icons, prefer \`Remotion.Icons.X\` (the lucide catalog is exposed via Proxy — any name works).
11. **Code length cap: 15000 chars per scene** for the source TSX. Compile output bounded separately at 25000 chars.
12. **Lucide icons** — full catalog exposed at runtime via Proxy. Common names: Cpu, Workflow, Database, BookOpen, Rocket, Zap, TrendingUp, Activity, Layers, Boxes, Code, Globe, Lock, MessageSquare (NOT Message), Volume2 (NOT Volume), BarChart2 (NOT BarChart), Bot, FileText, Image, Camera, Video, Settings, Search, Plus, Check, ArrowRight, ArrowUp, ArrowLeft, ArrowDown. Aliases: Message → MessageSquare, Volume → Volume2, BarChart → BarChart2. Avoid \`Sparkles\` (overused cliché). Version-sensitive names (\`BarChart3\`, \`ChartColumn\`) may not be in the bundled lucide — pick a guaranteed alternative.

## When to lean restrained

The default mode above is creative-by-default — appropriate for cinematic / surreal / brutalist / dark-canvas / one-off art pieces. **For clean SaaS product-tour videos** (Linear / Vercel / Stripe / Arc aesthetic), apply the restraint guide:

- Max 2 accent-colored elements per scene; everything else zinc / white / black.
- Mock interiors match the canvas bgColor (white / zinc-50 inside MockFrame).
- Outer cards neutral (\`bg-white\` / \`bg-zinc-50\`, \`border-zinc-200/80\`); reserve accent tint for the ONE focal card.
- Glows subtle (\`boxShadow: 0 8px 32px \${accent}22\` upper bound).
- Body \`text-zinc-700\`, secondary \`text-zinc-500\`; only the focal title gets accent or zinc-900.
- Generous whitespace (\`p-8\`–\`p-12\`, \`gap-5\`–\`gap-8\`).

Signal restraint mode by setting \`styleSeed\` to one of: \`product-tour\`, \`metric-driven\`, \`process-flow\`, \`brand-first\`, \`data-density\`, \`editorial\` — or by writing it explicitly in a free-text seed (e.g. "clean SaaS product tour, Linear-style restraint").

## Remotion API surface

\`\`\`ts
Remotion.useCurrentFrame()  // current frame in THIS scene's local timeline (0 = scene start)
Remotion.useVideoConfig()   // { fps, durationInFrames, width, height }
Remotion.interpolate(input, [in1, in2, ...], [out1, out2, ...], { extrapolateLeft?: 'clamp', extrapolateRight?: 'clamp' })
Remotion.spring({ frame, fps, config: { damping, stiffness, mass } })
Remotion.AbsoluteFill   // component, fills parent
Remotion.Img            // for remote images (use sparingly)
\`\`\`

## Cadrage — OPTIONAL, pick one per scene (no longer "browser by default")

The earlier MCP contract forced \`<Remotion.MockFrame>\` as the OUTERMOST element of every mock. That converged every video onto a "look at our app in a Chrome window" look. **MockFrame is now optional.** Pick the cadrage that fits the scene:

- **\`browser\`** — \`<Remotion.MockFrame url='…' tone='light'>{children}</Remotion.MockFrame>\`. Use when the scene shows the product UI as a web app.
- **\`mobile\`** — write your own phone-shape wrapper inline: rounded corners (radius 36-44), thin Dynamic Island bar, ~9:19 aspect. Use when the product is mobile-first.
- **\`terminal\`** — write your own dark panel wrapper: \`#0B0B0F\` bg, three traffic dots, monospace text inside. Use for code / CLI / agent output.
- **\`fullbleed\`** — NO frame. Hero typography, full-canvas color blocks, magazine-cover. Use for "big claim" / "single number" beats. The composition layer STILL draws the scene \`headline\` in a panel beside the mock (the mock occupies a 920×580 area).
- **\`fullbleed-total\`** — NO frame AND NO headline panel from the composition layer. The mock owns the **full 1920×1080 canvas** and the voice-over carries the narrative on its own. Use for a single cinematic shot where any on-screen copy would compete with the mock for attention. ⚠️ When you pick this, position your mockCode for 1920×1080 (NOT 920×580) AND \`scene.headline\` is silently ignored on screen — you can still set it (it's used as accessible metadata) but it won't appear in the rendered frame.
- **\`split\`** — divide the canvas in two via flex: before/after, problem/solution. NO outer frame; each side is its own composition.

When you set \`framing\` on the scene (optional field), the cadrage is explicit. Otherwise pick based on the scene's idea — don't reach for \`browser\` by default.

Pre-built helpers (use when they fit):
- \`<Remotion.MockFrame url='app.example.com/path' tone='light'>{children}</Remotion.MockFrame>\` — designed browser-window chrome (macOS traffic lights + URL bar). Use ONLY \`tone='light'\`. Max ONE per scene; never nest. **Optional — pick a different cadrage when the scene calls for it.** **MockFrame inherits its size from its parent — never let it collapse to intrinsic content size.** Always wrap it in a parent div with an EXPLICIT width, and add an explicit height when the children need pixel-area to render into. Pick the dimensions based on the scene: the visual canvas is 920×580, so leave ~20-100px of breathing room. Width: matched to scene content density (a dense bento needs more than a single chat bubble). Height: usually content-driven; set explicit pixel height ONLY when children include \`flex-1\`, \`<Remotion.Charts.ResponsiveContainer>\`, or any element that itself needs fixed pixel area (those collapse to 0px without a sized ancestor — a common cause of "chart renders as a tiny strip"). Perspective tilts (\`transform: perspective(...) rotateY(...)\`) do NOT constrain layout size; you still need width / height on the wrapper.
- \`<Remotion.Pill tone='success' | 'warning' | 'danger' | 'accent' | 'muted' dot accentColor={branding.accentColor}>connected</Remotion.Pill>\`
- \`<Remotion.AnimatedCursor leftPct={50} topPct={55} ripple={click} rippleRadius={r} rippleOpacity={ro} accentColor={branding.accentColor} />\`
- \`<Remotion.Icons.Cpu size={14} color='currentColor' />\` — any lucide name, pre-wrapped at strokeWidth=1.5. Aliases: Message → MessageSquare, Volume → Volume2, BarChart → BarChart2.
- \`Remotion.Charts\` — recharts subset: ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip. Wrap in \`<Remotion.Charts.ResponsiveContainer width='100%' height='100%'>\` inside a fixed-size parent. Set \`isAnimationActive={false}\` and drive data via Remotion.interpolate.

## Animation primitives — pure logic, compose freely

These primitives encapsulate non-trivial timing math (typewriter character pacing, particle drift, traveling photons, orbital motion). They impose NO visual identity — colors / sizes come from your props. Use them anywhere instead of rewriting the math inline.

- \`<Remotion.TypewriterText text='hello' startFrame={10} charsPerFrame={0.6} cursor />\` — types text out one character at a time. Caller controls font / color / size via parent style.
- \`<Remotion.FadeInStagger startFrame={6} stagger={6} fadeFrames={12} slideY={8}>{children}</Remotion.FadeInStagger>\` — cascades children via opacity + translateY.
- \`<Remotion.PulseGlow color={branding.accentColor} intensity={32} period={42}>{children}</Remotion.PulseGlow>\` — wrapper with pulsing boxShadow on a sine. ONE per scene max.
- \`<Remotion.BreathingScale amplitude={0.02} period={64}>{children}</Remotion.BreathingScale>\` — subtle 2-4% scale oscillation for "alive" feel.
- \`<Remotion.OrbitingDot center={{x:50,y:50}} radius={64} period={90} phase={0} color={branding.accentColor} />\` — dot orbiting a point as % of parent. Parent must be \`position: relative\`.
- \`<Remotion.Connector from={{x:10,y:50}} to={{x:90,y:50}} color={branding.accentColor} traveling startFrame={20} />\` — animated line between two % coordinates with optional traveling photon. Use for flow connectors WITHOUT inline SVG.
- \`<Remotion.TravelingPhoton from={{x:10,y:50}} to={{x:90,y:50}} speed={60} color={branding.accentColor} glow />\` — glowing dot traversing a segment on a loop. Signal-flow visuals.
- \`<Remotion.ParticleField count={24} color={branding.accentColor} drift={0.4} opacity={0.3} />\` — drifting particles as ambient backdrop. Cap count at ~60. Parent must be \`position: relative; overflow: hidden\`.

These REPLACE inline timing math (Math.sin glow, manual character-slicing typewriters, hand-rolled traveling-dot loops). Smaller mockCode + consistent smoothness across videos.

## Visual mode dispatch (assign one per scene; NEVER repeat within a video)

- **hero-stat** (abstract, no frame): tiny eyebrow label + giant accent number/metric (text-[100px]+ font-black) + one-line subhead. Counter ticks live then keeps drifting. Use for any "look at this number" / metric beat. UNDER-USED — favor it.
- **bento** (UI, browser frame WITH perspective tilt rotateY -3deg + rotateX 2deg): mixed-size grid, ONE accent-tinted hero card, supporting cards stay neutral. Counter ticks live, latency jitters, dot pulses. Use SPARINGLY — model defaults to bento for everything, fight that.
- **chat** (UI, browser frame): user bubble (top, right, accentColor bg) + AI typing dots → AI reply, all in PRE-ALLOCATED slots so nothing reflows. Pick ONLY when product is fundamentally chat-based.
- **chart** (UI, browser frame): Recharts area/line/bar chart that draws in left-to-right via frame-driven data. \`isAnimationActive={false}\`. Use for "growth / metrics / trends".
- **cursor-click** (UI, browser frame): populated product surface (header + empty-state + CTA button), cursor flies in from top-right and clicks at ~frame 70 with ripple. NEVER an isolated button on an empty page.
- **flow-diagram** (abstract, no frame): 3 connected nodes (e.g. "Your docs" → "AI reads" → "Better answers") with animated arrows + traveling dots on each connector (fps*1.6 cycle). Middle node = accent hero with gradient + glow.
- **logo-hero** (abstract, no frame): \`branding.logoUrl\` via \`<Remotion.Img>\` at 140-180px + small uppercase product name + tagline below. NEVER fabricate a fake brand icon. If logoUrl null, fall back to clean overlapping geometric shapes.
- **custom**: when none of the above structurally fits — split-screen before/after, isometric stack, kanban, etc. Use sparingly.

**Anti-default rule:** the trio \`flow-diagram + chat + bento\` is BANNED unless the product is literally a chat-based dashboard with a 3-step pipeline. Across your scenes, AT LEAST 2 should be from: hero-stat, cursor-click, logo-hero, chart, custom.

## Sustained motion (non-negotiable)

Each scene runs 5-12 seconds — entry animations alone leave the canvas dead-static. Layer in CONTINUOUS motion that runs the WHOLE scene. Pick at LEAST one per scene:
- Counter ticks up live (hero-stat / bento)
- Traveling dot along a connector (flow-diagram): \`const t = (f % (fps * 1.6)) / (fps * 1.6)\` then \`left: \\\`\${t * 100}%\\\`\`
- AI typing dots (chat): three pulsing dots before the reply, opacity cycles 0.3 → 1 → 0.3 with 6-frame stagger
- Cursor blink (input/text): \`opacity: (f % 30) < 15 ? 1 : 0\`
- Subtle accent pulse: \`scale: 1 + 0.02 * Math.sin(f / 18)\`
- Live-indicator dot: \`opacity: 0.6 + 0.4 * Math.sin(f / 12)\`

## Smooth motion (avoid choppy / saccadée)

- **Floor of 12 frames** for any opacity/position change. \`interpolate(f, [0, 4], [0, 1])\` snaps; \`[55, 70], [0, 1]\` is smooth.
- **Spring damping 14-18** (oscillates visibly below 12).
- **Sin frequency f/14-22** for ambient pulses (~3-5s cycles); f/6 reads nervous.
- **No binary opacity flips on big elements.** \`f > 60 ? 1 : 0\` is a hard cut. Use interpolate. Hard \`(f%30)<15\` blink is OK on tiny carets / dots only.
- **Stagger entries 6-12 frames apart**, not all at frame 0.

## 2026 restraint (the difference between "designed" and "branded SaaS")

- **MAXIMUM 2 accent-colored elements per scene.** ONE focal element gets full \`branding.accentColor\` (the hero number, the CTA button, the user bubble, the middle flow node). Everything else: zinc / white / black.
- Outer cards: \`bg-white\` or \`bg-zinc-50\`, \`border-zinc-200/80\`. NOT accent-tinted card bgs.
- Borders: zinc-200/70 or zinc-100. Reserve accent borders for the ONE focal card.
- Glows subtle: \`boxShadow: 0 8px 32px \${accent}22\` upper bound (NOT \`\${accent}55\`/\`\${accent}77\`).
- Body text \`text-zinc-700\`, secondary \`text-zinc-500\`. Only the focal title gets \`text-zinc-900\` or accent.
- Generous whitespace: \`p-8\`-\`p-12\` on outer cards, \`gap-5\`-\`gap-8\` between elements.
- Modern texture cues: subtle dot-grid backdrop on a card (\`background: radial-gradient(circle, #18181b08 1px, transparent 1px); backgroundSize: 24px 24px\`), frosted/glass element with backdrop-blur, asymmetric balance (focal at 35-45%, not dead-center), mixed type weights (tiny eyebrow + huge hero number).

## Returning errors

If any scene's mockCode fails to compile, this tool returns a structured error listing each failed scene + the compile error. Fix the TSX and resubmit. Doclee does NOT rewrite your TSX — that's by design; you control the output.

## Companion tools

- \`get_page\` — read the source doc that the video pitches.
- \`generate_doc\` — create the doc first if the page is empty.

## Inputs

- \`projectId\` (required): UUID of the project.
- \`slug\` (required): page slug — must already have a doc; the source-of-truth for what the video says.
- \`script\` (required): the full script object described above.
- \`tone\` (optional): voice tone — punchy / calm / playful / serious / confident / inspirational / conversational. Defaults to 'punchy'.
- \`voiceId\` (optional): ElevenLabs voice ID override.
- \`musicTrackId\` (optional): 'none' | 'ai' | 'ai-cinematic' | 'ai-upbeat' | 'ai-lofi' | 'ai-ambient' | 'ai-synthwave' | 'ai-acoustic' | 'ai-tech' | 'ai-inspirational' | 'ai-playful' | 'ai-dark' | one of the preset IDs. Defaults to 'ai-inspirational'.
- \`musicVolume\` (optional): 0-1. Defaults to 0.15.
- \`aiMusicPrompt\` (optional): free-form steering for AI music when \`musicTrackId\` starts with 'ai'.
- \`withVoiceover\` (optional): defaults to true. Set false to render a silent video.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project UUID.' },
        slug: { type: 'string', description: 'Page slug — the source doc the video pitches.' },
        script: {
          type: 'object',
          description: 'The full marketing video script — hook + scenes (with mockCode TSX) + cta. See description for the exact shape.',
        },
        tone: {
          type: 'string',
          enum: ['punchy', 'calm', 'playful', 'serious', 'confident', 'inspirational', 'conversational'],
          description: 'Voice-over tone preset. Drives ElevenLabs settings + which audio tags fit. Default: punchy.',
        },
        voiceId: { type: 'string', description: 'Optional ElevenLabs voice ID override.' },
        musicTrackId: {
          type: 'string',
          description: "Music selection: 'none' | 'ai' | 'ai-<style>' | preset id. Default: 'ai-inspirational'.",
        },
        musicVolume: { type: 'number', description: 'Music volume 0-1. Default 0.15.' },
        aiMusicPrompt: { type: 'string', description: "Free-form steering when musicTrackId starts with 'ai'." },
        withVoiceover: { type: 'boolean', description: 'Synthesize the voice-over. Default true.' },
      },
      required: ['projectId', 'slug', 'script'],
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
    case 'generate_voiceover':
      return handleGenerateVoiceover(rawArgs, ctx)
    case 'generate_marketing_video':
      return handleGenerateMarketingVideo(rawArgs, ctx)
    case 'get_marketing_video':
      return handleGetMarketingVideo(rawArgs, ctx)
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

  const { findLatestRunByPageId } = await import('../run/run.repository.js')
  const run = await findLatestRunByPageId(page.id)
  if (!run) return toolText(`No run attached to "${parsed.data.slug}". Record a screen capture or upload a video via the UI first.`)

  await enforceQuotaOrThrow(ctx.teamId)

  // Same pipeline as the HTTP route — one shared implementation in
  // voiceover.service.ts handles ElevenLabs check, timestamp shaping, Gemini
  // narration with video, section parsing, word-budget enforcement, farewell
  // top-up, synthesis, persistence, and the background mux. Parity guaranteed.
  try {
    const { generateVoiceoverForRun } = await import('../documentation/voiceover.service.js')
    const result = await generateVoiceoverForRun(run.id, {
      voiceId: parsed.data.voiceId,
      language: parsed.data.language,
    })
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

async function handleGenerateMarketingVideo(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = GenerateMarketingVideoToolArgsSchema.safeParse(raw)
  if (!parsed.success) return toolText(`Invalid arguments: ${parsed.error.message}`)

  // Validate the script with the same Zod the in-app flow uses, so MCP
  // callers and UI users can never desync on shape. The error path for
  // a bad script is precise — Zod paths point at the offending field.
  const { MarketingScriptSchema } = await import('../marketing-video/marketing-video.schema.js')
  const scriptResult = MarketingScriptSchema.safeParse(parsed.data.script)
  if (!scriptResult.success) {
    const issues = scriptResult.error.issues
      .slice(0, 8)
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    return toolText(
      `Invalid script shape — fix and resubmit:\n${issues}${scriptResult.error.issues.length > 8 ? `\n  ... +${scriptResult.error.issues.length - 8} more issue(s)` : ''}`,
    )
  }
  const script = scriptResult.data

  // `totalDurationSeconds` is derived from the parts downstream
  // (computeTotalDuration in the service). The MCP caller no longer
  // needs to pass it — and if they do and it's wrong, we ignore it
  // rather than reject the whole submission. We DO warn loudly in the
  // logs when the caller sent an inconsistent value so the discrepancy
  // is observable for diagnostics.
  const { computeTotalDuration } = await import('../marketing-video/marketing-video.schema.js')
  const partsSum = computeTotalDuration(script)
  if (
    typeof script.totalDurationSeconds === 'number' &&
    Math.abs(partsSum - script.totalDurationSeconds) > 0.5
  ) {
    console.warn(
      `[mcp/marketing-video] totalDurationSeconds (${script.totalDurationSeconds}s) is inconsistent with parts sum (${partsSum.toFixed(2)}s) — overriding with the derived value.`,
    )
  }
  script.totalDurationSeconds = partsSum

  let page
  try {
    page = await resolvePageBySlug(parsed.data.projectId, parsed.data.slug, ctx)
  } catch (err) {
    if (err instanceof AppError) return toolText(err.message)
    throw err
  }

  await enforceQuotaOrThrow(ctx.teamId)

  // Resolve a run for the page. If the page already has a run (from a
  // recording or a prior marketing-video session), reuse it. Otherwise
  // mint a stub — the in-app panel does the same thing on first
  // generate, so MCP and UI converge on the same shape.
  const { findLatestRunByPageId, createRun } = await import('../run/run.repository.js')
  let run = await findLatestRunByPageId(page.id)
  if (!run) {
    const projectBaseUrl = (await import('../project/project.repository.js')).findProjectById
    const project = await projectBaseUrl(parsed.data.projectId)
    run = await createRun({
      featureName: `[Marketing] ${page.title}`,
      startUrl: project?.baseUrl || 'https://example.com',
      goal: `Marketing video for ${page.title}`,
      docPageId: page.id,
    })
  }

  try {
    const { submitMarketingVideoFromScript, renderMarketingVideoForRun } = await import(
      '../marketing-video/marketing-video.service.js'
    )
    // Cast: MarketingScriptSchema is permissive on the legacy `mock` DSL
    // (z.string() on the discriminator), so the Zod-inferred shape widens
    // beyond the static MarketingScript union. The runtime data conforms;
    // the cast is just type-system reconciliation.
    await submitMarketingVideoFromScript({
      runId: run.id,
      script: script as unknown as import('../marketing-video/marketing-video.types.js').MarketingScript,
      options: {
        withVoiceover: parsed.data.withVoiceover,
        voiceId: parsed.data.voiceId,
        tone: parsed.data.tone,
        musicTrackId: parsed.data.musicTrackId,
        musicVolume: parsed.data.musicVolume,
        aiMusicPrompt: parsed.data.aiMusicPrompt,
        // visualMode is implicit — caller authored mockCode TSX, so we
        // route through the mocks render path. Screenshots-mode would
        // ignore the mockCode anyway.
        visualMode: 'mocks',
      },
    })
    const rendered = await renderMarketingVideoForRun(run.id)

    const videoUrl = rendered.videoUrl
    const compiledScenes = script.scenes.filter((s) => s.mockCompiledCode).length

    // Bump the marketing_video usage counter — same accounting as the
    // in-app generate path. Wrap so a billing hiccup never fails an MCP
    // pipeline that already produced a video.
    try {
      const { incrementUsage } = await import('../../shared/usage/usage.repository.js')
      await incrementUsage(ctx.teamId, 'marketing_video')
    } catch (err) {
      console.warn(`[mcp/marketing-video] Usage increment failed: ${(err as Error).message}`)
    }

    return toolText(
      `Marketing video rendered for "${page.title}" (/${parsed.data.slug}).\n\n` +
        `- Run: ${run.id}\n` +
        `- Compiled scenes: ${compiledScenes}/${script.scenes.length}\n` +
        `- Video: ${videoUrl ?? '(render still in flight — call get_page or poll the run summary in a few seconds)'}\n` +
        `- Voice-over: ${parsed.data.withVoiceover === false ? '(skipped)' : 'synthesized'}\n` +
        `- Music: ${parsed.data.musicTrackId ?? 'ai-inspirational (default)'}\n\n` +
        `Want to iterate on a single scene? Resubmit the full script with the updated mockCode for that scene — Doclee re-renders the whole 45s video.`,
    )
  } catch (err) {
    return toolText(`Marketing video pipeline failed: ${(err as Error).message}`)
  }
}

async function handleGetMarketingVideo(
  raw: Record<string, unknown>,
  ctx: McpAuthContext,
): Promise<ReturnType<typeof toolText>> {
  const parsed = GetMarketingVideoToolArgsSchema.safeParse(raw)
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
  if (!run) {
    return toolText(
      `No run attached to "${parsed.data.slug}" yet — and so no marketing video. Author one with \`generate_marketing_video\`.`,
    )
  }

  const { findMarketingVideoByRunId } = await import('../marketing-video/marketing-video.repository.js')
  const summary = await findMarketingVideoByRunId(run.id)
  if (!summary) {
    return toolText(
      `Page "${parsed.data.slug}" has no marketing video manifest yet. Start fresh with \`generate_marketing_video\`.`,
    )
  }

  // Strip the heavy esbuild output unless explicitly asked — it's derived
  // from `mockCode` and re-computed on every resubmit, so a session
  // editing the script doesn't need it round-tripped.
  const includeCompiled = parsed.data.includeCompiledCode === true
  const manifest = summary.manifest
  const script = {
    ...manifest.script,
    scenes: manifest.script.scenes.map((s) => {
      const out: Record<string, unknown> = { ...s }
      if (!includeCompiled) delete out.mockCompiledCode
      return out
    }),
  }

  // Surface what we actually stored on the manifest. Tone and the
  // original musicTrackId aren't persisted (only the resolved music
  // URL / volume), so we can't round-trip them — caller must re-pass
  // these on the next `generate_marketing_video` call if they want to
  // keep the same audio direction. We flag this explicitly in the
  // header text so the model doesn't silently lose the choice.
  const options = {
    withVoiceover: manifest.voiceoverUrl !== null,
    musicVolume: manifest.musicVolume ?? null,
  }

  const render = {
    renderStatus: summary.renderStatus,
    renderError: summary.renderError,
    videoUrl: summary.videoUrl,
    thumbnailUrl: manifest.thumbnailUrl ?? null,
    voiceoverUrl: manifest.voiceoverUrl,
    voiceoverDurationSeconds: manifest.voiceoverDurationSeconds ?? null,
    musicUrl: manifest.musicUrl ?? null,
    musicError: manifest.musicError ?? null,
    generatedAt: manifest.generatedAt,
    runId: manifest.runId,
  }

  const payload = {
    script,
    branding: manifest.branding,
    options,
    render,
  }

  const sceneCount = script.scenes.length
  const compiledCount = manifest.script.scenes.filter((s) => s.mockCompiledCode).length
  const header =
    `Marketing video manifest for **${page.title}** (/${parsed.data.slug}).\n` +
    `- ${sceneCount} scene(s), ${compiledCount} with compiled mockCode\n` +
    `- Render: ${render.renderStatus}${render.videoUrl ? ` — ${render.videoUrl}` : ''}\n` +
    `- Generated: ${render.generatedAt}\n\n` +
    `Edit any subset of \`script\` (a single scene's \`mockCode\`, the hook \`voiceover\`, the cta \`buttonLabel\`, …) and resubmit the FULL \`script\` via \`generate_marketing_video\`. ⚠️ \`tone\` and \`musicTrackId\` are NOT persisted on the manifest — re-pass them on the next call to keep the same audio direction (defaults: tone='punchy', musicTrackId='ai-inspirational').`

  return toolText(`${header}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``)
}
