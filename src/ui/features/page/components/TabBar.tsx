import { useEffect, useRef, useState } from 'react'
import { Tooltip, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type TabDTO, type TabWithCountDTO } from '../../../shared/api/client.js'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import styles from './TabBar.module.css'

interface TabBarProps {
  projectId: string
  tabs: TabWithCountDTO[]
  activeTabId: string | null
  onActiveTabChange: (tabId: string) => void
  onTabsChange: (tabs: TabWithCountDTO[]) => void
}

/**
 * Horizontal tab bar shown above the page tree. Reorder via drag,
 * rename via double-click, create via the "+" button at the end, delete
 * via the contextual "…" menu — which routes through a confirm dialog
 * that asks for a move-target tab when the source has pages.
 */
export function TabBar({ projectId, tabs, activeTabId, onActiveTabChange, onTabsChange }: TabBarProps): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const { confirm, dialog } = useConfirmDialog()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => {
    if (editingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    if (adding && addInputRef.current) addInputRef.current.focus()
  }, [adding])

  const commitRename = async (tab: TabDTO): Promise<void> => {
    const next = draftName.trim()
    if (!next || next === tab.name) {
      setEditingId(null)
      return
    }
    setBusy(true)
    try {
      const updated = await api.tabs.update(projectId, tab.id, { name: next })
      onTabsChange(tabs.map((t) => (t.id === tab.id ? { ...t, ...updated } : t)))
      setEditingId(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const commitAdd = async (): Promise<void> => {
    const name = addName.trim()
    if (!name) { setAdding(false); return }
    setBusy(true)
    try {
      const created = await api.tabs.create(projectId, { name })
      onTabsChange([...tabs, { ...created, pageCount: 0 }])
      onActiveTabChange(created.id)
      setAdding(false)
      setAddName('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (tab: TabWithCountDTO): Promise<void> => {
    if (tabs.length <= 1) {
      setError('A project must keep at least one tab')
      return
    }
    const otherTabs = tabs.filter((t) => t.id !== tab.id)

    let moveToTabId: string | undefined
    if (tab.pageCount > 0) {
      // Pages exist → force-pick a destination tab. We use a native
      // <select> inside the confirm dialog body — simple, accessible,
      // and the move target is the only knob anyway.
      moveToTabId = otherTabs[0]!.id
      const ok = await confirm({
        title: `Delete "${tab.name}"?`,
        message: (
          <div className={styles.dialogBody}>
            <p>
              This tab contains <strong>{tab.pageCount} page{tab.pageCount === 1 ? '' : 's'}</strong>. They will be moved to:
            </p>
            <select
              className={styles.moveSelect}
              defaultValue={moveToTabId}
              onChange={(e) => { moveToTabId = e.target.value }}
              autoFocus
            >
              {otherTabs.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className={styles.dialogHint}>The tab itself will be deleted. This cannot be undone.</p>
          </div>
        ),
        confirmLabel: 'Move pages & delete tab',
        variant: 'danger',
      })
      if (!ok) return
    } else {
      const ok = await confirm({
        title: `Delete "${tab.name}"?`,
        message: 'This tab is empty. Deleting cannot be undone.',
        confirmLabel: 'Delete tab',
        variant: 'danger',
      })
      if (!ok) return
    }

    setBusy(true)
    try {
      await api.tabs.delete(projectId, tab.id, moveToTabId)
      const remaining = tabs.filter((t) => t.id !== tab.id)
      // Mirror the page move client-side so the count reflects the
      // server state without an extra round-trip.
      if (moveToTabId && tab.pageCount > 0) {
        for (const t of remaining) {
          if (t.id === moveToTabId) t.pageCount += tab.pageCount
        }
      }
      onTabsChange(remaining)
      if (activeTabId === tab.id && remaining[0]) onActiveTabChange(remaining[0].id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = tabs.findIndex((t) => t.id === active.id)
    const newIndex = tabs.findIndex((t) => t.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(tabs, oldIndex, newIndex)
    // Optimistic update — revert on server failure.
    onTabsChange(reordered)
    try {
      await api.tabs.reorder(projectId, reordered.map((t) => t.id))
    } catch (err) {
      setError((err as Error).message)
      onTabsChange(tabs)
    }
  }

  return (
    <>
      <div className={styles.bar} role="tablist" aria-label="Project tabs">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                editing={editingId === tab.id}
                draftName={draftName}
                onSelect={() => onActiveTabChange(tab.id)}
                onStartRename={() => { setEditingId(tab.id); setDraftName(tab.name) }}
                onDraftChange={setDraftName}
                onCommitRename={() => void commitRename(tab)}
                onCancelRename={() => setEditingId(null)}
                onDelete={() => void handleDelete(tab)}
                renameInputRef={renameInputRef}
              />
            ))}
          </SortableContext>
        </DndContext>

        {adding ? (
          <div className={styles.addInput}>
            <input
              ref={addInputRef}
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onBlur={() => void commitAdd()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitAdd() }
                if (e.key === 'Escape') { setAdding(false); setAddName('') }
              }}
              placeholder="Tab name"
              disabled={busy}
              maxLength={40}
            />
          </div>
        ) : (
          <Tooltip content="Add tab" placement="bottom">
            <button
              className={styles.addBtn}
              onClick={() => setAdding(true)}
              disabled={busy}
              aria-label="Add tab"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
            </button>
          </Tooltip>
        )}
      </div>

      {error && (
        <div className={styles.errorBar} role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {dialog}
    </>
  )
}

interface SortableTabProps {
  tab: TabWithCountDTO
  active: boolean
  editing: boolean
  draftName: string
  onSelect: () => void
  onStartRename: () => void
  onDraftChange: (v: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onDelete: () => void
  renameInputRef: React.RefObject<HTMLInputElement | null>
}

function SortableTab({ tab, active, editing, draftName, onSelect, onStartRename, onDraftChange, onCommitRename, onCancelRename, onDelete, renameInputRef }: SortableTabProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  if (editing) {
    return (
      <div ref={setNodeRef} style={style} className={`${styles.tab} ${styles.tabEditing}`}>
        <input
          ref={renameInputRef}
          type="text"
          value={draftName}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onCommitRename() }
            if (e.key === 'Escape') onCancelRename()
          }}
          maxLength={40}
        />
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.tab} ${active ? styles.tabActive : ''}`}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
    >
      <span className={styles.tabName}>{tab.name}</span>
      <button
        className={styles.tabMenu}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Delete tab ${tab.name}`}
        title="Delete tab"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" /><path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  )
}
