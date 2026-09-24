// Vidéo → SOP (markdown + captures) → vidéo narrée.
// Tourne sur le service vidéo (Railway), sans limite de durée ; en local, dans le même process.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../db.js'
import { creditsFor } from '../credits.js'
import { cutVideo, durationOf, extractFrame, normalizeVideo, renderNarrated } from './ffmpeg.js'
import { askJson, askJsonWithImages, speakWithGemini, withVideo } from './gemini.js'
import { speakWithElevenLabs } from './elevenlabs.js'
import {
  FramePickSchema,
  framePickPrompt,
  NarrationSchema,
  VideoStepsSchema,
  insertScreenshots,
  narrationPrompt,
  sopPrompt,
  videoAnalysisPrompt,
  type VideoSteps,
} from './prompts.js'
import {
  applyPickedTimes,
  candidateTimes,
  cleanSteps,
  fitSegment,
  narrationSlots,
  planEdit,
} from './steps.js'

/**
 * Filet de sécurité si le service vidéo tombe : un traitement qui n'avance plus depuis 30 min
 * est passé en échec et remboursé (vérifié à chaque lecture côté API).
 */
const STALE_AFTER_MS = 30 * 60_000

export async function failIfStale(sop: db.Sop): Promise<db.Sop> {
  if (sop.status !== 'processing') return sop
  if (Date.now() - new Date(sop.updatedAt).getTime() < STALE_AFTER_MS) return sop
  const error =
    'Processing took too long and was stopped. Your credits were refunded, please try again.'
  await fail(sop, error)
  return { ...sop, status: 'failed', progress: null, error }
}

export async function fail(sop: db.Sop, message: string): Promise<void> {
  await db.updateSop(sop.id, { status: 'failed', error: message, progress: null })
  if (sop.creditsUsed > 0) {
    await db.applyCredits(sop.userId, sop.creditsUsed, 'refund', `refund:${sop.id}`)
  }
}

export async function processSop(id: string): Promise<void> {
  const sop = await db.getSop(id)
  if (!sop || sop.status !== 'processing') return

  const dir = await mkdtemp(join(tmpdir(), `sop-${id}-`))
  const folder = `${sop.userId}/${sop.id}`
  const step = (progress: string) => db.updateSop(id, { progress })

  try {
    // 1. Vidéo propre (MP4 720p) + durée réelle
    await step('Preparing the video')
    const video = join(dir, 'video.mp4')
    // ffmpeg lit la vidéo source directement (URL du stockage, ou fichier en mode local).
    await normalizeVideo(db.sourceForFfmpeg(sop.sourcePath), video)
    const duration = await durationOf(video)
    await db.updateSop(id, { durationSeconds: duration })

    // La durée annoncée par le navigateur a fixé le prix ; on complète si la vraie durée est plus longue.
    const extra = creditsFor(duration) - sop.creditsUsed
    if (extra > 0) {
      if (!(await db.applyCredits(sop.userId, -extra, 'sop', `sop-extra:${id}`))) {
        throw new UserFacingError(`Not enough credits: this video needs ${creditsFor(duration)}.`)
      }
      sop.creditsUsed += extra
      await db.updateSop(id, { creditsUsed: sop.creditsUsed })
    }

    // 2 à 4 : la vidéo est envoyée une fois à Gemini, qui la regarde ET l'écoute pour chaque étape.
    const { steps, markdown } = await withVideo(video, duration, async (gemini) => {
      // 2. Transcription de ce que dit la personne + liste des étapes
      await step('Analyzing the video')
      const analysis = await gemini.json(videoAnalysisPrompt(duration), VideoStepsSchema)
      const found = cleanSteps(analysis.steps, duration)
      if (found.length === 0) {
        throw new UserFacingError(
          'No action detected in the video. Record your screen while you perform the task.',
        )
      }

      // 3. Une capture par étape, au meilleur moment (Gemini choisit parmi plusieurs images)
      await step('Taking screenshots')
      const steps = await pickScreenshotTimes(video, found, duration, dir)
      const urls: (string | null)[] = []
      for (const [i, s] of steps.entries()) {
        const jpg = join(dir, `step-${i + 1}.jpg`)
        try {
          await extractFrame(video, s.timestamp, jpg)
          const path = `${folder}/step-${i + 1}.jpg`
          await db.uploadFile(path, await readFile(jpg), 'image/jpeg')
          urls.push(db.publicUrl(path))
        } catch (err) {
          console.warn(`[pipeline] capture ${i + 1} ratée`, (err as Error).message)
          urls.push(null)
        }
      }

      // 4. Rédaction de la SOP, vidéo + transcription sous les yeux
      await step('Writing the procedure')
      const raw = await gemini.text(
        sopPrompt({
          title: sop.title || analysis.title,
          language: sop.language,
          steps,
          transcript: analysis.transcript,
        }),
      )
      const markdown = insertScreenshots(stripFence(raw), urls)
      await db.updateSop(id, { markdown })
      return { steps, markdown }
    })

    // 5. Montage : la vidéo livrée dure 4 min max (extraits autour de chaque étape).
    const edit = planEdit(steps, duration)
    let finalVideo = video
    if (edit.clips.length > 1 || edit.duration < duration) {
      await step('Editing the video')
      finalVideo = join(dir, 'edited.mp4')
      await cutVideo(video, edit.clips, finalVideo, sop.voice === 'none')
    }

    // 6. Voix off, calée sur la vidéo montée
    if (sop.voice !== 'none') {
      await step('Recording the voice-over')
      const narrated = join(dir, 'narrated.mp4')
      await narrate({
        video: finalVideo,
        duration: edit.duration,
        steps: edit.steps,
        markdown,
        sop,
        dir,
        output: narrated,
      })
      finalVideo = narrated
    }

    await step('Finishing')
    const videoPath = `${folder}/video.mp4`
    await db.uploadFile(videoPath, await readFile(finalVideo), 'video/mp4')
    await db.updateSop(id, { videoPath, status: 'ready', progress: null })
    await db.deleteFolder(`${folder}/source`).catch(() => {})
  } catch (err) {
    console.error(`[pipeline] SOP ${id} en échec`, err)
    const message =
      err instanceof UserFacingError
        ? err.message
        : 'Generation failed. Your credits were refunded.'
    await fail(sop, message)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

class UserFacingError extends Error {}

function stripFence(text: string): string {
  return text.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '')
}

async function narrate(input: {
  video: string
  duration: number
  steps: VideoSteps['steps']
  markdown: string
  sop: db.Sop
  dir: string
  output: string
}): Promise<void> {
  const slots = narrationSlots(input.steps, input.duration)
  const { lines } = await askJson(
    narrationPrompt({ language: input.sop.language, sop: input.markdown, slots }),
    NarrationSchema,
  )

  // Synthèse de toutes les phrases, 4 à la fois.
  const premium = input.sop.voice === 'premium'
  const files = await mapLimit(slots, 4, async (_, i) => {
    const text = lines[i]?.trim()
    if (!text) return null
    const audio = premium ? await speakWithElevenLabs(text) : await speakWithGemini(text)
    const file = join(input.dir, `voice-${i}.${premium ? 'mp3' : 'wav'}`)
    await writeFile(file, audio)
    return file
  })

  // La vidéo suit la voix : chaque passage dure exactement le temps de sa phrase (aucun blanc).
  const segments = await Promise.all(
    slots.map(async (slot, i) => {
      const audio = files[i] ?? null
      const fit = fitSegment(slot.seconds, audio ? await durationOf(audio) : 0)
      return { start: slot.start, end: slot.start + slot.seconds, audio, ...fit }
    }),
  )
  if (!segments.some((s) => s.audio)) throw new Error('Voix off vide')
  await renderNarrated(input.video, segments, input.output)
}

/**
 * Gemini situe les étapes à 1-2 s près : pour chaque étape on extrait quelques images autour,
 * et Gemini choisit celle qui l'illustre le mieux. En cas d'échec, on garde les horodatages d'origine.
 */
async function pickScreenshotTimes(
  video: string,
  steps: VideoSteps['steps'],
  duration: number,
  dir: string,
): Promise<VideoSteps['steps']> {
  try {
    const candidates = steps.map((_, i) => candidateTimes(steps, i, duration))
    const batches: number[][] = []
    for (let i = 0; i < steps.length; i += 6)
      batches.push(steps.slice(i, i + 6).map((_, k) => i + k))

    const picked: (number | null)[] = steps.map(() => null)
    await mapLimit(batches, 3, async (batch) => {
      const images: { label: string; jpeg: Buffer }[] = []
      const items = []
      for (const i of batch) {
        const numbers: number[] = []
        for (const t of candidates[i]!) {
          const file = join(dir, `cand-${i}-${t}.jpg`)
          await extractFrame(video, t, file, 640)
          images.push({ label: `Image ${images.length + 1}`, jpeg: await readFile(file) })
          numbers.push(images.length)
        }
        items.push({
          step: i + 1,
          action: steps[i]!.action,
          screen: steps[i]!.screen,
          images: numbers,
        })
      }
      const { picks } = await askJsonWithImages(framePickPrompt(items), images, FramePickSchema)
      for (const p of picks) {
        const item = items.find((it) => it.step === p.step)
        const k = item?.images.indexOf(p.image) ?? -1
        if (item && k >= 0) picked[item.step - 1] = candidates[item.step - 1]![k] ?? null
      }
    })
    return applyPickedTimes(steps, picked)
  } catch (err) {
    console.warn(
      '[pipeline] choix des captures impossible, horodatages d’origine',
      (err as Error).message,
    )
    return steps
  }
}

/** Comme Promise.all(items.map(fn)), mais `limit` appels à la fois au maximum. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
