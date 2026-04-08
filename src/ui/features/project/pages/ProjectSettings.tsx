import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { api, type ProjectDTO, type DiscoveredContextDTO } from '../../../shared/api/client.js'
import { fetchProject, updateProject } from '../../../shared/api/db.js'
import styles from './ProjectSettings.module.css'

interface Credential { label: string; username: string; password: string }

type SettingsTab = 'general' | 'widget' | 'context' | 'credentials' | 'knowledge'

export function ProjectSettings(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectDTO | null>(null)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [context, setContext] = useState({ audience: '', workflow: '', quirks: '' })
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    fetchProject(projectId).then((p) => {
      setProject(p)
      setName(p.name)
      setBaseUrl(p.baseUrl)
      setContext(p.context ?? { audience: '', workflow: '', quirks: '' })
      setCredentials((p as ProjectDTO & { credentials?: Credential[] | null }).credentials ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [projectId])

  const handleSave = async (): Promise<void> => {
    if (!projectId) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const validCreds = credentials.filter((c) => c.label && c.username && c.password)
      await updateProject(projectId, {
        name, baseUrl,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) { setError((err as Error).message) }
    finally { setSaving(false) }
  }

  if (loading) return <Shell><div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-2xl)' }}><Spinner size="lg" /></div></Shell>
  if (!project) return <Shell><p>Project not found</p></Shell>

  const tabs: { id: SettingsTab; label: string; highlight?: boolean }[] = [
    { id: 'general', label: 'General' },
    { id: 'widget', label: 'Widget', highlight: true },
    { id: 'context', label: 'AI Context' },
    { id: 'credentials', label: 'Credentials' },
    { id: 'knowledge', label: 'Knowledge' },
  ]

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Settings</h1>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
            &larr; Back
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
              {t.highlight && <span className={styles.tabBadge} />}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {activeTab === 'general' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>General</h2>
                <p className={styles.sectionDesc}>Basic project information.</p>
              </div>
              <div className={styles.fieldGrid}>
                <div className={styles.field}>
                  <label className={styles.label}>Project name</label>
                  <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>URL</label>
                  <input className={styles.inputMono} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
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
          )}

          {activeTab === 'widget' && (
            <WidgetTab project={project} onUpdate={(u) => setProject({ ...project, ...u })} />
          )}

          {activeTab === 'context' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>AI Context</h2>
                <p className={styles.sectionDesc}>Help the AI understand your product. Better context = better documentation and chat answers.</p>
              </div>
              <div className={styles.fieldGrid}>
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <label className={styles.label}>Target audience</label>
                  <textarea className={styles.textarea} value={context.audience}
                    onChange={(e) => setContext({ ...context, audience: e.target.value })}
                    placeholder="e.g. SaaS product managers who need to track feature adoption" rows={2} />
                </div>
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <label className={styles.label}>Key workflow</label>
                  <textarea className={styles.textarea} value={context.workflow}
                    onChange={(e) => setContext({ ...context, workflow: e.target.value })}
                    placeholder="e.g. User creates a project, adds team members, runs first report" rows={2} />
                </div>
                <div className={`${styles.field} ${styles.fieldFull}`}>
                  <label className={styles.label}>Domain knowledge</label>
                  <textarea className={styles.textarea} value={context.quirks}
                    onChange={(e) => setContext({ ...context, quirks: e.target.value })}
                    placeholder="e.g. 'Workspace' means a team account. Archive is hidden until 5+ items." rows={2} />
                </div>
              </div>
              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
              </div>
            </div>
          )}

          {activeTab === 'credentials' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Test Credentials</h2>
                <p className={styles.sectionDesc}>Used by the AI agent to log in during auto-exploration.</p>
              </div>
              {credentials.map((cred, i) => (
                <div key={i} className={styles.credRow}>
                  <input className={styles.credInput} value={cred.label}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, label: e.target.value } : c))}
                    placeholder="Label" />
                  <input className={styles.credInput} value={cred.username}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, username: e.target.value } : c))}
                    placeholder="Email" />
                  <input className={styles.credInput} type="password" value={cred.password}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, password: e.target.value } : c))}
                    placeholder="Password" />
                  <button className={styles.removeBtn} onClick={() => setCredentials(credentials.filter((_, j) => j !== i))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              ))}
              <button className={styles.addBtn} onClick={() => setCredentials([...credentials, { label: '', username: '', password: '' }])}>
                + Add credential
              </button>
              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
              </div>
            </div>
          )}

          {activeTab === 'knowledge' && (
            <KnowledgeTab context={project.discoveredContext} projectId={projectId!}
              onSaved={(updated) => setProject({ ...project, discoveredContext: updated })} />
          )}
        </div>
      </div>
    </Shell>
  )
}

// --- Widget Tab (core feature, prominent) ---

function WidgetTab({ project, onUpdate }: { project: ProjectDTO; onUpdate: (u: Partial<ProjectDTO>) => void }): React.ReactElement {
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const handleGenerate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const result = await api.projects.generateWidgetKey(project.id)
      onUpdate({ widgetApiKey: result.widgetApiKey, widgetEnabled: result.widgetEnabled })
    } finally { setGenerating(false) }
  }

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const snippet = project.widgetApiKey
    ? `<script src="${origin}/widget.js"\n  data-key="${project.widgetApiKey}"\n  data-user-name="{{USER_NAME}}"\n  data-user-email="{{USER_EMAIL}}"\n  data-user-plan="{{USER_PLAN}}"\n></script>`
    : ''

  return (
    <div className={styles.featureSection}>
      <div className={styles.featureIcon}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Embed Chat Widget</h2>
        <p className={styles.sectionDesc}>
          Deploy an AI-powered chat on your app. Your users ask questions about your product — the widget answers using your documentation, with screenshots and step-by-step guidance.
        </p>
      </div>

      {!project.widgetApiKey ? (
        <Button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Generating...' : 'Enable Widget'}
        </Button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div className={styles.field}>
            <label className={styles.label}>
              API Key {project.widgetEnabled
                ? <span className={styles.statusActive}>active</span>
                : <span className={styles.statusDisabled}>disabled</span>}
            </label>
            <div className={styles.codeBlock}>
              {project.widgetApiKey}
              <button className={styles.copyBtn} onClick={() => copy(project.widgetApiKey!, 'key')}>
                {copied === 'key' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Add to your HTML</label>
            <div className={styles.codeBlock}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{snippet}</pre>
              <button className={styles.copyBtn} onClick={() => copy(snippet, 'snippet')}>
                {copied === 'snippet' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className={styles.widgetHelp}>
              Replace <code>{'{{...}}'}</code> placeholders with your user&apos;s data. All <code>data-user-*</code> attributes are optional.
              The widget auto-detects the current page URL for contextual answers.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <Button size="sm" variant="secondary" onClick={() => void handleGenerate()} disabled={generating}>
              Regenerate Key
            </Button>
            {project.widgetEnabled && (
              <Button size="sm" variant="ghost" onClick={() => void api.projects.disableWidget(project.id).then(() => onUpdate({ widgetEnabled: false }))}>
                Disable
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Knowledge Tab ---

function KnowledgeTab({ context, projectId, onSaved }: {
  context: DiscoveredContextDTO | null; projectId: string; onSaved: (ctx: DiscoveredContextDTO) => void
}): React.ReactElement {
  const [summary, setSummary] = useState(context?.summary ?? '')
  const [terminology, setTerminology] = useState<[string, string][]>(
    context?.terminology ? Object.entries(context.terminology) : [],
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!context) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Knowledge Base</h2>
          <p className={styles.sectionDesc}>
            The AI builds this automatically as it generates documentation. Generate docs for any page to get started.
          </p>
        </div>
      </div>
    )
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true); setSaved(false)
    try {
      const updated: DiscoveredContextDTO = {
        ...context, summary,
        terminology: Object.fromEntries(terminology.filter(([k]) => k.trim())),
      }
      await updateProject(projectId, { discoveredContext: updated })
      onSaved(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }

  const ago = context.lastUpdated ? formatTimeAgo(context.lastUpdated) : ''

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Knowledge Base</h2>
        <p className={styles.sectionDesc}>Auto-generated by the AI. You can edit to correct mistakes.</p>
      </div>

      <div className={styles.statRow}>
        <span className={styles.stat}>{context.features.length} features</span>
        <span className={styles.stat}>{context.siteStructure.length} pages</span>
        <span className={styles.stat}>{Object.keys(context.terminology).length} terms</span>
        {ago && <span className={styles.stat}>updated {ago}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div className={styles.field}>
          <p className={styles.subLabel}>Summary</p>
          <textarea className={styles.textarea} value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p className={styles.subLabel}>Terminology</p>
            <button className={styles.addBtn} style={{ width: 'auto', padding: '2px 8px' }}
              onClick={() => setTerminology([...terminology, ['', '']])}>+ add</button>
          </div>
          {terminology.map(([term, def], i) => (
            <div key={i} className={styles.termRow}>
              <input className={styles.credInput} style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}
                value={term} onChange={(e) => setTerminology(terminology.map((t, j) => j === i ? [e.target.value, t[1]] : t))}
                placeholder="term" />
              <input className={styles.credInput} value={def}
                onChange={(e) => setTerminology(terminology.map((t, j) => j === i ? [t[0], e.target.value] : t))}
                placeholder="definition" />
              <button className={styles.removeBtn} onClick={() => setTerminology(terminology.filter((_, j) => j !== i))}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          ))}
        </div>

        {context.features.length > 0 && (
          <div>
            <p className={styles.subLabel}>Features</p>
            <div className={styles.tagList}>
              {context.features.map((f, i) => <span key={i} className={styles.stat}>{f}</span>)}
            </div>
          </div>
        )}

        {context.siteStructure.length > 0 && (
          <div>
            <p className={styles.subLabel}>Site structure</p>
            <div className={styles.urlList}>
              {context.siteStructure.map((url, i) => <span key={i}>{url}</span>)}
            </div>
          </div>
        )}

        <div className={styles.saveBar}>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving...' : 'Save Knowledge'}
          </Button>
          {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
        </div>
      </div>
    </div>
  )
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
