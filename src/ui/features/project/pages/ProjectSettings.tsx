import { type ChangeEvent, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field, Spinner } from '../../../design-system/components/index.js'
import { api, type ProjectDTO } from '../../../shared/api/client.js'

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
    api.projects.get(projectId).then((p) => {
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
      await api.projects.update(projectId, {
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
      </div>
    </Shell>
  )
}
