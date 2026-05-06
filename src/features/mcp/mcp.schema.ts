import { z } from 'zod'

/** Token capability scope. `read` = read-only (list/get/search), `write` =
 *  read + create/update/reorder, `admin` = everything including delete. */
export const McpScopeSchema = z.enum(['read', 'write', 'admin'])
export type McpScope = z.infer<typeof McpScopeSchema>

/** Body for POST /api/mcp-tokens — creates a new token for a workspace. */
export const CreateMcpTokenSchema = z.object({
  name: z.string().min(1, 'Name is required').max(80, 'Name too long'),
  teamId: z.string().uuid('teamId must be a valid UUID'),
  /** Permission scope. Defaults to `admin` server-side for backwards-compat
   *  with tokens created before scopes existed. */
  scope: McpScopeSchema.optional(),
  /** Optional expiry. Default = no expiry. Capped at 365 days because longer
   *  is just a bare token in disguise; users who want forever can omit it. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

/** Arg shapes for the JSON-RPC `tools/call` method. Each tool has its own
 *  schema. All projectId fields are UUIDs so a malformed argument can never
 *  reach a DB query. */
const UuidField = z.string().uuid()

export const CreateProjectToolArgsSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  description: z.string().max(2000).optional(),
})

export const ListPagesToolArgsSchema = z.object({
  projectId: UuidField,
})

export const GetPageToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
})

/** Briefing shape accepted by create_page / update_page. Keeps the loose
 *  JSONB contract on the DB side (extra keys are dropped here so we don't
 *  leak UI-only fields from the caller). */
const McpBriefingSchema = z.object({
  objective: z.string().max(4000).optional().default(''),
  knowledge: z.string().max(8000).optional().default(''),
  resources: z
    .array(
      z.object({
        type: z.enum(['url', 'credential', 'endpoint', 'file', 'note']),
        label: z.string().max(200),
        value: z.string().max(4000),
      }),
    )
    .max(50)
    .optional()
    .default([]),
})

const PageStatusSchema = z.enum(['draft', 'exploring', 'published'])

export const SearchDocumentationToolArgsSchema = z.object({
  projectId: UuidField,
  query: z.string().min(1).max(2000),
})

export const CreatePageToolArgsSchema = z.object({
  projectId: UuidField,
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens')
    .optional(),
  parentSlug: z.string().min(1).max(200).optional(),
  content: z.string().max(200_000).optional(),
  /** Lifecycle status — defaults to 'draft' server-side when omitted. */
  status: PageStatusSchema.optional(),
  /** When true, the page is visible on the public docs site. */
  isPublic: z.boolean().optional(),
  briefing: McpBriefingSchema.optional(),
  /** 0-based order among siblings. Server auto-assigns (max+1) when omitted. */
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

export const UpdatePageToolArgsSchema = z
  .object({
    projectId: UuidField,
    slug: z.string().min(1).max(200),
    title: z.string().min(1).max(200).optional(),
    newSlug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens')
      .optional(),
    /** Full markdown body — replaces the existing content entirely. */
    content: z.string().max(200_000).optional(),
    /** Markdown to append at the end of the existing content. Useful for
     *  incremental additions without a read-then-full-write round trip.
     *  Mutually exclusive with `content`. */
    contentAppend: z.string().max(200_000).optional(),
    /** Lifecycle status — useful to publish / unpublish via MCP. */
    status: PageStatusSchema.optional(),
    isPublic: z.boolean().optional(),
    briefing: McpBriefingSchema.optional(),
  })
  .refine((d) => !(d.content !== undefined && d.contentAppend !== undefined), {
    message: 'Provide either `content` (full replace) or `contentAppend` (add to end) — not both.',
  })

export const DeletePageToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
})

/** Args for generate_voiceover — runs ElevenLabs TTS over the page's
 *  generated (or hand-written) doc, synced to the video timestamps.
 *  All voice params are optional; defaults come from the project settings. */
export const GenerateVoiceoverToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
  voiceId: z.string().min(1).max(200).optional(),
  language: z.string().min(2).max(10).optional(),
})

/** Each item carries the new (parentId, sortOrder) pair to apply.
 *  parentId is null for top-level pages. */
export const ReorderPagesToolArgsSchema = z.object({
  projectId: UuidField,
  items: z
    .array(
      z.object({
        id: UuidField,
        parentId: UuidField.nullable(),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1, 'At least one item is required')
    .max(500, 'Too many items in a single reorder call'),
})

/** Args for generate_marketing_video — the caller (a Claude session
 *  with the Doclee MCP loaded) authors the full script + per-scene
 *  TSX directly and submits via this tool. Doclee compiles the TSX,
 *  synthesizes the voice-over, generates / loads music, and renders.
 *  No LLM call on the Doclee side. The `script` shape mirrors
 *  MarketingScriptSchema; we keep it loose here (z.unknown) and
 *  validate inside the handler so structural errors surface with
 *  precise paths instead of getting flattened into a single Zod issue
 *  before they reach Doclee's own schema. */
export const GenerateMarketingVideoToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
  script: z.unknown(),
  // Voice options
  withVoiceover: z.boolean().optional(),
  voiceId: z.string().min(1).max(200).optional(),
  tone: z
    .enum(['punchy', 'calm', 'playful', 'serious', 'confident', 'inspirational', 'conversational'])
    .optional(),
  // Music options — passed through to the existing music block.
  // 'none' / '<presetId>' / 'ai' / 'ai-<style>' (e.g. 'ai-cinematic').
  musicTrackId: z.string().min(1).max(40).optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  aiMusicPrompt: z.string().max(500).optional(),
})

/** Args for get_marketing_video — retrieves the full manifest (script,
 *  per-scene TSX, voice/music settings, render URLs) of the latest
 *  marketing video attached to a page. Lets a Claude session edit ONE
 *  scene's mockCode (or the hook voiceover, or the CTA) and resubmit
 *  via generate_marketing_video without rewriting the whole script
 *  from scratch. */
export const GetMarketingVideoToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
  /** When true, the (large) esbuild output for each scene is included in
   *  the response. Default false because that field is derived from
   *  mockCode and adds ~25 kB per scene without helping a human-driven
   *  edit. Set true only for diagnostics. */
  includeCompiledCode: z.boolean().optional(),
})
