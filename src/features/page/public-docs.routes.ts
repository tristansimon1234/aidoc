import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { findPublicPagesMetaByProjectId, findPublicPageBySlug, findPublicPageByTabAndSlug } from './page.repository.js'
import { listTabsByProjectId, findTabBySlug } from '../tab/tab.repository.js'
import { findLatestRunByPageId } from '../run/run.repository.js'
import { getPublicUrl } from '../../shared/db/storage.repository.js'
import * as chatService from '../chat/chat.service.js'
import { ChatRequestSchema } from '../chat/chat.schema.js'
import { hasEmbeddings } from '../chat/chat.repository.js'
import { registerChatSession, incrementUsage } from '../../shared/usage/usage.repository.js'
import { logChatMessages, logPageView } from '../analytics/analytics.repository.js'
import { PageViewPingSchema } from '../analytics/analytics.schema.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { createLimiter } from '../../shared/rate-limit/rate-limit.js'
import { findPagesByProjectId } from './page.repository.js'
import type { Project } from '../project/project.types.js'

export const publicDocsRouter = Router()

// Distributed rate limiters (Upstash / in-memory fallback).
const publicChatLimiter = createLimiter('public-docs:chat', { limit: 30, windowSec: 60 })
const viewLimiter = createLimiter('public-docs:view', { limit: 120, windowSec: 60 })

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim()
  return req.ip ?? 'anon'
}

// Public-docs session tracking — awaited so `incrementUsage` actually fires
// on Vercel (fire-and-forget gets killed when the function tears down).
async function trackPublicSession(project: Project, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken || sessionToken.length < 8 || sessionToken.length > 128) return
  try {
    const isNew = await registerChatSession(project.id, project.teamId, sessionToken, 'widget')
    if (isNew) await incrementUsage(project.teamId, 'chat_sessions')
  } catch (err) {
    console.warn('[usage] public docs chat session track failed:', (err as Error).message)
  }
}

async function loadChatEnabledProject(projectId: string): Promise<Project> {
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')
  if (!project.publicDocsChatEnabled) {
    throw new NotFoundError('Chat is not enabled for this documentation')
  }
  return project
}

// In-memory suggestions cache (1h TTL) — shared with widget pattern
const publicSuggestionsCache = new Map<string, { suggestions: string[]; expiresAt: number }>()
const PUBLIC_SUGGESTIONS_TTL_MS = 3_600_000

// GET /docs/:projectId — public, no auth.
// Returns only page metadata (title + slug + hierarchy) so projects with
// hundreds of pages ship a small payload on first paint. Content, video
// and voice-over are fetched lazily per page via /docs/:projectId/pages/:slug.
publicDocsRouter.get('/:projectId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      // getProject (vs. findProjectById) re-signs stale logo URLs so the
      // public docs header logo doesn't 401.
      const { getProject } = await import('../project/project.service.js')
      const project = await getProject(req.params.projectId as string).catch(() => null)
      if (!project) throw new NotFoundError('Project not found')

      const [pages, allTabs] = await Promise.all([
        findPublicPagesMetaByProjectId(project.id),
        listTabsByProjectId(project.id),
      ])

      // Only surface tabs that contain at least one public page —
      // private-only tabs would otherwise appear in the public nav
      // as empty groups.
      const tabIdsWithPages = new Set(pages.map((p) => p.tabId))
      const tabs = allTabs
        .filter((t) => tabIdsWithPages.has(t.id))
        .map((t) => ({ id: t.id, name: t.name, slug: t.slug, sortOrder: t.sortOrder }))

      res.status(200).json({
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          design: project.design,
        },
        chatEnabled: Boolean(project.publicDocsChatEnabled),
        tabs,
        pages,
      })
    } catch (err) {
      next(err)
    }
  })()
})

// Internal: serialize a public page with media URLs. Same shape for both
// the canonical (tab, slug) and the legacy (slug-only) endpoints.
async function serializePublicPage(page: import('./page.types.js').DocPage): Promise<unknown> {
  const briefing = page.briefing as Record<string, unknown> | null
  const showVideo = briefing?.showVideoOnPublic === true

  let videoUrl: string | null = null
  let audioUrl: string | null = null

  if (showVideo) {
    const run = await findLatestRunByPageId(page.id)
    const summary = run?.summaryJson as Record<string, unknown> | null
    if (summary?.videoPath) {
      videoUrl = getPublicUrl('artifacts', summary.videoPath as string)
    }
    const voiceover = summary?.voiceover as Record<string, unknown> | null
    if (voiceover?.audioUrl) {
      audioUrl = voiceover.audioUrl as string
    } else if (voiceover?.audioPath) {
      audioUrl = getPublicUrl('artifacts', voiceover.audioPath as string)
    }
  }

  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    content: page.content,
    parentId: page.parentId,
    sortOrder: page.sortOrder,
    tabId: page.tabId,
    videoUrl,
    audioUrl,
  }
}

// GET /docs/:projectId/tabs/:tabSlug/pages/:slug — canonical lookup.
// The public docs frontend uses this since slug uniqueness moved to
// (project, tab, slug) — two tabs can host pages with the same slug.
publicDocsRouter.get('/:projectId/tabs/:tabSlug/pages/:slug', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const tabSlug = req.params.tabSlug as string
      const slug = req.params.slug as string

      const project = await findProjectById(projectId)
      if (!project) throw new NotFoundError('Project not found')

      const tab = await findTabBySlug(projectId, tabSlug)
      if (!tab) throw new NotFoundError('Tab not found')

      const page = await findPublicPageByTabAndSlug(projectId, tab.id, slug)
      if (!page) throw new NotFoundError('Page not found')

      res.status(200).json(await serializePublicPage(page))
    } catch (err) {
      next(err)
    }
  })()
})

// GET /docs/:projectId/pages/:slug — legacy path kept for back-compat
// with old links (pre-tabs URLs and inbound external references). If
// the slug resolves uniquely we serve the page; otherwise we surface a
// 409 so the frontend can fall back to the tab-aware path.
publicDocsRouter.get('/:projectId/pages/:slug', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const slug = req.params.slug as string

      const project = await findProjectById(projectId)
      if (!project) throw new NotFoundError('Project not found')

      const page = await findPublicPageBySlug(projectId, slug)
      if (!page) throw new NotFoundError('Page not found')

      res.status(200).json(await serializePublicPage(page))
    } catch (err) {
      next(err)
    }
  })()
})

// --- Public chat: anonymous, gated by publicDocsChatEnabled, rate-limited ---

publicDocsRouter.post('/:projectId/chat', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      await publicChatLimiter.checkOrThrow(`${projectId}:${clientIp(req)}`)

      const project = await loadChatEnabledProject(projectId)

      // Block public-docs chat when the owner has exhausted their quota.
      await enforceQuotaOrThrow(project.teamId)

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      // Run session counter in parallel with the chat Gemini call. Sentiment
      // / frustration classification is deferred to the hourly cron —
      // see analytics.service.classifyPendingMessages.
      const sessionTrackPromise = trackPublicSession(project, sessionToken)

      const result = await chatService.chat(
        project.id,
        body.data.message,
        body.data.history,
        body.data.userContext,
      )

      // Anonymous visitors don't get walkthrough hints (no DOM context)
      delete result.walkthroughAvailable

      if (sessionToken) {
        try {
          await logChatMessages({
            projectId: project.id,
            userId: project.userId,
            sessionToken,
            source: 'public',
            userMessage: body.data.message,
            assistantMessage: result.answer,
          })
        } catch (err) {
          console.warn('[analytics] public chat log failed:', (err as Error).message)
        }
      }

      await sessionTrackPromise

      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  })()
})

// SSE streaming variant — same auth + quota + rate limit as POST /chat,
// just emits Gemini deltas as they arrive so the public docs surface can
// render token-by-token. The legacy POST stays for callers that want a
// single JSON response (search bots, future integrations).
publicDocsRouter.post('/:projectId/chat/stream', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      await publicChatLimiter.checkOrThrow(`${projectId}:${clientIp(req)}`)

      const project = await loadChatEnabledProject(projectId)
      await enforceQuotaOrThrow(project.teamId)

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      const sessionTrackPromise = trackPublicSession(project, sessionToken)

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()

      const stream = chatService.chatStream(
        project.id,
        body.data.message,
        body.data.history,
        body.data.userContext,
      )
      let assistantText = ''
      try {
        for await (const event of stream) {
          // Anonymous visitors don't get walkthrough hints (no DOM context)
          if (event.type === 'walkthrough') continue
          if (event.type === 'done') assistantText = event.fullText
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`)
      }

      res.write('data: [DONE]\n\n')
      res.end()

      if (sessionToken && assistantText) {
        try {
          await logChatMessages({
            projectId: project.id,
            userId: project.userId,
            sessionToken,
            source: 'public',
            userMessage: body.data.message,
            assistantMessage: assistantText,
          })
        } catch (err) {
          console.warn('[analytics] public chat stream log failed:', (err as Error).message)
        }
      }
      await sessionTrackPromise
    } catch (err) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`)
        res.end()
      } else {
        next(err)
      }
    }
  })()
})

publicDocsRouter.get('/:projectId/chat/status', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const project = await loadChatEnabledProject(req.params.projectId as string)
      const ready = await hasEmbeddings(project.id)
      res.status(200).json({ ready })
    } catch (err) {
      next(err)
    }
  })()
})

publicDocsRouter.get('/:projectId/chat/suggestions', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const project = await loadChatEnabledProject(req.params.projectId as string)
      const cached = publicSuggestionsCache.get(project.id)
      if (cached && Date.now() < cached.expiresAt) {
        res.status(200).json({ suggestions: cached.suggestions })
        return
      }

      const suggestions = await chatService.getSuggestions(project.id)
      if (suggestions.length > 0) {
        publicSuggestionsCache.set(project.id, { suggestions, expiresAt: Date.now() + PUBLIC_SUGGESTIONS_TTL_MS })
      }
      res.status(200).json({ suggestions })
    } catch (err) {
      next(err)
    }
  })()
})

// --- Public page view ping (fire-and-forget from the docs SPA) ---

publicDocsRouter.post('/:projectId/view', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      const viewCheck = await viewLimiter.check(`${projectId}:${clientIp(req)}`)
      if (!viewCheck.allowed) {
        res.status(204).end()
        return
      }

      const body = PageViewPingSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const project = await findProjectById(projectId)
      if (!project) throw new NotFoundError('Project')

      // Resolve page by slug (soft: store view even if page lookup misses)
      const pages = await findPagesByProjectId(projectId)
      const page = pages.find((p) => p.slug === body.data.pageSlug) ?? null

      void (async () => {
        try {
          await logPageView({
            projectId,
            userId: project.userId,
            pageId: page?.id ?? null,
            pageSlug: body.data.pageSlug,
            sessionToken: body.data.sessionToken,
            source: 'public',
          })
        } catch (err) {
          console.warn('[analytics] page view log failed:', (err as Error).message)
        }
      })()

      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })()
})
