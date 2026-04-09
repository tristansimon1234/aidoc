import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { type ProjectDTO } from '../../../shared/api/client.js'
import { api } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import styles from './SharePage.module.css'

type ShareTab = 'publish' | 'widget' | 'team'

const TABS: { id: ShareTab; label: string; desc: string }[] = [
  { id: 'publish', label: 'Publish', desc: 'Public documentation URL' },
  { id: 'widget', label: 'Widget', desc: 'Embeddable AI chat' },
  { id: 'team', label: 'Team', desc: 'Invite collaborators' },
]

export function SharePage(): React.ReactElement {
  const { project, setProject } = useOutletContext<{ project: ProjectDTO; setProject: (p: ProjectDTO) => void }>()
  const [activeTab, setActiveTab] = useState<ShareTab>('publish')

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Share & Integrate</h1>
        <p className={styles.subtitle}>Publish your docs, embed a chat widget, or invite your team.</p>
      </div>

      <div className={styles.tabs}>
        {TABS.map((t) => (
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
        {activeTab === 'publish' && <PublishSection project={project} />}
        {activeTab === 'widget' && <WidgetSection project={project} setProject={setProject} />}
        {activeTab === 'team' && <TeamSection />}
      </div>
    </div>
  )
}

// --- Publish ---

function PublishSection({ project }: { project: ProjectDTO }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const publicUrl = `${window.location.origin}/docs/${project.id}`

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Public documentation</h2>
        <p className={styles.sectionDesc}>Anyone with the link can read your published pages. Only pages marked as Published are visible.</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Documentation URL</label>
        <div className={styles.urlRow}>
          <div className={styles.urlBox}>{publicUrl}</div>
          <button className={styles.copyBtn} onClick={() => {
            void navigator.clipboard.writeText(publicUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className={styles.infoBox}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
        </svg>
        <span>Toggle each page's visibility from its header using the Published/Draft button.</span>
      </div>
    </div>
  )
}

// --- Widget ---

function WidgetSection({ project, setProject }: { project: ProjectDTO; setProject: (p: ProjectDTO) => void }): React.ReactElement {
  const [generating, setGenerating] = useState(false)
  const [widgetKey, setWidgetKey] = useState(project.widgetApiKey)
  const [widgetEnabled, setWidgetEnabled] = useState(project.widgetEnabled)
  const [copied, setCopied] = useState<string | null>(null)
  const [position, setPosition] = useState<'right' | 'left'>((project.design?.widgetPosition as 'right' | 'left') ?? 'right')
  const [greeting, setGreeting] = useState(project.design?.widgetGreeting ?? '')
  const [testing, setTesting] = useState(false)
  const saveWidgetConfig = async (pos: string, greet: string): Promise<void> => {
    const design = { ...(project.design ?? { accentColor: '#635BFF', bgColor: '#0C0C0E', textColor: '#E5E5E5', font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }), widgetPosition: pos, widgetGreeting: greet }
    const updated = await updateProject(project.id, { design })
    setProject(updated)
  }

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
  const buildSnippet = (): string => {
    if (!widgetKey) return ''
    const attrs = [`  data-key="${widgetKey}"`]
    if (position !== 'right') attrs.push(`  data-position="${position}"`)
    if (greeting) attrs.push(`  data-greeting="${greeting}"`)
    return `<script src="${origin}/widget.js"\n${attrs.join('\n')}\n></script>`
  }

  if (!widgetKey) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>AI Chat Widget</h2>
          <p className={styles.sectionDesc}>Embed an AI chatbot on your app. It answers user questions from your published documentation.</p>
        </div>
        <div className={styles.featureList}>
          <div className={styles.featureItem}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <span>RAG-powered answers from your docs</span>
          </div>
          <div className={styles.featureItem}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <span>Auto-generated contextual suggestions</span>
          </div>
          <div className={styles.featureItem}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <span>Single <code>&lt;script&gt;</code> tag — works on any website</span>
          </div>
        </div>
        <Button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Generating...' : 'Enable Widget'}
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <h2 className={styles.sectionTitle}>AI Chat Widget</h2>
          <span className={widgetEnabled ? styles.statusActive : styles.statusDisabled}>
            {widgetEnabled ? 'Active' : 'Disabled'}
          </span>
        </div>
        <p className={styles.sectionDesc}>Colors and fonts are configured in the <strong>Design</strong> tab.</p>
      </div>

      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <label className={styles.label}>Position</label>
          <div className={styles.positionRow}>
            <button className={`${styles.positionBtn} ${position === 'left' ? styles.positionBtnActive : ''}`} onClick={() => { setPosition('left'); void saveWidgetConfig('left', greeting) }}>
              Bottom left
            </button>
            <button className={`${styles.positionBtn} ${position === 'right' ? styles.positionBtnActive : ''}`} onClick={() => { setPosition('right'); void saveWidgetConfig('right', greeting) }}>
              Bottom right
            </button>
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Greeting</label>
          <input className={styles.fieldInput} value={greeting} onChange={(e) => setGreeting(e.target.value)} onBlur={() => void saveWidgetConfig(position, greeting)} placeholder="Hi! Ask me anything." />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Embed code</label>
        <div className={styles.codeBlock}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{buildSnippet()}</pre>
          <button className={styles.codeCopy} onClick={() => copy(buildSnippet(), 'snippet')}>
            {copied === 'snippet' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <span className={styles.hint}>Add <code>data-user-name</code>, <code>data-user-email</code>, <code>data-user-plan</code> for personalized answers.</span>
      </div>

      <div className={styles.actions}>
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

// --- Team ---

function TeamSection(): React.ReactElement {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Team</h2>
        <p className={styles.sectionDesc}>Invite team members to collaborate on your documentation.</p>
      </div>
      <div className={styles.memberRow}>
        <div className={styles.memberAvatar}>Y</div>
        <div className={styles.memberInfo}>
          <span className={styles.memberName}>You</span>
          <span className={styles.memberRole}>Owner</span>
        </div>
        <span className={styles.roleBadge}>Full access</span>
      </div>
      <p className={styles.comingSoon}>Team collaboration coming soon.</p>
    </div>
  )
}
