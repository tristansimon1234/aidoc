import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Field } from '../../../design-system/components/index.js'
import styles from './Login.module.css'

interface LoginProps {
  onSignIn: (email: string, password: string) => Promise<string | null>
  onSignUp: (email: string, password: string, emailRedirectTo?: string) => Promise<string | null>
}

/** Only accept same-origin app paths for returnTo — prevents open-redirect. */
function sanitizeReturnTo(raw: string | null): string {
  if (!raw) return '/'
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  return '/'
}

export function Login({ onSignIn, onSignUp }: LoginProps): React.ReactElement {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'))
  // Honor `?mode=signup` / `?mode=signin` so callers (notably the invite
  // accept page) can deep-link straight to the right pane instead of
  // dumping every visitor on Sign In and asking them to toggle.
  const initialMode = searchParams.get('mode') === 'signup'
  // When the user lands here from an invite link, the email is in the
  // URL — prefill so they don't have to retype the address the invite
  // was sent to (which is the only one that will be accepted).
  const initialEmail = (searchParams.get('email') ?? '').trim()

  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(initialMode)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [signUpSuccess, setSignUpSuccess] = useState(false)
  const [signedUpEmail, setSignedUpEmail] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (isSignUp && password !== confirmPassword) {
      setError("Passwords don't match.")
      return
    }
    setLoading(true)

    // For sign-up, pass the returnTo so the Supabase confirmation email
    // redirects the user back to the invite acceptance page (or wherever they
    // came from) instead of dropping them on the homepage with no context.
    const emailRedirectTo = returnTo !== '/' ? `${window.location.origin}${returnTo}` : undefined
    const result = isSignUp
      ? await onSignUp(email, password, emailRedirectTo)
      : await onSignIn(email, password)

    setLoading(false)
    if (result) { setError(result); return }
    if (isSignUp) { setSignedUpEmail(email); setSignUpSuccess(true); return }
    // Sign-in succeeded — jump back to where the user was going. React Router
    // picks up the navigate() once the auth state flips in App.tsx and the
    // authenticated route tree mounts.
    navigate(returnTo, { replace: true })
  }

  if (signUpSuccess) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>
            <img
              src="https://xpcacqvwnfdkvmqbeeqp.supabase.co/storage/v1/object/public/website/playd-lockup-transparent%20(1).png"
              alt="doclee"
              className={styles.logoImg}
            />
          </h1>
          <p className={styles.subtitle} style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>
            Verify your email
          </p>
          <p className={styles.subtitle}>
            We sent a confirmation link to {signedUpEmail ? <strong>{signedUpEmail}</strong> : 'your inbox'}.
            Click it to activate your account, then come back here to continue.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>
          <img
            src="https://xpcacqvwnfdkvmqbeeqp.supabase.co/storage/v1/object/public/website/playd-lockup-transparent%20(1).png"
            alt="doclee"
            className={styles.logoImg}
          />
        </h1>
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

          {isSignUp && (
            <Field
              label="confirm password"
              type="password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
              required
            />
          )}

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <Button type="submit" disabled={loading}>
              {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
            </Button>
          </div>
        </form>

        {!isSignUp && (
          <p className={styles.toggle}>
            <Link to="/auth/forgot" className={styles.toggleLink}>Forgot your password?</Link>
          </p>
        )}

        <p className={styles.toggle}>
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            className={styles.toggleLink}
            type="button"
            onClick={() => { setIsSignUp(!isSignUp); setError(null); setConfirmPassword('') }}
          >
            {isSignUp ? 'Sign In' : 'Sign Up'}
          </button>
        </p>
      </div>
    </div>
  )
}
