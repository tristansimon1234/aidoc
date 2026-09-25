// Règles de prix — le seul endroit à modifier pour changer la tarification.

/** SOP : 1 crédit par tranche de 10 minutes de vidéo commencée. */
export const MINUTES_PER_CREDIT = 10

/** Vidéo marketing : nombre maximum de captures envoyées. */
export const MAX_SCREENSHOTS = 8

/** Au-delà, la vidéo est refusée (temps de traitement + limites Gemini). */
export const MAX_VIDEO_MINUTES = 60

/** Une vidéo marketing animée (30 ou 60 s) coûte un prix fixe, quelle que soit la durée de l'enregistrement. */
export const MARKETING_CREDITS = 2

export function creditsFor(durationSeconds: number, kind: 'sop' | 'marketing' = 'sop'): number {
  if (kind === 'marketing') return MARKETING_CREDITS
  return Math.max(1, Math.ceil(durationSeconds / (MINUTES_PER_CREDIT * 60)))
}

/** Offres Stripe. Le prix affiché vient de Stripe ; ici on fixe seulement les crédits accordés. */
export const OFFERS = {
  pack: { credits: 10, mode: 'payment' },
  monthly: { credits: 30, mode: 'subscription' },
} as const

export type OfferId = keyof typeof OFFERS
