// Petites fonctions ffmpeg (binaire système, installé dans le Dockerfile du service vidéo).
import { spawn } from 'node:child_process'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

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
    '-vf', "scale='min(1280,iw)':-2,fps=15",
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
  const streams = clips.map((_, i) => (audio ? `[${i}:v][${i}:a]` : `[${i}:v]`)).join('')
  const concat = `${streams}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${audio ? '[v][a]' : '[v]'}`

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
  await run([
    '-y', '-ss', seconds.toFixed(2), '-i', video, '-frames:v', '1',
    ...(width ? ['-vf', `scale=${width}:-2`] : []),
    '-q:v', '3', output,
  ])
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
  }[],
  output: string,
): Promise<void> {
  // Un « -ss/-t » par passage (saut direct), puis les fichiers audio.
  const videoInputs = segments.flatMap((s) => [
    '-ss', s.start.toFixed(3), '-t', (s.end - s.start).toFixed(3), '-i', video,
  ])
  const audioFiles = segments.map((s) => s.audio).filter((a): a is string => a !== null)
  const audioInputs = audioFiles.flatMap((f) => ['-i', f])

  let audioIndex = segments.length
  const filters = segments.map((s, i) => {
    const freeze = s.freeze > 0 ? `,tpad=stop_mode=clone:stop_duration=${s.freeze.toFixed(3)}` : ''
    const v = `[${i}:v]setpts=(PTS-STARTPTS)*${s.factor.toFixed(4)},fps=15${freeze}[v${i}]`
    const len = s.length.toFixed(3)
    const a = s.audio
      ? `[${audioIndex++}:a]aresample=44100,aformat=channel_layouts=mono,apad,atrim=duration=${len}[a${i}]`
      : `aevalsrc=0:s=44100:d=${len},aformat=channel_layouts=mono[a${i}]`
    return `${v};${a}`
  })
  const concat = `${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[v][a]`

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
