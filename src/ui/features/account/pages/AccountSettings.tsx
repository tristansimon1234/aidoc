import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Spinner, Badge } from '../../../design-system/components/index.js'
import { api, type BillingSummaryDTO, type PlanDTO, type PlanId, type ProfileDTO } from '../../../shared/api/client.js'
import { Shell } from '../../../shared/layout/Shell.js'
import styles from './AccountSettings.module.css'

type AccountTab = 'profile' | 'billing'

export function AccountSettings(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab: AccountTab = searchParams.get('tab') === 'billing' ? 'billing' : 'profile'
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
  ]

  return (
    <Shell>
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
          ) : (
            <BillingTab />
          )}
        </div>
      </div>
    </Shell>
  )
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }): React.ReactElement {
  const pct = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const tone = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
  return (
    <div className={styles.usage}>
      <div className={styles.usageHead}>
        <span className={styles.usageLabel}>{label}</span>
        <span className={styles.usageValue}>
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div className={styles.usageTrack}>
        <div
          className={`${styles.usageFill} ${styles[`usageFill_${tone}`]}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
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
          <div className={styles.usageGrid}>
            <UsageBar label="Doc generations" used={summary.usage.docRun} limit={summary.plan.maxDocRuns} />
            <UsageBar label="Voice-overs" used={summary.usage.voiceover} limit={summary.plan.maxVoiceovers} />
            <UsageBar label="Try Doc tests" used={summary.usage.tryDoc} limit={summary.plan.maxTryDoc} />
            <UsageBar label="Widget sessions" used={summary.usage.widgetSessions} limit={summary.plan.maxWidgetSessions} />
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
