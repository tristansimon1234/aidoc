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

      // Try to fetch the main CSS stylesheet for design tokens
      const cssLink = html.match(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/i)?.[1]
        ?? html.match(/<link[^>]*href=["']([^"']+\.css[^"']*)/i)?.[1]
      let externalCss = ''
      if (cssLink) {
        try {
          const cssUrl = cssLink.startsWith('http') ? cssLink : new URL(cssLink, url).href
          console.log(`[analyze-url] Fetching CSS: ${cssUrl}`)
          const cssResp = await fetch(cssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AiDoc/1.0)' },
            signal: AbortSignal.timeout(5000),
          })
          externalCss = (await cssResp.text()).slice(0, 30_000)
        } catch {
          // Non-critical
        }
      }

      // --- Extract structured data from HTML ---
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
      const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1] ?? ''

      // Headings & navigation
      const headings = extractAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, html).map(h => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean)
      const links = extractAll(/<a[^>]*>([\s\S]*?)<\/a>/gi, html).map(a => a.replace(/<[^>]+>/g, '').trim()).filter(h => h.length > 2 && h.length < 60)

      // --- Design extraction: search EVERYWHERE for colors and fonts ---

      // 1. Extract <style> blocks BEFORE stripping them
      const styleBlocks = extractAll(/<style[^>]*>([\s\S]*?)<\/style>/gi, html).join('\n')

      // 2. Extract inline style attributes
      const inlineStyles = extractAll(/style=["']([^"']+)/gi, html).join('; ')

      // 3. Combine all CSS sources (inline + <style> blocks + external stylesheet)
      const allCss = styleBlocks + '\n' + inlineStyles + '\n' + externalCss

      // 4. Extract colors from all sources (hex, rgb, hsl, CSS vars)
      const hexColors = [...new Set(extractAll(/#[0-9a-fA-F]{3,8}(?=[\s;,)"']|$)/g, allCss + ' ' + html))]
        .filter(c => c.length >= 4 && c !== '#000' && c !== '#fff' && c !== '#FFF' && c !== '#000000' && c !== '#ffffff' && c !== '#FFFFFF')
      const rgbColors = [...new Set(extractAll(/rgba?\(\s*(\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?)\s*\)/g, allCss))]
      const cssVarColors = [...new Set(extractAll(/--[\w-]*(?:color|brand|primary|accent|bg|background)[\w-]*\s*:\s*([^;}\n]+)/gi, allCss))]

      // 5. Fonts from all sources
      const fontFamilies = [...new Set(extractAll(/font-family\s*:\s*["']?([^;'"}\n]+)/gi, allCss))]
      const googleFonts = [...new Set(extractAll(/fonts\.googleapis\.com\/css2?\?[^"']*family=([^"'&]+)/gi, html))].map(f => f.replace(/\+/g, ' '))
      const fontLinks = [...new Set(extractAll(/href=["'][^"']*fonts[^"']*["']/gi, html))]

      // 6. CSS custom properties (brand-related)
      const brandVars = [...new Set(extractAll(/--([\w-]*(?:primary|accent|brand|main|theme)[\w-]*)\s*:\s*([^;}\n]+)/gi, allCss))]

      // Text content (stripped)
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
        ogImage && `OG image: ${ogImage}`,
        themeColor && `Theme color: ${themeColor}`,
        headings.length > 0 && `Headings: ${headings.slice(0, 10).join(' | ')}`,
        links.length > 0 && `Nav links: ${[...new Set(links)].slice(0, 15).join(', ')}`,
        '',
        '--- DESIGN DATA ---',
        hexColors.length > 0 && `Hex colors found in CSS: ${hexColors.slice(0, 20).join(', ')}`,
        rgbColors.length > 0 && `RGB colors: ${rgbColors.slice(0, 10).map(c => `rgb(${c})`).join(', ')}`,
        cssVarColors.length > 0 && `CSS color variables: ${cssVarColors.slice(0, 10).join(', ')}`,
        brandVars.length > 0 && `Brand CSS variables: ${brandVars.slice(0, 10).join(', ')}`,
        googleFonts.length > 0 && `Google Fonts: ${googleFonts.join(', ')}`,
        fontFamilies.length > 0 && `CSS font-family: ${fontFamilies.slice(0, 5).join(' | ')}`,
        fontLinks.length > 0 && `Font links: ${fontLinks.slice(0, 3).join(', ')}`,
        themeColor && `Meta theme-color: ${themeColor}`,
        '',
        `Page text (excerpt): ${textContent}`,
      ].filter(Boolean).join('\n')

      console.log(`[analyze-url] Extracted info (${pageInfo.length} chars), ${hexColors.length} hex colors, ${fontFamilies.length} fonts`)

      const { generateText } = await import('../../shared/ai/gemini.client.js')
      const result = await generateText({
        userPrompt: `Analyze this webpage and extract product information + design.
${fetchError ? `(Note: fetch failed: "${fetchError}" — infer from URL)` : ''}

${pageInfo}

Return ONLY valid JSON with these fields:
{
  "name": "product or company name (from <title>, logo text, headings, or URL domain)",
  "description": "SHORT one-sentence description (max 20 words)",
  "audience": "target users in 10 words max",
  "workflow": "primary user journey in 15 words max",
  "design": {
    "accentColor": "#hex (brand/accent color from buttons or links)",
    "bgColor": "#hex (page background)",
    "textColor": "#hex (body text color)",
    "font": "font family name (e.g. Inter)"
  }
}

Keep ALL values SHORT. Return ONLY raw JSON, no markdown fences, no extra text.`,
        maxTokens: 2048,
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
