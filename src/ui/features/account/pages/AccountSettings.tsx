import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Spinner, Field, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type BillingSummaryDTO, type McpScopeDTO, type McpTokenSummaryDTO, type McpTokenCreatedDTO, type ProfileDTO, type TeamDTO, type TeamMemberDTO, type TeamRoleDTO, type TeamSeatInfoDTO, type TeamInviteDTO, getActiveTeamId, setActiveTeamId } from '../../../shared/api/client.js'
import { Link } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import styles from './AccountSettings.module.css'

type AccountTab = 'profile' | 'billing' | 'team' | 'mcp'

export function AccountSettings(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const initialTab: AccountTab =
    rawTab === 'billing' ? 'billing'
    : rawTab === 'team' ? 'team'
    : rawTab === 'mcp' ? 'mcp'
    : 'profile'
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
    { id: 'mcp', label: 'MCP Tokens' },
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
          ) : activeTab === 'team' ? (
            <TeamTab />
          ) : (
            <McpTokensTab />
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

function BillingTab(): React.ReactElement {
  // Plans grid + plan-switching are hidden during the design-partner
  // phase — we only need the current-plan summary + monthly usage bar.
  // To restore: re-add the `plans` state + the api.billing.plans() call,
  // sortedPlans memo, handleSelect handler, and the JSX block that was
  // removed below.
  const [summary, setSummary] = useState<BillingSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.billing.summary()
        setSummary(s)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) return <div className={styles.loading}><Spinner size="md" /></div>
  if (error && !summary) return <div className={styles.section}><p className={`${styles.saveMsg} ${styles.error}`}>{error}</p></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Current plan</h2>
          <p className={styles.sectionDesc}>
            {summary && <><strong>{summary.team.name}</strong>{summary.team.personal ? ' (personal workspace)' : ''} is on the <strong>{summary.plan.name}</strong> plan.</>}
            {summary?.plan.priceCents === 0
              ? ' Upgrade anytime to increase this workspace\'s monthly quota.'
              : ' Usage is metered per calendar month, per workspace.'}
          </p>
        </div>

        {summary && (
          <div className={styles.usageBlock}>
            <UsageBar label="Monthly usage" percent={summary.usage.percent} />
          </div>
        )}
      </div>

      {/* Pricing grid + Stripe footnote intentionally hidden during the
       *  design-partner phase — prices aren't finalized and the upgrade
       *  flow isn't billable yet, so showing them would mislead. To
       *  re-enable, restore the <div className={styles.plansGrid}>...</div>
       *  block and the trailing "Stripe checkout is not wired yet" <p>. */}

      {(msg || error) && (
        <div className={styles.saveBar}>
          {msg && <span className={`${styles.saveMsg} ${styles.success}`}>{msg}</span>}
          {error && <span className={`${styles.saveMsg} ${styles.error}`}>{error}</span>}
        </div>
      )}
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
  const [pendingInvites, setPendingInvites] = useState<TeamInviteDTO[]>([])
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
      // Single-workspace model: default to the personal team unless the user
      // explicitly opted into another one (invite accept flow sets activeId).
      // This protects against leftover non-personal teams from earlier
      // iterations accidentally winning the default selection.
      const activeId = getActiveTeamId()
      const pick = list.find((t) => t.team.id === activeId)
        ?? list.find((t) => t.team.personal)
        ?? list[0]
      if (!pick) { setError('No workspace found'); return }
      // Lock in the choice so sibling API calls (billing summary, etc.)
      // attach the same X-Team-Id header.
      setActiveTeamId(pick.team.id)
      const data = await api.teams.get(pick.team.id)
      setTeam(data.team)
      setMembers(data.members)
      setMyRole(data.role)
      setSeats(data.seats)
      setPendingInvites(data.pendingInvites)
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

  const handleCancelInvite = async (invite: TeamInviteDTO): Promise<void> => {
    if (!team) return
    const ok = await confirm({
      title: `Cancel invite to ${invite.email}?`,
      message: 'The invitation link will no longer work.',
      confirmLabel: 'Cancel invite',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.teams.cancelInvite(team.id, invite.id)
      await load()
    } catch (err) { setError((err as Error).message) }
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

      {pendingInvites.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label}>Pending invitations ({pendingInvites.length})</label>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {pendingInvites.map((inv) => {
              const expiresIn = Math.max(0, Math.ceil((new Date(inv.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
              return (
                <div key={inv.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  padding: 'var(--space-sm) 0',
                  borderBottom: '1px solid var(--color-border)',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: 'var(--color-secondary)', color: 'var(--color-muted-fg)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600, fontSize: 14,
                  }}>?</div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.email}</span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
                      Expires in {expiresIn} day{expiresIn === 1 ? '' : 's'}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 999,
                    textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
                    background: 'var(--color-status-pending-bg, var(--color-secondary))',
                    color: 'var(--color-warning, var(--color-muted-fg))',
                  }}>Invited</span>
                  {isOwner && (
                    <Button size="sm" variant="ghost" onClick={() => void handleCancelInvite(inv)}>Cancel</Button>
                  )}
                </div>
              )
            })}
          </div>
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

// --- MCP tokens tab ---
// Personal access tokens for the MCP server, scoped to a single workspace.
// Each token authenticates as (user, workspace) and lets the holder manage
// projects / pages via Claude Desktop, Claude Code, or any MCP client.
function McpTokensTab(): React.ReactElement {
  const { confirm, dialog } = useConfirmDialog()
  const [tokens, setTokens] = useState<McpTokenSummaryDTO[]>([])
  const [teams, setTeams] = useState<{ team: TeamDTO; role: TeamRoleDTO }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [teamId, setTeamId] = useState<string>('')
  const [scope, setScope] = useState<McpScopeDTO>('admin')
  const [expiryChoice, setExpiryChoice] = useState<'never' | '30' | '90' | '365'>('never')
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState<McpTokenCreatedDTO | null>(null)
  const [copied, setCopied] = useState<'token' | 'url' | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [rotatingId, setRotatingId] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true); setError(null)
    try {
      const [t, teamList] = await Promise.all([api.mcpTokens.list(), api.teams.list()])
      setTokens(t)
      setTeams(teamList)
      if (!teamId) {
        const personal = teamList.find((x) => x.team.personal) ?? teamList[0]
        if (personal) setTeamId(personal.team.id)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || !teamId) return
    setCreating(true); setError(null)
    try {
      const expiresInDays = expiryChoice === 'never' ? undefined : Number(expiryChoice)
      const created = await api.mcpTokens.create({
        name: name.trim(),
        teamId,
        scope,
        ...(expiresInDays ? { expiresInDays } : {}),
      })
      setJustCreated(created)
      setName('')
      setCopied(null)
      setRevealed(false)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const handleRotate = async (t: McpTokenSummaryDTO): Promise<void> => {
    const ok = await confirm({
      title: `Rotate "${t.name}"?`,
      message:
        'A new token will be generated with the same scope and expiry. The current one keeps working for 24 hours so a session in flight isn\'t cut mid-call. After that, it stops working.',
      confirmLabel: 'Rotate',
      variant: 'primary',
    })
    if (!ok) return
    setRotatingId(t.id)
    try {
      const rotated = await api.mcpTokens.rotate(t.id)
      setJustCreated(rotated)
      setCopied(null)
      setRevealed(false)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRotatingId(null)
    }
  }

  const handleRevoke = async (t: McpTokenSummaryDTO): Promise<void> => {
    const ok = await confirm({
      title: `Revoke "${t.name}"?`,
      message: 'Any MCP client using this token will stop working immediately. This cannot be undone.',
      confirmLabel: 'Revoke',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.mcpTokens.revoke(t.id)
      if (justCreated?.id === t.id) setJustCreated(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const copyValue = (value: string, which: 'token' | 'url'): void => {
    void navigator.clipboard.writeText(value)
    setCopied(which)
    setTimeout(() => setCopied(null), 2000)
  }

  const maskToken = (full: string): string => {
    const prefix = 'aidoc_usr_'
    const tail = full.slice(-4)
    return `${prefix}${'•'.repeat(20)}${tail}`
  }

  const teamName = (id: string): string =>
    teams.find((t) => t.team.id === id)?.team.name ?? 'Unknown workspace'

  const mcpUrl = justCreated
    ? `${window.location.origin}/api/mcp-user/${justCreated.token}`
    : null

  const maskedMcpUrl = justCreated
    ? `${window.location.origin}/api/mcp-user/${maskToken(justCreated.token)}`
    : null

  if (loading) return <div className={styles.loading}><Spinner size="md" /></div>

  const activeTokens = tokens.filter((t) => !t.revokedAt)
  const endpointPattern = `${window.location.origin}/api/mcp-user/<YOUR_TOKEN>`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      {dialog}

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>MCP Tokens</h2>
          <p className={styles.sectionDesc}>
            Create a personal access token to connect an MCP client (Claude Desktop, Claude Code, …) to one of your workspaces.
            Each token authenticates as you and is scoped to a single workspace — it can list, create, and edit projects and pages in that workspace only.
          </p>
        </div>

        <div style={{
          marginBottom: 'var(--space-md)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <label className={styles.label}>MCP endpoint</label>
          <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
            <code style={{
              flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all', background: 'var(--color-card)',
              padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)',
            }}>{endpointPattern}</code>
            <Button size="sm" variant="ghost" onClick={() => copyValue(endpointPattern, 'url')}>
              {copied === 'url' && !justCreated ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
            Paste this URL (replacing <code>&lt;YOUR_TOKEN&gt;</code> with the token you saved) as an HTTP MCP server in your client.
            The full token is only shown once at creation — if you lost it, revoke and create a new one.
          </span>
        </div>

        {justCreated && mcpUrl && (
          <div style={{
            marginBottom: 'var(--space-md)',
            padding: 'var(--space-md)',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-primary)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
          }}>
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
                Token created — copy it now
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', lineHeight: 1.5, marginTop: 4 }}>
                This is the only time the full token is shown. Store it in your MCP client config; you can always revoke and create a new one.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label className={styles.label}>MCP Server URL</label>
                <Button size="sm" variant="ghost" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide' : 'Reveal'}
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                <code style={{
                  flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)',
                  wordBreak: 'break-all', background: 'var(--color-card)',
                  padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)',
                }}>{revealed ? mcpUrl : maskedMcpUrl}</code>
                <Button size="sm" onClick={() => copyValue(mcpUrl, 'url')}>
                  {copied === 'url' ? 'Copied!' : 'Copy URL'}
                </Button>
              </div>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
                The token is embedded in the URL — paste it into your MCP client (Claude Desktop, Claude Code…) as an HTTP MCP server.
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label className={styles.label}>Token (secret)</label>
              <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                <code style={{
                  flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)',
                  wordBreak: 'break-all', background: 'var(--color-card)',
                  padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)',
                }}>{revealed ? justCreated.token : maskToken(justCreated.token)}</code>
                <Button size="sm" onClick={() => copyValue(justCreated.token, 'token')}>
                  {copied === 'token' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>

            <div>
              <Button size="sm" variant="ghost" onClick={() => { setJustCreated(null); setRevealed(false) }}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <div className={styles.fieldGrid} style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'end' }}>
          <div className={styles.field}>
            <label className={styles.label}>Token name</label>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Laptop — Claude Desktop"
              maxLength={80}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Workspace</label>
            <select
              className={styles.input}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={teams.length === 0}
            >
              {teams.map((t) => (
                <option key={t.team.id} value={t.team.id}>
                  {t.team.name}{t.team.personal ? ' (personal)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Scope</label>
            <select
              className={styles.input}
              value={scope}
              onChange={(e) => setScope(e.target.value as McpScopeDTO)}
            >
              <option value="admin">Admin — full access (create, edit, delete)</option>
              <option value="write">Write — list, read, create, edit (no delete)</option>
              <option value="read">Read-only — list, get, search</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Expiry</label>
            <select
              className={styles.input}
              value={expiryChoice}
              onChange={(e) => setExpiryChoice(e.target.value as typeof expiryChoice)}
            >
              <option value="never">Never — rotate manually when needed</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 'var(--space-sm)', display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim() || !teamId}
          >
            {creating ? 'Creating…' : 'Create token'}
          </Button>
        </div>
        {error && <p className={`${styles.saveMsg} ${styles.error}`} style={{ marginTop: 'var(--space-sm)' }}>{error}</p>}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Active tokens ({activeTokens.length})</h2>
          <p className={styles.sectionDesc}>
            Revoke any token you no longer trust — the MCP endpoint will refuse it immediately.
          </p>
        </div>
        {activeTokens.length === 0 ? (
          <p className={styles.sectionDesc}>No active tokens yet. Create one above to get started.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {activeTokens.map((t) => {
              const now = Date.now()
              const expiresAt = t.expiresAt ? new Date(t.expiresAt) : null
              const daysLeft = expiresAt
                ? Math.max(0, Math.ceil((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)))
                : null
              const expiringSoon = daysLeft !== null && daysLeft <= 7
              return (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                  padding: 'var(--space-sm) 0',
                  borderBottom: '1px solid var(--color-border)',
                }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs, 6px)' }}>
                      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)' }}>
                        {t.name}
                      </span>
                      <ScopeBadge scope={t.scope} />
                      {daysLeft !== null && (
                        <span style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 999,
                          textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
                          background: expiringSoon ? 'var(--color-warning-bg, var(--color-secondary))' : 'var(--color-secondary)',
                          color: expiringSoon ? 'var(--color-warning, var(--color-muted-fg))' : 'var(--color-muted-fg)',
                        }}>
                          {daysLeft === 0 ? 'Expires today' : daysLeft === 1 ? 'Expires tomorrow' : `Expires in ${daysLeft}d`}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
                      {teamName(t.teamId)} · aidoc_usr_…{t.preview} · created {new Date(t.createdAt).toLocaleDateString()}
                      {t.lastUsedAt && ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`}
                      {t.lastUsedIp && ` · from ${t.lastUsedIp}`}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRotate(t)}
                    disabled={rotatingId === t.id}
                  >
                    {rotatingId === t.id ? 'Rotating…' : 'Rotate'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleRevoke(t)}>Revoke</Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Small badge that color-codes a token's capability scope so the user can
 *  spot a risky `admin` token at a glance vs a safe `read` one. */
function ScopeBadge({ scope }: { scope: McpScopeDTO }): React.ReactElement {
  const label = scope === 'admin' ? 'admin' : scope === 'write' ? 'write' : 'read'
  const bg = scope === 'admin' ? 'var(--color-accent)' : scope === 'write' ? 'var(--color-secondary)' : 'var(--color-bg)'
  const fg = scope === 'admin' ? 'var(--color-primary)' : 'var(--color-muted-fg)'
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
      background: bg, color: fg, border: '1px solid var(--color-border)',
    }}>{label}</span>
  )
}
