import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { api, setActiveTeamId, ApiError } from '../../../shared/api/client.js'
import { useAuth } from '../../../shared/hooks/useAuth.js'
import styles from '../../auth/pages/Login.module.css'

interface InvitePeek {
  teamName: string
  email: string
  inviterName: string | null
  expiresAt: string
  accepted: boolean
}

/**
 * Public route /invite/:token. The user lands here from the email:
 * - If not authenticated → show a CTA to sign in / sign up first.
 * - If authenticated → accept the invite and bounce to the projects list with
 *   the new team active.
 */
export function AcceptInvite(): React.ReactElement {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const [invite, setInvite] = useState<InvitePeek | null>(null)
  const [peekError, setPeekError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    void (async () => {
      try {
        const data = await api.invites.peek(token)
        setInvite(data)
      } catch (err) {
        setPeekError((err as Error).message)
      }
    })()
  }, [token])

  const handleAccept = async (): Promise<void> => {
    if (!token) return
    setAccepting(true); setAcceptError(null)
    try {
      const { teamId } = await api.teams.acceptInvite(token)
      setActiveTeamId(teamId)
      navigate('/')
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null
      if (code === 'EMAIL_MISMATCH') {
        setAcceptError(`This invite was sent to ${invite?.email}. Sign in with that email to accept.`)
      } else {
        setAcceptError((err as Error).message)
      }
      setAccepting(false)
    }
  }

  if (peekError) return <EmptyState title="Invitation invalid" description={peekError} />
  if (!invite) return <div className={styles.page}><Spinner size="lg" /></div>

  if (invite.accepted) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>doclee</h1>
          <p className={styles.subtitle}>This invitation has already been accepted.</p>
          <Link to="/" className={styles.toggleLink}>Go to doclee</Link>
        </div>
      </div>
    )
  }

  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>doclee</h1>
          <p className={styles.subtitle}>This invitation has expired. Ask {invite.inviterName ?? 'the team owner'} to resend it.</p>
        </div>
      </div>
    )
  }

  if (authLoading) return <div className={styles.page}><Spinner size="lg" /></div>

  // Not signed in: send them to login; preserve the invite path via returnTo.
  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.logo}>doclee</h1>
          <p className={styles.subtitle}>
            {invite.inviterName ?? 'Someone'} invited you to <strong>{invite.teamName}</strong>.
          </p>
          <p className={styles.subtitle} style={{ fontSize: 'var(--text-xs)' }}>
            Sign in or create an account with <strong>{invite.email}</strong> to accept.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => navigate(`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`)}>
              Continue
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Signed in — offer the accept button.
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.logo}>doclee</h1>
        <p className={styles.subtitle}>
          {invite.inviterName ?? 'Someone'} invited you to <strong>{invite.teamName}</strong>.
        </p>
        {acceptError && <p className={styles.error}>{acceptError}</p>}
        <div className={styles.actions}>
          <Button onClick={() => void handleAccept()} disabled={accepting}>
            {accepting ? 'Accepting…' : `Join ${invite.teamName}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
