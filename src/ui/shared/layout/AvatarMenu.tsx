import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.js'
import { api, type ProfileDTO, type TeamDTO, type TeamRoleDTO, getActiveTeamId, setActiveTeamId } from '../api/client.js'
import styles from './AvatarMenu.module.css'

function initialsFromEmail(email: string | undefined | null): string {
  if (!email) return '?'
  const localPart = email.split('@')[0] ?? ''
  const first = localPart[0]
  if (!first) return '?'
  return first.toUpperCase()
}

export function AvatarMenu(): React.ReactElement {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<ProfileDTO | null>(null)
  const [teams, setTeams] = useState<{ team: TeamDTO; role: TeamRoleDTO }[]>([])
  const [creating, setCreating] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Fetch profile once per mount — admin flag lives server-side so we don't
  // leak the admin email list into the frontend bundle.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void api.profile.get().then((p) => { if (!cancelled) setProfile(p) }).catch(() => { /* ignore */ })
    void api.teams.list().then((t) => { if (!cancelled) setTeams(t) }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [user])

  const activeTeamId = getActiveTeamId()
  // Personal team is the implicit default when no X-Team-Id header is sent.
  const personalTeamId = teams.find((t) => t.team.personal)?.team.id ?? null
  const resolvedActiveId = activeTeamId ?? personalTeamId
  const switchTeam = (teamId: string): void => {
    if (teamId === resolvedActiveId) { setOpen(false); return }
    setActiveTeamId(teamId)
    // Full reload is the simplest way to re-hydrate every team-scoped query
    // (projects list, billing summary, usage banner) with the new X-Team-Id
    // header without threading invalidation through every hook.
    window.location.assign('/')
  }

  const submitNewTeam = async (): Promise<void> => {
    const name = newTeamName.trim()
    if (!name || submitting) return
    setSubmitting(true); setCreateError(null)
    try {
      const team = await api.teams.create(name)
      setActiveTeamId(team.id)
      window.location.assign('/')
    } catch (err) {
      setCreateError((err as Error).message)
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (path: string): void => {
    setOpen(false)
    navigate(path)
  }

  const handleSignOut = (): void => {
    setOpen(false)
    void signOut().then(() => navigate('/login'))
  }

  const email = user?.email ?? ''
  const initial = initialsFromEmail(email)

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        className={styles.avatar}
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
      >
        {initial}
      </button>

      {open && (
        <div ref={menuRef} className={styles.menu} role="menu">
          {email && <div className={styles.header}>{email}</div>}

          <div className={styles.sectionLabel}>Workspace</div>
          {teams.map((t) => {
            const isActive = t.team.id === resolvedActiveId
            return (
              <button
                key={t.team.id}
                className={styles.item}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => switchTeam(t.team.id)}
              >
                <span className={styles.teamDot} aria-hidden="true">
                  {isActive ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </span>
                <span className={styles.teamName}>{t.team.name}</span>
                {t.team.personal && <span className={styles.teamTag}>Personal</span>}
              </button>
            )
          })}
          {creating ? (
            <div className={styles.createRow}>
              <input
                className={styles.createInput}
                autoFocus
                placeholder="Team name"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void submitNewTeam() }
                  if (e.key === 'Escape') { setCreating(false); setNewTeamName(''); setCreateError(null) }
                }}
                disabled={submitting}
              />
              <button
                className={styles.createSubmit}
                onClick={() => void submitNewTeam()}
                disabled={submitting || !newTeamName.trim()}
              >
                {submitting ? '…' : 'Create'}
              </button>
            </div>
          ) : (
            <button
              className={styles.item}
              role="menuitem"
              onClick={() => setCreating(true)}
            >
              <span className={styles.teamDot} aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span className={styles.teamName}>New team</span>
            </button>
          )}
          {createError && <div className={styles.createError}>{createError}</div>}
          <div className={styles.divider} />


          <button className={styles.item} role="menuitem" onClick={() => go('/account')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>

          <button className={styles.item} role="menuitem" onClick={() => go('/account?tab=billing')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3 8-8" />
              <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
            </svg>
            <span>View all plans</span>
          </button>

          <a
            className={styles.item}
            role="menuitem"
            href="https://app.doclee.tech/docs/d8577a1d-b81b-4c0b-b009-25b351a6376a"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            style={{ textDecoration: 'none' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>Doclee docs</span>
          </a>

          {profile?.isAdmin && (
            <>
              <div className={styles.divider} />
              <button className={styles.item} role="menuitem" onClick={() => go('/admin/usage')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <rect x="7" y="13" width="3" height="5" />
                  <rect x="12" y="9" width="3" height="9" />
                  <rect x="17" y="5" width="3" height="13" />
                </svg>
                <span>Admin · Usage</span>
              </button>
            </>
          )}

          <div className={styles.divider} />

          <button className={styles.item} role="menuitem" onClick={handleSignOut}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  )
}
