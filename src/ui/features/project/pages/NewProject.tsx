import { type ChangeEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field } from '../../../design-system/components/index.js'
import { createProject } from '../../../shared/api/db.js'
import styles from './NewProject.module.css'

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
      <div className={styles.container}>
        <h1 className={styles.title}>New Project</h1>

        <form className={styles.form} onSubmit={handleSubmit}>
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

          <Field
            label="audience"
            multiline
            placeholder="e.g. SaaS product managers who need to track feature adoption"
            value={context.audience}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, audience: e.target.value })}
            rows={2}
          />
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '-12px 0 0' }}>Who uses this product and what do they use it for?</p>

          <Field
            label="workflow"
            multiline
            placeholder="e.g. User creates a project, adds team members, sets up integrations, runs first report"
            value={context.workflow}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, workflow: e.target.value })}
            rows={2}
          />
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '-12px 0 0' }}>What is the most important user journey?</p>

          <Field
            label="quirks"
            multiline
            placeholder="e.g. 'Workspace' means a team account. The 'Archive' button is hidden until 5+ items exist."
            value={context.quirks}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext({ ...context, quirks: e.target.value })}
            rows={2}
          />
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '-12px 0 0' }}>Non-obvious terms, hidden behaviors, or domain-specific knowledge the agent won&apos;t guess from the UI.</p>

          {/* Credentials section */}
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
                  The agent will use these to log in during exploration
                </p>
              </div>
              <Button size="sm" variant="ghost" type="button" onClick={addCredential}>
                + Add
              </Button>
            </div>

            {credentials.map((cred, i) => (
              <div key={i} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr auto',
                gap: 'var(--space-sm)',
                marginBottom: 'var(--space-sm)',
                alignItems: 'end',
              }}>
                <Field
                  label="label"
                  type="text"
                  placeholder="e.g. admin"
                  value={cred.label}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'label', e.target.value)}
                />
                <Field
                  label="username"
                  type="text"
                  placeholder="user@example.com"
                  value={cred.username}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'username', e.target.value)}
                />
                <Field
                  label="password"
                  type="password"
                  placeholder="••••••••"
                  value={cred.password}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updateCredential(i, 'password', e.target.value)}
                />
                <Button size="sm" variant="ghost" type="button" onClick={() => removeCredential(i)}>
                  x
                </Button>
              </div>
            ))}
          </div>

          {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)' }}>{error}</p>}

          <div className={styles.actions}>
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
