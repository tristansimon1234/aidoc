import { useState, type ChangeEvent, type FormEvent } from 'react'
import { Button, Field } from '../ui/design-system/components'
import { supabase } from '../supabase'
import styles from './Login.module.css'

/** Connexion sans mot de passe : un lien magique par email (crée le compte au premier passage). */
export function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>
          <span className={styles.logoMark}>d</span>doclee
        </h1>
        <p className={styles.tagline}>Vidéo → procédure</p>
        <p className={styles.subtitle}>
          Filmez votre écran pendant une tâche. Recevez la procédure écrite avec captures et une
          vidéo commentée.
        </p>

        {sent ? (
          <p className={styles.sent}>
            Lien de connexion envoyé à <strong>{email}</strong>.<br />
            Ouvrez votre boîte mail (et vos spams).
          </p>
        ) : (
          <form className={styles.form} onSubmit={(e) => void submit(e)}>
            <Field
              label="Email"
              type="email"
              placeholder="vous@entreprise.com"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              required
            />
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.actions}>
              <Button type="submit" disabled={loading}>
                {loading ? 'Envoi…' : 'Recevoir un lien de connexion'}
              </Button>
            </div>
            <p className={styles.toggle}>Première vidéo offerte.</p>
          </form>
        )}
      </div>
    </div>
  )
}
