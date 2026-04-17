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
      const result = await generateText({
        userPrompt: `Analyze this website. Return ONLY valid JSON.

${info}

{
  "name": "company name (short)",
  "description": "1 sentence, max 20 words",
  "audience": "1 sentence, max 15 words",
  "workflow": "1 sentence, max 15 words",
  "design": {
    "accentColor": "#hex — the PRIMARY brand color (buttons, CTAs, links). If unknown, pick a color that matches the brand's industry. NEVER return null — always provide a valid hex.",
    "bgColor": "#hex — page background. Default #FFFFFF if unknown.",
    "textColor": "#hex — body text. Default #1A1A1A if unknown.",
    "font": "font name. Default 'Inter' if unknown."
  },
}

RULES:
- ALL design values must be valid hex (no null). Guess from the brand if needed.
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

      // Ensure design has no null values — fallback to defaults
      if (analysis.design) {
        analysis.design = {
          accentColor: analysis.design.accentColor || '#2563EB',
          bgColor: analysis.design.bgColor || '#FFFFFF',
          textColor: analysis.design.textColor || '#1A1A1A',
          font: analysis.design.font || '',
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

// Token usage & cost estimation per project
projectRouter.get('/:id/usage', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const params = ProjectIdParamSchema.safeParse(req.params)
      if (!params.success) throw new ValidationError(params.error.flatten())

      const { supabase } = await import('../../shared/db/supabase.client.js')

      const { data: pages } = await supabase
        .from('doc_pages')
        .select('id')
        .eq('project_id', params.data.id)

      const pageIds = (pages ?? []).map((p) => p.id as string)
      if (pageIds.length === 0) {
        res.json({ totalTokens: 0, runs: 0, estimatedCost: 0, breakdown: [] })
        return
      }

      const { data: runs } = await supabase
        .from('runs')
        .select('id, feature_name, token_usage, created_at, status')
        .in('doc_page_id', pageIds)
        .order('created_at', { ascending: false })

      const allRuns = runs ?? []
      const totalTokens = allRuns.reduce((sum, r) => sum + ((r.token_usage as number) ?? 0), 0)
      const testRuns = allRuns.filter((r) => (r.feature_name as string).startsWith('[Test]'))
      const docRuns = allRuns.filter((r) => !(r.feature_name as string).startsWith('[Test]'))

      // Cost estimation
      // Gemini 2.5 Flash: ~$0.15/1M input + $0.60/1M output ≈ $0.35/1M avg
      // Claude Sonnet (Stagehand): ~$3/1M input + $15/1M output ≈ $9/1M avg
      const geminiTokens = docRuns.reduce((sum, r) => sum + ((r.token_usage as number) ?? 0), 0)
      const stagehandTokens = testRuns.reduce((sum, r) => sum + ((r.token_usage as number) ?? 0), 0)
      const geminiCost = (geminiTokens / 1_000_000) * 0.35
      const stagehandCost = (stagehandTokens / 1_000_000) * 9
      const estimatedCost = geminiCost + stagehandCost

      res.json({
        totalTokens,
        runs: allRuns.length,
        estimatedCost: Math.round(estimatedCost * 100) / 100,
        breakdown: [
          { label: 'Documentation generation', tokens: geminiTokens, runs: docRuns.length, cost: Math.round(geminiCost * 100) / 100 },
          { label: 'Try Doc testing', tokens: stagehandTokens, runs: testRuns.length, cost: Math.round(stagehandCost * 100) / 100 },
        ],
      })
    } catch (err) {
      next(err)
    }
  })()
})
