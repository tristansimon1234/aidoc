import { type ChangeEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field } from '../../../design-system/components/index.js'
import { createProject } from '../../../shared/api/db.js'

interface Credential {
  label: string
  username: string
  password: string
}

export function NewProject(): React.ReactElement {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [context, setContext] = useState({ audience: '', workflow: '', quirks: '' })
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addCredential = (): void => {
    setCredentials([...credentials, { label: '', username: '', password: '' }])
  }

  const updateCredential = (index: number, field: keyof Credential, value: string): void => {
    setCredentials(credentials.map((c, i) => i === index ? { ...c, [field]: value } : c))
  }

  const removeCredential = (index: number): void => {
    setCredentials(credentials.filter((_, i) => i !== index))
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const validCreds = credentials.filter((c) => c.label && c.username && c.password)

    createProject({
        name,
        baseUrl,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
      })
      .then((p) => navigate(`/projects/${p.id}`))
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <Shell>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xl)' }}>New Project</h1>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-xl)', alignItems: 'start' }}>

            {/* Left: Essentials */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-accent-blue)', color: 'white', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>1</span>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Product</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                  <Field
                    label="project_name"
                    type="text"
                    placeholder="e.g. My SaaS App"
                    value={name}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    required
                  />
                  <Field
                    label="base_url"
                    type="url"
                    placeholder="https://myapp.com"
                    value={baseUrl}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setBaseUrl(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Credentials */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-accent-blue)', color: 'white', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>2</span>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Test Credentials</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>optional</span>
                </div>
                <div style={{
                  padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
                }}>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-sm)' }}>
                    The agent uses these to log in during exploration. Add them here or later in Settings.
                  </p>
                  {credentials.map((cred, i) => (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
                      gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)', alignItems: 'end',
                    }}>
                      <Field label="label" type="text" placeholder="e.g. admin" value={cred.label}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'label', e.target.value)} />
                      <Field label="username" type="text" placeholder="user@example.com" value={cred.username}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'username', e.target.value)} />
                      <Field label="password" type="password" placeholder="••••••••" value={cred.password}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'password', e.target.value)} />
                      <Button size="sm" variant="ghost" type="button" onClick={() => removeCredential(i)}>x</Button>
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" type="button" onClick={addCredential}>+ Add credentials</Button>
                </div>
              </div>
            </div>

            {/* Right: Product context */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-accent-blue)', color: 'white', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>3</span>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Product Context</span>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-md)', lineHeight: 1.4 }}>
                  Help the AI understand your product. This context is injected into every exploration and doc generation.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                  <div>
                    <Field
                      label="audience"
                      multiline
                      placeholder="e.g. SaaS product managers who need to track feature adoption"
                      value={context.audience}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, audience: e.target.value })}
                      rows={2}
                    />
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>Who uses this product and what do they use it for?</p>
                  </div>
                  <div>
                    <Field
                      label="workflow"
                      multiline
                      placeholder="e.g. User creates a project, adds team members, sets up integrations, runs first report"
                      value={context.workflow}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, workflow: e.target.value })}
                      rows={2}
                    />
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>What is the most important user journey?</p>
                  </div>
                  <div>
                    <Field
                      label="quirks"
                      multiline
                      placeholder="e.g. 'Workspace' means a team account. The 'Archive' button is hidden until 5+ items exist."
                      value={context.quirks}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, quirks: e.target.value })}
                      rows={2}
                    />
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>Non-obvious terms, hidden behaviors, or domain-specific knowledge.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-md)' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-xl)' }}>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Project'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => navigate('/')}>Cancel</Button>
          </div>
        </form>
      </div>
    </Shell>
  )
}
