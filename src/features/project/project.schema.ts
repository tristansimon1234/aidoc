import { z } from 'zod'
import { UuidParamSchema } from '../../shared/validation/schemas.js'

const CredentialSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
})

export const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  baseUrl: z.string().url('Must be a valid URL'),
  description: z.string().optional(),
  context: z.string().optional(),
  credentials: z.array(CredentialSchema).optional(),
})

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  credentials: z.array(CredentialSchema).optional(),
})

export const ProjectIdParamSchema = UuidParamSchema
