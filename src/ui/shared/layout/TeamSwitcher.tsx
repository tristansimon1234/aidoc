import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { api, type TeamDTO, type TeamRoleDTO, getActiveTeamId, setActiveTeamId } from '../api/client.js'
import { useConfirmDialog, Button, Field } from '../../design-system/components/index.js'
import styles from './TeamSwitcher.module.css'

interface TeamEntry { team: TeamDTO; role: TeamRoleDTO }

/**
 * Team picker in the AppRail: shows the active team's initial, opens a popup
 * with all the user's teams, lets them switch, create, or open settings.
 * Reloads the window on switch so every page reads fresh data (projects,
 * billing, analytics) for the new team — simpler than plumbing a context.
 */
export function TeamSwitcher(): React.ReactElement | null {
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirmDialog()
  const [teams, setTeams] = useState<TeamEntry[]>([])
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.teams.list()
        setTeams(data)
        // Lock in an active team if localStorage is empty (first mount).
        if (!getActiveTeamId() && data.length > 0) {
          const personal = data.find((t) => t.team.personal) ?? data[0]!
          setActiveTeamId(personal.team.id)
        }
      } catch { /* silent — topbar isn't critical */ }
    })()
  }, [])

  // Close on outside click — kept ABOVE any conditional returns so the hook
  // order stays stable across renders (React #310 fires otherwise).
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (popupRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false); setCreating(false); setNewName('')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const activeId = getActiveTeamId()
  const active = teams.find((t) => t.team.id === activeId) ?? teams[0]
  if (!active) return null

  const initial = active.team.name.charAt(0).toUpperCase()

  const openPopup = (): void => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPopupPos({ left: rect.right + 8, top: rect.top })
    setOpen(true)
  }

  const switchTeam = (teamId: string): void => {
    if (teamId === activeId) { setOpen(false); return }
    setActiveTeamId(teamId)
    window.location.reload()
  }

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim()) return
    setSaving(true)
    try {
      const created = await api.teams.create(newName.trim())
      setActiveTeamId(created.id)
      window.location.href = `/teams/${created.id}`
    } catch (err) {
      await confirm({
        title: 'Could not create team',
        message: (err as Error).message,
        confirmLabel: 'OK',
        cancelLabel: 'Dismiss',
        variant: 'primary',
      })
      setSaving(false)
    }
  }

  return (
    <>
      {dialog}
      <button
        ref={btnRef}
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={openPopup}
        aria-label={`Active team: ${active.team.name}`}
        title={active.team.name}
      >
        <span className={styles.initial}>{initial}</span>
      </button>

      {open && popupPos && createPortal(
        <div
          ref={popupRef}
          className={styles.popup}
          style={{ left: popupPos.left, top: popupPos.top }}
        >
          <div className={styles.popupHeader}>Teams</div>
          <ul className={styles.teamList}>
            {teams.map(({ team, role }) => (
              <li key={team.id}>
                <button
                  className={`${styles.teamRow} ${team.id === activeId ? styles.teamRowActive : ''}`}
                  onClick={() => switchTeam(team.id)}
                >
                  <span className={styles.teamInitial}>{team.name.charAt(0).toUpperCase()}</span>
                  <span className={styles.teamName}>{team.name}</span>
                  {team.personal && <span className={styles.teamBadge}>personal</span>}
                  {role === 'owner' && !team.personal && <span className={styles.teamBadge}>owner</span>}
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.popupActions}>
            <button
              className={styles.popupAction}
              onClick={() => { setOpen(false); navigate(`/teams/${active.team.id}`) }}
            >
              Team settings
            </button>
            {!creating ? (
              <button className={styles.popupAction} onClick={() => setCreating(true)}>
                + Create team
              </button>
            ) : (
              <div className={styles.createForm}>
                <Field label="" placeholder="Team name" value={newName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)} autoFocus />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button size="sm" onClick={() => void handleCreate()} disabled={saving || !newName.trim()}>
                    {saving ? '…' : 'Create'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName('') }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
