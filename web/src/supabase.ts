import { createClient } from '@supabase/supabase-js'

/** Sans VITE_SUPABASE_URL : mode local, pas d'écran de connexion (le serveur accepte le jeton « local »). */
export const isLocalMode = !import.meta.env.VITE_SUPABASE_URL

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
