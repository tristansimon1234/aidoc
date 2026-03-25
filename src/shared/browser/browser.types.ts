export interface PageSnapshot {
  url: string
  title: string
  screenshot: Buffer
}

export interface BrowserAction {
  type: 'click' | 'fill' | 'navigate' | 'select'
  selector?: string
  value?: string
  url?: string
}
