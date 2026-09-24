import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import * as db from './db.js'
import * as billing from './billing.js'
import {
  MARKETING_CREDITS,
  MAX_VIDEO_MINUTES,
  MINUTES_PER_CREDIT,
  OFFERS,
  creditsFor,
} from './credits.js'
import { isElevenLabsEnabled } from './pipeline/elevenlabs.js'
import { isKnownVoice, listVoices, previewVoice } from './voices.js'
import { DEFAULT_TONE, LANGUAGES, TONES, type Tone } from './pipeline/prompts.js'
import { dispatchSop } from './dispatch.js'
import { withAbsoluteUrls } from './urls.js'
import { fail, failIfStale } from './pipeline/index.js'

export const api = Router()

type Handler = (req: Request, res: Response, userId: string) => Promise<void>

/** Vérifie le jeton Supabase puis appelle le handler avec l'id de l'utilisateur. */
function authed(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '')
      const userId = token ? await db.userIdFromToken(token) : null
      if (!userId) {
        res.status(401).json({ error: 'Not signed in' })
        return
      }
      await handler(req, res, userId)
    } catch (err) {
      next(err)
    }
  }
}

async function ownedSop(id: string, userId: string): Promise<db.Sop | null> {
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return null
  const sop = await db.getSop(parsed.data)
  return sop && sop.userId === userId ? failIfStale(sop) : null
}

function serverBase(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`
}

function toView(sop: db.Sop, base: string) {
  return {
    id: sop.id,
    title: sop.title,
    language: sop.language,
    voice: sop.voice,
    tone: sop.tone,
    status: sop.status,
    progress: sop.progress,
    error: sop.error,
    creditsUsed: sop.creditsUsed,
    durationSeconds: sop.durationSeconds,
    markdown: sop.markdown === null ? null : withAbsoluteUrls(sop.markdown, base),
    videoUrl: sop.videoPath ? withAbsoluteUrls(db.publicUrl(sop.videoPath), base) : null,
    kind: sop.kind,
    brief: sop.brief,
    targetSeconds: sop.targetSeconds,
    music: sop.music,
    createdAt: sop.createdAt,
  }
}

// Infos de l'utilisateur + ce que l'interface doit savoir pour s'afficher.
api.get(
  '/me',
  authed(async (_req, res, userId) => {
    const account = await db.getAccount(userId)
    res.json({
      credits: account.credits,
      hasBillingAccount: account.stripeCustomerId !== null,
      languages: Object.keys(LANGUAGES),
      tones: Object.entries(TONES).map(([id, t]) => ({ id, label: t.label })),
      musicAvailable: isElevenLabsEnabled(),
      minutesPerCredit: MINUTES_PER_CREDIT,
      marketingCredits: MARKETING_CREDITS,
      maxVideoMinutes: MAX_VIDEO_MINUTES,
      offers: await billing.listOffers(),
    })
  }),
)

// Voix disponibles pour la voix off, et extrait d'écoute de chacune.
api.get(
  '/voices',
  authed(async (_req, res) => {
    res.json(await listVoices())
  }),
)

api.get(
  '/voices/preview',
  authed(async (req, res) => {
    const { voice, language, tone } = z
      .object({
        voice: z.string().max(100),
        language: z.string().refine((l) => l in LANGUAGES),
        tone: z.enum(Object.keys(TONES) as [Tone, ...Tone[]]).default(DEFAULT_TONE),
      })
      .parse(req.query)
    if (voice === 'none' || !(await isKnownVoice(voice))) {
      res.status(404).json({ error: 'Unknown voice' })
      return
    }
    const { audio, ext } = await previewVoice(voice, language, tone)
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/wav')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(audio)
  }),
)

api.get(
  '/sops',
  authed(async (req, res, userId) => {
    const sops = await Promise.all((await db.listSops(userId)).map(failIfStale))
    res.json(sops.map((s) => ({ ...toView(s, serverBase(req)), markdown: null })))
  }),
)

api.get(
  '/sops/:id',
  authed(async (req, res, userId) => {
    const sop = await ownedSop(String(req.params.id), userId)
    if (!sop) {
      res.status(404).json({ error: 'SOP not found' })
      return
    }
    res.json(toView(sop, serverBase(req)))
  }),
)

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  language: z.string().refine((l) => l in LANGUAGES),
  voice: z.string().max(100),
  tone: z.enum(Object.keys(TONES) as [Tone, ...Tone[]]),
  kind: z.enum(['sop', 'marketing']).default('sop'),
  // Vidéo marketing uniquement
  brief: z.string().trim().max(2000).optional(),
  targetSeconds: z.union([z.literal(30), z.literal(60)]).default(60),
  music: z.boolean().default(false),
  fileName: z.string().max(300),
  durationSeconds: z
    .number()
    .positive()
    .max(MAX_VIDEO_MINUTES * 60),
})

// Étape 1 : crée la SOP et renvoie une URL d'upload direct vers le stockage.
api.post(
  '/sops',
  authed(async (req, res, userId) => {
    const input = CreateSchema.parse(req.body)
    if (!(await isKnownVoice(input.voice))) {
      res.status(400).json({ error: 'Unknown voice' })
      return
    }
    const needed = creditsFor(input.durationSeconds, input.kind)
    if ((await db.getAccount(userId)).credits < needed) {
      res.status(402).json({ error: `Not enough credits: this video needs ${needed}.` })
      return
    }
    const id = randomUUID()
    const ext =
      (input.fileName.split('.').pop() ?? 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
    const sourcePath = `${userId}/${id}/source/video.${ext}`
    await db.createSop({
      id,
      userId,
      title: input.title,
      language: input.language,
      voice: input.voice,
      tone: input.tone,
      kind: input.kind,
      brief: input.kind === 'marketing' ? input.brief || null : null,
      targetSeconds: input.targetSeconds,
      music: input.kind === 'marketing' && input.music && isElevenLabsEnabled(),
      sourcePath,
    })
    const upload = await db.createUploadUrl(sourcePath)
    res.status(201).json({ id, uploadUrl: upload.signedUrl })
  }),
)

// Étape 2 : l'upload est fini → on débite les crédits et on lance le traitement.
api.post(
  '/sops/:id/start',
  authed(async (req, res, userId) => {
    const sop = await ownedSop(String(req.params.id), userId)
    if (!sop || sop.status !== 'uploading') {
      res.status(404).json({ error: 'SOP not found' })
      return
    }
    if (!(await db.fileExists(sop.sourcePath))) {
      res.status(400).json({ error: 'The video was not received' })
      return
    }
    const { durationSeconds } = z.object({ durationSeconds: z.number().positive() }).parse(req.body)
    const cost = creditsFor(Math.min(durationSeconds, MAX_VIDEO_MINUTES * 60), sop.kind)
    if (!(await db.applyCredits(userId, -cost, 'sop', `sop:${sop.id}`))) {
      res.status(402).json({ error: `Not enough credits: this video needs ${cost}.` })
      return
    }
    await db.updateSop(sop.id, { status: 'processing', creditsUsed: cost, progress: 'Queued' })
    try {
      await dispatchSop(sop.id)
    } catch (err) {
      console.error('[dispatch]', err)
      await fail(
        { ...sop, creditsUsed: cost },
        'The video service is unavailable. Your credits were refunded, please try again.',
      )
      res
        .status(502)
        .json({ error: 'The video service is unavailable. Please try again in a moment.' })
      return
    }
    res.json({ ok: true })
  }),
)

api.delete(
  '/sops/:id',
  authed(async (req, res, userId) => {
    const sop = await ownedSop(String(req.params.id), userId)
    if (!sop) {
      res.status(404).json({ error: 'SOP not found' })
      return
    }
    if (sop.status === 'processing') {
      res.status(409).json({ error: 'Wait until processing is finished' })
      return
    }
    await db.deleteFolder(`${userId}/${sop.id}/source`).catch(() => {})
    await db.deleteFolder(`${userId}/${sop.id}`).catch(() => {})
    await db.deleteSop(sop.id)
    res.json({ ok: true })
  }),
)

api.post(
  '/checkout',
  authed(async (req, res, userId) => {
    const { offer } = z
      .object({ offer: z.enum(Object.keys(OFFERS) as ['pack', 'monthly']) })
      .parse(req.body)
    res.json({ url: await billing.createCheckout(userId, offer) })
  }),
)

api.post(
  '/billing-portal',
  authed(async (_req, res, userId) => {
    res.json({ url: await billing.createPortal(userId) })
  }),
)
