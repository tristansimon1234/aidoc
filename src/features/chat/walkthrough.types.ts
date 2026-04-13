import type { ChatMessage, UserContext } from './chat.types.js'

/** Lightweight representation of a single interactive DOM element */
export interface DomElement {
  ref: string
  tag: string
  text: string
  role: string
  ariaLabel: string
  rect: { x: number; y: number; w: number; h: number }
  selector: string
  placeholder: string
}

/** DOM snapshot sent from widget to backend */
export interface DomSnapshot {
  url: string
  title: string
  viewport: { width: number; height: number }
  elements: DomElement[]
}

/** A step the user already completed */
export interface CompletedStep {
  instruction: string
  action: string
  pageUrl: string
}

/** A single walkthrough step returned by AI */
export interface WalkthroughStep {
  instruction: string
  action: 'click' | 'type' | 'select' | 'scroll' | 'observe' | 'navigate'
  elementRef: string | null
  fallbackSelector: string | null
  typeValue: string | null
}

/** Progressive walkthrough response — one step at a time */
export interface WalkthroughResponse {
  done: boolean
  step: WalkthroughStep | null
  stepNumber: number
  hint: string | null
}

/** Progressive walkthrough request */
export interface WalkthroughRequest {
  message: string
  history: ChatMessage[]
  domSnapshot: DomSnapshot
  completedSteps: CompletedStep[]
  userContext?: UserContext
}
