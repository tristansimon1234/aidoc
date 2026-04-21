import { z } from 'zod'

/** Body for POST /api/mcp-tokens — creates a new token for a workspace. */
export const CreateMcpTokenSchema = z.object({
  name: z.string().min(1, 'Name is required').max(80, 'Name too long'),
  teamId: z.string().uuid('teamId must be a valid UUID'),
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
