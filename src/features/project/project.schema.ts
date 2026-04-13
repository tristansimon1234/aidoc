import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

const CredentialSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
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

const DesignSchema = z.object({
  accentColor: z.string(),
  bgColor: z.string(),
  textColor: z.string(),
  font: z.string(),
  widgetPosition: z.string().optional(),
  widgetGreeting: z.string().optional(),
})

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  description: z.string().optional(),
  context: ProjectContextSchema.optional(),
  credentials: z.array(CredentialSchema).optional(),
  discoveredContext: DiscoveredContextSchema.optional(),
  design: DesignSchema.optional(),
})

export const ProjectIdParamSchema = UuidParamSchema
