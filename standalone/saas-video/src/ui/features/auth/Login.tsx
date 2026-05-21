import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../design-system/components/index.js'
import { useAuth } from '../../shared/hooks/useAuth.js'
import styles from './Auth.module.css'

export function Login(): React.ReactElement {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const err = await signIn(email, password)
    setSubmitting(false)
    if (err) setError(err)
    // Success leads to the authed App branch via the BrowserRouter; no
    // explicit navigation needed (the route table re-renders on the
    // useAuth state flip).
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Link to="/" className={styles.brand}>SaaS Video</Link>
        <h1 className={styles.title}>Sign in</h1>
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={styles.input}
            />
          </label>
          {error && <div className={styles.error}>{error}</div>}
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className={styles.foot}>
          No account? <Link to="/signup" className={styles.link}>Create one</Link>
        </p>
      </div>
    </div>
  )
}
