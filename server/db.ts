// Accès aux données : Supabase si SUPABASE_URL est défini, sinon le mode local (tests sur son poste).
// Le reste du code n'importe que ce fichier.
import { env } from './env.js'
import * as remote from './db.supabase.js'
import * as local from './db.local.js'

export type { Account, Sop, SopKind, SopPatch, SopStatus, Voice } from './db.types.js'

export const isLocalMode = !env.SUPABASE_URL || env.LOCAL_MODE

if (isLocalMode && process.env.VERCEL) {
  throw new Error(
    'SUPABASE_URL manquant : sans Supabase, l’API doit tourner sur Railway ou en local',
  )
}
if (isLocalMode)
  console.log('[db] Mode local : données dans .local-data/, pas de connexion requise')
else if (env.DISABLE_LOGIN)
  console.warn('[db] DISABLE_LOGIN : pas de connexion, compte de test partagé')

const impl: typeof remote = isLocalMode ? local : remote

/** Jeton envoyé par l'interface quand il n'y a pas de connexion (mode local ou mode test). */
const NO_LOGIN_TOKEN = 'local'

export async function userIdFromToken(token: string): Promise<string | null> {
  if (token === NO_LOGIN_TOKEN && (isLocalMode || env.DISABLE_LOGIN)) return impl.testUserId()
  return impl.userIdFromToken(token)
}

export const {
  userEmail,
  getAccount,
  setStripeCustomerId,
  findUserIdByStripeCustomer,
  applyCredits,
  createSop,
  listSops,
  getSop,
  updateSop,
  deleteSop,
  listProcessingSops,
  createUploadUrl,
  fileExists,
  uploadFile,
  downloadFile,
  publicUrl,
  sourceForFfmpeg,
  deleteFile,
  deleteFolder,
} = impl
