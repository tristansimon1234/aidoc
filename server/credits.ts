// Règles de prix — le seul endroit à modifier pour changer la tarification.

/** 1 crédit par tranche de 10 minutes de vidéo commencée. */
export const MINUTES_PER_CREDIT = 10

/** Au-delà, la vidéo est refusée : le traitement doit tenir dans la durée max d'une fonction Vercel (~13 min). */
export const MAX_VIDEO_MINUTES = 30

export function creditsFor(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds / (MINUTES_PER_CREDIT * 60)))
}

/** Offres Stripe. Le prix affiché vient de Stripe ; ici on fixe seulement les crédits accordés. */
export const OFFERS = {
  pack: { credits: 10, mode: 'payment' },
  monthly: { credits: 30, mode: 'subscription' },
} as const

export type OfferId = keyof typeof OFFERS
