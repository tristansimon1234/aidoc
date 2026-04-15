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
      console.log(`[analyze-url] Starting analysis: ${url}`)

      // 1. Fetch HTML for text content (product info)
      let html = ''
      let fetchError: string | null = null
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0)', Accept: 'text/html' },
          signal: AbortSignal.timeout(10000),
          redirect: 'follow',
        })
        html = await resp.text()
      } catch (err) { fetchError = (err as Error).message }

      // Extract text content for Gemini
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)

      // 2. Screenshot the page via thum.io (free, no API key)
      let screenshotBuffer: Buffer | null = null
      try {
        const screenshotUrl = `https://image.thum.io/get/width/1280/crop/800/${encodeURIComponent(url)}`
        console.log(`[analyze-url] Fetching screenshot...`)
        const ssResp = await fetch(screenshotUrl, { signal: AbortSignal.timeout(15000) })
        if (ssResp.ok) {
          screenshotBuffer = Buffer.from(await ssResp.arrayBuffer())
          console.log(`[analyze-url] Screenshot: ${(screenshotBuffer.length / 1024).toFixed(0)}KB`)
        }
      } catch (err) {
        console.warn(`[analyze-url] Screenshot failed: ${(err as Error).message}`)
      }

      // 3. Send screenshot + text to Gemini (multimodal if screenshot available)
      const { GoogleGenerativeAI } = await import('@google/generative-ai')
      const { env } = await import('../../shared/config/env.js')
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY!)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { maxOutputTokens: 1024 } })

      const prompt = `Analyze this website and return ONLY valid JSON:
${fetchError ? `(Could not fetch page — analyze from screenshot and URL: ${url})` : ''}

${title ? `Title: ${title}` : ''}
${metaDesc || ogDesc ? `Description: ${metaDesc || ogDesc}` : ''}
${textContent ? `Page text: ${textContent.slice(0, 800)}` : ''}

Return this exact JSON structure:
{
  "name": "company/product name",
  "description": "what this product does (1 sentence)",
  "audience": "who uses it (role + use case)",
  "workflow": "main user journey",
  "design": {
    "accentColor": "#hex of the primary/brand color (buttons, links, CTA — look at the screenshot)",
    "bgColor": "#hex of the page background",
    "textColor": "#hex of the main body text",
    "font": "primary font family name visible on the page"
  }
}

IMPORTANT for design: Look at the SCREENSHOT to identify the exact colors. The accent color is the main brand color used for buttons, links, and CTAs — NOT a gray or neutral color.
Return ONLY raw JSON.`

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []

      if (screenshotBuffer) {
        parts.push({ inlineData: { mimeType: 'image/png', data: screenshotBuffer.toString('base64') } })
      }
      parts.push({ text: prompt })

      const result = await model.generateContent(parts)
      const responseText = result.response.text()
      console.log(`[analyze-url] Gemini response: ${responseText.slice(0, 300)}`)

      // Parse response
      let analysis: {
        name: string; description: string; audience: string; workflow: string
        design?: { accentColor: string; bgColor: string; textColor: string; font: string }
      } = { name: '', description: '', audience: '', workflow: '' }
      try {
        let jsonStr = responseText.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
        const s = jsonStr.indexOf('{'), e = jsonStr.lastIndexOf('}')
        if (s !== -1 && e > s) jsonStr = jsonStr.slice(s, e + 1)
        analysis = JSON.parse(jsonStr) as typeof analysis
      } catch {
        console.warn('[analyze-url] JSON parse failed')
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
