import { type ChangeEvent, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field, Spinner } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DiscoveredContextDTO } from '../../../shared/api/client.js'
import { fetchProject, updateProject } from '../../../shared/api/db.js'

interface Credential {
  label: string
  username: string
  password: string
}

export function ProjectSettings(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectDTO | null>(null)
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

  const addCredential = (): void => {
    setCredentials([...credentials, { label: '', username: '', password: '' }])
  }

  const updateCredential = (index: number, field: keyof Credential, value: string): void => {
    setCredentials(credentials.map((c, i) => i === index ? { ...c, [field]: value } : c))
  }

  const removeCredential = (index: number): void => {
    setCredentials(credentials.filter((_, i) => i !== index))
  }

  const handleSave = async (): Promise<void> => {
    if (!projectId) return
    setSaving(true)
    setError(null)
    setSaved(false)

    try {
      const validCreds = credentials.filter((c) => c.label && c.username && c.password)
      await updateProject(projectId, {
        name,
        baseUrl,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Shell><Spinner size="lg" /></Shell>
  if (!project) return <Shell><p>Project not found</p></Shell>

  return (
    <Shell>
      <div style={{ maxWidth: '560px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-xl)' }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Project Settings</h1>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
            &larr; Back
          </Button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <Field
            label="project_name"
            type="text"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />

          <Field
            label="base_url"
            type="url"
            value={baseUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)}
          />

          <Field
            label="audience"
            multiline
            placeholder="Qui utilise ce produit et pour quoi faire ?"
            value={context.audience}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, audience: e.target.value })}
            rows={2}
          />

          <Field
            label="workflow"
            multiline
            placeholder="Quel est le workflow le plus important ?"
            value={context.workflow}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, workflow: e.target.value })}
            rows={2}
          />

          <Field
            label="quirks"
            multiline
            placeholder="Y a-t-il des termes ou comportements non-évidents ?"
            value={context.quirks}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, quirks: e.target.value })}
            rows={2}
          />

          {/* Credentials */}
          <div style={{
            padding: 'var(--space-md)',
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-lg)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: credentials.length > 0 ? 'var(--space-md)' : 0 }}>
              <div>
                <p style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>
                  Test Credentials
                </p>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' }}>
                  Used by the agent to log in during exploration
                </p>
              </div>
              <Button size="sm" variant="ghost" type="button" onClick={addCredential}>+ Add</Button>
            </div>

            {credentials.map((cred, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
                gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)', alignItems: 'end',
              }}>
                <Field label="label" type="text" placeholder="admin" value={cred.label}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'label', e.target.value)} />
                <Field label="username" type="text" placeholder="user@test.com" value={cred.username}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'username', e.target.value)} />
                <Field label="password" type="password" placeholder="••••••" value={cred.password}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'password', e.target.value)} />
                <Button size="sm" variant="ghost" type="button" onClick={() => removeCredential(i)}>x</Button>
              </div>
            ))}
          </div>

          {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)' }}>{error}</p>}
          {saved && <p style={{ color: 'var(--color-accent-green)', fontSize: 'var(--text-sm)' }}>Saved</p>}

          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>

        {/* Knowledge Base */}
        <KnowledgePanel
          context={project.discoveredContext}
          projectId={projectId!}
          onSaved={(updated) => setProject({ ...project, discoveredContext: updated })}
        />
      </div>
    </Shell>
  )
}

// --- Knowledge Base Panel ---

function KnowledgePanel({
  context,
  projectId,
  onSaved,
}: {
  context: DiscoveredContextDTO | null
  projectId: string
  onSaved: (ctx: DiscoveredContextDTO) => void
}): React.ReactElement {
  const [summary, setSummary] = useState(context?.summary ?? '')
  const [terminology, setTerminology] = useState<[string, string][]>(
    context?.terminology ? Object.entries(context.terminology) : [],
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!context) {
    return (
      <div style={{
        marginTop: 'var(--space-xl)', padding: 'var(--space-lg)',
        backgroundColor: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-lg)', textAlign: 'center',
      }}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 }}>
          No knowledge discovered yet — run an exploration to start building the knowledge base.
        </p>
      </div>
    )
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    try {
      const updated: DiscoveredContextDTO = {
        ...context,
        summary,
        terminology: Object.fromEntries(terminology.filter(([k]) => k.trim())),
      }
      await updateProject(projectId, { discoveredContext: updated })
      onSaved(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const addTerm = (): void => {
    setTerminology([...terminology, ['', '']])
  }

  const updateTerm = (i: number, col: 0 | 1, val: string): void => {
    setTerminology(terminology.map((entry, idx) => {
      if (idx !== i) return entry
      const copy: [string, string] = [...entry]
      copy[col] = val
      return copy
    }))
  }

  const removeTerm = (i: number): void => {
    setTerminology(terminology.filter((_, idx) => idx !== i))
  }

  const statStyle: React.CSSProperties = {
    fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
    padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)',
  }

  const sectionLabel: React.CSSProperties = {
    fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)', margin: '0 0 var(--space-xs)',
  }

  const ago = context.lastUpdated ? formatTimeAgo(context.lastUpdated) : ''

  return (
    <div style={{ marginTop: 'var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: 0 }}>Knowledge Base</h2>

      {/* Coverage stats */}
      <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        <span style={statStyle}>{context.features.length} features</span>
        <span style={statStyle}>{context.siteStructure.length} pages</span>
        <span style={statStyle}>{Object.keys(context.terminology).length} terms</span>
        {ago && <span style={statStyle}>updated {ago}</span>}
      </div>

      {/* Summary — editable */}
      <div>
        <p style={sectionLabel}>summary</p>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          style={{
            width: '100%', fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)',
            background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-md)', padding: 'var(--space-sm)',
            fontFamily: 'var(--font-sans)', resize: 'vertical',
          }}
        />
      </div>

      {/* Terminology — editable */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p style={sectionLabel}>terminology</p>
          <button type="button" onClick={addTerm} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)',
          }}>+ add</button>
        </div>
        {terminology.map(([term, def], i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr 2fr auto',
            gap: 'var(--space-xs)', marginBottom: 'var(--space-xs)', alignItems: 'center',
          }}>
            <input type="text" value={term} onChange={(e) => updateTerm(i, 0, e.target.value)}
              placeholder="term" style={{
                fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', fontWeight: 500,
                background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--color-text-primary)',
              }} />
            <input type="text" value={def} onChange={(e) => updateTerm(i, 1, e.target.value)}
              placeholder="definition" style={{
                fontSize: 'var(--text-sm)', fontFamily: 'var(--font-sans)',
                background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)', padding: '4px 8px', color: 'var(--color-text-secondary)',
              }} />
            <button type="button" onClick={() => removeTerm(i)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
            }}>x</button>
          </div>
        ))}
      </div>

      {/* Features — read-only */}
      {context.features.length > 0 && (
        <div>
          <p style={sectionLabel}>features</p>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
            {context.features.map((f, i) => (
              <span key={i} style={statStyle}>{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* Navigation — read-only */}
      {context.navigation.length > 0 && (
        <div>
          <p style={sectionLabel}>navigation</p>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
            {context.navigation.map((n, i) => (
              <span key={i} style={statStyle}>{n}</span>
            ))}
          </div>
        </div>
      )}

      {/* Site structure — read-only */}
      {context.siteStructure.length > 0 && (
        <div>
          <p style={sectionLabel}>site_structure</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {context.siteStructure.map((url, i) => (
              <span key={i} style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>{url}</span>
            ))}
          </div>
        </div>
      )}

      {saved && <p style={{ color: 'var(--color-accent-green)', fontSize: 'var(--text-sm)' }}>Knowledge saved</p>}

      <Button onClick={() => void handleSave()} disabled={saving}>
        {saving ? 'Saving...' : 'Save Knowledge'}
      </Button>
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
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
