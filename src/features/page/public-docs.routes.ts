import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError, ValidationError, AppError } from '../../shared/middleware/error.middleware.js'
import { findProjectById } from '../project/project.repository.js'
import { findPublicPagesByProjectId } from './page.repository.js'
import { findLatestRunByPageId } from '../run/run.repository.js'
import { getPublicUrl } from '../../shared/db/storage.repository.js'
import * as chatService from '../chat/chat.service.js'
import { ChatRequestSchema } from '../chat/chat.schema.js'
import { hasEmbeddings } from '../chat/chat.repository.js'
import { registerChatSession, incrementUsage } from '../../shared/usage/usage.repository.js'
import { logChatMessages, logPageView } from '../analytics/analytics.repository.js'
import { classifyMessageContent, applyClassificationToMessage } from '../analytics/analytics.service.js'
import { PageViewPingSchema } from '../analytics/analytics.schema.js'
import { enforceQuotaOrThrow } from '../../shared/middleware/quota.middleware.js'
import { findPagesByProjectId } from './page.repository.js'
import type { Project } from '../project/project.types.js'

export const publicDocsRouter = Router()

// --- Anonymous chat: in-memory rate limit per (projectId + best-effort IP) ---
const PUBLIC_CHAT_LIMIT = 30
const PUBLIC_CHAT_WINDOW_MS = 60_000
const publicRateMap = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim()
  return req.ip ?? 'anon'
}

function checkPublicChatLimit(projectId: string, ip: string): void {
  const key = `${projectId}:${ip}`
  const now = Date.now()
  let entry = publicRateMap.get(key)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + PUBLIC_CHAT_WINDOW_MS }
    publicRateMap.set(key, entry)
  }
  entry.count++
  if (entry.count > PUBLIC_CHAT_LIMIT) {
    throw new AppError('Rate limit exceeded. Try again in a minute.', 'RATE_LIMITED', 429)
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of publicRateMap) if (now > v.resetAt) publicRateMap.delete(k)
}, 300_000).unref?.()

// Public-docs session tracking — awaited so `incrementUsage` actually fires
// on Vercel (fire-and-forget gets killed when the function tears down).
async function trackPublicSession(project: Project, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken || sessionToken.length < 8 || sessionToken.length > 128) return
  try {
    const isNew = await registerChatSession(project.id, project.userId, sessionToken, 'widget')
    if (isNew) await incrementUsage(project.userId, 'chat_sessions')
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

// GET /docs/:projectId — public, no auth
publicDocsRouter.get('/:projectId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const project = await findProjectById(req.params.projectId as string)
      if (!project) throw new NotFoundError('Project not found')

      const pages = await findPublicPagesByProjectId(project.id)

      // For pages with showVideoOnPublic, include video/voiceover data
      const pagesWithVideo = await Promise.all(pages.map(async (p) => {
        const briefing = p.briefing as Record<string, unknown> | null
        const showVideo = briefing?.showVideoOnPublic === true

        let videoUrl: string | null = null
        let audioUrl: string | null = null

        if (showVideo) {
          const run = await findLatestRunByPageId(p.id)
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
          id: p.id,
          title: p.title,
          slug: p.slug,
          content: p.content,
          parentId: p.parentId,
          sortOrder: p.sortOrder,
          videoUrl,
          audioUrl,
        }
      }))

      res.status(200).json({
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          design: project.design,
        },
        chatEnabled: Boolean(project.publicDocsChatEnabled),
        pages: pagesWithVideo,
      })
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
      checkPublicChatLimit(projectId, clientIp(req))

      const project = await loadChatEnabledProject(projectId)

      // Block public-docs chat when the owner has exhausted their quota.
      await enforceQuotaOrThrow(project.userId)

      const body = ChatRequestSchema.safeParse(req.body)
      if (!body.success) throw new ValidationError(body.error.flatten())

      const sessionToken = (req.body as { sessionToken?: string }).sessionToken
      // Run session counter + classifier in parallel with the chat Gemini call.
      const sessionTrackPromise = trackPublicSession(project, sessionToken)
      const classifyPromise = sessionToken
        ? classifyMessageContent(body.data.message)
        : Promise.resolve(null)

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
          const { userMessageId } = await logChatMessages({
            projectId: project.id,
            userId: project.userId,
            sessionToken,
            source: 'public',
            userMessage: body.data.message,
            assistantMessage: result.answer,
          })
          const classified = await classifyPromise
          if (userMessageId && classified) {
            await applyClassificationToMessage(userMessageId, classified)
          }
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

const VIEW_LIMIT = 120 // per minute per (projectId:ip)
const viewRateMap = new Map<string, { count: number; resetAt: number }>()

function checkViewLimit(projectId: string, ip: string): boolean {
  const key = `${projectId}:${ip}`
  const now = Date.now()
  let entry = viewRateMap.get(key)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 }
    viewRateMap.set(key, entry)
  }
  entry.count++
  return entry.count <= VIEW_LIMIT
}

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of viewRateMap) if (now > v.resetAt) viewRateMap.delete(k)
}, 300_000).unref?.()

publicDocsRouter.post('/:projectId/view', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const projectId = req.params.projectId as string
      if (!checkViewLimit(projectId, clientIp(req))) {
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
