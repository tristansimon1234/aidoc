import { useState } from 'react'
import { Button } from '../../../design-system/components/index.js'
import { api, type ProjectDTO, type DocPageDTO } from '../../../shared/api/client.js'
import { updatePage as dbUpdatePage } from '../../../shared/api/db.js'
import styles from './SharePanel.module.css'

type ShareTab = 'share' | 'publish' | 'widget'

export function SharePanel({
  project,
  page,
  projectId,
  pageId,
  onClose,
  onPageUpdate,
}: {
  project: ProjectDTO
  page: DocPageDTO
  projectId: string
  pageId: string
  onClose: () => void
  onPageUpdate: (updates: Partial<DocPageDTO>) => void
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ShareTab>('publish')

  const tabs: { id: ShareTab; label: string }[] = [
    { id: 'share', label: 'Share' },
    { id: 'publish', label: 'Publish' },
    { id: 'widget', label: 'Widget' },
  ]

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.panel}>
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
          {activeTab === 'publish' && (
            <PublishTabContent page={page} projectId={projectId} pageId={pageId} onPageUpdate={onPageUpdate} />
          )}
          {activeTab === 'widget' && (
            <WidgetTabContent project={project} />
          )}
        </div>
      </div>
    </>
  )
}

// --- Share tab (placeholder) ---

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

function PublishTabContent({
  page, projectId, pageId, onPageUpdate,
}: {
  page: DocPageDTO; projectId: string; pageId: string
  onPageUpdate: (updates: Partial<DocPageDTO>) => void
}): React.ReactElement {
  const [toggling, setToggling] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleToggle = async (): Promise<void> => {
    setToggling(true)
    try {
      const newValue = !page.isPublic
      await dbUpdatePage(projectId, pageId, { isPublic: newValue })
      onPageUpdate({ isPublic: newValue })
    } finally { setToggling(false) }
  }

  const publicUrl = `${window.location.origin}/docs/${page.slug}`

  const copyUrl = (): void => {
    void navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className={styles.publishRow}>
        <div className={styles.publishLabel}>
          <span className={styles.publishTitle}>Publish to web</span>
          <span className={styles.publishDesc}>
            {page.isPublic ? 'Anyone with the link can view this page' : 'Only you can see this page'}
          </span>
        </div>
        <button
          className={`${styles.toggle} ${page.isPublic ? styles.toggleOn : ''}`}
          onClick={() => void handleToggle()}
          disabled={toggling}
        />
      </div>

      {page.isPublic && (
        <div className={styles.urlRow}>
          <div className={styles.urlBox}>{publicUrl}</div>
          <button className={styles.copyBtn} onClick={copyUrl}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
      )}

      <div style={{ marginTop: 'var(--space-md)' }}>
        <span className={`${styles.statusPill} ${page.isPublic ? styles.statusPublished : styles.statusDraft}`}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
          {page.isPublic ? 'Published' : 'Draft'}
        </span>
      </div>
    </div>
  )
}

// --- Widget tab ---

function WidgetTabContent({ project }: { project: ProjectDTO }): React.ReactElement {
  const [generating, setGenerating] = useState(false)
  const [widgetKey, setWidgetKey] = useState(project.widgetApiKey)
  const [widgetEnabled, setWidgetEnabled] = useState(project.widgetEnabled)
  const [copied, setCopied] = useState<string | null>(null)

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

  const origin = window.location.origin
  const snippet = widgetKey
    ? `<script src="${origin}/widget.js"\n  data-key="${widgetKey}"\n></script>`
    : ''

  if (!widgetKey) {
    return (
      <div style={{ textAlign: 'center', padding: 'var(--space-md) 0' }}>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', marginBottom: 'var(--space-md)' }}>
          Add an AI chat widget to your app. Your users ask questions — the widget answers from your docs.
        </p>
        <Button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Generating...' : 'Enable Widget'}
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.widgetSection}>
      <div className={styles.field}>
        <label className={styles.label}>
          API Key {widgetEnabled
            ? <span className={styles.statusActive}>active</span>
            : <span className={styles.statusDisabled}>disabled</span>}
        </label>
        <div className={styles.codeBlock}>
          {widgetKey}
          <button className={styles.codeCopy} onClick={() => copy(widgetKey, 'key')}>
            {copied === 'key' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

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

      <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
        <Button size="sm" variant="secondary" onClick={() => void handleGenerate()} disabled={generating}>
          Regenerate
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
