import { type FormEvent, useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, EmptyState, Field, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type TeamDTO, type TeamMemberDTO, type TeamRoleDTO, setActiveTeamId } from '../../../shared/api/client.js'
import styles from './TeamSettings.module.css'

/** /teams/:teamId — manage members, invite, rename. */
export function TeamSettings(): React.ReactElement {
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirmDialog()

  const [team, setTeam] = useState<TeamDTO | null>(null)
  const [role, setRole] = useState<TeamRoleDTO>('member')
  const [members, setMembers] = useState<TeamMemberDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Rename
  const [nameInput, setNameInput] = useState('')
  const [saving, setSaving] = useState(false)

  // Invite
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; emailSent: boolean } | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!teamId) return
    try {
      const data = await api.teams.get(teamId)
      setTeam(data.team)
      setRole(data.role)
      setMembers(data.members)
      setNameInput(data.team.name)
    } catch (err) { setError((err as Error).message) }
    finally { setLoading(false) }
  }, [teamId])

  useEffect(() => { void load() }, [load])

  const handleRename = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!teamId || !nameInput.trim()) return
    setSaving(true)
    try {
      const updated = await api.teams.rename(teamId, nameInput.trim())
      setTeam(updated)
    } catch (err) { setError((err as Error).message) }
    finally { setSaving(false) }
  }

  const handleInvite = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!teamId || !inviteEmail.trim()) return
    setInviting(true); setInviteResult(null); setInviteError(null)
    try {
      const result = await api.teams.invite(teamId, inviteEmail.trim())
      setInviteResult({ acceptUrl: result.acceptUrl, emailSent: result.emailSent })
      setInviteEmail('')
    } catch (err) {
      setInviteError((err as Error).message)
    } finally { setInviting(false) }
  }

  const handleRemove = async (member: TeamMemberDTO): Promise<void> => {
    if (!teamId) return
    const ok = await confirm({
      title: `Remove ${member.email ?? 'member'}?`,
      message: 'They will lose access to this team and its projects immediately.',
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.teams.removeMember(teamId, member.userId)
      await load()
    } catch (err) { setError((err as Error).message) }
  }

  const handleDelete = async (): Promise<void> => {
    if (!teamId || !team) return
    const ok = await confirm({
      title: `Delete team ${team.name}?`,
      message: 'All projects in this team will be deleted permanently.',
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.teams.delete(teamId)
      setActiveTeamId(null)
      navigate('/')
    } catch (err) { setError((err as Error).message) }
  }

  if (loading) return <Shell><Spinner size="lg" /></Shell>
  if (error || !team) return <Shell><EmptyState title="Failed to load team" description={error ?? 'Not found'} /></Shell>

  const isOwner = role === 'owner'

  return (
    <Shell>
      {dialog}
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>{team.name}</h1>
          <p className={styles.subtitle}>
            {team.personal ? 'Personal workspace — only you' : 'Team workspace'} · {members.length} member{members.length === 1 ? '' : 's'}
          </p>
        </header>

        {isOwner && !team.personal && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Name</h2>
            <form className={styles.inlineForm} onSubmit={(e) => void handleRename(e)}>
              <Field label="" value={nameInput} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNameInput(e.target.value)} />
              <Button type="submit" size="sm" disabled={saving || !nameInput.trim() || nameInput.trim() === team.name}>
                {saving ? 'Saving…' : 'Rename'}
              </Button>
            </form>
          </section>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Members</h2>
          <ul className={styles.memberList}>
            {members.map((m) => (
              <li key={m.userId} className={styles.memberRow}>
                <div className={styles.memberInfo}>
                  <span className={styles.memberName}>{m.fullName ?? m.email ?? m.userId}</span>
                  <span className={styles.memberEmail}>{m.email}</span>
                </div>
                <span className={`${styles.rolePill} ${styles[`role_${m.role}`]}`}>{m.role}</span>
                {isOwner && members.length > 1 && (
                  <button className={styles.removeBtn} onClick={() => void handleRemove(m)}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {isOwner && !team.personal && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Invite a member</h2>
            <form className={styles.inlineForm} onSubmit={(e) => void handleInvite(e)}>
              <Field label="" type="email" placeholder="colleague@company.com"
                value={inviteEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)} />
              <Button type="submit" size="sm" disabled={inviting || !inviteEmail.trim()}>
                {inviting ? 'Sending…' : 'Send invite'}
              </Button>
            </form>
            {inviteError && <p className={styles.error}>{inviteError}</p>}
            {inviteResult && (
              <div className={styles.inviteSent}>
                <p>
                  Invite created. {inviteResult.emailSent
                    ? 'We sent the email — tell them to check their inbox.'
                    : 'Email not sent (no SMTP configured). Copy the link manually:'}
                </p>
                <code className={styles.inviteLink}>{inviteResult.acceptUrl}</code>
              </div>
            )}
          </section>
        )}

        {isOwner && !team.personal && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Danger zone</h2>
            <Button variant="danger" size="sm" onClick={() => void handleDelete()}>
              Delete team
            </Button>
          </section>
        )}
      </div>
    </Shell>
  )
}
