export const tokens = {
  colors: {
    bg: {
      base: '#0C0C0E',
      surface: '#141416',
      elevated: '#1C1C1F',
      overlay: '#242428',
    },
    border: {
      subtle: '#2A2A2E',
      default: '#3A3A3F',
      strong: '#5A5A62',
    },
    text: {
      primary: '#F2F2F4',
      secondary: '#9898A6',
      muted: '#5C5C6B',
      inverse: '#0C0C0E',
    },
    accent: {
      blue: '#4D9CFF',
      green: '#3DD68C',
      amber: '#F5A623',
      red: '#FF4D4D',
      purple: '#A78BFA',
    },
    status: {
      pending: { bg: '#1A1A20', text: '#9898A6', border: '#3A3A3F' },
      running: { bg: '#0D1F35', text: '#4D9CFF', border: '#1A3A5C' },
      blocked: { bg: '#2D1A0A', text: '#F5A623', border: '#4A2D10' },
      completed: { bg: '#0A1F16', text: '#3DD68C', border: '#124D2C' },
      failed: { bg: '#1F0A0A', text: '#FF4D4D', border: '#4D1212' },
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
    sm: '4px',
    md: '6px',
    lg: '10px',
    full: '9999px',
  },
  font: {
    sans: "'Geist', 'DM Sans', system-ui, sans-serif",
    mono: "'Geist Mono', 'JetBrains Mono', monospace",
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
    sm: '0 1px 2px rgba(0,0,0,0.4)',
    md: '0 4px 12px rgba(0,0,0,0.5)',
    lg: '0 8px 32px rgba(0,0,0,0.6)',
  },
} as const

export type Tokens = typeof tokens
export type StatusKey = keyof typeof tokens.colors.status
