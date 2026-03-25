import React from 'react'
import { tokens, type StatusKey } from '../tokens.js'

interface StatusIndicatorProps {
  status: StatusKey
  label?: string
}

export function StatusIndicator({ status, label }: StatusIndicatorProps): React.ReactElement {
  const statusStyle = tokens.colors.status[status]
  const displayLabel = label ?? status

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing.xs,
        padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`,
        fontSize: tokens.fontSize.xs,
        fontFamily: tokens.font.mono,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: statusStyle.text,
        backgroundColor: statusStyle.bg,
        border: `1px solid ${statusStyle.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: tokens.radius.full,
          backgroundColor: statusStyle.text,
        }}
      />
      {displayLabel}
    </span>
  )
}
