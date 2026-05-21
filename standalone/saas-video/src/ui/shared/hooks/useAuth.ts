import { useState, useEffect, useCallback } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '../api/supabase.js'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signUp: (email: string, password: string, emailRedirectTo?: string) => Promise<string | null>
  signOut: () => Promise<void>
  /** Send the Supabase password-reset email. Supabase handles the email
   *  delivery via the SMTP configured in the dashboard (Resend in prod). */
  requestPasswordReset: (email: string) => Promise<string | null>
  /** Update the password on the recovery session set by Supabase when the
   *  user clicks the email link. */
  updatePassword: (password: string) => Promise<string | null>
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? error.message : null
  }, [])

  const signUp = useCallback(async (email: string, password: string, emailRedirectTo?: string): Promise<string | null> => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    })
    return error ? error.message : null
  }, [])

  const signOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut()
  }, [])

  const requestPasswordReset = useCallback(async (email: string): Promise<string | null> => {
    const redirectTo = `${window.location.origin}/auth/reset`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    return error ? error.message : null
  }, [])

  const updatePassword = useCallback(async (password: string): Promise<string | null> => {
    const { error } = await supabase.auth.updateUser({ password })
    return error ? error.message : null
  }, [])

  return { user, session, loading, signIn, signUp, signOut, requestPasswordReset, updatePassword }
}
