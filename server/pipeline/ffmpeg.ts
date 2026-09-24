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

export async function extractFrame(video: string, seconds: number, output: string): Promise<void> {
  await run(['-y', '-ss', seconds.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', output])
}

/**
 * Remplace la bande son de la vidéo par la voix off.
 * Chaque segment audio est posé à son instant `start` (secondes).
 * Si la voix dépasse la fin, la dernière image est figée le temps nécessaire.
 */
export async function muxNarration(
  video: string,
  segments: { file: string; start: number }[],
  audioEnd: number,
  output: string,
): Promise<void> {
  const videoDuration = await durationOf(video)
  const freeze = Math.max(0, audioEnd - videoDuration + 0.5)

  const inputs = segments.flatMap((s) => ['-i', s.file])
  const delays = segments
    .map((s, i) => {
      const ms = Math.round(s.start * 1000)
      return `[${i + 1}:a]aresample=44100,adelay=${ms}|${ms}[a${i}]`
    })
    .join(';')
  const mix = `${segments.map((_, i) => `[a${i}]`).join('')}amix=inputs=${segments.length}:normalize=0[aout]`
  const pad = freeze > 0 ? `[0:v]tpad=stop_mode=clone:stop_duration=${freeze.toFixed(2)}[vout]` : '[0:v]null[vout]'

  await run([
    '-y', '-i', video, ...inputs,
    '-filter_complex', `${delays};${mix};${pad}`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ])
}
