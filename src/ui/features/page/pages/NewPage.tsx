import { type ChangeEvent, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Field } from '../../../design-system/components/index.js'
import { createPage } from '../../../shared/api/db.js'

export function NewPage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTitleChange = (val: string): void => {
    setTitle(val)
    if (!slug || slug === toSlug(title)) {
      setSlug(toSlug(val))
    }
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!projectId) return
    setSubmitting(true)
    setError(null)

    createPage(projectId, {
        title,
        slug,
        startUrl: startUrl || undefined,
        goal: goal || undefined,
      })
      .then((page) => navigate(`/projects/${projectId}/pages/${page.id}`))
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xl)' }}>
        New Page
      </h1>

      <form style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)', maxWidth: '480px' }} onSubmit={handleSubmit}>
        <Field
          label="title"
          type="text"
          placeholder="e.g. Getting Started"
          value={title}
          onChange={(e: ChangeEvent<HTMLInputElement>) => handleTitleChange(e.target.value)}
          required
        />

        <Field
          label="slug"
          type="text"
          placeholder="e.g. getting-started"
          value={slug}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSlug(e.target.value)}
          required
        />

        <Field
          label="start_url"
          type="text"
          placeholder="https://myapp.com/feature or /feature (relative)"
          value={startUrl}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setStartUrl(e.target.value)}
        />

        <Field
          label="goal"
          multiline
          placeholder="What should this page document?"
          value={goal}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)}
          rows={3}
        />

        {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Page'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => navigate(`/projects/${projectId}`)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
