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
      console.log(`[analyze-url] ${url}`)

      // Fetch HTML
      let html = ''
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0)', Accept: 'text/html' },
          signal: AbortSignal.timeout(10000),
          redirect: 'follow',
        })
        html = await resp.text()
      } catch (err) {
        console.warn(`[analyze-url] Fetch failed: ${(err as Error).message}`)
      }

      // Extract useful meta + text
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const favicon = html.match(/<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']+)/i)?.[1] ?? ''
      const googleFont = html.match(/fonts\.googleapis\.com\/css2?\?[^"']*family=([^"'&:]+)/i)?.[1]?.replace(/\+/g, ' ') ?? ''
      // Find logo images
      const logoImgs: string[] = []
      const imgMatches = html.matchAll(/<img[^>]*(?:class=["'][^"']*logo[^"']*["']|alt=["'][^"']*logo[^"']*["']|src=["'][^"']*logo[^"']*["'])[^>]*src=["']([^"']+)/gi)
      for (const m of imgMatches) { if (m[1]) logoImgs.push(m[1]) }
      // Also try src before class/alt
      const imgMatches2 = html.matchAll(/<img[^>]*src=["']([^"']*logo[^"']*)/gi)
      for (const m of imgMatches2) { if (m[1]) logoImgs.push(m[1]) }

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
        ogImage && `OG image: ${ogImage}`,
        favicon && `Favicon: ${favicon.startsWith('http') ? favicon : new URL(favicon, url).href}`,
        logoImgs.length > 0 && `Logo images found: ${[...new Set(logoImgs)].slice(0, 3).map(l => l.startsWith('http') ? l : new URL(l, url).href).join(', ')}`,
        `Page text: ${textContent}`,
      ].filter(Boolean).join('\n')

      console.log(`[analyze-url] Info: ${info.length} chars`)

      // Single Gemini call — product info + design
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const result = await generateText({
        userPrompt: `Analyze this website. Return ONLY valid JSON.

${info}

{
  "name": "company/product name",
  "description": "what this product does",
  "audience": "who uses it and why",
  "workflow": "the main user journey",
  "design": {
    "accentColor": "#hex brand color used for buttons/CTAs (NOT gray/black/white)",
    "bgColor": "#hex page background",
    "textColor": "#hex body text color",
    "font": "primary font family name"
  },
  "logoUrl": "absolute URL to the company logo (from og:image, favicon, or <img> with 'logo' in src/alt/class). null if not found."
}

Return ONLY raw JSON, no markdown fences.`,
        maxTokens: 2048,
      })

      console.log(`[analyze-url] Gemini: ${result.text.slice(0, 300)}`)

      // Parse
      let analysis: {
        name: string; description: string; audience: string; workflow: string
        design?: { accentColor: string; bgColor: string; textColor: string; font: string }
        logoUrl?: string | null
      } = { name: '', description: '', audience: '', workflow: '' }
      try {
        let jsonStr = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
        const s = jsonStr.indexOf('{'), e = jsonStr.lastIndexOf('}')
        if (s !== -1 && e > s) jsonStr = jsonStr.slice(s, e + 1)
        analysis = JSON.parse(jsonStr) as typeof analysis
      } catch { console.warn('[analyze-url] JSON parse failed') }

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
