import { z } from 'zod'

/**
 * Re-declares the manifest shape on the Remotion side instead of importing
 * from `src/features/marketing-video/marketing-video.types.ts`. Keeping the
 * Remotion bundle independent of the backend tsconfig means we can ship the
 * video templates without bundling Express, Supabase, etc.
 *
 * Source of truth lives in marketing-video.types.ts — keep these in sync.
 */

/** A single tone label that maps to a brand-aware color in the renderer.
 *  We keep this as an enum (vs hex codes from the LLM) so the rendered
 *  mocks always respect the project's accent color and the dark/light
 *  frame contrast. */
export const MockToneSchema = z.enum(['default', 'muted', 'accent', 'success', 'warning', 'danger'])

/** Each MockElement is a small named primitive — terminal line, pill,
 *  button, etc. Recursive via `group` for layout composition. The
 *  Remotion-side DynamicMock renderer maps these one-to-one to React
 *  components with frame-driven animations.
 *
 *  Why this shape: Gemini struggles to generate working framer-motion +
 *  React code reliably AND framer-motion doesn't compose with Remotion's
 *  per-frame rendering anyway. The DSL gives the LLM editorial freedom
 *  (which elements, what text, what timings) while keeping the actual
 *  rendering deterministic. */
const BaseMockElementSchema = z.object({
  /** Seconds from the start of the scene at which this element fades in.
   *  Default 0 (visible from frame 0). Used by Gemini to stagger lines
   *  for a "typing in" feel — `0`, `0.25`, `0.5`, `0.75`. */
  delay: z.number().min(0).max(20).optional(),
})

type MockElement =
  | { type: 'header'; label: string; icon?: string; statusText?: string; statusTone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'terminalLine'; prefix?: string; text: string; tone?: z.infer<typeof MockToneSchema>; indent?: boolean; trailingHighlight?: string; delay?: number }
  | { type: 'blinkingCursor'; delay?: number }
  | { type: 'card'; title?: string; rows: { left: string; right?: string; tone?: z.infer<typeof MockToneSchema> }[]; delay?: number }
  | { type: 'pill'; text: string; tone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'pulsingDot'; tone?: z.infer<typeof MockToneSchema>; size?: number; delay?: number }
  | { type: 'button'; label: string; primary?: boolean; delay?: number }
  | { type: 'input'; placeholder?: string; value?: string; focused?: boolean; delay?: number }
  | { type: 'spacer'; height?: number }
  | { type: 'text'; text: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; tone?: z.infer<typeof MockToneSchema>; weight?: 'normal' | 'bold'; delay?: number }
  | { type: 'counter'; from: number; to: number; prefix?: string; suffix?: string; delay?: number }
  | { type: 'avatar'; initials: string; tone?: z.infer<typeof MockToneSchema>; delay?: number }
  | { type: 'codeLine'; lineNumber?: number; tokens: { text: string; tone?: z.infer<typeof MockToneSchema> }[]; delay?: number }
  | { type: 'group'; layout: 'row' | 'column'; gap?: number; align?: 'start' | 'center' | 'end' | 'between'; children: MockElement[]; delay?: number }

export const MockElementSchema: z.ZodType<MockElement> = z.lazy(() => z.discriminatedUnion('type', [
  BaseMockElementSchema.extend({
    type: z.literal('header'),
    label: z.string(),
    icon: z.string().optional(),
    statusText: z.string().optional(),
    statusTone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('terminalLine'),
    prefix: z.string().optional(),
    text: z.string(),
    tone: MockToneSchema.optional(),
    indent: z.boolean().optional(),
    trailingHighlight: z.string().optional(),
  }),
  BaseMockElementSchema.extend({ type: z.literal('blinkingCursor') }),
  BaseMockElementSchema.extend({
    type: z.literal('card'),
    title: z.string().optional(),
    rows: z.array(z.object({
      left: z.string(),
      right: z.string().optional(),
      tone: MockToneSchema.optional(),
    })),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('pill'),
    text: z.string(),
    tone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('pulsingDot'),
    tone: MockToneSchema.optional(),
    size: z.number().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('button'),
    label: z.string(),
    primary: z.boolean().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('input'),
    placeholder: z.string().optional(),
    value: z.string().optional(),
    focused: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('spacer'),
    height: z.number().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('text'),
    text: z.string(),
    size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).optional(),
    tone: MockToneSchema.optional(),
    weight: z.enum(['normal', 'bold']).optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('counter'),
    from: z.number(),
    to: z.number(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('avatar'),
    initials: z.string().min(1).max(3),
    tone: MockToneSchema.optional(),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('codeLine'),
    lineNumber: z.number().optional(),
    tokens: z.array(z.object({ text: z.string(), tone: MockToneSchema.optional() })),
  }),
  BaseMockElementSchema.extend({
    type: z.literal('group'),
    layout: z.enum(['row', 'column']),
    gap: z.number().optional(),
    align: z.enum(['start', 'center', 'end', 'between']).optional(),
    children: z.array(MockElementSchema),
  }),
]))

export const MockSchema = z.object({
  /** Optional browser-chrome wrapper. Drop this for "free-floating" mocks
   *  (a chat widget overlay, a notification toast). */
  frame: z.object({
    url: z.string().max(80).optional(),
    tone: z.enum(['light', 'dark']).optional(),
  }).optional(),
  /** Top-level layout for the elements. Defaults to 'column'. */
  layout: z.enum(['row', 'column']).optional(),
  elements: z.array(MockElementSchema).max(20),
})

/* === Template-based scenes ===
 *  A scene's visual is one of three things, picked in this priority order
 *  by FeatureScene:
 *    1. `template` — structured JSON the LLM fills (preferred, fixed
 *       components, zero compile/runtime risk).
 *    2. `mockCode` — free TSX the LLM writes (legacy, runs in a
 *       sandboxed Function; can fail in many ways).
 *    3. `screenshotIndex` — a real product screenshot.
 *
 *  Templates are the new default. The mockCode escape hatch stays for
 *  the rare scene the templates can't express. */

const ListItemSchema = z.object({
  text: z.string().max(160),
  icon: z.string().max(40).optional(),
})

const FlowNodeSchema = z.object({
  icon: z.string().max(40),
  label: z.string().max(40),
  accent: z.boolean().optional(),
})

const ChartPointSchema = z.object({
  label: z.string().max(20),
  value: z.number(),
})

const MockFrameCardSchema = z.object({
  title: z.string().max(60),
  subtitle: z.string().max(120).optional(),
  pillText: z.string().max(20).optional(),
  pillTone: z.enum(['accent', 'success', 'warning', 'danger', 'muted']).optional(),
})

export const SceneTemplateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hero-text'),
    headline: z.string().max(120),
    subhead: z.string().max(160).optional(),
    layout: z.enum(['center', 'left', 'burst']).optional(),
  }),
  z.object({
    kind: z.literal('kpi-reveal'),
    metric: z.string().max(40),
    value: z.string().max(20),
    sub: z.string().max(80).optional(),
    trend: z.enum(['up', 'down', 'flat']).optional(),
  }),
  z.object({
    kind: z.literal('list-reveal'),
    title: z.string().max(80),
    items: z.array(ListItemSchema).min(1).max(8),
  }),
  z.object({
    kind: z.literal('mock-frame'),
    url: z.string().max(80).optional(),
    appName: z.string().max(40).optional(),
    cards: z.array(MockFrameCardSchema).min(1).max(6),
  }),
  z.object({
    kind: z.literal('chat-bubble'),
    appName: z.string().max(40).optional(),
    question: z.string().max(200),
    answer: z.string().max(400),
  }),
  z.object({
    kind: z.literal('flow-diagram'),
    nodes: z.array(FlowNodeSchema).min(2).max(3),
  }),
  z.object({
    kind: z.literal('chart'),
    type: z.enum(['bar', 'line']),
    title: z.string().max(80).optional(),
    points: z.array(ChartPointSchema).min(2).max(12),
  }),
  // === Phase 3 templates ===
  z.object({
    kind: z.literal('before-after'),
    beforeLabel: z.string().max(40),
    afterLabel: z.string().max(40),
    beforeText: z.string().max(120).optional(),
    afterText: z.string().max(120).optional(),
    beforeIcon: z.string().max(40).optional(),
    afterIcon: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('comparison-bars'),
    leftLabel: z.string().max(40),
    rightLabel: z.string().max(40),
    rows: z.array(z.object({
      feature: z.string().max(60),
      left: z.boolean(),
      right: z.boolean(),
    })).min(2).max(6),
  }),
  z.object({
    kind: z.literal('quote'),
    text: z.string().max(300),
    author: z.string().max(40),
    role: z.string().max(60).optional(),
    company: z.string().max(40).optional(),
    avatarUrl: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal('step-progression'),
    steps: z.array(z.object({
      title: z.string().max(60),
      description: z.string().max(120).optional(),
    })).min(2).max(5),
  }),
  z.object({
    kind: z.literal('big-stat'),
    value: z.string().max(12),
    label: z.string().max(60).optional(),
    sub: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('live-typing'),
    language: z.enum(['shell', 'js', 'json', 'http']).optional(),
    lines: z.array(z.string().max(120)).min(1).max(8),
  }),
  z.object({
    kind: z.literal('dual-screen'),
    leftUrl: z.string().max(80).optional(),
    rightUrl: z.string().max(80).optional(),
    leftCards: z.array(MockFrameCardSchema).min(1).max(3),
    rightCards: z.array(MockFrameCardSchema).min(1).max(3),
  }),
  // === Phase 4: rich UI templates — lean passe-partout modern SaaS ===
  z.object({
    kind: z.literal('chat-thread'),
    appName: z.string().max(40).optional(),
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(280),
    })).min(2).max(6),
  }),
  z.object({
    kind: z.literal('dashboard-mock'),
    appName: z.string().max(40).optional(),
    sidebarItems: z.array(z.string().max(30)).min(2).max(6),
    metrics: z.array(z.object({
      label: z.string().max(40),
      value: z.string().max(20),
      trend: z.enum(['up', 'down', 'flat']).optional(),
    })).min(1).max(4),
  }),
  z.object({
    kind: z.literal('analytics-card'),
    metric: z.string().max(40),
    value: z.string().max(20),
    delta: z.string().max(20).optional(),
    trend: z.enum(['up', 'down', 'flat']).optional(),
    sparkline: z.array(z.number()).min(3).max(20).optional(),
  }),
  z.object({
    kind: z.literal('command-palette'),
    placeholder: z.string().max(60).optional(),
    query: z.string().max(60).optional(),
    results: z.array(z.object({
      label: z.string().max(60),
      hint: z.string().max(40).optional(),
      icon: z.string().max(40).optional(),
    })).min(2).max(5),
    selectedIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('notification-toast'),
    title: z.string().max(60),
    body: z.string().max(160).optional(),
    icon: z.string().max(40).optional(),
    tone: z.enum(['success', 'info', 'warning', 'accent']).optional(),
  }),
  z.object({
    kind: z.literal('data-table'),
    appName: z.string().max(40).optional(),
    columns: z.array(z.string().max(20)).min(2).max(4),
    rows: z.array(z.array(z.string().max(40))).min(2).max(6),
  }),
])

export type SceneTemplate = z.infer<typeof SceneTemplateSchema>

export const SceneSchema = z.object({
  voiceover: z.string(),
  headline: z.string(),
  subhead: z.string().optional(),
  screenshotIndex: z.number().nullable(),
  durationSeconds: z.number().positive(),
  /** Structured template — preferred path. Fixed React components fill
   *  the slots; zero compile/runtime risk. */
  template: SceneTemplateSchema.optional(),
  /** Legacy DSL mock kept for backwards-compat with persisted manifests. */
  mock: MockSchema.optional(),
  /** Free TSX written by the LLM (escape hatch for scenes templates
   *  can't express). Diagnostics only — bundle runs mockCompiledCode. */
  mockCode: z.string().optional(),
  /** esbuild output of mockCode. The bundle's <DynamicScene>
   *  evaluates this with React + Remotion + branding bound. */
  mockCompiledCode: z.string().optional(),
})

// (thumbnail fields are on the manifest, not the scene — see below)

export const ScriptSchema = z.object({
  hook: z.object({
    voiceover: z.string(),
    headline: z.string(),
    durationSeconds: z.number().positive(),
  }),
  scenes: z.array(SceneSchema),
  cta: z.object({
    voiceover: z.string(),
    headline: z.string(),
    buttonLabel: z.string(),
    durationSeconds: z.number().positive(),
  }),
  totalDurationSeconds: z.number().positive(),
  language: z.string(),
})

export const ScreenshotSchema = z.object({
  url: z.string(),
  caption: z.string(),
})

export const BrandingSchema = z.object({
  productName: z.string(),
  accentColor: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().nullable(),
})

export const ManifestSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  script: ScriptSchema,
  screenshots: z.array(ScreenshotSchema),
  branding: BrandingSchema,
  voiceoverUrl: z.string().nullable(),
  voiceoverPath: z.string().nullable(),
  /** Approximate duration (seconds) of the voice-over MP3 as actually
   *  synthesized — different from script.totalDurationSeconds because
   *  ElevenLabs adds real time for [short pause] tags, ellipses, and
   *  em-dashes. The composition uses max(script, voiceover) so the
   *  audio never gets cut off. */
  voiceoverDurationSeconds: z.number().positive().optional(),
  /** Optional background music track URL — mixed into the composition
   *  at low volume so it sits under the voice-over. Null = silent. */
  musicUrl: z.string().nullable().optional(),
  /** Linear volume 0–1 for the music track. Defaults to 0.15 (subtle).
   *  Bumped down further automatically inside scenes if needed. */
  musicVolume: z.number().min(0).max(1).optional(),
})

export type Manifest = z.infer<typeof ManifestSchema>
export type Scene = z.infer<typeof SceneSchema>
export type Script = z.infer<typeof ScriptSchema>
export type Screenshot = z.infer<typeof ScreenshotSchema>
export type Branding = z.infer<typeof BrandingSchema>
export type Mock = z.infer<typeof MockSchema>
export type MockTone = z.infer<typeof MockToneSchema>
