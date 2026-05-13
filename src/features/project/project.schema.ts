import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'
import { LenientHexColorSchema } from '../../shared/design/colors.js'
import { isAllowedFontFamily, DEFAULT_FONT } from '../../shared/design/fonts.js'

const CredentialSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
})

const ResourceSchema = z.object({
  type: z.enum(['url', 'file', 'note']),
  label: z.string().min(1),
  value: z.string().min(1),
})

const ProjectContextSchema = z.object({
  audience: z.string(),
  workflow: z.string(),
  quirks: z.string(),
})

export const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  baseUrl: z.string().url('Must be a valid URL'),
  description: z.string().optional(),
  context: ProjectContextSchema.optional(),
  credentials: z.array(CredentialSchema).optional(),
})

export const DiscoveredContextSchema = z.object({
  lastUpdated: z.string(),
  siteStructure: z.array(z.string()).default([]),
  navigation: z.array(z.string()).default([]),
  terminology: z.record(z.string(), z.string()).default({}),
  features: z.array(z.string()).default([]),
  summary: z.string().default(''),
})

/**
 * Font family — must match one of the entries in the shared allowlist
 * (`src/shared/design/fonts.ts`). Anything else is silently coerced to
 * the default system stack so a malformed AI auto-fill or a renamed
 * Google Font never lands as an arbitrary CSS string in the renderer.
 */
const FontFamilySchema = z.preprocess(
  (v) => (typeof v === 'string' && isAllowedFontFamily(v) ? v : DEFAULT_FONT.cssValue),
  z.string(),
)

/**
 * Logo URL — only accepts an https URL pointing at our own Supabase
 * storage public artifacts bucket. Constraining the host stops a caller
 * from setting `logoUrl` to an arbitrary domain (would let them ship a
 * tracking pixel inside every public docs page, exfiltrate referrer +
 * visitor IPs on each view). The actual upload route writes to that
 * bucket, so this constraint matches what the happy path produces.
 */
const LogoUrlSchema = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const parsed = new URL(u)
        if (parsed.protocol !== 'https:') return false
        // Match either *.supabase.co/storage/... or *.supabase.in/storage/...
        // (covers prod + ephemeral preview projects). Anything else rejected.
        return /\.supabase\.(co|in)$/.test(parsed.hostname) && parsed.pathname.startsWith('/storage/')
      } catch {
        return false
      }
    },
    { message: 'Logo URL must be an https Supabase storage URL' },
  )

export const DesignSchema = z.object({
  accentColor: LenientHexColorSchema,
  bgColor: LenientHexColorSchema,
  textColor: LenientHexColorSchema,
  font: FontFamilySchema,
  logoUrl: LogoUrlSchema.optional(),
  widgetPosition: z.string().optional(),
  widgetGreeting: z.string().optional(),
  /** Optional brand-kit fields (added 2026-05). Older projects don't
   *  have these and the renderer falls back to safe defaults. */
  accentSecondary: LenientHexColorSchema.optional(),
  radius: z.number().min(0).max(64).optional(),
})

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  description: z.string().optional(),
  context: ProjectContextSchema.optional(),
  credentials: z.array(CredentialSchema).optional(),
  resources: z.array(ResourceSchema).optional(),
  discoveredContext: DiscoveredContextSchema.optional(),
  design: DesignSchema.optional(),
  walkthroughEnabled: z.boolean().optional(),
  publicDocsChatEnabled: z.boolean().optional(),
})

export const ProjectIdParamSchema = UuidParamSchema

export const AnalyzeUrlSchema = z.object({
  url: z.string().url('Must be a valid URL'),
})
