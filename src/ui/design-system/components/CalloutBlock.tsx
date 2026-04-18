import { defaultProps } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'

export type CalloutType = 'info' | 'tip' | 'warning' | 'danger'

interface CalloutMeta {
  label: string
  color: string
  bg: string
}

const META: Record<CalloutType, CalloutMeta> = {
  info: {
    label: 'Info',
    color: 'var(--color-primary)',
    bg: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
  },
  tip: {
    label: 'Tip',
    color: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
  },
  warning: {
    label: 'Warning',
    color: 'var(--color-warning)',
    bg: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
  },
  danger: {
    label: 'Danger',
    color: 'var(--color-destructive)',
    bg: 'color-mix(in srgb, var(--color-destructive) 10%, transparent)',
  },
}

// Custom BlockNote block. Schema-managed = ProseMirror happy. Markdown
// round-trip uses GitHub-style alert syntax via toExternalHTML so saving
// gives `> [!TIP]\n> content` and reloading re-promotes those blockquotes
// to callouts in BlockEditor's content-load step.
export const Callout = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      ...defaultProps,
      calloutType: {
        default: 'info',
        values: ['info', 'tip', 'warning', 'danger'],
      },
    },
    content: 'inline',
  },
  {
    render: ({ block, contentRef }) => {
      const type = (block.props.calloutType as CalloutType) ?? 'info'
      const meta = META[type] ?? META.info
      return (
        <div
          style={{
            padding: 'var(--space-md)',
            borderRadius: 'var(--radius-lg)',
            borderLeft: `3px solid ${meta.color}`,
            background: meta.bg,
            margin: 'var(--space-sm) 0',
            width: '100%',
          }}
        >
          <div
            contentEditable={false}
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: meta.color,
              marginBottom: 'var(--space-xs)',
              userSelect: 'none',
            }}
          >
            {meta.label}
          </div>
          <div ref={contentRef} style={{ flex: 1 }} />
        </div>
      )
    },
    toExternalHTML: ({ block, contentRef }) => {
      // Save as a GitHub-style alert blockquote so the markdown is
      // standard and self-explanatory:
      //   > [!TIP]
      //   > Some content
      const type = ((block.props.calloutType as string) ?? 'info').toUpperCase()
      return (
        <blockquote data-callout-type={type}>
          <p>[!{type}]</p>
          <div ref={contentRef} />
        </blockquote>
      )
    },
  },
)
