import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'

export function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <main className="narrow">
      <h1 className="logo big">Doclee</h1>
      <p className="lead">
        Filmez votre écran pendant que vous faites une tâche.
        <br />
        Recevez la procédure écrite, avec captures, et une vidéo commentée.
      </p>

      {sent ? (
        <p className="notice">Lien de connexion envoyé à {email}. Ouvrez votre boîte mail.</p>
      ) : (
        <form onSubmit={submit} className="stack">
          <input
            type="email"
            required
            placeholder="vous@entreprise.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="primary">Recevoir un lien de connexion</button>
          {error && <p className="error">{error}</p>}
          <p className="muted">Première vidéo offerte.</p>
        </form>
      )}
    </main>
  )
}
