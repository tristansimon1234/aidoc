import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type AllowedEmailDTO } from '../../../shared/api/client.js'
import styles from './AdminAllowlist.module.css'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

export function AdminAllowlist(): React.ReactElement {
  const [items, setItems] = useState<AllowedEmailDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { confirm, dialog } = useConfirmDialog()

  const load = useCallback(async () => {
    setError(null)
    try {
      const { items: rows } = await api.admin.allowlist.list()
      setItems(rows)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await api.admin.allowlist.add({ email: email.trim(), note: note.trim() || null })
      setEmail('')
      setNote('')
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const onRemove = async (target: string): Promise<void> => {
    const ok = await confirm({
      title: 'Remove from allowlist?',
      message: `${target} will no longer be able to sign up. Existing sessions are not affected.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.admin.allowlist.remove(target)
      setItems((prev) => prev.filter((r) => r.email !== target))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>Admin · Allowlist</h1>
            <p className={styles.subtitle}>
              Doclee is closed during the design-partner phase. Only emails on
              this list can sign up. Existing accounts are unaffected — removing
              an email here only blocks future signups.
            </p>
          </div>
        </div>

        <form className={styles.addForm} onSubmit={(e) => void onAdd(e)}>
          <input
            type="email"
            required
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={styles.input}
            disabled={submitting}
          />
          <input
            type="text"
            placeholder="note (optional) — e.g. design partner #3"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${styles.input} ${styles.noteInput}`}
            disabled={submitting}
            maxLength={500}
          />
          <Button type="submit" variant="primary" disabled={submitting || !email.trim()}>
            {submitting ? 'Adding…' : 'Add'}
          </Button>
        </form>

        {error && <div className={styles.error}>{error}</div>}

        {loading ? (
          <div className={styles.loading}><Spinner size="md" /></div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Note</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.email}>
                    <td className={styles.emailCell}>{row.email}</td>
                    <td className={styles.noteCell}>{row.note ?? '—'}</td>
                    <td className={styles.dateCell}>{formatDate(row.createdAt)}</td>
                    <td className={styles.actionCell}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void onRemove(row.email)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={4} className={styles.empty}>No emails on the allowlist yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {dialog}
    </Shell>
  )
}
