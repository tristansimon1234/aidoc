// Vidéo marketing animée : Gemini écrit le storyboard à partir de l'enregistrement, Claude (ou Gemini)
// code chaque scène en React/Remotion à partir des vraies captures, chaque scène est testée
// (compilation + rendu de quelques images, 3 essais) puis relue en images par le modèle ;
// Remotion rend la vidéo, ffmpeg ajoute la voix off et la musique.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HeadlessBrowser } from '@remotion/renderer'
import type * as db from '../db.js'
import { VIDEO_FPS, type Brand, type Shot } from '../../remotion/props.js'
import { codeChat, codeModelName, type ChatPart } from './claude.js'
import { generateMusic } from './elevenlabs.js'
import {
  addMusic,
  buildVoiceTrack,
  durationOf,
  extractFrame,
  frameSize,
  muxAudio,
} from './ffmpeg.js'
import { askJson, withVideo } from './gemini.js'
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
import { captionWords, luminance, mapLimit, repairTimecode } from './steps.js'
import { speak } from '../voices.js'

const WIDTH = 1920
const HEIGHT = 1080
/** Essais de compilation + rendu par scène avant la scène de secours. */
const MAX_ATTEMPTS = 3

interface MotionJob {
  video: string
  duration: number
  sop: db.Sop
  dir: string
  step: (progress: string) => Promise<void>
}

export async function makeMotionVideo({
  video,
  duration,
  sop,
  dir,
  step,
}: MotionJob): Promise<string> {
  const tone = toTone(sop.tone)

  // 1. Storyboard (Gemini regarde et écoute l'enregistrement)
  await step('Writing the storyboard')
  const board = await withVideo(video, duration, (gemini) =>
    gemini.json(
      storyboardPrompt({
        language: sop.language,
        tone,
        durationSeconds: duration,
        title: sop.title,
        brief: sop.brief,
        targetSeconds: sop.targetSeconds,
      }),
      StoryboardSchema,
    ),
  )
  await pickHook(board, sop.brief)
  const brand = toBrand(board)

  // 2. Voix off : une phrase par scène ; chaque scène dure le temps de sa phrase.
  await step('Recording the voice-over')
  const voice = sop.voice === 'none' ? 'gemini:Puck' : sop.voice
  const voiceFiles = await mapLimit(board.scenes, 4, async (scene, i) => {
    const { audio, ext } = await speak(voice, scene.line, tone)
    const file = join(dir, `line-${i}.${ext}`)
    await writeFile(file, audio)
    return { file, seconds: await durationOf(file) }
  })
  const frames = voiceFiles.map((v) => Math.round(Math.max(2.5, v.seconds + 0.6) * VIDEO_FPS))

  // 3. Captures de l'enregistrement choisies par le storyboard
  const shots = await Promise.all(
    board.scenes.map((scene, i) =>
      Promise.all(
        scene.screenshots.map((s, k) =>
          screenshot(
            video,
            Math.min(Math.max(0, repairTimecode(s.time, duration)), duration - 0.2),
            s.what,
            join(dir, `shot-${i}-${k}.jpg`),
          ),
        ),
      ).then((list) => list.filter((s): s is Shot => s !== null)),
    ),
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
        brief: sop.brief,
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
          shots: shots[i]!,
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
    const { best } = await askJson(
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
  const dark = luminance(board.brand.background) < 0.3
  return {
    productName: board.productName,
    accent: board.brand.accent,
    accent2: luminance(board.brand.accent2) > 0.35 ? board.brand.accent2 : '#FFD84D',
    background: board.brand.background,
    text: dark ? '#FFFFFF' : '#0B0B0F',
  }
}

async function screenshot(
  video: string,
  time: number,
  what: string,
  file: string,
): Promise<Shot | null> {
  try {
    await extractFrame(video, time, file)
    const { width, height } = await frameSize(file)
    const jpeg = await readFile(file)
    return {
      src: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width,
      height,
      description: what,
    }
  } catch (err) {
    console.warn('[marketing] capture impossible', (err as Error).message)
    return null
  }
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
    Math.round(input.frames * 0.12),
    Math.round(input.frames * 0.5),
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
            shots: input.shots,
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
  const review = await chat.send([
    { text: sceneReviewPrompt(checkpoints, input.frames) },
    ...good.stills.map((png): ChatPart => ({ image: png, mediaType: 'image/png' })),
  ])
  if (!reviewApproved(review)) {
    const improved = await tryAnswer(review)
    if (improved.ok) return improved.code
  }
  return good.code
}
