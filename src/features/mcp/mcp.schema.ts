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
  })
  .refine((d) => !(d.content !== undefined && d.contentAppend !== undefined), {
    message: 'Provide either `content` (full replace) or `contentAppend` (add to end) — not both.',
  })

export const DeletePageToolArgsSchema = z.object({
  projectId: UuidField,
  slug: z.string().min(1).max(200),
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
