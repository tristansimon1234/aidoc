import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { ValidationError } from '../../shared/middleware/error.middleware.js'
import { CreateProjectSchema, UpdateProjectSchema, ProjectIdParamSchema, AnalyzeUrlSchema } from './project.schema.js'
import * as projectService from './project.service.js'

export const projectRouter = Router()

function getUserId(req: Request): string {
  return (req as Request & { userId: string }).userId
}

projectRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projects = await projectService.listProjects(getUserId(req))
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
      const project = await projectService.createProject(getUserId(req), parsed.data)
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

      const url = parsed.data.url
      console.log(`[analyze-url] Fetching: ${url}`)

      // Fetch HTML server-side (avoids CORS)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      let html = ''
      let fetchError: string | null = null
      try {
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0; +https://aidoc.app)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
        })
        console.log(`[analyze-url] Response: ${resp.status} ${resp.statusText}, content-type: ${resp.headers.get('content-type')}`)
        html = await resp.text()
        console.log(`[analyze-url] HTML length: ${html.length} chars`)
      } catch (err) {
        fetchError = (err as Error).message
        console.warn(`[analyze-url] Fetch failed: ${fetchError}`)
      } finally {
        clearTimeout(timeout)
      }

      // Strip scripts/styles/SVGs, keep text + structure
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .slice(0, 80_000)

      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const result = await generateText({
        userPrompt: `Analyze this webpage and extract product information + design details.

URL: ${url}
${fetchError ? `(Note: direct fetch failed with "${fetchError}" — infer what you can from the URL itself)` : ''}

${stripped ? `HTML content (scripts/styles removed):\n${stripped}` : '(No HTML content available — analyze based on URL pattern)'}

Return ONLY valid JSON with these fields:
{
  "name": "product or company name (from <title>, logo text, headings, or URL domain)",
  "description": "one-sentence description of what this product does",
  "audience": "who uses this product — role, industry, use case (be specific)",
  "workflow": "the most important user journey or primary workflow",
  "design": {
    "accentColor": "primary/accent color hex (from buttons, links, brand elements — e.g. #4F46E5)",
    "bgColor": "background color hex (usually #FFFFFF or similar)",
    "textColor": "main text color hex (usually dark — e.g. #1A1A1A)",
    "font": "primary font family name (from headings or body — e.g. Inter, Roboto, system-ui)"
  }
}

Rules:
- For design colors: look at inline styles, class names that suggest colors, brand elements, meta theme-color tags
- If you can't determine exact colors, make educated guesses based on the brand/industry
- For font: check font-family declarations, Google Fonts links, or common SaaS fonts
- If a field is truly unknowable, use empty string (except design — always provide best guesses)
- Return ONLY the JSON object, no markdown fences, no commentary`,
        maxTokens: 1024,
      })

      console.log(`[analyze-url] Gemini response (${result.text.length} chars): ${result.text.slice(0, 300)}`)

      // Parse JSON from Gemini response
      let analysis: {
        name: string
        description: string
        audience: string
        workflow: string
        design?: { accentColor: string; bgColor: string; textColor: string; font: string }
      } = { name: '', description: '', audience: '', workflow: '' }
      try {
        const cleaned = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
        analysis = JSON.parse(cleaned) as typeof analysis
      } catch (parseErr) {
        console.warn(`[analyze-url] JSON parse failed: ${(parseErr as Error).message}`)
        // Try to extract JSON from the response more aggressively
        const jsonMatch = result.text.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            analysis = JSON.parse(jsonMatch[0]) as typeof analysis
          } catch {
            // Give up — return empty defaults
          }
        }
      }

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
      const project = await projectService.getProject(params.data.id)
      res.status(200).json(project)
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
      const project = await projectService.updateProject(params.data.id, body.data)
      res.status(200).json(project)
    } catch (err) {
      next(err)
    }
  })()
})

// Generate or regenerate widget API key
projectRouter.post('/:id/widget-key', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const { randomBytes } = await import('node:crypto')
      const apiKey = `aidoc_${randomBytes(24).toString('hex')}`
      const { setWidgetApiKey } = await import('./project.repository.js')
      const project = await setWidgetApiKey(params.data.id, apiKey)
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
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())
      const { disableWidget } = await import('./project.repository.js')
      await disableWidget(params.data.id)
      res.status(200).json({ widgetEnabled: false })
    } catch (err) {
      next(err)
    }
  })()
})

// Upload project logo
projectRouter.post('/:id/logo', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      await new Promise<void>((resolve) => req.on('end', resolve))
      const body = Buffer.concat(chunks)

      if (body.length === 0) throw new ValidationError('No file uploaded')
      if (body.length > 5_000_000) throw new ValidationError('File too large (max 5MB)')

      const contentType = req.headers['content-type'] ?? 'image/png'
      const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
      const path = `projects/${params.data.id}/logo.${ext}`

      const { uploadToStorage, getPublicUrl } = await import('../../shared/db/storage.repository.js')
      await uploadToStorage('artifacts', path, body, contentType)
      const logoUrl = getPublicUrl('artifacts', path)

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
      await projectService.deleteProject(params.data.id)
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
