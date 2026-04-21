import { defaultProps } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'

export type CalloutType = 'info' | 'tip' | 'warning' | 'danger'

interface CalloutMeta {
  label: string
  color: string
  bg: string
}

// Callout colors are pinned to hex values (rather than CSS vars) so the
// admin BlockEditor view and the public docs page (which overrides
// --color-primary with the project's accent) render identical callouts.
// Info stays a neutral warm grey, Tip/Warning/Danger use their semantic
// colors at 10% tint on a white-ish background.
const META: Record<CalloutType, CalloutMeta> = {
  info: {
    label: 'Info',
    color: '#1A1A1A',
    bg: '#F3F4F6',
  },
  tip: {
    label: 'Tip',
    color: '#10B981',
    bg: 'color-mix(in srgb, #10B981 10%, #FFFFFF)',
  },
  warning: {
    label: 'Warning',
    color: '#F59E0B',
    bg: 'color-mix(in srgb, #F59E0B 10%, #FFFFFF)',
  },
  danger: {
    label: 'Danger',
    color: '#EF4444',
    bg: 'color-mix(in srgb, #EF4444 10%, #FFFFFF)',
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
      //
      // The second child must be a block-level HTML element that Turndown
      // keeps INSIDE the blockquote during HTML→markdown export — a <div>
      // gets hoisted out into a sibling paragraph, stripping the content
      // from the callout. A <p> stays nested and round-trips cleanly.
      const type = ((block.props.calloutType as string) ?? 'info').toUpperCase()
      return (
        <blockquote data-callout-type={type}>
          <p>[!{type}]</p>
          <p ref={contentRef} />
        </blockquote>
      )
    },
  },
)
