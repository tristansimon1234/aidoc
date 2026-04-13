import { z } from 'zod'

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
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
  elements: z.array(DomElementSchema).max(200),
})

export const WalkthroughRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(ChatMessageSchema).max(50).default([]),
  domSnapshot: DomSnapshotSchema,
  userContext: UserContextSchema,
})

export type WalkthroughRequestInput = z.infer<typeof WalkthroughRequestSchema>

export const WalkthroughStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  instruction: z.string(),
  action: z.enum(['click', 'type', 'select', 'scroll', 'observe', 'navigate']),
  elementRef: z.string().nullable(),
  fallbackSelector: z.string().nullable(),
  typeValue: z.string().nullable(),
  notFound: z.boolean(),
})

export const WalkthroughResponseSchema = z.object({
  steps: z.array(WalkthroughStepSchema).max(15),
  totalSteps: z.number().int().positive(),
  pageNote: z.string().nullable(),
})
