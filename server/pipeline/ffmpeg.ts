// Petites fonctions ffmpeg (binaire système, installé dans le Dockerfile du service vidéo).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

/**
 * Images par seconde de toutes les vidéos produites. Chaque passage monté dure un nombre ENTIER
 * d'images, et sa piste audio exactement la même durée : sinon les arrondis (1/15 s par passage)
 * s'accumulent et la voix se décale de plus en plus vers la fin.
 */
export const FPS = 15
export function toFrames(seconds: number): number {
  return Math.max(1, Math.round(seconds * FPS))
}

/** Lance ffmpeg ; renvoie la sortie d'erreur (c'est là que ffmpeg écrit ses infos). */
function run(args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args])
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 || allowFailure
        ? resolve(err)
        : reject(new Error(`ffmpeg a échoué (${code}): ${err.slice(-800)}`)),
    )
  })
}

/** Durée et présence d'une piste audio, lues dans l'en-tête affiché par `ffmpeg -i`. */
export async function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const info = await run(['-i', file], true) // sans fichier de sortie, ffmpeg « échoue » : normal
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info)
  if (!m) throw new Error(`Durée illisible pour ${file}`)
  return {
    duration: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
    hasAudio: /Stream #\S+.*: Audio:/.test(info),
  }
}

export async function durationOf(file: string): Promise<number> {
  return (await probe(file)).duration
}

/**
 * Ré-encode n'importe quelle vidéo (webm, mov…) en MP4 720p / 15 i/s léger, pour la lecture web,
 * Gemini et les captures. `input` peut être une URL : ffmpeg la lit en streaming (rien sur le disque).
 */
export async function normalizeVideo(input: string, output: string): Promise<void> {
  await run([
    '-y', '-i', input,
    '-vf', `scale='min(1280,iw)':-2,fps=${FPS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output,
  ])
}

/** Monte la vidéo en ne gardant que les extraits `clips` (secondes), mis bout à bout. */
export async function cutVideo(
  input: string,
  clips: { start: number; end: number }[],
  output: string,
  keepAudio: boolean,
): Promise<void> {
  const audio = keepAudio && (await probe(input)).hasAudio
  // Un « -ss/-t » par extrait : ffmpeg saute directement au bon endroit (rapide même sur une longue vidéo).
  const inputs = clips.flatMap((c) => [
    '-ss', c.start.toFixed(3), '-t', (c.end - c.start).toFixed(3), '-i', input,
  ])
  // Durée de chaque extrait calée à l'image près, identique pour l'image et le son.
  const filters = clips.map((c, i) => {
    const frames = toFrames(c.end - c.start)
    const v = `[${i}:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    const a = `[${i}:a]apad,atrim=duration=${(frames / FPS).toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`
    return audio ? `${v};${a}` : v
  })
  const streams = clips.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
  const concat = `${filters.join(';')};${streams}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${audio ? '[vc][a]' : '[vc]'};[vc]setpts=N/(${FPS}*TB)[v]`

  await run([
    '-y', ...inputs,
    '-filter_complex', concat,
    '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ])
}

/** Une image de la vidéo à l'instant `seconds` ; `width` pour une miniature (choix des captures). */
export async function extractFrame(
  video: string,
  seconds: number,
  output: string,
  width?: number,
): Promise<void> {
  // Tout près de la fin, ffmpeg peut ne trouver aucune image (sans erreur) : on recule un peu.
  for (const back of [0, 0.5, 1.5, 3]) {
    await rm(output, { force: true })
    await run([
      '-y', '-ss', Math.max(0, seconds - back).toFixed(2), '-i', video, '-frames:v', '1',
      ...(width ? ['-vf', `scale=${width}:-2`] : []),
      '-q:v', '3', output,
    ])
    if (existsSync(output)) return
  }
  throw new Error(`Aucune image à ${seconds.toFixed(2)} s dans ${video}`)
}

/**
 * Vidéo commentée sans blanc : chaque passage [start, end] de la vidéo est suivi de sa phrase de voix off,
 * accéléré ou ralenti (`factor`) et prolongé (`freeze`) pour durer exactement `length` secondes.
 */
export async function renderNarrated(
  video: string,
  segments: {
    start: number
    end: number
    audio: string | null
    factor: number
    freeze: number
    length: number
    tempo: number
  }[],
  output: string,
): Promise<void> {
  // Un « -ss/-t » par passage (saut direct), puis les fichiers audio. Un passage ne commence jamais
  // après la dernière image : il serait vide et ne pourrait pas être prolongé.
  const lastFrame = Math.max(0, (await durationOf(video)) - 1 / FPS)
  const videoInputs = segments.flatMap((s) => {
    const start = Math.min(s.start, lastFrame)
    return ['-ss', start.toFixed(3), '-t', Math.max(1 / FPS, s.end - start).toFixed(3), '-i', video]
  })
  const audioFiles = segments.map((s) => s.audio).filter((a): a is string => a !== null)
  const audioInputs = audioFiles.flatMap((f) => ['-i', f])

  let audioIndex = segments.length
  const filters = segments.map((s, i) => {
    // Passage accéléré/ralenti, image figée si besoin, puis coupé à un nombre exact d'images ;
    // la voix (ou le silence) est coupée exactement à la même durée.
    const frames = toFrames(s.length)
    const len = (frames / FPS).toFixed(6)
    const v = `[${i}:v]setpts=(PTS-STARTPTS)*${s.factor.toFixed(4)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${(s.freeze + 1).toFixed(3)},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    const a = s.audio
      ? `[${audioIndex++}:a]aresample=44100,aformat=channel_layouts=mono${s.tempo > 1.001 ? `,atempo=${s.tempo.toFixed(3)}` : ''},apad,atrim=duration=${len}[a${i}]`
      : `aevalsrc=0:s=44100:d=${len},aformat=channel_layouts=mono[a${i}]`
    return `${v};${a}`
  })
  // Après l'assemblage, chaque image est réhorodatée d'après son rang (n / 15 s) : sinon des images en
  // limite de passage se chevauchent, l'encodeur en supprime, et l'image prend du retard sur la voix.
  const concat = `${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[vc][a];[vc]setpts=N/(${FPS}*TB)[v]`

  await run([
    '-y', ...videoInputs, ...audioInputs,
    '-filter_complex', `${filters.join(';')};${concat}`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ])
}

/** Ajoute une musique de fond discrète sous la voix (la vidéo garde sa durée). */
export async function addMusic(video: string, music: string, output: string): Promise<void> {
  await run([
    '-y', '-i', video, '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    '[1:a]volume=0.12,afade=t=in:d=1[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ])
}

/** Largeur et hauteur de l'image d'une vidéo ou d'une image. */
export async function frameSize(file: string): Promise<{ width: number; height: number }> {
  const info = await run(['-i', file], true)
  const m = /Stream #\S+.*: Video: .*?, (\d{2,5})x(\d{2,5})/.exec(info)
  if (!m) throw new Error(`Dimensions illisibles pour ${file}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

/** Piste voix off : chaque phrase (ou silence) occupe exactement la durée de sa scène, bout à bout. */
export async function buildVoiceTrack(
  parts: { audio: string | null; seconds: number }[],
  output: string,
): Promise<void> {
  const files = parts.map((p) => p.audio).filter((a): a is string => a !== null)
  let input = 0
  const filters = parts.map((p, i) => {
    const len = p.seconds.toFixed(6)
    return p.audio
      ? `[${input++}:a]aresample=44100,aformat=channel_layouts=mono,apad,atrim=duration=${len}[a${i}]`
      : `aevalsrc=0:s=44100:d=${len},aformat=channel_layouts=mono[a${i}]`
  })
  const concat = `${parts.map((_, i) => `[a${i}]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`
  await run([
    '-y', ...files.flatMap((f) => ['-i', f]),
    '-filter_complex', `${filters.join(';')};${concat}`,
    '-map', '[a]', '-c:a', 'pcm_s16le',
    output,
  ])
}

/** Assemble une vidéo muette et sa piste audio (la vidéo garde sa durée). */
export async function muxAudio(video: string, audio: string, output: string): Promise<void> {
  await run([
    '-y', '-i', video, '-i', audio,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-af', 'apad', '-shortest',
    '-movflags', '+faststart',
    output,
  ])
}
