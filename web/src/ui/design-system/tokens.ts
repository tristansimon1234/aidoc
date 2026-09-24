export const tokens = {
  colors: {
    bg: '#FFFFFF',
    card: '#FFFFFF',
    secondary: '#F7F7F8',
    fg: '#1A1A1A',
    mutedFg: '#6B7280',
    primary: '#1A1A1A',
    primaryHover: '#333333',
    destructive: '#EF4444',
    success: '#10B981',
    warning: '#F59E0B',
    border: '#E5E7EB',
    accent: '#F3F4F6',
    status: {
      pending: { bg: '#F3F4F6', text: '#6B7280', border: '#E5E7EB' },
      running: { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE' },
      blocked: { bg: '#FFFBEB', text: '#D97706', border: '#FDE68A' },
      completed: { bg: '#ECFDF5', text: '#059669', border: '#A7F3D0' },
      failed: { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA' },
    },
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '40px',
    '2xl': '64px',
  },
  radius: {
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    full: '9999px',
  },
  font: {
    sans: "'Inter', system-ui, -apple-system, sans-serif",
    heading: "'Inter', system-ui, -apple-system, sans-serif",
    mono: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace",
  },
  fontSize: {
    xs: '11px',
    sm: '13px',
    base: '14px',
    md: '16px',
    lg: '20px',
    xl: '28px',
    '2xl': '40px',
  },
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.04)',
    md: '0 2px 8px rgba(0,0,0,0.06)',
    lg: '0 8px 24px rgba(0,0,0,0.08)',
  },
} as const

export type Tokens = typeof tokens
export type StatusKey = keyof typeof tokens.colors.status
