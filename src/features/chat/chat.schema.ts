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
