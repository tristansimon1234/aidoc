export const tokens = {
  colors: {
    bg: '#F6F9FC',
    card: '#FFFFFF',
    secondary: '#EDF0F4',
    fg: '#0A2540',
    mutedFg: '#425466',
    primary: '#635BFF',
    primaryHover: '#4F46E5',
    destructive: '#CD3D64',
    success: '#09825D',
    warning: '#E08A09',
    border: '#E6EBF1',
    accent: '#EEEAFF',
    status: {
      pending: { bg: '#F0F0F3', text: '#425466', border: '#E6EBF1' },
      running: { bg: '#EEF0FF', text: '#635BFF', border: '#D4D0FF' },
      blocked: { bg: '#FFF5E6', text: '#B87A00', border: '#FFE0A3' },
      completed: { bg: '#E8F7F0', text: '#09825D', border: '#B4E6D0' },
      failed: { bg: '#FDE8EC', text: '#CD3D64', border: '#F9C2CE' },
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
    sm: '2px',
    md: '4px',
    lg: '6px',
    xl: '10px',
    full: '9999px',
  },
  font: {
    sans: "'Mona Sans Variable', 'Mona Sans', system-ui, -apple-system, sans-serif",
    heading: "'Hubot Sans Variable', 'Hubot Sans', system-ui, -apple-system, sans-serif",
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
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 12px rgba(0,0,0,0.08)',
    lg: '0 12px 40px rgba(0,0,0,0.12)',
  },
} as const

export type Tokens = typeof tokens
export type StatusKey = keyof typeof tokens.colors.status
