export interface AnthropicUsage {
  inputTokens: number
  outputTokens: number
}

export interface AnthropicResponse {
  content: string
  usage: AnthropicUsage
}
