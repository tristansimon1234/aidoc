import { useState } from 'react'
import { Button } from '../../../design-system/components/index.js'
import { api, type ProjectDTO } from '../../../shared/api/client.js'
import styles from './SharePanel.module.css'

type ShareTab = 'share' | 'publish' | 'widget'

export function SharePanel({
  project,
  onClose,
  inline = false,
}: {
  project: ProjectDTO
  onClose: () => void
  inline?: boolean
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ShareTab>('widget')

  const tabs: { id: ShareTab; label: string }[] = [
    { id: 'share', label: 'Share' },
    { id: 'publish', label: 'Publish' },
    { id: 'widget', label: 'Widget' },
  ]

  return (
    <>
      {!inline && <div className={styles.overlay} onClick={onClose} />}
      <div className={inline ? styles.panelInline : styles.panel}>
        {!inline && (
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Share &amp; Integrate</span>
            <button className={styles.closeBtn} onClick={onClose}>&times;</button>
          </div>
        )}
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
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

// --- Widget tab (with customization + test) ---

function WidgetTabContent({ project }: { project: ProjectDTO }): React.ReactElement {
  const [generating, setGenerating] = useState(false)
  const [widgetKey, setWidgetKey] = useState(project.widgetApiKey)
  const [widgetEnabled, setWidgetEnabled] = useState(project.widgetEnabled)
  const [copied, setCopied] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  // Widget-specific settings (position + greeting)
  const [position, setPosition] = useState<'right' | 'left'>('right')
  const [greeting, setGreeting] = useState('')

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
    const existing = document.getElementById('aidoc-widget-test')
    if (existing) { existing.remove(); setTesting(false); return }
    const script = document.createElement('script')
    script.id = 'aidoc-widget-test'
    script.src = `${window.location.origin}/widget.js`
    script.setAttribute('data-key', widgetKey)
    script.setAttribute('data-position', position)
    if (greeting) script.setAttribute('data-greeting', greeting)
    document.body.appendChild(script)
    script.onload = () => {
      setTimeout(() => {
        const btn = document.getElementById('aidoc-widget-btn') as HTMLButtonElement | null
        btn?.click()
        setTesting(false)
      }, 500)
    }
  }

  const origin = window.location.origin

  // Build snippet with customization attrs
  const buildSnippet = (): string => {
    if (!widgetKey) return ''
    const attrs = [`  data-key="${widgetKey}"`]
    if (position !== 'right') attrs.push(`  data-position="${position}"`)
    if (greeting) attrs.push(`  data-greeting="${greeting}"`)
    return `<script src="${origin}/widget.js"\n${attrs.join('\n')}\n></script>`
  }

  const snippet = buildSnippet()

  if (!widgetKey) {
    return (
      <div>
        {/* About section */}
        <div className={styles.widgetAbout}>
          <div className={styles.widgetAboutHeader}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
            <div>
              <p className={styles.widgetAboutTitle}>AI Chat Widget</p>
              <p className={styles.widgetAboutDesc}>An embeddable chatbot that answers questions from your documentation.</p>
            </div>
          </div>

          <div className={styles.featureList}>
            <div className={styles.featureItem}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span>Answers from your published docs via RAG</span>
            </div>
            <div className={styles.featureItem}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span>Auto-generated suggestions based on your content</span>
            </div>
            <div className={styles.featureItem}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span>Personalized answers with user context (name, plan)</span>
            </div>
            <div className={styles.featureItem}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              <span>Single <code>&lt;script&gt;</code> tag — works on any website</span>
            </div>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 'var(--space-md)' }}>
          <Button onClick={() => void handleGenerate()} disabled={generating}>
            {generating ? 'Generating...' : 'Enable Widget'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.widgetSection}>
      {/* Status */}
      <div className={styles.widgetStatusRow}>
        <span className={styles.label}>Status</span>
        <span className={widgetEnabled ? styles.statusActive : styles.statusDisabled}>
          {widgetEnabled ? 'Active' : 'Disabled'}
        </span>
      </div>

      {/* Widget-specific settings */}
      <div className={styles.widgetCustom}>
        <span className={styles.widgetCustomTitle}>Widget settings</span>
        <p className={styles.customHint} style={{ marginTop: '-4px' }}>Colors and fonts are configured in the <strong>Design</strong> tab.</p>

        {/* Position */}
        <div className={styles.customField}>
          <label className={styles.customLabel}>Position</label>
          <div className={styles.positionRow}>
            <button
              className={`${styles.positionBtn} ${position === 'left' ? styles.positionBtnActive : ''}`}
              onClick={() => setPosition('left')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="16" r="2" /></svg>
              Bottom left
            </button>
            <button
              className={`${styles.positionBtn} ${position === 'right' ? styles.positionBtnActive : ''}`}
              onClick={() => setPosition('right')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="16" cy="16" r="2" /></svg>
              Bottom right
            </button>
          </div>
        </div>

        {/* Greeting */}
        <div className={styles.customField}>
          <label className={styles.customLabel}>Greeting message</label>
          <input
            className={styles.customInput}
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="Hi! Ask me anything."
          />
          <span className={styles.customHint}>Leave blank for the default greeting</span>
        </div>
      </div>

      {/* Embed code */}
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

      {/* Actions */}
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
