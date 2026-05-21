import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../design-system/components/index.js'
import { useAuth } from '../../shared/hooks/useAuth.js'
import styles from './Auth.module.css'

export function Signup(): React.ReactElement {
  const { signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const err = await signUp(email, password)
    setSubmitting(false)
    if (err) {
      setError(err)
      return
    }
    setDone(true)
    // The user has to confirm via email before useAuth flips to authed,
    // unless Supabase is in "confirm: false" mode in which case the
    // session is set immediately and App.tsx redirects to /dashboard.
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Link to="/" className={styles.brand}>SaaS Video</Link>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.muted}>1 free credit on signup — try a video before paying anything.</p>
        {done ? (
          <div className={styles.confirm}>
            <p>Check your inbox to confirm your email, then sign in.</p>
            <Link to="/login" className={styles.link}>Go to sign in</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className={styles.form}>
            <label className={styles.field}>
              <span className={styles.label}>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={styles.input}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className={styles.input}
              />
              <span className={styles.hint}>At least 8 characters.</span>
            </label>
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
        )}
        <p className={styles.foot}>
          Already have an account? <Link to="/login" className={styles.link}>Sign in</Link>
        </p>
      </div>
    </div>
  )
}
