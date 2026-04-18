import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Spinner, Badge, Field, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type BillingSummaryDTO, type PlanDTO, type PlanId, type ProfileDTO, type TeamDTO, type TeamMemberDTO, type TeamRoleDTO, type TeamSeatInfoDTO } from '../../../shared/api/client.js'
import { Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import styles from './AccountSettings.module.css'

type AccountTab = 'profile' | 'billing' | 'team'

export function AccountSettings(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const initialTab: AccountTab = rawTab === 'billing' ? 'billing' : rawTab === 'team' ? 'team' : 'profile'
  const [activeTab, setActiveTab] = useState<AccountTab>(initialTab)
  const [profile, setProfile] = useState<ProfileDTO | null>(null)
  const [fullName, setFullName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.profile.get()
        setProfile(p)
        setFullName(p.fullName ?? '')
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const selectTab = (tab: AccountTab): void => {
    setActiveTab(tab)
    const next = new URLSearchParams(searchParams)
    if (tab === 'profile') next.delete('tab')
    else next.set('tab', tab)
    setSearchParams(next, { replace: true })
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await api.profile.update({
        fullName: fullName.trim() || null,
      })
      setProfile(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const tabs: { id: AccountTab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'billing', label: 'Plan & Billing' },
    { id: 'team', label: 'Team' },
  ]

  return (
    <Shell fullWidth>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Account</h1>
        </div>

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {loading ? (
            <div className={styles.loading}><Spinner size="md" /></div>
          ) : activeTab === 'profile' ? (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Profile</h2>
                <p className={styles.sectionDesc}>Your account details.</p>
              </div>
              <div className={styles.fieldGrid}>
                <div className={styles.field}>
                  <label className={styles.label}>Email</label>
                  <input className={styles.input} type="email" value={profile?.email ?? ''} readOnly />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Full name</label>
                  <input
                    className={styles.input}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
              </div>
              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
                {error && <span className={`${styles.saveMsg} ${styles.error}`}>{error}</span>}
              </div>
            </div>
          ) : activeTab === 'billing' ? (
            <BillingTab />
          ) : (
            <TeamTab />
          )}
        </div>
      </div>
    </Shell>
  )
}

function UsageBar({ label, percent }: { label: string; percent: number }): React.ReactElement {
  const clamped = Math.max(0, percent)
  const tone = clamped >= 100 ? 'over' : clamped >= 80 ? 'warn' : 'ok'
  return (
    <div className={styles.usage}>
      <div className={styles.usageHead}>
        <span className={styles.usageLabel}>{label}</span>
        <span className={styles.usageValue}>{clamped.toFixed(1)} %</span>
      </div>
      <div className={styles.usageTrack}>
        <div
          className={`${styles.usageFill} ${styles[`usageFill_${tone}`]}`}
          style={{ width: `${Math.min(clamped, 100)}%` }}
        />
      </div>
    </div>
  )
}

function formatPrice(plan: PlanDTO): string {
  if (plan.priceCents === 0) return 'Free'
  const amount = (plan.priceCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })
  const symbol = plan.currency === 'EUR' ? '€' : plan.currency
  return `${amount}${symbol}/mo`
}

function BillingTab(): React.ReactElement {
  const [summary, setSummary] = useState<BillingSummaryDTO | null>(null)
  const [plans, setPlans] = useState<PlanDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState<PlanId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([api.billing.summary(), api.billing.plans()])
        setSummary(s)
        setPlans(p)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const currentPlanId = summary?.plan.id ?? null

  const sortedPlans = useMemo(
    () => (plans ? [...plans].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [plans],
  )

  const handleSelect = async (planId: PlanId): Promise<void> => {
    if (planId === currentPlanId || selecting) return
    setSelecting(planId)
    setError(null)
    setMsg(null)
    try {
      // TODO(stripe): for paid plans, call POST /billing/checkout instead and
      // redirect to the Stripe Checkout Session URL. Free / downgrade stays here.
      const next = await api.billing.selectPlan(planId)
      setSummary(next)
      setMsg(`Switched to the ${next.plan.name} plan.`)
      setTimeout(() => setMsg(null), 3000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSelecting(null)
    }
  }

  if (loading) return <div className={styles.loading}><Spinner size="md" /></div>
  if (error && !summary) return <div className={styles.section}><p className={`${styles.saveMsg} ${styles.error}`}>{error}</p></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Current plan</h2>
          <p className={styles.sectionDesc}>
            You're on the <strong>{summary?.plan.name}</strong> plan.
            {summary?.plan.priceCents === 0
              ? ' Upgrade anytime to increase your monthly quotas.'
              : ' Usage is metered per calendar month.'}
          </p>
        </div>

        {summary && (
          <div className={styles.usageBlock}>
            <UsageBar label="Monthly usage" percent={summary.usage.percent} />
          </div>
        )}
      </div>

      <div className={styles.plansGrid}>
        {sortedPlans.map((plan) => {
          const isCurrent = plan.id === currentPlanId
          const isBusy = selecting === plan.id
          return (
            <div
              key={plan.id}
              className={`${styles.planCard} ${isCurrent ? styles.planCardCurrent : ''}`}
            >
              <div className={styles.planHeader}>
                <div>
                  <h3 className={styles.planName}>{plan.name}</h3>
                  <p className={styles.planPrice}>{formatPrice(plan)}</p>
                </div>
                {isCurrent && <Badge color="green">Current</Badge>}
              </div>

              <ul className={styles.planFeatures}>
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>

              <Button
                size="sm"
                variant={isCurrent ? 'ghost' : 'primary'}
                disabled={isCurrent || isBusy}
                onClick={() => void handleSelect(plan.id)}
              >
                {isCurrent
                  ? 'Active'
                  : isBusy
                    ? 'Updating...'
                    : plan.priceCents === 0
                      ? 'Switch to Free'
                      : 'Select'}
              </Button>
            </div>
          )
        })}
      </div>

      {(msg || error) && (
        <div className={styles.saveBar}>
          {msg && <span className={`${styles.saveMsg} ${styles.success}`}>{msg}</span>}
          {error && <span className={`${styles.saveMsg} ${styles.error}`}>{error}</span>}
        </div>
      )}

      <p className={styles.billingFootnote}>
        Stripe checkout is not wired yet — paid plan changes are applied
        immediately without payment. When Stripe is enabled, paid plans will
        redirect to a hosted checkout.
      </p>
    </div>
  )
}

// --- Team tab ---
// Single-workspace model: the user has one personal team, they invite
// collaborators here. No team creation / switching surface in the UI.
function TeamTab(): React.ReactElement {
  const { confirm, dialog } = useConfirmDialog()
  const [team, setTeam] = useState<TeamDTO | null>(null)
  const [members, setMembers] = useState<TeamMemberDTO[]>([])
  const [myRole, setMyRole] = useState<TeamRoleDTO>('member')
  const [seats, setSeats] = useState<TeamSeatInfoDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; emailSent: boolean } | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const list = await api.teams.list()
      // Single-workspace model: the personal team is the anchor.
      const personal = list.find((t) => t.team.personal) ?? list[0]
      if (!personal) { setError('No workspace found'); return }
      const data = await api.teams.get(personal.team.id)
      setTeam(data.team)
      setMembers(data.members)
      setMyRole(data.role)
      setSeats(data.seats)
    } catch (err) {
      setError((err as Error).message)
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const handleInvite = async (): Promise<void> => {
    if (!team || !inviteEmail.trim()) return
    setInviting(true); setInviteError(null); setInviteResult(null)
    try {
      const result = await api.teams.invite(team.id, inviteEmail.trim())
      setInviteResult({ acceptUrl: result.acceptUrl, emailSent: result.emailSent })
      setInviteEmail('')
      await load()
    } catch (err) {
      setInviteError((err as Error).message)
    } finally { setInviting(false) }
  }

  const handleRemove = async (member: TeamMemberDTO): Promise<void> => {
    if (!team) return
    const ok = await confirm({
      title: `Remove ${member.fullName ?? member.email ?? 'this member'}?`,
      message: 'They will lose access to every project in this workspace.',
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.teams.removeMember(team.id, member.userId)
      await load()
    } catch (err) { setError((err as Error).message) }
  }

  const copyLink = (url: string): void => { void navigator.clipboard.writeText(url) }

  if (loading) return <div className={styles.loading}><Spinner size="md" /></div>
  if (error || !team) return (
    <div className={styles.section}>
      <p className={`${styles.saveMsg} ${styles.error}`}>{error ?? 'Team not found'}</p>
    </div>
  )

  const isOwner = myRole === 'owner'

  return (
    <div className={styles.section}>
      {dialog}
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Team</h2>
        <p className={styles.sectionDesc}>
          Invite collaborators to <strong>{team.name}</strong>. Members share all your projects and usage quota.
        </p>
        {seats && (
          <p className={styles.sectionDesc} style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
            <strong>{seats.used}</strong> of <strong>{seats.max}</strong> seat{seats.max === 1 ? '' : 's'} used on the {seats.planName} plan
            {seats.used >= seats.max && (
              <> — <Link to="/account?tab=billing" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Upgrade →</Link></>
            )}
          </p>
        )}
      </div>

      {isOwner && (
        <div className={styles.field}>
          <label className={styles.label}>Invite by email</label>
          <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Field label="" type="email" placeholder="colleague@company.com"
                value={inviteEmail}
                disabled={seats ? !seats.allowed : false}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)} />
            </div>
            <Button size="sm" onClick={() => void handleInvite()}
              disabled={inviting || !inviteEmail.trim() || (seats ? !seats.allowed : false)}>
              {inviting ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
          {seats && !seats.allowed && (
            <span className={styles.sectionDesc} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
              Seat limit reached on the {seats.planName} plan. Upgrade to invite more members.
            </span>
          )}
          {inviteError && <span className={`${styles.saveMsg} ${styles.error}`}>{inviteError}</span>}
          {inviteResult && (
            <div style={{
              marginTop: 'var(--space-sm)',
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 'var(--text-xs)',
              lineHeight: 1.5,
              color: 'var(--color-muted-fg)',
            }}>
              <div>
                {inviteResult.emailSent
                  ? '✓ Email sent — they should check their inbox.'
                  : 'Email not sent (SMTP not configured yet). Share this link directly:'}
              </div>
              {!inviteResult.emailSent && (
                <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 6, alignItems: 'center' }}>
                  <code style={{ flex: 1, fontSize: 10, fontFamily: 'var(--font-mono)', wordBreak: 'break-all', background: 'var(--color-card)', padding: '4px 6px', borderRadius: 4 }}>
                    {inviteResult.acceptUrl}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => copyLink(inviteResult.acceptUrl)}>Copy</Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Members ({members.length})</label>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {members.map((m) => {
            const display = m.fullName ?? m.email ?? m.userId
            const initial = display.charAt(0).toUpperCase()
            return (
              <div key={m.userId} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                padding: 'var(--space-sm) 0',
                borderBottom: '1px solid var(--color-border)',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--color-primary)', color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 600, fontSize: 12,
                }}>{initial}</div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email}</span>
                </div>
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 999,
                  textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
                  background: m.role === 'owner' ? 'var(--color-accent)' : 'var(--color-secondary)',
                  color: m.role === 'owner' ? 'var(--color-primary)' : 'var(--color-muted-fg)',
                }}>{m.role}</span>
                {isOwner && m.role !== 'owner' && (
                  <Button size="sm" variant="ghost" onClick={() => void handleRemove(m)}>Remove</Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
