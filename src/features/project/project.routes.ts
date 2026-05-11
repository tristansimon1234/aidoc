import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { CreateProjectSchema, UpdateProjectSchema, ProjectIdParamSchema, AnalyzeUrlSchema } from './project.schema.js'
import * as projectService from './project.service.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { resolveActiveTeam } from '../../shared/middleware/team-context.middleware.js'

export const projectRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

projectRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const userId = getUserId(req)
      // Optional X-Team-Id scopes the list to one team; otherwise returns all
      // projects across all the user's teams (via RLS).
      const headerTeam = req.header('x-team-id')
      const teamId = headerTeam && /^[0-9a-f-]{36}$/i.test(headerTeam) ? headerTeam : undefined
      const projects = await projectService.listProjects(userId, teamId)
      res.status(200).json(projects)
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = CreateProjectSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())
      const userId = getUserId(req)
      const teamId = await resolveActiveTeam(req, userId)
      const project = await projectService.createProject(userId, teamId, parsed.data)
      res.status(201).json(project)
    } catch (err) {
      next(err)
    }
  })()
})

// Analyze a URL to auto-fill project details
projectRouter.post('/analyze-url', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const parsed = AnalyzeUrlSchema.safeParse(req.body)
      if (!parsed.success) throw new ValidationError(parsed.error.flatten())

      const userId = getUserId(req)
      const teamId = await resolveActiveTeam(req, userId)
      await enforceQuotaOrThrow(teamId)

      const url = parsed.data.url

      // Demo shortcut — returns a hardcoded, believable analysis for the
      // Doclee domain without hitting the network or Gemini. Used when
      // showing the product to design partners before the marketing site
      // is live. Safe to leave in prod: restricted to doclee.tech, takes
      // 5s (matches real analysis latency), doesn't touch quota further.
      if (/(^|\/\/|\.)doclee\.tech(\/|$|\?)/i.test(url)) {
        console.log(`[analyze-url] Demo shortcut for ${url}`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
        res.status(200).json({
          name: 'Doclee',
          description: 'Turn a 2-minute screen recording into a published product guide with AI narration and an embeddable chat widget.',
          audience: 'B2B SaaS founders and product builders shipping fast.',
          workflow: 'Record a screen walkthrough, AI generates the doc, publish and embed the chat widget.',
          design: {
            accentColor: '#635BFF',
            bgColor: '#FFFFFF',
            textColor: '#0C0C0E',
            font: 'Inter',
          },
        })
        return
      }

      console.log(`[analyze-url] request received`)

      // Fetch HTML via SSRF-safe wrapper: rejects non-http(s) schemes
      // and private / link-local hosts (AWS metadata, localhost, RFC1918),
      // caps body size and applies a hard timeout. The URL is validated
      // upstream by AnalyzeUrlSchema; safeFetch is defence-in-depth.
      let html = ''
      try {
        const { safeFetch } = await import('../../shared/http/safe-fetch.js')
        const resp = await safeFetch(url, { timeoutMs: 10_000, maxBytes: 2_000_000 })
        html = resp.text
      } catch (err) {
        console.warn(`[analyze-url] Fetch failed: ${(err as Error).message}`)
      }

      // Extract useful meta + text
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const googleFont = html.match(/fonts\.googleapis\.com\/css2?\?[^"']*family=([^"'&:]+)/i)?.[1]?.replace(/\+/g, ' ') ?? ''

      // Strip to text
      const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)

      // Build compact info
      const info = [
        `URL: ${url}`,
        title && `Title: ${title}`,
        (metaDesc || ogDesc) && `Description: ${metaDesc || ogDesc}`,
        themeColor && `Brand color (meta theme-color): ${themeColor}`,
        googleFont && `Google Font: ${googleFont}`,
        `Page text: ${textContent}`,
      ].filter(Boolean).join('\n')

      console.log(`[analyze-url] Info: ${info.length} chars`)

      // Single Gemini call — product info + design
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      // Surface the allowlist to the model so the auto-fill picks from the
      // curated catalog instead of inventing a font name. Sanitization
      // downstream still drops anything that escapes the prompt — defence
      // in depth — but a constrained prompt produces clean output the
      // user actually sees on their dashboard.
      const { GOOGLE_FONTS } = await import('../../shared/design/fonts.js')
      const fontList = GOOGLE_FONTS.map((f) => f.googleName).filter(Boolean).join(', ')

      const result = await generateText({
        userPrompt: `Analyze this website. Return ONLY valid JSON.

${info}

{
  "name": "company name (short)",
  "description": "1 sentence, max 20 words",
  "audience": "1 sentence, max 15 words",
  "workflow": "1 sentence, max 15 words",
  "design": {
    "accentColor": "#RRGGBB — the PRIMARY brand color (buttons, CTAs, links). If unknown, pick a color that matches the brand's industry. NEVER return null — always provide a valid 6-char hex starting with #.",
    "bgColor": "#RRGGBB — page background. Default #FFFFFF if unknown.",
    "textColor": "#RRGGBB — body text. Default #1A1A1A if unknown.",
    "font": "Google Font name from this exact list (case-sensitive): ${fontList}. Pick the closest match to the brand's actual font, or 'Inter' if unknown."
  }
}

RULES:
- All color values MUST be 6-char hex \`#RRGGBB\` (uppercase preferred). No rgb(), hsl(), named colors, or alpha.
- font MUST be one of the listed names, exactly. No other strings.
- Keep text values SHORT.
- Return ONLY raw JSON, no markdown fences.`,
        maxTokens: 2048,
      })

      console.log(`[analyze-url] Gemini raw:`, result.text)

      // Parse
      let analysis: {
        name: string; description: string; audience: string; workflow: string
        design?: { accentColor: string; bgColor: string; textColor: string; font: string }
      } = { name: '', description: '', audience: '', workflow: '' }
      try {
        let jsonStr = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
        const s = jsonStr.indexOf('{'), e = jsonStr.lastIndexOf('}')
        if (s !== -1 && e > s) jsonStr = jsonStr.slice(s, e + 1)
        analysis = JSON.parse(jsonStr) as typeof analysis
      } catch { console.warn('[analyze-url] JSON parse failed') }

      // Sanitize what the AI returns BEFORE handing it back to the
      // client: hex colors only (normalize 3-char / unprefixed / case
      // drift, fall back to a safe default on invalid), font name must
      // match the curated allowlist (else fall back to System). This
      // closes the obvious vector — AI hallucinates `rgba(...)`, a
      // CSS expression, or an unknown Google Font — without rejecting
      // the whole analysis. The result is also re-validated by
      // `DesignSchema` when the client POSTs it back.
      if (analysis.design) {
        const { normalizeHex } = await import('../../shared/design/colors.js')
        const { findGoogleFont, DEFAULT_FONT } = await import('../../shared/design/fonts.js')
        const namedFont = analysis.design.font?.trim()
        const matchedFont = namedFont ? findGoogleFont(namedFont) : null
        analysis.design = {
          accentColor: normalizeHex(analysis.design.accentColor) ?? '#2563EB',
          bgColor: normalizeHex(analysis.design.bgColor) ?? '#FFFFFF',
          textColor: normalizeHex(analysis.design.textColor) ?? '#1A1A1A',
          font: matchedFont?.cssValue ?? DEFAULT_FONT.cssValue,
        }
      }

      console.log(`[analyze-url] Parsed:`, JSON.stringify(analysis))
      res.status(200).json(analysis)
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const project = await projectService.getProject(params.data.id, getUserId(req))
      res.status(200).json(project)
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.get('/:id/activity', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const { getProjectActivity } = await import('./activity.service.js')
      const items = await getProjectActivity(params.data.id, getUserId(req))
      res.status(200).json({ items })
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.put('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = UpdateProjectSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())
      const project = await projectService.updateProject(params.data.id, getUserId(req), body.data)
      res.status(200).json(project)
    } catch (err) {
      next(err)
    }
  })()
})

// Helper: validate params + assert project ownership
async function verifyProjectOwnership(req: Request): Promise<string> {
  const params = ProjectIdParamSchema.safeParse(req.params)
  if (!params.success) throw new ValidationError(params.error.flatten())
  await projectService.getProject(params.data.id, getUserId(req))
  return params.data.id
}

// Generate or regenerate widget API key
projectRouter.post('/:id/widget-key', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = await verifyProjectOwnership(req)
      const { randomBytes } = await import('node:crypto')
      const apiKey = `aidoc_${randomBytes(24).toString('hex')}`
      const { setWidgetApiKey } = await import('./project.repository.js')
      const project = await setWidgetApiKey(projectId, apiKey)
      res.status(200).json({ widgetApiKey: project.widgetApiKey, widgetEnabled: project.widgetEnabled })
    } catch (err) {
      next(err)
    }
  })()
})

// Disable widget
projectRouter.delete('/:id/widget-key', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = await verifyProjectOwnership(req)
      const { disableWidget } = await import('./project.repository.js')
      await disableWidget(projectId)
      res.status(200).json({ widgetEnabled: false })
    } catch (err) {
      next(err)
    }
  })()
})

// Generate MCP API key
projectRouter.post('/:id/mcp-key', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = await verifyProjectOwnership(req)
      const { randomBytes } = await import('node:crypto')
      const key = `aidoc_mcp_${randomBytes(24).toString('hex')}`
      const { setMcpApiKey } = await import('./project.repository.js')
      const project = await setMcpApiKey(projectId, key)
      res.status(200).json({ mcpApiKey: project.mcpApiKey, mcpEnabled: true })
    } catch (err) {
      next(err)
    }
  })()
})

// Disable MCP
projectRouter.delete('/:id/mcp-key', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = await verifyProjectOwnership(req)
      const { disableMcp } = await import('./project.repository.js')
      await disableMcp(projectId)
      res.status(200).json({ mcpEnabled: false })
    } catch (err) {
      next(err)
    }
  })()
})

// Upload project logo
projectRouter.post('/:id/logo', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = await verifyProjectOwnership(req)

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      await new Promise<void>((resolve) => req.on('end', resolve))
      const body = Buffer.concat(chunks)

      if (body.length === 0) throw new ValidationError('No file uploaded')
      if (body.length > 5_000_000) throw new ValidationError('File too large (max 5MB)')

      const contentType = req.headers['content-type'] ?? 'image/png'
      const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
      const path = `projects/${projectId}/logo.${ext}`

      const { uploadToStorage, getSignedUrl } = await import('../../shared/db/storage.repository.js')
      await uploadToStorage('artifacts', path, body, contentType)
      // Signed URL (1 year). Public URLs from getPublicUrl 401 when the
      // artifacts bucket isn't actually public on the user's Supabase
      // instance — happens when the make-public migration didn't run.
      // Signed URLs work regardless of bucket visibility.
      const logoUrl = await getSignedUrl('artifacts', path)

      res.status(200).json({ logoUrl })
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      await projectService.deleteProject(params.data.id, getUserId(req))
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})

projectRouter.post('/:id/transfer', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const body = req.body as { teamId?: unknown }
      const teamId = typeof body?.teamId === 'string' ? body.teamId : ''
      if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
        throw new ValidationError('teamId must be a valid UUID')
      }
      const project = await projectService.transferProject(params.data.id, getUserId(req), teamId)
      res.status(200).json(project)
    } catch (err) {
      next(err)
    }
  })()
})

