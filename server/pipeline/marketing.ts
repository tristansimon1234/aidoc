// Vidéo marketing animée : Claude (ou Gemini) écrit le storyboard à partir des captures du produit et du brief,
// Claude (ou Gemini) code chaque scène en React/Remotion à partir de ces captures, chaque scène est testée
// (compilation + rendu de quelques images, 3 essais) puis relue en images par le modèle ;
// Remotion rend la vidéo, ffmpeg ajoute la voix off et la musique.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HeadlessBrowser } from '@remotion/renderer'
import * as db from '../db.js'
import { MAX_SCREENSHOTS } from '../credits.js'
import { VIDEO_FPS, type Brand, type Shot } from '../../remotion/props.js'
import { codeChat, codeModelName, writeJson, type ChatPart } from './claude.js'
import { generateMusic, isElevenLabsEnabled } from './elevenlabs.js'
import {
  addMusic,
  buildVoiceTrack,
  durationOf,
  frameSize,
  muxAudio,
  normalizeImage,
} from './ffmpeg.js'
import {
  HookPickSchema,
  SCENE_SYSTEM_PROMPT,
  StoryboardSchema,
  hookPickPrompt,
  reviewApproved,
  sceneFixPrompt,
  scenePrompt,
  sceneReviewPrompt,
  storyboardPrompt,
  toTone,
  type Storyboard,
} from './prompts.js'
import { renderMarketingVideo, renderSceneStills, withBrowser } from './remotion.js'
import { compileScene, extractCode } from './scene-code.js'
import { brandColors, captionWords, mapLimit } from './steps.js'
import { defaultVoice, speak } from '../voices.js'

const WIDTH = 1920
const HEIGHT = 1080
/** Essais de compilation + rendu par scène avant la scène de secours. */
const MAX_ATTEMPTS = 3

/** Problème dans ce que la personne a envoyé : message affiché tel quel. */
export class MarketingInputError extends Error {}

interface MotionJob {
  sop: db.Sop
  dir: string
  folder: string
  step: (progress: string) => Promise<void>
}

export async function makeMotionVideo({ sop, dir, folder, step }: MotionJob): Promise<string> {
  const tone = toTone(sop.tone)

  // 1. Storyboard à partir des captures et du brief
  await step('Writing the storyboard')
  const images = await loadScreenshots(folder, dir)
  // Régénération : le storyboard précédent est corrigé selon le retour de l'utilisateur.
  const previous = sop.feedback
    ? ((await db.downloadFile(`${folder}/storyboard.json`))?.toString('utf8') ?? null)
    : null
  const board = await writeJson(
    storyboardPrompt({
      language: sop.language,
      tone,
      imageCount: images.length,
      title: sop.title,
      brief: sop.brief,
      targetSeconds: sop.targetSeconds,
      feedback: sop.feedback,
      previous,
    }),
    StoryboardSchema,
    images.map((img, i) => ({ label: `Image ${i + 1}`, jpeg: img.jpeg })),
  )
  // Correction demandée sur l'accroche : on garde celle du storyboard corrigé.
  if (!sop.feedback) await pickHook(board, sop.brief)
  const brand = toBrand(board)
  await db
    .uploadFile(`${folder}/storyboard.json`, Buffer.from(JSON.stringify(board)), 'application/json')
    .catch((err: Error) => console.warn('[marketing] storyboard non enregistré', err.message))

  // 2. Voix off : une phrase par scène ; chaque scène dure le temps de sa phrase.
  await step('Recording the voice-over')
  const voice = sop.voice === 'none' ? await defaultVoice() : sop.voice
  console.log(
    `[marketing] voix ${voice} · musique ${sop.music ? 'oui' : 'non'} · ElevenLabs ${isElevenLabsEnabled() ? 'configuré' : 'non configuré (ELEVENLABS_API_KEY absente)'}`,
  )
  const voiceFiles = await mapLimit(board.scenes, 4, async (scene, i) => {
    const { audio, ext } = await speak(voice, scene.line, tone, 'marketing')
    const file = join(dir, `line-${i}.${ext}`)
    await writeFile(file, audio)
    return { file, seconds: await durationOf(file) }
  })
  const frames = voiceFiles.map((v) => Math.round(Math.max(2.5, v.seconds + 0.6) * VIDEO_FPS))

  // 3. Captures utilisées par chaque scène (choisies par le storyboard)
  const shots = board.scenes.map((scene) =>
    scene.screenshots
      .map((s) => {
        const img = images[s.image - 1]
        return img ? { ...img.shot, description: s.what || img.shot.description } : null
      })
      .filter((s): s is Shot => s !== null),
  )

  // 4 et 5. Code des scènes, puis rendu de la vidéo, dans un même navigateur headless
  const silent = join(dir, 'motion.mp4')
  await withBrowser(async (browser) => {
    let done = 0
    await step(`Designing the scenes (0/${board.scenes.length})`)
    const codes = await mapLimit(board.scenes, 3, async (_, i) => {
      const code = await designScene(browser, {
        board,
        brand,
        index: i,
        frames: frames[i]!,
        shots: shots[i]!,
        language: sop.language,
        brief: sop.feedback
          ? `${sop.brief ?? ''}\n\nCorrections asked by the user on the previous version (apply those about this scene): ${sop.feedback}`
          : sop.brief,
        dir,
      }).catch((err: unknown) => {
        console.warn(`[marketing] scène ${i + 1} : scène de secours`, (err as Error).message)
        return null
      })
      await step(`Designing the scenes (${++done}/${board.scenes.length})`)
      return code
    })
    console.log(
      `[marketing] ${codes.filter(Boolean).length}/${codes.length} scènes codées par ${codeModelName()}`,
    )

    await step('Rendering the video')
    let startMs = 0
    const captionLines = board.scenes.map((scene, i) => {
      const line = { text: scene.line, startMs, durationMs: voiceFiles[i]!.seconds * 1000 }
      startMs += (frames[i]! / VIDEO_FPS) * 1000
      return line
    })
    await renderMarketingVideo(
      browser,
      {
        width: WIDTH,
        height: HEIGHT,
        brand,
        captions: captionWords(captionLines),
        scenes: board.scenes.map((scene, i) => ({
          code: codes[i] ?? null,
          durationInFrames: frames[i]!,
          // Les captures ne sont que des références pour Claude : jamais affichées dans la vidéo.
          shots: [],
          headline: scene.onScreen,
        })),
      },
      silent,
    )
  })

  // 6. Voix off + musique
  await step('Mixing the sound')
  const voiceTrack = join(dir, 'voice.wav')
  await buildVoiceTrack(
    voiceFiles.map((v, i) => ({ audio: v.file, seconds: frames[i]! / VIDEO_FPS })),
    voiceTrack,
  )
  let clip = join(dir, 'marketing.mp4')
  await muxAudio(silent, voiceTrack, clip)

  if (sop.music) {
    try {
      const music = join(dir, 'music.mp3')
      const length = await durationOf(clip)
      await writeFile(music, await generateMusic(board.musicPrompt, (length + 1) * 1000))
      const withMusic = join(dir, 'marketing-music.mp4')
      await addMusic(clip, music, withMusic)
      clip = withMusic
    } catch (err) {
      console.warn('[marketing] musique impossible, vidéo sans musique', (err as Error).message)
    }
  }
  return clip
}

/** La meilleure des accroches proposées devient la première scène (sinon on garde celle du storyboard). */
async function pickHook(board: Storyboard, brief: string | null): Promise<void> {
  if (board.hooks.length < 2) return
  try {
    const { best } = await writeJson(
      hookPickPrompt({ productName: board.productName, brief, hooks: board.hooks }),
      HookPickSchema,
    )
    const hook = board.hooks[best - 1]
    const first = board.scenes[0]
    if (hook && first) Object.assign(first, { line: hook.line, onScreen: hook.onScreen })
  } catch (err) {
    console.warn('[marketing] choix de l’accroche impossible', (err as Error).message)
  }
}

/** Couleurs du storyboard, corrigées pour rester lisibles (fond sombre, surlignage clair). */
function toBrand(board: Storyboard): Brand {
  return {
    productName: board.productName,
    ...brandColors(board.brand.accent, board.brand.background),
  }
}

/** Captures envoyées (source/shot-0.jpg, shot-1.jpg…), redimensionnées pour Gemini et le rendu. */
async function loadScreenshots(
  folder: string,
  dir: string,
): Promise<{ shot: Shot; jpeg: Buffer }[]> {
  const out: { shot: Shot; jpeg: Buffer }[] = []
  for (let i = 0; i < MAX_SCREENSHOTS; i++) {
    const path = `${folder}/source/shot-${i}.jpg`
    if (!(await db.fileExists(path))) break
    const file = join(dir, `shot-${i}.jpg`)
    await normalizeImage(db.sourceForFfmpeg(path), file)
    const { width, height } = await frameSize(file)
    const jpeg = await readFile(file)
    out.push({
      shot: {
        src: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        width,
        height,
        description: `Screenshot ${i + 1}`,
      },
      jpeg,
    })
  }
  if (out.length === 0) {
    throw new MarketingInputError(
      'No screenshot received. Add at least one screenshot of your product.',
    )
  }
  return out
}

type Attempt = { ok: true; code: string; stills: Buffer[] } | { ok: false; error: string }

/**
 * Fait coder une scène : réponse du modèle → compilation → rendu de 3 images. En cas d'erreur, elle
 * est renvoyée au modèle (3 essais). Puis le modèle relit les images de sa scène et peut l'améliorer.
 * Renvoie le code compilé, ou null (la vidéo utilisera la scène de secours).
 */
export async function designScene(
  browser: HeadlessBrowser,
  input: {
    board: Storyboard
    brand: Brand
    index: number
    frames: number
    shots: Shot[]
    language: string
    brief: string | null
    dir: string
  },
  chat = codeChat(SCENE_SYSTEM_PROMPT),
): Promise<string | null> {
  const scene = input.board.scenes[input.index]!
  const checkpoints = [
    Math.round(input.frames * 0.1),
    Math.round(input.frames * 0.35),
    Math.round(input.frames * 0.65),
    input.frames - 4,
  ]
  let run = 0
  const tryAnswer = async (answer: string): Promise<Attempt> => {
    const source = extractCode(answer)
    if (!source)
      return { ok: false, error: 'No ```tsx code block defining `function Scene` was found.' }
    const compiled = await compileScene(source)
    if (!compiled.ok) return compiled
    try {
      const stills = await renderSceneStills(
        browser,
        {
          width: WIDTH,
          height: HEIGHT,
          brand: input.brand,
          scene: {
            code: compiled.code,
            durationInFrames: input.frames,
            shots: [],
            headline: scene.onScreen,
          },
        },
        checkpoints,
        input.dir,
        `scene-${input.index}-${run++}`,
      )
      return { ok: true, code: compiled.code, stills }
    } catch (err) {
      return { ok: false, error: `Runtime error while rendering:\n${(err as Error).message}` }
    }
  }

  const prompt = scenePrompt({
    language: input.language,
    productName: input.brand.productName,
    brief: input.brief,
    storyboard: input.board.scenes,
    index: input.index,
    visual: scene.visual,
    seconds: input.frames / VIDEO_FPS,
    frames: input.frames,
    width: WIDTH,
    height: HEIGHT,
    brand: input.brand,
    shots: input.shots.map((s) => ({ what: s.description })),
  })
  const images: ChatPart[] = input.shots.map((s) => ({
    image: Buffer.from(s.src.slice(s.src.indexOf(',') + 1), 'base64'),
    mediaType: 'image/jpeg',
  }))

  let answer = await chat.send([{ text: prompt }, ...images])
  let good: Attempt | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await tryAnswer(answer)
    if (result.ok) {
      good = result
      break
    }
    console.warn(
      `[marketing] scène ${input.index + 1}, essai ${attempt} :`,
      result.error.slice(0, 300),
    )
    if (attempt < MAX_ATTEMPTS) answer = await chat.send([{ text: sceneFixPrompt(result.error) }])
  }
  if (!good?.ok) return null

  // Relecture « directeur artistique » sur les images rendues ; on garde l'ancienne version si la
  // nouvelle ne passe pas.
  // Deux relectures au plus : la version corrigée est relue à son tour.
  let best: Extract<Attempt, { ok: true }> = good
  for (let round = 1; round <= 2; round++) {
    const review = await chat.send([
      { text: sceneReviewPrompt(checkpoints, input.frames) },
      ...best.stills.map((png): ChatPart => ({ image: png, mediaType: 'image/png' })),
    ])
    if (reviewApproved(review)) {
      console.log(`[marketing] scène ${input.index + 1} : validée à la relecture ${round}`)
      return best.code
    }
    const improved = await tryAnswer(review)
    if (!improved.ok) {
      console.warn(
        `[marketing] scène ${input.index + 1} : correction de relecture refusée`,
        improved.error.slice(0, 200),
      )
      break
    }
    best = improved
  }
  return best.code
}
