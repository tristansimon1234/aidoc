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
 */
export function narrationSlots(
  steps: VideoSteps['steps'],
  duration: number,
): { start: number; seconds: number; action: string }[] {
  const MIN_SLOT = 4
  const slots: { start: number; end: number; action: string }[] = []
  steps.forEach((s, i) => {
    const start = i === 0 ? 0 : steps[i - 1]!.timestamp
    const end = i === steps.length - 1 ? duration : s.timestamp
    const last = slots[slots.length - 1]
    if (last && last.end - last.start < MIN_SLOT) {
      last.end = end
      last.action += ` Then: ${s.action}`
    } else {
      slots.push({ start, end, action: s.action })
    }
  })
  return slots.map((s) => ({
    start: s.start,
    seconds: Math.max(2, s.end - s.start),
    action: s.action,
  }))
}
