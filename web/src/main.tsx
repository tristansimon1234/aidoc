import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { api, type Me } from './api'
import { Login } from './pages/Login'
import { Home } from './pages/Home'
import { SopPage } from './pages/SopPage'
import { Credits } from './pages/Credits'
import './styles.css'

function App() {
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
    <>
      <header className="header">
        <Link to="/" className="logo">
          Doclee
        </Link>
        <nav>
          <Link to="/credits">{me ? `${me.credits} crédit${me.credits > 1 ? 's' : ''}` : '…'}</Link>
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Déconnexion
          </button>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home me={me} onChange={refreshMe} />} />
          <Route path="/sop/:id" element={<SopPage />} />
          <Route path="/credits" element={<Credits me={me} />} />
        </Routes>
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
