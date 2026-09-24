// Petites fonctions ffmpeg (binaire système, installé dans le Dockerfile).
import { spawn } from 'node:child_process'

function run(cmd: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} a échoué (${code}): ${err.slice(-800)}`)),
    )
  })
}

export async function durationOf(file: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ])
  const seconds = Number.parseFloat(out.trim())
  if (!Number.isFinite(seconds)) throw new Error(`Durée illisible pour ${file}`)
  return seconds
}

/** Ré-encode n'importe quelle vidéo (webm, mov…) en MP4 720p léger : lecture web + envoi à Gemini. */
export async function normalizeVideo(input: string, output: string): Promise<void> {
  await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output,
  ])
}

export async function hasAudio(file: string): Promise<boolean> {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0',
    file,
  ])
  return out.trim().length > 0
}

/** Monte la vidéo en ne gardant que les extraits `clips` (secondes), mis bout à bout. */
export async function cutVideo(
  input: string,
  clips: { start: number; end: number }[],
  output: string,
  keepAudio: boolean,
): Promise<void> {
  const audio = keepAudio && (await hasAudio(input))
  const parts = clips.map((c, i) => {
    const range = `start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)}`
    const v = `[0:v]trim=${range},setpts=PTS-STARTPTS[v${i}]`
    const a = `[0:a]atrim=${range},asetpts=PTS-STARTPTS[a${i}]`
    return audio ? `${v};${a}` : v
  })
  const inputs = clips.map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
  const concat = `${inputs}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}${audio ? '[v][a]' : '[v]'}`

  await run('ffmpeg', [
    '-y', '-i', input,
    '-filter_complex', `${parts.join(';')};${concat}`,
    '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ])
}

export async function extractFrame(video: string, seconds: number, output: string): Promise<void> {
  await run('ffmpeg', ['-y', '-ss', seconds.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', output])
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

  await run('ffmpeg', [
    '-y', '-i', video, ...inputs,
    '-filter_complex', `${delays};${mix};${pad}`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ])
}
