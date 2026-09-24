import { createClient } from '@supabase/supabase-js'

/**
 * Adresse de l'API quand elle n'est pas sur le même site : le service Railway en mode test sans Supabase.
 * `https://` est ajouté s'il manque (sinon le navigateur la prendrait pour un chemin du site).
 */
export const apiUrl = normalizeUrl(import.meta.env.VITE_API_URL as string | undefined)

function normalizeUrl(raw: string | undefined): string {
  const url = (raw ?? '').trim().replace(/\/+$/, '')
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

/**
 * Mode local, sans écran de connexion (le serveur accepte le jeton « local ») :
 * pas de Supabase configuré, ou API sur Railway en mode test (VITE_API_URL), même si
 * les variables Supabase sont présentes.
 */
export const isLocalMode = !import.meta.env.VITE_SUPABASE_URL || apiUrl !== ''

/** Pas d'écran de connexion : mode local, ou mode test (VITE_DISABLE_LOGIN=true, avec DISABLE_LOGIN côté serveur). */
export const loginDisabled = isLocalMode || import.meta.env.VITE_DISABLE_LOGIN === 'true'

/** Client Supabase, utilisé uniquement pour la connexion. Absent en mode local. */
export const supabase = isLocalMode
  ? null
  : createClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    )

export async function accessToken(): Promise<string> {
  if (!supabase || loginDisabled) return 'local'
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? ''
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}
