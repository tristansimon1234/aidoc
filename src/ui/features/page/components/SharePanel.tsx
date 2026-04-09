import { useState } from 'react'
import { Button } from '../../../design-system/components/index.js'
import { api, type ProjectDTO } from '../../../shared/api/client.js'
import styles from './SharePanel.module.css'

type ShareTab = 'share' | 'publish' | 'widget'

export function SharePanel({
  project,
  onClose,
}: {
  project: ProjectDTO
  onClose: () => void
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ShareTab>('widget')

  const tabs: { id: ShareTab; label: string }[] = [
    { id: 'share', label: 'Share' },
    { id: 'publish', label: 'Publish' },
    { id: 'widget', label: 'Widget' },
  ]

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Share &amp; Integrate</span>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
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
        <div className={styles.content}>
          {activeTab === 'share' && <ShareTabContent />}
          {activeTab === 'publish' && <PublishTabContent project={project} />}
          {activeTab === 'widget' && <WidgetTabContent project={project} />}
        </div>
      </div>
    </>
  )
}

// --- Share tab ---

function ShareTabContent(): React.ReactElement {
  return (
    <div>
      <div className={styles.inviteRow}>
        <input className={styles.inviteInput} placeholder="Email or group, separated by commas" disabled />
        <Button size="sm" disabled>Invite</Button>
      </div>
      <div className={styles.memberRow}>
        <div className={styles.avatar}>Y</div>
        <div className={styles.memberInfo}>
          <div className={styles.memberName}>You</div>
          <div className={styles.memberEmail}>Owner</div>
        </div>
        <span className={styles.roleBadge}>Full access</span>
      </div>
      <p className={styles.comingSoon}>Team collaboration coming soon</p>
    </div>
  )
}

// --- Publish tab ---

function PublishTabContent({ project }: { project: ProjectDTO }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const publicUrl = `${window.location.origin}/docs/${project.id}`

  return (
    <div>
      <div className={styles.infoBox}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>Only pages marked as <strong>Published</strong> are visible publicly and in the widget. Toggle each page individually from its header.</span>
      </div>

      <div className={styles.publishLabel} style={{ marginTop: 'var(--space-md)' }}>
        <span className={styles.publishTitle}>Public documentation URL</span>
        <span className={styles.publishDesc}>Share this link to give anyone read access to your published pages.</span>
      </div>

      <div className={styles.urlRow}>
        <div className={styles.urlBox}>{publicUrl}</div>
        <button className={styles.copyBtn} onClick={() => {
          void navigator.clipboard.writeText(publicUrl)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}

// --- Widget tab (with test button) ---

function WidgetTabContent({ project }: { project: ProjectDTO }): React.ReactElement {
  const [generating, setGenerating] = useState(false)
  const [widgetKey, setWidgetKey] = useState(project.widgetApiKey)
  const [widgetEnabled, setWidgetEnabled] = useState(project.widgetEnabled)
  const [copied, setCopied] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const result = await api.projects.generateWidgetKey(project.id)
      setWidgetKey(result.widgetApiKey)
      setWidgetEnabled(result.widgetEnabled)
    } finally { setGenerating(false) }
  }

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleTest = (): void => {
    if (!widgetKey) return
    setTesting(true)
    // Inject the real widget script into the page
    const existing = document.getElementById('aidoc-widget-test')
    if (existing) { existing.remove(); setTesting(false); return }
    const script = document.createElement('script')
    script.id = 'aidoc-widget-test'
    script.src = `${window.location.origin}/widget.js`
    script.setAttribute('data-key', widgetKey)
    document.body.appendChild(script)
    // Auto-open after script loads
    script.onload = () => {
      setTimeout(() => {
        const btn = document.getElementById('aidoc-widget-btn') as HTMLButtonElement | null
        btn?.click()
        setTesting(false)
      }, 500)
    }
  }

  const origin = window.location.origin
  const snippet = widgetKey
    ? `<script src="${origin}/widget.js"\n  data-key="${widgetKey}"\n></script>`
    : ''

  if (!widgetKey) {
    return (
      <div style={{ textAlign: 'center', padding: 'var(--space-md) 0' }}>
        <div className={styles.widgetIntro}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p className={styles.widgetIntroTitle}>Embed an AI chat widget</p>
          <p className={styles.widgetIntroDesc}>
            Your users ask questions about your product — the widget answers from your published documentation.
          </p>
        </div>
        <Button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Generating...' : 'Enable Widget'}
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.widgetSection}>
      <div className={styles.field}>
        <label className={styles.label}>
          Status {widgetEnabled
            ? <span className={styles.statusActive}>active</span>
            : <span className={styles.statusDisabled}>disabled</span>}
        </label>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Embed code</label>
        <div className={styles.codeBlock}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{snippet}</pre>
          <button className={styles.codeCopy} onClick={() => copy(snippet, 'snippet')}>
            {copied === 'snippet' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className={styles.hint}>
          Add <code>data-user-name</code>, <code>data-user-email</code>, <code>data-user-plan</code> for personalized answers.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        <Button size="sm" onClick={handleTest} disabled={testing}>
          {testing ? 'Loading...' : 'Test Widget'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void handleGenerate()} disabled={generating}>
          Regenerate Key
        </Button>
        {widgetEnabled && (
          <Button size="sm" variant="ghost" onClick={() => void api.projects.disableWidget(project.id).then(() => setWidgetEnabled(false))}>
            Disable
          </Button>
        )}
      </div>
    </div>
  )
}
