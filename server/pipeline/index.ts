// Vidéo → SOP (markdown + captures) → vidéo narrée.
// Tourne dans le process du serveur, dans une petite file d'attente (2 traitements à la fois).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../db.js'
import { creditsFor } from '../credits.js'
import { durationOf, extractFrame, muxNarration, normalizeVideo } from './ffmpeg.js'
import { askAboutVideo, askJson, askText, speakWithGemini } from './gemini.js'
import { speakWithElevenLabs } from './elevenlabs.js'
import {
  NarrationSchema,
  VideoStepsSchema,
  insertScreenshots,
  narrationPrompt,
  sopPrompt,
  videoAnalysisPrompt,
  type VideoSteps,
} from './prompts.js'
import { cleanSteps, narrationSlots } from './steps.js'

const MAX_PARALLEL = 2
const queue: string[] = []
let running = 0

export function enqueue(sopId: string): void {
  queue.push(sopId)
  void drain()
}

async function drain(): Promise<void> {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const id = queue.shift()!
    running++
    processSop(id)
      .catch((err) => console.error(`[pipeline] ${id}`, err))
      .finally(() => {
        running--
        void drain()
      })
  }
}

/** Au démarrage : les traitements coupés par un redémarrage sont marqués en échec et remboursés. */
export async function recoverInterrupted(): Promise<void> {
  for (const sop of await db.listStuckSops()) {
    await fail(
      sop,
      'Traitement interrompu (redémarrage du serveur). Crédits remboursés, relancez la vidéo.',
    )
  }
}

async function fail(sop: db.Sop, message: string): Promise<void> {
  await db.updateSop(sop.id, { status: 'failed', error: message, progress: null })
  if (sop.creditsUsed > 0) {
    await db.applyCredits(sop.userId, sop.creditsUsed, 'refund', `refund:${sop.id}`)
  }
}

async function processSop(id: string): Promise<void> {
  const sop = await db.getSop(id)
  if (!sop || sop.status !== 'processing') return

  const dir = await mkdtemp(join(tmpdir(), `sop-${id}-`))
  const folder = `${sop.userId}/${sop.id}`
  const step = (progress: string) => db.updateSop(id, { progress })

  try {
    // 1. Vidéo propre (MP4 720p) + durée réelle
    await step('Préparation de la vidéo')
    const original = join(dir, 'original')
    const video = join(dir, 'video.mp4')
    await db.downloadToFile(sop.sourcePath, original)
    await normalizeVideo(original, video)
    const duration = await durationOf(video)
    await db.updateSop(id, { durationSeconds: duration })

    // La durée annoncée par le navigateur a fixé le prix ; on complète si la vraie durée est plus longue.
    const extra = creditsFor(duration) - sop.creditsUsed
    if (extra > 0) {
      if (!(await db.applyCredits(sop.userId, -extra, 'sop', `sop-extra:${id}`))) {
        throw new UserFacingError(
          `Crédits insuffisants : cette vidéo en demande ${creditsFor(duration)}.`,
        )
      }
      sop.creditsUsed += extra
      await db.updateSop(id, { creditsUsed: sop.creditsUsed })
    }

    // 2. Gemini regarde la vidéo et liste les étapes
    await step('Analyse de la vidéo')
    const analysis = await askAboutVideo(
      video,
      duration,
      videoAnalysisPrompt(duration),
      VideoStepsSchema,
    )
    const steps = cleanSteps(analysis.steps, duration)
    if (steps.length === 0) {
      throw new UserFacingError(
        "Aucune action détectée dans la vidéo. Filmez l'écran pendant que vous réalisez la tâche.",
      )
    }

    // 3. Une capture par étape
    await step('Captures d’écran')
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

    // 4. Rédaction de la SOP
    await step('Rédaction de la procédure')
    const title = analysis.title || sop.title
    const raw = await askText(sopPrompt({ title, language: sop.language, steps }))
    const markdown = insertScreenshots(stripFence(raw), urls)
    await db.updateSop(id, { markdown })

    // 5. Voix off (ou vidéo seule)
    let finalVideo = video
    if (sop.voice !== 'none') {
      await step('Voix off')
      finalVideo = join(dir, 'narrated.mp4')
      await narrate({ video, duration, steps, markdown, sop, dir, output: finalVideo })
    }

    await step('Finalisation')
    const videoPath = `${folder}/video.mp4`
    await db.uploadFile(videoPath, await readFile(finalVideo), 'video/mp4')
    await db.updateSop(id, { videoPath, status: 'ready', progress: null })
    await db.deleteFolder(`${folder}/source`).catch(() => {})
  } catch (err) {
    console.error(`[pipeline] SOP ${id} en échec`, err)
    const message =
      err instanceof UserFacingError
        ? err.message
        : 'La génération a échoué. Vos crédits ont été remboursés.'
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

  const segments: { file: string; start: number }[] = []
  let cursor = 0
  for (const [i, slot] of slots.entries()) {
    const text = lines[i]?.trim()
    if (!text) continue
    const premium = input.sop.voice === 'premium'
    const audio = premium ? await speakWithElevenLabs(text) : await speakWithGemini(text)
    const file = join(input.dir, `voice-${i}.${premium ? 'mp3' : 'wav'}`)
    await writeFile(file, audio)
    // Jamais deux phrases l'une sur l'autre : si la précédente déborde, celle-ci attend.
    const start = Math.max(slot.start, cursor)
    segments.push({ file, start })
    cursor = start + (await durationOf(file)) + 0.3
  }
  if (segments.length === 0) throw new Error('Voix off vide')
  await muxNarration(input.video, segments, cursor, input.output)
}
