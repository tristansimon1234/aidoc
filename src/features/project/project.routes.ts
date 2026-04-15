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
      console.log(`[analyze-url] Starting: ${url}`)

      // 1. Fetch full HTML
      let html = ''
      let fetchError: string | null = null
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0)', Accept: 'text/html' },
          signal: AbortSignal.timeout(10000),
          redirect: 'follow',
        })
        html = await resp.text()
        console.log(`[analyze-url] HTML: ${html.length} chars`)
      } catch (err) { fetchError = (err as Error).message }

      // 2. Extract <style> blocks + inline styles (design data)
      const styleBlocks: string[] = []
      html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, s) => { styleBlocks.push(s as string); return '' })
      const inlineStyles: string[] = []
      html.replace(/style=["']([^"']+)/gi, (_, s) => { inlineStyles.push(s as string); return '' })

      // 3. Quick fetch of main CSS file (2s timeout)
      const cssLink = html.match(/<link[^>]*href=["']([^"']+\.css[^"']*)/i)?.[1]
      let externalCss = ''
      if (cssLink) {
        try {
          const cssUrl = cssLink.startsWith('http') ? cssLink : new URL(cssLink, url).href
          const r = await fetch(cssUrl, { signal: AbortSignal.timeout(2000) })
          externalCss = (await r.text()).slice(0, 15_000)
        } catch { /* skip */ }
      }

      // 4. Build CSS digest for Gemini — all CSS vars, color declarations, font declarations
      const allCss = styleBlocks.join('\n') + '\n' + inlineStyles.join('; ') + '\n' + externalCss
      const cssLines: string[] = []

      // CSS custom properties (ALL of them — they define the design system)
      const varMatches = allCss.matchAll(/--[\w-]+\s*:\s*[^;}\n]+/gi)
      for (const m of varMatches) cssLines.push(m[0])

      // Color declarations
      const colorMatches = allCss.matchAll(/(?:color|background(?:-color)?|border-color|fill|stroke)\s*:\s*[^;}\n]+/gi)
      for (const m of colorMatches) cssLines.push(m[0])

      // Font declarations
      const fontMatches = allCss.matchAll(/font(?:-family|-weight|-size)?\s*:\s*[^;}\n]+/gi)
      for (const m of fontMatches) cssLines.push(m[0])

      const cssDigest = [...new Set(cssLines)].slice(0, 100).join('\n')

      // 5. Extract text content
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const googleFont = html.match(/fonts\.googleapis\.com\/css2?\?[^"']*family=([^"'&:]+)/i)?.[1]?.replace(/\+/g, ' ') ?? ''
      const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500)

      console.log(`[analyze-url] CSS digest: ${cssDigest.length} chars, ${cssLines.length} declarations`)

      // 6. Send to Gemini — act like a designer reading the source code
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const result = await generateText({
        userPrompt: `You are a UI designer analyzing a website's source code to extract its design system.

URL: ${url}
${fetchError ? `(Fetch failed: ${fetchError} — infer from URL)` : ''}
${themeColor ? `Meta theme-color: ${themeColor}` : ''}
${googleFont ? `Google Font loaded: ${googleFont}` : ''}

## Page content
Title: ${title}
${metaDesc || ogDesc ? `Description: ${metaDesc || ogDesc}` : ''}
Text: ${textContent.slice(0, 800)}

## CSS declarations (from <style>, inline styles, and main stylesheet)
${cssDigest}

## Task
Analyze the CSS like a designer would. Look at:
- CSS custom properties (--primary, --accent, --brand, --color-*, etc.) for the brand color
- background-color and color declarations for bg/text colors
- font-family declarations and Google Fonts imports for typography
- CTA/button styles for the accent color
- The overall color scheme (light/dark theme)

Return ONLY valid JSON:
{
  "name": "product/company name",
  "description": "what this product does (1 sentence)",
  "audience": "who uses it (role + use case)",
  "workflow": "main user journey (1 sentence)",
  "design": {
    "accentColor": "#hex (the PRIMARY brand color — used for buttons, CTAs, links. NOT gray, NOT black, NOT white)",
    "bgColor": "#hex (page background color)",
    "textColor": "#hex (main body text color)",
    "font": "primary font family name (just the name, e.g. 'Inter')"
  }
}

Return ONLY raw JSON.`,
        maxTokens: 1024,
      })

      console.log(`[analyze-url] Gemini: ${result.text.slice(0, 300)}`)

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
