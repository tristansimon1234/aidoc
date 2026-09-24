import type { VideoSteps } from './prompts.js'

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
