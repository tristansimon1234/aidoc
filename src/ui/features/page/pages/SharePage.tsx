import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Button, ShareMenu } from '../../../design-system/components/index.js'
import { type ProjectDTO } from '../../../shared/api/client.js'
import { api } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import styles from './SharePage.module.css'

type ShareTab = 'publish' | 'widget' | 'mcp' | 'team'

const TABS: { id: ShareTab; label: string; desc: string }[] = [
  { id: 'publish', label: 'Publish', desc: 'Public documentation URL' },
  { id: 'widget', label: 'Widget', desc: 'Embeddable AI chat' },
  { id: 'mcp', label: 'MCP', desc: 'Connect to Claude' },
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
        {activeTab === 'publish' && <PublishSection project={project} setProject={setProject} />}
        {activeTab === 'widget' && <WidgetSection project={project} setProject={setProject} />}
        {activeTab === 'mcp' && <McpSection project={project} setProject={setProject} />}
        {activeTab === 'team' && <TeamSection />}
      </div>
    </div>
  )
}

// --- Publish ---

function PublishSection({ project, setProject }: { project: ProjectDTO; setProject: (p: ProjectDTO) => void }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [chatEnabled, setChatEnabled] = useState(project.publicDocsChatEnabled ?? false)
  const publicUrl = `${window.location.origin}/docs/${project.id}`

  const toggleChat = async (next: boolean): Promise<void> => {
    setChatEnabled(next)
    const updated = await updateProject(project.id, { publicDocsChatEnabled: next })
    setProject(updated)
  }

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

      <div className={styles.field}>
        <label className={styles.label}>Share on social</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <ShareMenu
            url={publicUrl}
            title={`${project.name} — Documentation`}
            label="Share"
          />
          <span className={styles.hint} style={{ margin: 0 }}>
            Post to LinkedIn, X, Facebook, WhatsApp, or send by email.
          </span>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={chatEnabled}
            onChange={(e) => void toggleChat(e.target.checked)}
          />
          Enable "Chat with docs" on public site
        </label>
        <span className={styles.hint}>
          Adds a chat button to your public docs. Anonymous visitors can ask questions and get answers grounded in your documentation.
        </span>
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
  const [walkthroughEnabled, setWalkthroughEnabled] = useState(project.walkthroughEnabled ?? false)
  const [testing, setTesting] = useState(false)

  const toggleWalkthrough = async (next: boolean): Promise<void> => {
    setWalkthroughEnabled(next)
    const updated = await updateProject(project.id, { walkthroughEnabled: next })
    setProject(updated)
  }
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

  // Build design config JSON for data-cfg attribute
  const buildDesignCfg = (): string | null => {
    const d = project.design
    if (!d) return null
    const cfg: Record<string, string> = {}
    if (d.accentColor) cfg.accentColor = d.accentColor
    if (d.bgColor) cfg.bgColor = d.bgColor
    if (d.textColor) cfg.textColor = d.textColor
    if (d.font) cfg.font = d.font
    if (position) cfg.widgetPosition = position
    if (greeting) cfg.widgetGreeting = greeting
    return JSON.stringify(cfg)
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
    const cfg = buildDesignCfg()
    if (cfg) script.setAttribute('data-cfg', cfg)
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
    const cfg = buildDesignCfg()
    if (cfg) attrs.push(`  data-cfg='${cfg}'`)
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
        <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={walkthroughEnabled} onChange={(e) => void toggleWalkthrough(e.target.checked)} />
          Enable interactive walkthrough
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 6px',
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--color-primary)',
              background: 'var(--color-accent)',
              borderRadius: 'var(--radius-sm, 4px)',
            }}
          >
            Beta
          </span>
        </label>
        <span className={styles.hint}>
          Lets the widget guide users step-by-step through your app by highlighting UI elements (buttons, links, form fields). When off, the widget only answers questions. <strong>Beta — expect some rough edges on complex layouts.</strong>
        </span>
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

// --- MCP ---

function McpSection({ project, setProject }: { project: ProjectDTO; setProject: (p: ProjectDTO) => void }): React.ReactElement {
  const [enabling, setEnabling] = useState(false)
  const [copied, setCopied] = useState(false)

  const hasKey = !!project.mcpApiKey && project.mcpEnabled

  const enableMcp = async (): Promise<void> => {
    setEnabling(true)
    try {
      const result = await api.projects.generateMcpKey(project.id)
      setProject({ ...project, mcpApiKey: result.mcpApiKey, mcpEnabled: true })
    } finally {
      setEnabling(false)
    }
  }

  const mcpUrl = hasKey ? `${window.location.origin}/api/mcp/${project.mcpApiKey}` : null

  const configJson = mcpUrl ? JSON.stringify({
    mcpServers: {
      [project.name.toLowerCase().replace(/\s+/g, '-')]: {
        url: mcpUrl,
      },
    },
  }, null, 2) : ''

  const copyConfig = (): void => {
    void navigator.clipboard.writeText(configJson)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>MCP Server</h2>
        <p className={styles.sectionDesc}>Connect your documentation to Claude Desktop, Claude Code, or any MCP-compatible AI assistant.</p>
      </div>

      {!hasKey ? (
        <div>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', marginBottom: 'var(--space-md)' }}>
            Enable the API to generate an MCP endpoint for your documentation. This uses the same API key as the chat widget.
          </p>
          <Button onClick={() => void enableMcp()} disabled={enabling}>
            {enabling ? 'Enabling...' : 'Enable MCP'}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <div>
            <label style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>MCP Server URL</label>
            <div className={styles.codeBlock}>
              <code>{mcpUrl}</code>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Claude Desktop config</label>
            <div className={styles.codeBlock} style={{ position: 'relative' }}>
              <button className={styles.copyBtn} onClick={copyConfig}>{copied ? 'Copied!' : 'Copy'}</button>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 'var(--text-xs)' }}>{configJson}</pre>
            </div>
          </div>

          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', lineHeight: 1.6 }}>
            Add this to your Claude Desktop <code>claude_desktop_config.json</code> or Claude Code <code>.mcp.json</code>. Two tools are available: <strong>search_documentation</strong> (RAG search) and <strong>list_pages</strong>.
          </p>
        </div>
      )}
    </div>
  )
}

// --- Team ---
// Team is managed at the workspace level in Account → Team. This section is
// just a shortcut to that page; we don't show per-project membership here.

function TeamSection(): React.ReactElement {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Team</h2>
        <p className={styles.sectionDesc}>
          Members are managed at the workspace level — everyone you invite gets access to every project in this workspace.
        </p>
      </div>
      <div>
        <Link to="/account?tab=team"><Button size="sm">Manage team →</Button></Link>
      </div>
    </div>
  )
}

