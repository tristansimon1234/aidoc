import { z } from 'zod'

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  // Assistant turns that only call tools may have no text — allow empty string
  content: z.string(),
})

export const UserContextSchema = z.object({
  name: z.string().default(''),
  email: z.string().default(''),
  plan: z.string().default(''),
  extra: z.string().default(''),
  currentUrl: z.string().default(''),
}).optional()

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(ChatMessageSchema).max(50).default([]),
  userContext: UserContextSchema,
  /** When true the system prompt is enriched with Doclee platform knowledge
   *  so the assistant can answer questions about the platform itself (how to
   *  generate docs, use Try Doc, enable the widget, etc.) in addition to the
   *  project's own RAG context. Used by the in-app project assistant panel. */
  assistantMode: z.boolean().optional(),
})

export type ChatRequestInput = z.infer<typeof ChatRequestSchema>

// --- Walkthrough schemas ---

export const DomElementSchema = z.object({
  ref: z.string().max(100),
  tag: z.string().max(20),
  text: z.string().max(100),
  role: z.string().max(30),
  ariaLabel: z.string().max(100),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().min(0),
    h: z.number().min(0),
  }),
  selector: z.string().max(200),
  placeholder: z.string().max(100),
})

export const DomSnapshotSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500),
  viewport: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  elements: z.array(DomElementSchema).max(80),
})

export const CompletedStepSchema = z.object({
  instruction: z.string().max(500),
  action: z.string().max(50),
  pageUrl: z.string().max(2000),
})

export const WalkthroughRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(ChatMessageSchema).max(50).default([]),
  domSnapshot: DomSnapshotSchema,
  completedSteps: z.array(CompletedStepSchema).max(30).default([]),
  userContext: UserContextSchema,
})

export type WalkthroughRequestInput = z.infer<typeof WalkthroughRequestSchema>

export const WalkthroughStepSchema = z.object({
  instruction: z.string().max(500),
  action: z.enum(['click', 'type', 'select', 'scroll', 'observe', 'navigate']),
  elementRef: z.string().max(100).nullable(),
  fallbackSelector: z.string().max(200).nullable(),
  typeValue: z.string().max(1000).nullable(),
})

export const WalkthroughResponseSchema = z.object({
  done: z.boolean(),
  step: WalkthroughStepSchema.nullable(),
  stepNumber: z.number().int().min(0),
  hint: z.string().max(200).nullable(),
})
