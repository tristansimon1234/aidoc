import { z } from 'zod'

const SlugSchema = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens')

export const CreateTabSchema = z.object({
  name: z.string().min(1).max(40),
  // When omitted the service derives the slug from the name. Letting the
  // caller pass an explicit slug lets MCP clients control the URL.
  slug: SlugSchema.optional(),
  sortOrder: z.number().int().optional(),
})

export const UpdateTabSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  slug: SlugSchema.optional(),
  sortOrder: z.number().int().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: 'At least one field must be provided',
})

// Bulk reorder: caller sends the desired left-to-right order of tab ids.
// We re-number sort_order = index so gaps from previous edits collapse.
export const ReorderTabsSchema = z.object({
  tabIds: z.array(z.string().uuid()).min(1),
})

// Delete with optional move target. If the tab has pages, `moveToTabId`
// is required (the API enforces it); for an empty tab the field is
// ignored. We accept either id or slug for the move target so the MCP
// can refer by slug without an extra round-trip.
export const DeleteTabBodySchema = z.object({
  moveToTabId: z.string().uuid().optional(),
  moveToTabSlug: z.string().min(1).optional(),
}).optional()
