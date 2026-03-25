export interface PageSnapshot {
  url: string
  title: string
  screenshot: Buffer
}

export interface ObservedAction {
  description: string
  selector: string
}
