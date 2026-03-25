import React from 'react'
import { tokens } from '../tokens.js'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language }: CodeBlockProps): React.ReactElement {
  return (
    <div
      style={{
        position: 'relative',
        backgroundColor: tokens.colors.bg.base,
        border: `1px solid ${tokens.colors.border.subtle}`,
        borderRadius: tokens.radius.md,
        overflow: 'hidden',
      }}
    >
      {language && (
        <div
          style={{
            padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`,
            fontSize: tokens.fontSize.xs,
            fontFamily: tokens.font.mono,
            color: tokens.colors.text.muted,
            backgroundColor: tokens.colors.bg.surface,
            borderBottom: `1px solid ${tokens.colors.border.subtle}`,
          }}
        >
          {language}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: tokens.spacing.md,
          fontSize: tokens.fontSize.sm,
          fontFamily: tokens.font.mono,
          color: tokens.colors.text.primary,
          overflowX: 'auto',
          lineHeight: 1.6,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}
