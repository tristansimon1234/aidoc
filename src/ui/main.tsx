import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { initBrowserSentry } from './shared/observability/sentry.js'
import './design-system/globals.css'

// Init first so errors thrown during the initial render reach Sentry.
initBrowserSentry()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
