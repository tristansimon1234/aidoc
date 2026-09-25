// Vidéo → SOP (markdown + captures + vidéo commentée) ou vidéo marketing courte.
// Tourne sur le service vidéo (Railway), sans limite de durée ; en local, dans le même process.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../db.js'
import { creditsFor } from '../credits.js'
import { cutVideo, durationOf, extractFrame, normalizeVideo, renderNarrated } from './ffmpeg.js'
import { askJson, askJsonWithImages, QuotaExceededError, withVideo } from './gemini.js'
import { speak } from '../voices.js'
import {
  addUpdatedDate,
  toTone,
  FramePickSchema,
  framePickPrompt,
  NarrationFixSchema,
  NarrationSchema,
  narrationFixPrompt,
  VideoStepsSchema,
  insertScreenshots,
  MissingStepsSchema,
  missingStepsPrompt,
  maxWordsFor,
  narrationPrompt,
  sopPrompt,
  videoAnalysisPrompt,
  type VideoSteps,
} from './prompts.js'
import {
  applyPickedTimes,
  attachTranscript,
  candidateTimes,
  cleanSteps,
  fitSegment,
  limitWords,
  mapLimit,
  narrationSlots,
  misfit,
  planEdit,
  repairTimecodes,
  speakingRate,
  uncoveredRanges,
  wordsFor,
} from './steps.js'

/**
 * Filet de sécurité si le service vidéo tombe : un traitement qui n'avance plus depuis 30 min
 * est passé en échec et remboursé (vérifié à chaque lecture côté API).
 */
const STALE_AFTER_MS = 30 * 60_000

/** Secondes gardées après la dernière étape d'une SOP. */
const TAIL_SECONDS = 8

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
  const step: Step = (progress) => db.updateSop(id, { progress })

  try {
    const finalVideo =
      sop.kind === 'marketing'
        ? await makeMarketingVideo({ sop, dir, folder, step })
        : await makeSopFromVideo({ sop, dir, folder, step })

    await step('Finishing')
    const videoPath = `${folder}/video.mp4`
    await db.uploadFile(videoPath, await readFile(finalVideo), 'video/mp4')
    await db.updateSop(id, { videoPath, status: 'ready', progress: null })
    await db.deleteFolder(`${folder}/source`).catch(() => {})
  } catch (err) {
    console.error(`[pipeline] ${sop.kind} ${id} en échec`, err)
    const message =
      err instanceof UserFacingError
        ? err.message
        : err instanceof QuotaExceededError
          ? 'The AI service has reached its daily limit. Your credits were refunded, please try again later.'
          : 'Generation failed. Your credits were refunded.'
    await fail(sop, message)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type Step = (progress: string) => Promise<void>

/** Une création en cours de traitement : la SOP, un dossier de travail, son dossier de stockage. */
export interface Task {
  sop: db.Sop
  dir: string
  folder: string
  step: Step
}

/** SOP : prépare la vidéo (MP4 720p, durée réelle, complément de crédits) puis la traite. */
async function makeSopFromVideo({ sop, dir, folder, step }: Task): Promise<string> {
  const id = sop.id
  {
    // 1. Vidéo propre (MP4 720p) + durée réelle
    await step('Preparing the video')
    const video = join(dir, 'video.mp4')
    // ffmpeg lit la vidéo source directement (URL du stockage, ou fichier en mode local).
    await normalizeVideo(db.sourceForFfmpeg(sop.sourcePath), video)
    const duration = await durationOf(video)
    await db.updateSop(id, { durationSeconds: duration })

    // La durée annoncée par le navigateur a fixé le prix ; on complète si la vraie durée est plus longue.
    const extra = creditsFor(duration, sop.kind) - sop.creditsUsed
    if (extra > 0) {
      if (!(await db.applyCredits(sop.userId, -extra, 'sop', `sop-extra:${id}`))) {
        throw new UserFacingError(
          `Not enough credits: this video needs ${creditsFor(duration, sop.kind)}.`,
        )
      }
      sop.creditsUsed += extra
      await db.updateSop(id, { creditsUsed: sop.creditsUsed })
    }

    return makeSop({ video, duration, sop, dir, folder, step })
  }
}

interface Job {
  video: string
  duration: number
  sop: db.Sop
  dir: string
  folder: string
  step: Step
}

class UserFacingError extends Error {}

function stripFence(text: string): string {
  return text.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '')
}

/** SOP : procédure écrite avec captures, puis vidéo commentée de 4 min max. Renvoie la vidéo finale. */
async function makeSop({ video, duration, sop, dir, folder, step }: Job): Promise<string> {
  // 2 à 4 : la vidéo est envoyée une fois à Gemini, qui la regarde ET l'écoute pour chaque étape.
  const { steps, markdown } = await withVideo(video, duration, async (gemini) => {
    // 2. Transcription de ce que dit la personne + liste des étapes
    await step('Analyzing the video')
    const answer = await gemini.json(videoAnalysisPrompt(duration), VideoStepsSchema)
    const starts = repairTimecodes(
      answer.transcript.map((t) => t.start),
      duration,
    )
    const analysis = {
      ...answer,
      transcript: answer.transcript.map((t, i) => ({ ...t, start: starts[i]! })),
    }
    let found = cleanSteps(analysis.steps, duration)
    // Gemini s'arrête parfois de lister les étapes avant la fin : on ré-analyse les longs passages vides.
    for (const gap of found.length > 0 ? uncoveredRanges(found, duration) : []) {
      try {
        const before = found.filter((s) => s.timestamp <= gap.start).pop()
        const after = found.find((s) => s.timestamp >= gap.end)
        const extra = await gemini.json(
          missingStepsPrompt({
            ...gap,
            before: before?.action ?? null,
            after: after?.action ?? null,
            transcript: analysis.transcript,
          }),
          MissingStepsSchema,
        )
        const inside = extra.steps.filter((s) => s.timestamp > gap.start && s.timestamp < gap.end)
        if (inside.length > 0) found = cleanSteps([...found, ...inside], duration)
      } catch (err) {
        console.warn('[pipeline] ré-analyse d’un passage impossible', (err as Error).message)
      }
    }
    console.log(
      `[pipeline] ${found.length} étapes, dernière à ${found.at(-1)?.timestamp.toFixed(0)}s / ${duration.toFixed(0)}s`,
    )
    if (found.length === 0) {
      throw new UserFacingError(
        'No action detected in the video. Record your screen while you perform the task.',
      )
    }

    // 3. Une capture par étape, au meilleur moment (Gemini choisit parmi plusieurs images)
    await step('Taking screenshots')
    const steps = attachTranscript(
      await pickScreenshotTimes(video, found, duration, dir),
      analysis.transcript,
    )
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
    const markdown = addUpdatedDate(insertScreenshots(stripFence(raw), urls), sop.language)
    await db.updateSop(sop.id, { markdown })
    return { steps, markdown }
  })

  // 5. Montage : la vidéo livrée dure 4 min max (extraits autour de chaque étape).
  // Après la dernière étape, on garde quelques secondes (le résultat) puis on coupe : sinon la fin de
  // l'enregistrement défile sans rien à dire.
  const usable = Math.min(duration, (steps.at(-1)?.timestamp ?? duration) + TAIL_SECONDS)
  const edit = planEdit(steps, usable)
  let finalVideo = video
  if (edit.clips.length > 1 || edit.duration < duration) {
    await step('Editing the video')
    finalVideo = join(dir, 'edited.mp4')
    // Le son d'origine est gardé : il sert si la voix off ne peut pas être générée.
    await cutVideo(video, edit.clips, finalVideo, true)
  }

  // 6. Voix off, calée sur la vidéo montée
  if (sop.voice !== 'none') {
    await step('Recording the voice-over')
    const narrated = join(dir, 'narrated.mp4')
    try {
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
    } catch (err) {
      // Quota de voix épuisé : la SOP (texte + captures) est livrée quand même, avec la vidéo montée
      // et la voix d'origine de la personne, plutôt que de tout perdre.
      if (!(err instanceof QuotaExceededError)) throw err
      console.warn('[pipeline] voix off impossible (quota), vidéo livrée avec le son d’origine')
    }
  }
  return finalVideo
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
  const prompt = narrationPrompt({
    language: input.sop.language,
    tone: toTone(input.sop.tone),
    sop: input.markdown,
    slots,
  })
  // Une réponse avec moins de textes que de créneaux laisserait la fin de la vidéo sans voix : on redemande.
  let { lines } = await askJson(prompt, NarrationSchema)
  for (let retry = 0; retry < 2 && lines.filter((l) => l.trim()).length < slots.length; retry++) {
    console.warn(
      `[pipeline] voix off : ${lines.length} textes pour ${slots.length} créneaux, on redemande`,
    )
    const again = await askJson(prompt, NarrationSchema)
    if (again.lines.filter((l) => l.trim()).length > lines.filter((l) => l.trim()).length) {
      lines = again.lines
    }
  }

  // Synthèse de toutes les phrases, 4 à la fois. Plafond appliqué par le code : une phrase trop
  // longue décalerait la voix par rapport à l'écran.
  const tone = toTone(input.sop.tone)
  const synth = async (text: string, i: number, pass: number) => {
    if (!text) return null
    const { audio, ext } = await speak(input.sop.voice, text, tone)
    const file = join(input.dir, `voice-${i}-${pass}.${ext}`)
    await writeFile(file, audio)
    return { file, text, seconds: await durationOf(file) }
  }
  const texts = slots.map((slot, i) => limitWords(lines[i] ?? '', maxWordsFor(slot.seconds)))
  const voices = await mapLimit(slots, 4, (_, i) => synth(texts[i]!, i, 0))

  // Le bon niveau de parole : la vidéo n'est jamais accélérée, c'est le texte qui s'adapte. On mesure
  // la vitesse réelle de la voix, et les textes qui débordent de leur passage ou le laissent muet plus
  // de ~2 s sont réécrits à la bonne longueur, une fois.
  const rate = speakingRate(voices)
  const misfits = slots
    .map((slot, i) => ({ slot, i, voice: voices[i] ?? null }))
    .filter(({ slot, voice }) => {
      const seconds = voice?.seconds ?? 0
      return seconds + 0.4 > slot.seconds || (slot.seconds >= 4 && slot.seconds - seconds > 2.5)
    })
  if (misfits.length > 0) {
    try {
      const { lines: rewritten } = await askJson(
        narrationFixPrompt({
          language: input.sop.language,
          tone,
          items: misfits.map(({ slot, i, voice }) => ({
            slot: i + 1,
            action: slot.action,
            spoken: slot.spoken,
            current: voice?.text ?? '',
            words: wordsFor(slot.seconds, rate),
          })),
        }),
        NarrationFixSchema,
      )
      await mapLimit(misfits, 4, async ({ slot, i }) => {
        const text = rewritten.find((r) => r.slot === i + 1)?.text ?? ''
        const capped = limitWords(text, Math.max(3, Math.floor((slot.seconds - 0.5) * rate)))
        const again = capped ? await synth(capped, i, 1) : null
        // On garde la nouvelle version seulement si elle tient mieux dans le passage.
        if (
          again &&
          misfit(slot.seconds, again.seconds) <= misfit(slot.seconds, voices[i]?.seconds ?? 0)
        ) {
          voices[i] = again
        }
      })
    } catch (err) {
      console.warn('[pipeline] réécriture de la voix off impossible', (err as Error).message)
    }
  }
  const files = voices.map((v) => v?.file ?? null)

  // Diagnostic dans les logs : ce que chaque passage montre, ce que la voix dit, et le silence restant.
  console.log(
    `[pipeline] voix off : ${slots.length} passages, ${rate.toFixed(1)} mots/s\n` +
      slots
        .map((slot, i) => {
          const v = voices[i]
          const silence = slot.seconds - (v?.seconds ?? 0)
          return `  #${i + 1} ${slot.start.toFixed(0)}s +${slot.seconds.toFixed(1)}s | voix ${(v?.seconds ?? 0).toFixed(1)}s | ${silence < 0 ? `déborde ${(-silence).toFixed(1)}s` : `silence ${silence.toFixed(1)}s`} | ${slot.action.slice(0, 60)} → "${(v?.text ?? '').slice(0, 80)}"`
        })
        .join('\n'),
  )

  // La vidéo garde sa vitesse réelle : la voix dit ce qui est à l'écran à ce moment-là.
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
 * Vidéo marketing de 30 ou 60 s, animée à partir des captures envoyées (voir marketing.ts). Import à
 * la demande : Remotion n'est chargé que sur le service vidéo, jamais par l'API.
 */
async function makeMarketingVideo(task: Task): Promise<string> {
  const { makeMotionVideo, MarketingInputError } = await import('./marketing.js')
  try {
    return await makeMotionVideo(task)
  } catch (err) {
    throw err instanceof MarketingInputError ? new UserFacingError(err.message) : err
  }
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
