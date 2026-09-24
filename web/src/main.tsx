import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { api, type Me } from './api'
import { Shell } from './ui/layout/Shell'
import { useTheme } from './ui/layout/useTheme'
import { Login } from './pages/Login'
import { Home } from './pages/Home'
import { SopPage } from './pages/SopPage'
import { Credits } from './pages/Credits'
import './ui/design-system/globals.css'

function App() {
  useTheme() // applique le thème mémorisé (clair / sombre) dès le chargement
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const refreshMe = () =>
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
  useEffect(() => {
    if (session) void refreshMe()
  }, [session])

  if (session === undefined) return null
  if (!session) return <Login />

  return (
    <Shell email={session.user.email ?? ''} credits={me?.credits ?? null}>
      <Routes>
        <Route path="/" element={<Home me={me} onChange={refreshMe} />} />
        <Route path="/sop/:id" element={<SopPage />} />
        <Route path="/credits" element={<Credits me={me} />} />
      </Routes>
    </Shell>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
