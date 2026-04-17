import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { api, type ProfileDTO } from '../../../shared/api/client.js'
import { Shell } from '../../../shared/layout/Shell.js'
import { useAuth } from '../../../shared/hooks/useAuth.js'
import styles from './AccountSettings.module.css'

type AccountTab = 'profile' | 'billing'

export function AccountSettings(): React.ReactElement {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [activeTab, setActiveTab] = useState<AccountTab>('profile')
  const [profile, setProfile] = useState<ProfileDTO | null>(null)
  const [fullName, setFullName] = useState('')
  const [preferredLanguage, setPreferredLanguage] = useState('en')
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
        setPreferredLanguage(p.preferredLanguage ?? 'en')
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await api.profile.update({
        fullName: fullName.trim() || null,
        preferredLanguage,
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
  ]

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Account</h1>
          <Button size="sm" variant="secondary" onClick={() => { void signOut().then(() => navigate('/login')) }}>
            Sign out
          </Button>
        </div>

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(t.id)}
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
                <p className={styles.sectionDesc}>Your account details. The language preference is used for the UI and inherited by new projects.</p>
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
                <div className={styles.field}>
                  <label className={styles.label}>Preferred language</label>
                  <select
                    className={styles.input}
                    value={preferredLanguage}
                    onChange={(e) => setPreferredLanguage(e.target.value)}
                  >
                    <option value="en">English</option>
                    <option value="fr">Français</option>
                  </select>
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
          ) : (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Plan &amp; Billing</h2>
                <p className={styles.sectionDesc}>
                  You're on the <strong>Free</strong> plan. Paid plans with higher quotas are coming soon.
                </p>
              </div>
              <p className={styles.sectionDesc} style={{ marginTop: 'var(--space-md)' }}>
                Doc generations, voice-overs, Try Doc tests, and widget sessions will be metered per month.
                We'll show usage here once billing is live.
              </p>
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}
