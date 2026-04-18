import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Field } from '../../../design-system/components/index.js'
import { useAuth } from '../../../shared/hooks/useAuth.js'
import styles from './Login.module.css'

/**
 * Step 1 of password reset: the user enters their email and Supabase sends a
 * recovery link (via the Resend SMTP configured in the dashboard). Clicking
 * the link lands on /auth/reset which finalises the new password.
 */
export function ForgotPassword(): React.ReactElement {
  const { requestPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true); setError(null)
    const err = await requestPasswordReset(email)
    setLoading(false)
    if (err) setError(err)
    else setSent(true)
  }

  if (sent) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>aidoc</h1>
          <p className={styles.subtitle}>Check your inbox — we sent a reset link to <strong>{email}</strong>.</p>
          <Link to="/login" className={styles.toggleLink}>Back to sign in</Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>aidoc</h1>
        <p className={styles.subtitle}>Reset your password</p>
        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <Field
            label="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            required
          />
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <Button type="submit" disabled={loading || !email}>
              {loading ? 'Sending…' : 'Send reset link'}
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
