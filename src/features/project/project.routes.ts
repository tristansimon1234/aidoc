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

      // Quick fetch of main CSS (2s timeout — fast fail)
      const cssLink = html.match(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/i)?.[1]
        ?? html.match(/<link[^>]*href=["']([^"']+\.css[^"']*)/i)?.[1]
      let externalCss = ''
      if (cssLink) {
        try {
          const cssUrl = cssLink.startsWith('http') ? cssLink : new URL(cssLink, url).href
          const cssResp = await fetch(cssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0)' },
            signal: AbortSignal.timeout(2000),
          })
          externalCss = (await cssResp.text()).slice(0, 20_000)
        } catch { /* skip */ }
      }

      const extractAll = (pattern: RegExp, src: string): string[] => {
        const matches: string[] = []
        let m: RegExpExecArray | null
        while ((m = pattern.exec(src)) !== null) { matches.push(m[1] ?? m[0]); if (matches.length > 30) break }
        return matches
      }

      // Meta tags
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''
      const headings = extractAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, html).map(h => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean)
      const links = extractAll(/<a[^>]*>([\s\S]*?)<\/a>/gi, html).map(a => a.replace(/<[^>]+>/g, '').trim()).filter(h => h.length > 2 && h.length < 60)

      // --- Design: extract server-side with heuristics (not Gemini) ---
      const styleBlocks = extractAll(/<style[^>]*>([\s\S]*?)<\/style>/gi, html).join('\n')
      const inlineStyles = extractAll(/style=["']([^"']+)/gi, html).join('; ')
      const allCss = styleBlocks + '\n' + inlineStyles + '\n' + externalCss

      // Helper: find first hex color matching a pattern
      const findColor = (...patterns: RegExp[]): string | null => {
        for (const p of patterns) {
          const m = allCss.match(p) ?? html.match(p)
          if (m?.[1]) {
            // Could be a hex, rgb, or another var — extract hex if present
            const hex = m[1].match(/#[0-9a-fA-F]{3,8}/)?.[0]
            if (hex) return hex
          }
        }
        return null
      }

      // Accent color: priority order
      const accentColor = themeColor
        || findColor(
          /--(?:[\w-]*)?(?:primary|accent|brand)(?:[\w-]*)?\s*:\s*([^;}\n]+)/i,
          /--(?:[\w-]*)?main(?:[\w-]*)?\s*:\s*([^;}\n]+)/i,
        )
        || (() => {
          // Fallback: most common non-gray hex color in CSS
          const allHex = [...new Set(extractAll(/#[0-9a-fA-F]{6}(?=[\s;,)"']|$)/g, allCss))]
            .filter(c => {
              const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16)
              const isGray = Math.abs(r - g) < 20 && Math.abs(g - b) < 20
              const isTooLight = (r + g + b) / 3 > 200
              const isTooDark = (r + g + b) / 3 < 30
              return !isGray && !isTooLight && !isTooDark
            })
          return allHex[0] ?? null
        })()
        || '#2563EB'

      // Background + text
      const bgColor = findColor(/--(?:[\w-]*)?(?:bg|background)(?:[\w-]*)?\s*:\s*([^;}\n]+)/i) || '#FFFFFF'
      const textColor = findColor(/--(?:[\w-]*)?(?:text|fg|foreground|body)(?:[\w-]*)?\s*:\s*([^;}\n]+)/i) || '#1A1A1A'

      // Font
      const googleFont = html.match(/fonts\.googleapis\.com\/css2?\?[^"']*family=([^"'&:]+)/i)?.[1]?.replace(/\+/g, ' ') ?? ''
      const cssFontMatch = allCss.match(/font-family\s*:\s*["']?([^;'"}\n,]+)/i)
      const font = googleFont || cssFontMatch?.[1]?.trim().replace(/["']/g, '') || ''

      const extractedDesign = { accentColor, bgColor, textColor, font }
      console.log(`[analyze-url] Extracted design: ${JSON.stringify(extractedDesign)}`)

      // Text content for Gemini (just product info, no design)
      const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)

      const pageInfo = [
        `URL: ${url}`,
        title && `Title: ${title}`,
        ogTitle && ogTitle !== title && `OG Title: ${ogTitle}`,
        metaDesc && `Meta description: ${metaDesc}`,
        ogDesc && ogDesc !== metaDesc && `OG description: ${ogDesc}`,
        headings.length > 0 && `Headings: ${headings.slice(0, 8).join(' | ')}`,
        links.length > 0 && `Nav links: ${[...new Set(links)].slice(0, 10).join(', ')}`,
        `Page text: ${textContent}`,
      ].filter(Boolean).join('\n')

      // Gemini: only product info (design extracted above)
      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const result = await generateText({
        userPrompt: `Analyze this webpage. Return ONLY valid JSON:
${fetchError ? `(Note: fetch failed — infer from URL: ${url})` : ''}

${pageInfo}

{
  "name": "product/company name",
  "description": "what this product does (1 sentence)",
  "audience": "who uses it (specific role + use case)",
  "workflow": "main user journey (1 sentence)"
}

Return ONLY the JSON object.`,
        maxTokens: 512,
      })

      console.log(`[analyze-url] Gemini response: ${result.text.slice(0, 200)}`)

      // Parse Gemini response (product info only)
      let analysis = { name: '', description: '', audience: '', workflow: '' }
      try {
        let jsonStr = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim()
        const braceStart = jsonStr.indexOf('{')
        const braceEnd = jsonStr.lastIndexOf('}')
        if (braceStart !== -1 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)
        analysis = JSON.parse(jsonStr) as typeof analysis
      } catch {
        console.warn(`[analyze-url] JSON parse failed`)
      }

      res.status(200).json({ ...analysis, design: extractedDesign })
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
