import { type ChangeEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field } from '../../../design-system/components/index.js'
import { api } from '../../../shared/api/client.js'
import styles from './NewProject.module.css'

export function NewProject(): React.ReactElement {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [description, setDescription] = useState('')
  const [context, setContext] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    api.projects
      .create({
        name,
        baseUrl,
        description: description || undefined,
        context: context || undefined,
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
            label="description"
            multiline
            placeholder="Brief description of your product"
            value={description}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            rows={2}
          />

          <Field
            label="product_context"
            multiline
            placeholder="Detailed context: what the product does, who it's for, key features, terminology. This context will be injected into every AI exploration and doc generation."
            value={context}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContext(e.target.value)}
            rows={5}
          />

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
