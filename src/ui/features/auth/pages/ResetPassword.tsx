import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Field } from '../../../design-system/components/index.js'
import { useAuth } from '../../../shared/hooks/useAuth.js'
import styles from './Login.module.css'

/**
 * Step 2 of password reset: Supabase sets a recovery session when the user
 * lands here from the email link, so calling updateUser({password}) succeeds
 * without requiring the old password.
 */
export function ResetPassword(): React.ReactElement {
  const { updatePassword } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError("Passwords don't match."); return }
    setLoading(true); setError(null)
    const err = await updatePassword(password)
    setLoading(false)
    if (err) setError(err)
    else setDone(true)
  }

  if (done) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>aidoc</h1>
          <p className={styles.subtitle}>Password updated. You're signed in.</p>
          <Button onClick={() => navigate('/')}>Continue to app</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>aidoc</h1>
        <p className={styles.subtitle}>Choose a new password</p>
        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <Field
            label="new password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            required
          />
          <Field
            label="confirm password"
            type="password"
            placeholder="••••••••"
            value={confirm}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)}
            required
          />
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <Button type="submit" disabled={loading}>
              {loading ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </form>
        <p className={styles.toggle}>
          <Link to="/login" className={styles.toggleLink}>Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
