import { parseTimecode, type VideoSteps, type VideoStepsAnswer } from './prompts.js'

/** « 104 » → 64 (1:04), ou null si le nombre ne peut pas être des minutes-secondes collées. */
function asMinuteSeconds(seconds: number): number | null {
  if (seconds < 100) return null
  const minutes = Math.floor(seconds / 100)
  const rest = seconds - minutes * 100
  return rest < 60 ? minutes * 60 + rest : null
}

/**
 * Temps donnés en nombres au-delà de la fin de la vidéo qui ressemblent à des minutes-secondes collées
 * (« 110 » pour 1:10) : Gemini a écrit toute la liste ainsi après la première minute, donc on la relit
 * en entier (« 104 » = 1:04 aussi, même s'il tient dans la vidéo). Sinon la liste est laissée telle
 * quelle. Jamais appliqué aux temps écrits « MM:SS », qui sont sans ambiguïté.
 */
export function repairTimecodes(values: number[], duration: number): number[] {
  const tooLate = values.filter((v) => v > duration + 1)
  const repairable = tooLate.some((v) => {
    const fixed = asMinuteSeconds(v)
    return fixed !== null && fixed <= duration + 1
  })
  if (!repairable) return values
  return values.map((v) => {
    const fixed = asMinuteSeconds(v)
    return fixed !== null && fixed <= duration + 1 ? fixed : v
  })
}

/**
 * Convertit les temps de Gemini en secondes : « MM:SS » tel quel (un léger dépassement de la fin est
 * juste borné ensuite), les nombres avec la réparation des minutes-secondes collées. NaN si illisible.
 */
export function resolveTimes(values: (number | string)[], duration: number): number[] {
  const numbers = values.flatMap((v, i) => (typeof v === 'number' ? [i] : []))
  const repaired = repairTimecodes(
    numbers.map((i) => values[i] as number),
    duration,
  )
  const out = values.map((v) => (typeof v === 'string' ? parseTimecode(v) : v))
  numbers.forEach((i, k) => (out[i] = repaired[k]!))
  return out
}

/** Réponse de Gemini → analyse en secondes ; les entrées au temps illisible sont écartées. */
export function toVideoSteps(answer: VideoStepsAnswer, duration: number): VideoSteps {
  const starts = resolveTimes(
    answer.transcript.map((t) => t.start),
    duration,
  )
  const times = resolveTimes(
    answer.steps.map((s) => s.timestamp),
    duration,
  )
  return {
    title: answer.title,
    purpose: answer.purpose,
    keyPoints: answer.keyPoints,
    transcript: answer.transcript
      .map((t, i) => ({ start: starts[i]!, text: t.text }))
      .filter((t) => Number.isFinite(t.start)),
    steps: answer.steps
      .map((s, i) => ({ ...s, timestamp: times[i]! }))
      .filter((s) => Number.isFinite(s.timestamp)),
  }
}

/** Trie, borne les horodatages à la vidéo, et évite qu'une capture montre déjà l'étape suivante. */
export function cleanSteps(steps: VideoSteps['steps'], duration: number): VideoSteps['steps'] {
  const sorted = steps
    .map((s) => ({
      ...s,
      timestamp: Math.min(Math.max(0, s.timestamp), Math.max(0, duration - 0.2)),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  for (let i = 0; i < sorted.length - 1; i++) {
    const ceiling = Math.max(0, sorted[i + 1]!.timestamp - 0.5)
    if (sorted[i]!.timestamp > ceiling) sorted[i]!.timestamp = ceiling
  }
  return sorted
}

/**
 * Passages de la vidéo sans aucune étape pendant plus de `minGap` secondes (y compris avant la première
 * et après la dernière). Sur les longues vidéos, Gemini s'arrête parfois de lister les étapes avant la
 * fin : ces passages sont ré-analysés. Les 4 plus longs au maximum, dans l'ordre de la vidéo.
 */
export function uncoveredRanges(
  steps: VideoSteps['steps'],
  duration: number,
  minGap = 45,
): { start: number; end: number }[] {
  const points = [0, ...steps.map((s) => s.timestamp), duration]
  const gaps: { start: number; end: number }[] = []
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1]! - points[i]! > minGap) gaps.push({ start: points[i]!, end: points[i + 1]! })
  }
  return gaps
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 4)
    .sort((a, b) => a.start - b.start)
}

/**
 * Rattache à chaque étape ce que la personne dit entre l'étape précédente et elle (la transcription
 * horodatée, plus fiable que le champ « spoken » que Gemini remplit de moins en moins vers la fin
 * d'une longue réponse). Ce qui est dit après la dernière étape (la conclusion) va à la dernière.
 */
export function attachTranscript(
  steps: VideoSteps['steps'],
  transcript: VideoSteps['transcript'],
): VideoSteps['steps'] {
  return steps.map((s, i) => {
    const from = i === 0 ? -Infinity : steps[i - 1]!.timestamp
    const to = i === steps.length - 1 ? Infinity : s.timestamp
    const said = transcript
      .filter((t) => t.start >= from && t.start < to)
      .map((t) => t.text.trim())
      .join(' ')
    return { ...s, spoken: said || s.spoken }
  })
}

/**
 * Découpe la vidéo en créneaux de voix off : l'étape i est racontée entre la capture i-1 et la capture i
 * (on annonce l'action juste avant qu'elle se produise). Les créneaux trop courts sont fusionnés.
 * Chaque créneau emporte ce que la personne a dit pendant ces étapes, pour que la voix off le reprenne.
 */
export function narrationSlots(
  steps: VideoSteps['steps'],
  duration: number,
): { start: number; seconds: number; action: string; spoken: string }[] {
  const MIN_SLOT = 4
  const slots: { start: number; end: number; action: string; spoken: string }[] = []
  steps.forEach((s, i) => {
    const start = i === 0 ? 0 : steps[i - 1]!.timestamp
    const end = i === steps.length - 1 ? duration : s.timestamp
    const last = slots[slots.length - 1]
    if (last && last.end - last.start < MIN_SLOT) {
      last.end = end
      last.action += ` Then: ${s.action}`
      if (s.spoken) last.spoken = [last.spoken, s.spoken].filter(Boolean).join(' ')
    } else {
      slots.push({ start, end, action: s.action, spoken: s.spoken ?? '' })
    }
  })
  return slots.map((s) => ({
    start: s.start,
    seconds: Math.max(2, s.end - s.start),
    action: s.action,
    spoken: s.spoken,
  }))
}

/** Durée maximale de la vidéo SOP livrée. */
export const MAX_SOP_VIDEO_SECONDS = 240

export interface Clip {
  start: number
  end: number
}

/**
 * Plan de montage pour tenir en {@link MAX_SOP_VIDEO_SECONDS} : on garde un extrait autour de chaque
 * étape (surtout ce qui précède la capture : c'est là que l'action a lieu) et on coupe le reste.
 * Renvoie les extraits à garder et les étapes repositionnées sur la vidéo montée.
 */
export function planEdit(
  steps: VideoSteps['steps'],
  duration: number,
  max = MAX_SOP_VIDEO_SECONDS,
): { clips: Clip[]; steps: VideoSteps['steps']; duration: number } {
  if (duration <= max || steps.length === 0) {
    return { clips: [{ start: 0, end: duration }], steps, duration }
  }

  // Temps accordé à chaque étape : entre 2 s et 20 s, et jamais plus que max / nombre d'étapes.
  const perStep = Math.max(2, Math.min(20, max / steps.length))
  const windows = steps.map((s) => ({
    start: Math.max(0, s.timestamp - perStep * 0.7),
    end: Math.min(duration, s.timestamp + perStep * 0.3),
  }))

  // Fusionne les extraits qui se chevauchent ou se touchent presque.
  const clips: Clip[] = []
  for (const w of windows) {
    const last = clips[clips.length - 1]
    if (last && w.start <= last.end + 0.5) last.end = Math.max(last.end, w.end)
    else clips.push({ ...w })
  }

  // Bornes calées sur les images de la vidéo (15 / s), pour que le montage ne dérive pas.
  for (const c of clips) {
    c.start = Math.round(c.start * 15) / 15
    c.end = Math.round(c.end * 15) / 15
  }

  // Filet de sécurité (plus de 120 étapes) : on coupe ce qui dépasse.
  let total = 0
  const kept: Clip[] = []
  for (const c of clips) {
    if (total >= max) break
    const end = Math.min(c.end, c.start + (max - total))
    kept.push({ start: c.start, end })
    total += end - c.start
  }

  // Position de chaque étape sur la vidéo montée ; celles coupées par le filet de sécurité disparaissent.
  const remapped: VideoSteps['steps'] = []
  for (const s of steps) {
    let offset = 0
    for (const c of kept) {
      if (s.timestamp >= c.start && s.timestamp <= c.end) {
        remapped.push({ ...s, timestamp: offset + (s.timestamp - c.start) })
        break
      }
      offset += c.end - c.start
    }
  }
  return { clips: kept, steps: remapped, duration: total }
}

/**
 * Fenêtre où l'écran de l'étape est affiché : APRÈS l'action (le temps que la page s'ouvre), jusqu'à
 * juste avant l'étape suivante. La capture montre l'écran dont parle l'étape, pas le bouton qui y mène.
 */
function resultWindow(
  steps: VideoSteps['steps'],
  i: number,
  duration: number,
): { t: number; from: number; to: number } {
  const t = steps[i]!.timestamp
  const lo = i > 0 ? steps[i - 1]!.timestamp + 0.3 : 0
  const to = Math.max(
    lo,
    i < steps.length - 1 ? steps[i + 1]!.timestamp - 0.3 : Math.max(0, duration - 0.2),
  )
  return { t, from: Math.min(Math.max(t + 0.8, lo), to), to }
}

const round = (v: number) => Math.round(v * 10) / 10

/**
 * Moments candidats pour la capture d'une étape, tous pris après l'action et avant l'étape suivante ;
 * Gemini choisit celui où l'écran est le mieux affiché. Si l'étape suivante arrive presque aussitôt,
 * l'instant de l'action est gardé en plus.
 */
export function candidateTimes(steps: VideoSteps['steps'], i: number, duration: number): number[] {
  const { t, from, to } = resultWindow(steps, i, duration)
  const span = to - from
  const times = span < 0.8 ? [t, from, to] : [0, 0.25, 0.5, 0.75, 1].map((k) => from + span * k)
  return [...new Set(times.map(round))].sort((a, b) => a - b)
}

/** Capture par défaut (si Gemini n'a pas choisi) : un peu après l'action, l'écran s'étant affiché. */
export function defaultShotTime(steps: VideoSteps['steps'], i: number, duration: number): number {
  const { t, from, to } = resultWindow(steps, i, duration)
  return to - from < 0.8 ? t : round(Math.min(from + 1, to))
}

/**
 * Applique les moments choisis pour les captures en gardant les étapes dans l'ordre :
 * si un choix passe avant l'étape précédente, l'étape garde son horodatage d'origine.
 */
export function applyPickedTimes(
  steps: VideoSteps['steps'],
  picked: (number | null)[],
): VideoSteps['steps'] {
  const out: VideoSteps['steps'] = []
  steps.forEach((s, i) => {
    const prev = out[i - 1]
    const wanted = picked[i] ?? s.timestamp
    const timestamp = prev && wanted <= prev.timestamp ? s.timestamp : wanted
    out.push({ ...s, timestamp })
  })
  return out
}

/**
 * Cale un passage de vidéo sur sa phrase de voix off. La vidéo garde sa vitesse réelle, pour que la voix
 * corresponde toujours à ce qui est à l'écran. Voix plus courte : le passage continue sans voix. Voix
 * plus longue : on l'accélère un peu (×1,1 max, inaudible), puis on fige la dernière image le temps
 * qu'elle finisse.
 */
export function fitSegment(
  slotSeconds: number,
  audioSeconds: number,
): { factor: number; freeze: number; length: number; tempo: number } {
  const BREATH = 0.4 // petite respiration après chaque phrase
  const needed = audioSeconds > 0 ? audioSeconds + BREATH : 0
  const tempo = needed > slotSeconds ? Math.min(1.1, needed / slotSeconds) : 1
  const freeze = Math.max(0, (audioSeconds > 0 ? audioSeconds / tempo + BREATH : 0) - slotSeconds)
  return { factor: 1, freeze, length: slotSeconds + freeze, tempo }
}

/** Vitesse réelle de la voix (mots / seconde), mesurée sur les phrases synthétisées. */
export function speakingRate(voices: ({ text: string; seconds: number } | null)[]): number {
  let words = 0
  let seconds = 0
  for (const v of voices) {
    if (!v || v.seconds < 0.5) continue
    words += v.text.trim().split(/\s+/).length
    seconds += v.seconds
  }
  return seconds >= 5 ? Math.min(4, Math.max(1.5, words / seconds)) : 2.5
}

/** Mots visés pour un passage : la voix finit ~1 s avant la fin (jusqu'à 2 s de silence, c'est bien). */
export function wordsFor(slotSeconds: number, rate: number): number {
  return Math.max(3, Math.round((slotSeconds - 1.2) * rate))
}

/** Écart entre une voix et son passage : 0 si elle finit entre 0,4 s et 2,5 s avant la fin. */
export function misfit(slotSeconds: number, audioSeconds: number): number {
  const silence = slotSeconds - audioSeconds
  if (silence < 0.4) return (0.4 - silence) * 3 // déborder est pire que se taire
  return Math.max(0, silence - 2.5)
}

/** Coupe un texte trop long à la dernière phrase complète sous la limite de mots. */
export function limitWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text.trim()
  const cut = words.slice(0, maxWords).join(' ')
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (end > cut.length * 0.25) return cut.slice(0, end + 1)
  return `${cut.replace(/[,;:]$/, '')}.`
}

/** Comme Promise.all(items.map(fn)), mais `limit` appels à la fois au maximum. */
export async function mapLimit<T, R>(
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

/**
 * Sous-titres mot à mot : la durée de chaque phrase est répartie entre ses mots selon leur longueur
 * (une approximation suffisante tant que la synthèse vocale ne donne pas l'horodatage des mots).
 */
export function captionWords(
  lines: { text: string; startMs: number; durationMs: number }[],
): { text: string; startMs: number; endMs: number }[] {
  return lines.flatMap((line) => {
    const words = line.text.trim().split(/\s+/).filter(Boolean)
    const weights = words.map((w) => w.length + 2)
    const total = weights.reduce((a, b) => a + b, 0)
    let t = line.startMs
    return words.map((text, i) => {
      const length = (line.durationMs * weights[i]!) / total
      const word = { text, startMs: Math.round(t), endMs: Math.round(t + length) }
      t += length
      return word
    })
  })
}

/** Luminance relative d'une couleur hex (0 = noir, 1 = blanc). */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
