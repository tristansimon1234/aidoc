import type { ChatMessage, UserContext } from './chat.types.js'

/** Lightweight representation of a single interactive DOM element */
export interface DomElement {
  /** Stable identifier: data-testid, id, or positional hash */
  ref: string
  /** HTML tag name lowercased */
  tag: string
  /** Visible text content, truncated to 100 chars */
  text: string
  /** ARIA role or inferred role */
  role: string
  /** ARIA label if present */
  ariaLabel: string
  /** Bounding rect relative to viewport */
  rect: { x: number; y: number; w: number; h: number }
  /** Short CSS selector path (fallback matching) */
  selector: string
  /** Placeholder text for inputs */
  placeholder: string
}

/** DOM snapshot sent from widget to backend */
export interface DomSnapshot {
  /** Current page URL */
  url: string
  /** Page title */
  title: string
  /** Viewport dimensions */
  viewport: { width: number; height: number }
  /** Interactive elements visible in viewport (max 200) */
  elements: DomElement[]
}

/** A single walkthrough step returned by AI */
export interface WalkthroughStep {
  /** 1-based step number */
  stepNumber: number
  /** Human-readable instruction */
  instruction: string
  /** Action type for visual styling */
  action: 'click' | 'type' | 'select' | 'scroll' | 'observe' | 'navigate'
  /** Reference to DomElement.ref that this step targets, null if not found */
  elementRef: string | null
  /** Fallback CSS selector if ref matching fails */
  fallbackSelector: string | null
  /** For 'type' actions: what text to enter */
  typeValue: string | null
  /** Whether this step could not be matched to any visible element */
  notFound: boolean
}

/** Full walkthrough response from backend */
export interface WalkthroughResponse {
  steps: WalkthroughStep[]
  /** Total steps in the full guide */
  totalSteps: number
  /** Message if some steps are on a different page */
  pageNote: string | null
}

/** Request body for walkthrough endpoint */
export interface WalkthroughRequest {
  /** The original user question (for RAG context) */
  message: string
  /** Chat history for context */
  history: ChatMessage[]
  /** DOM snapshot of the current page */
  domSnapshot: DomSnapshot
  /** Optional user context */
  userContext?: UserContext
}
