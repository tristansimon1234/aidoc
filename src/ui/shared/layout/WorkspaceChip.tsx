import { useEffect, useRef, useState } from 'react'
import { api, type TeamDTO, type TeamRoleDTO, getActiveTeamId, setActiveTeamId } from '../api/client.js'
import styles from './WorkspaceChip.module.css'

/** Always-visible workspace indicator in the top bar. Shows the name of the
 *  currently-active workspace and, on click, opens a dropdown to switch to
 *  another workspace the user is a member of. Mirrors the switcher logic in
 *  AvatarMenu but surfaces it at-a-glance instead of hiding it behind the
 *  avatar popup. */
export function WorkspaceChip(): React.ReactElement | null {
  const [teams, setTeams] = useState<{ team: TeamDTO; role: TeamRoleDTO }[]>([])
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void api.teams.list()
      .then((t) => { if (!cancelled) setTeams(t) })
      .catch(() => { /* ignore — chip just stays empty if we can't load */ })
    return () => { cancelled = true }
  }, [])

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

  if (teams.length === 0) return null

  const activeId = getActiveTeamId()
  const personalId = teams.find((t) => t.team.personal)?.team.id ?? null
  const resolvedId = activeId ?? personalId ?? teams[0]?.team.id ?? null
  const active = teams.find((t) => t.team.id === resolvedId) ?? teams[0]
  if (!active) return null

  const switchTeam = (teamId: string): void => {
    if (teamId === resolvedId) { setOpen(false); return }
    setActiveTeamId(teamId)
    window.location.assign('/')
  }

  const multi = teams.length > 1

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        className={styles.chip}
        onClick={() => multi && setOpen((v) => !v)}
        aria-haspopup={multi ? 'listbox' : undefined}
        aria-expanded={multi ? open : undefined}
        disabled={!multi}
        title={multi ? 'Switch workspace' : active.team.name}
      >
        <svg className={styles.icon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className={styles.name}>{active.team.name}</span>
        {active.team.personal && <span className={styles.tag}>Personal</span>}
        {multi && (
          <svg className={styles.chevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && multi && (
        <div ref={menuRef} className={styles.menu} role="listbox">
          <div className={styles.menuLabel}>Switch workspace</div>
          {teams.map((t) => {
            const isActive = t.team.id === resolvedId
            return (
              <button
                key={t.team.id}
                className={styles.item}
                role="option"
                aria-selected={isActive}
                onClick={() => switchTeam(t.team.id)}
              >
                <span className={styles.itemCheck}>
                  {isActive && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className={styles.itemName}>{t.team.name}</span>
                {t.team.personal && <span className={styles.tag}>Personal</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
