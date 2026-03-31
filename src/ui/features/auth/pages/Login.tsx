import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Button, Field } from '../../../design-system/components/index.js'
import styles from './Login.module.css'

interface LoginProps {
  onSignIn: (email: string, password: string) => Promise<string | null>
  onSignUp: (email: string, password: string) => Promise<string | null>
}

export function Login({ onSignIn, onSignUp }: LoginProps): React.ReactElement {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [signUpSuccess, setSignUpSuccess] = useState(false)

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const result = isSignUp
      ? await onSignUp(email, password)
      : await onSignIn(email, password)

    if (result) {
      setError(result)
    } else if (isSignUp) {
      setSignUpSuccess(true)
    }

    setLoading(false)
  }

  if (signUpSuccess) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>aidoc</h1>
          <p className={styles.subtitle}>
            Check your email to confirm your account, then sign in.
          </p>
          <Button onClick={() => { setSignUpSuccess(false); setIsSignUp(false) }}>
            Back to Sign In
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>aidoc</h1>
        <p style={{ textAlign: 'center', color: 'var(--color-accent-blue)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-xs)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          AI-powered product documentation
        </p>
        <p className={styles.subtitle}>
          {isSignUp ? 'Create your account' : 'Sign in to continue'}
        </p>

        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <Field
            label="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            required
          />

          <Field
            label="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            required
          />

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <Button type="submit" disabled={loading}>
              {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
            </Button>
          </div>
        </form>

        <p className={styles.toggle}>
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            className={styles.toggleLink}
            type="button"
            onClick={() => { setIsSignUp(!isSignUp); setError(null) }}
          >
            {isSignUp ? 'Sign In' : 'Sign Up'}
          </button>
        </p>
      </div>
    </div>
  )
}
