// Régénération : l'utilisateur corrige un résultat avec un retour écrit. Même prix qu'une création,
// remboursée si elle échoue (la version précédente est alors gardée, voir fail()).
import * as db from './db.js'
import { creditRef, creditsFor } from './credits.js'
import { dispatchSop } from './dispatch.js'
import { fail } from './pipeline/index.js'

export type RegenerateOutcome = { ok: true } | { ok: false; status: number; error: string }

export function regenerationCost(sop: db.Sop): number {
  return creditsFor(sop.durationSeconds ?? 0, sop.kind)
}

export async function regenerate(sop: db.Sop, feedback: string): Promise<RegenerateOutcome> {
  if (sop.status !== 'ready') {
    return { ok: false, status: 409, error: 'Wait until the current generation is finished.' }
  }
  // Créations faites avant la régénération : leurs fichiers d'origine ont été supprimés.
  if (!(await db.fileExists(sop.sourcePath))) {
    return {
      ok: false,
      status: 410,
      error: 'The original files are no longer available for this one. Please create a new one.',
    }
  }
  const next = { ...sop, revision: sop.revision + 1 }
  const cost = regenerationCost(sop)
  if (!(await db.applyCredits(sop.userId, -cost, 'sop', creditRef('sop', next)))) {
    return { ok: false, status: 402, error: `Not enough credits: regenerating needs ${cost}.` }
  }
  await db.updateSop(sop.id, {
    status: 'processing',
    progress: 'Queued',
    error: null,
    feedback,
    revision: next.revision,
    creditsUsed: cost,
  })
  try {
    await dispatchSop(sop.id)
  } catch (err) {
    console.error('[dispatch]', err)
    await fail(
      { ...next, feedback, creditsUsed: cost },
      'The video service is unavailable. Your credits were refunded.',
    )
    return {
      ok: false,
      status: 502,
      error: 'The video service is unavailable. Please try again in a moment.',
    }
  }
  return { ok: true }
}
