import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import { z } from 'zod'
import { env } from '../config/env.js'

// --- Shared Gemini client ---

// Default model — Flash is fast and smart enough for 95% of queries.
// chat.service routes complex questions to Pro via the `model` override.
const GEMINI_MODEL = 'gemini-2.5-flash'
export const GEMINI_PRO_MODEL = 'gemini-2.5-pro'

function getGenAI(): GoogleGenerativeAI {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured')
  return new GoogleGenerativeAI(env.GEMINI_API_KEY)
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 429 && attempt < maxRetries) {
        const waitSec = Math.min(30 * (attempt + 1), 90)
        console.log(`[gemini] Rate limited, retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})`)
        await new Promise((r) => setTimeout(r, waitSec * 1000))
        continue
      }
      throw err
    }
  }
  throw new Error('Unreachable')
}

// --- Generic text generation ---

export interface GeminiUsage {
  inputTokens: number
  outputTokens: number
}

export async function generateText(opts: {
  systemPrompt?: string
  userPrompt: string
  maxTokens?: number
  /** Sampling temperature, 0.0–1.0. Lower = more deterministic. */
  temperature?: number
  /** Override default model (e.g. switch to Pro for complex queries). */
  model?: string
  /** Force Gemini to emit a valid JSON response (no prose, no code fences). */
  json?: boolean
}): Promise<{ text: string; usage: GeminiUsage }> {
  const genAI = getGenAI()
  const model = genAI.getGenerativeModel({
    model: opts.model ?? GEMINI_MODEL,
    ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
  })

  const result = await withRetry(() =>
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  )

  const usage = result.response.usageMetadata
  return {
    text: result.response.text(),
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
  }
}

// --- Embeddings ---

const EMBEDDING_DIMENSIONS = 768

// Auto-discover the first available embedding model
let _cachedEmbeddingModel: string | null = null

async function getEmbeddingModel(): Promise<string> {
  if (_cachedEmbeddingModel) return _cachedEmbeddingModel

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`,
  )
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`)

  const data = (await res.json()) as { models: { name: string; supportedGenerationMethods: string[] }[] }
  const embeddingModel = data.models.find((m) =>
    m.supportedGenerationMethods.includes('embedContent'),
  )

  if (!embeddingModel) throw new Error('No embedding model available for this API key')

  _cachedEmbeddingModel = embeddingModel.name.replace('models/', '')
  console.log(`[gemini] Using embedding model: ${_cachedEmbeddingModel}`)
  return _cachedEmbeddingModel
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured')

  const model = await getEmbeddingModel()
  const results: number[][] = []

  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100)
    const response = await withRetry(async () => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBEDDING_DIMENSIONS,
            })),
          }),
        },
      )
      if (!res.ok) {
        const errBody = await res.text()
        console.error(`[gemini] Embedding error ${res.status}:`, errBody)
        const err = new Error(`Embedding failed: ${res.status} ${res.statusText}`) as Error & { status: number }
        err.status = res.status
        throw err
      }
      return res.json() as Promise<{ embeddings: { values: number[] }[] }>
    })
    for (const emb of response.embeddings) {
      results.push(emb.values)
    }
  }
  return results
}

export async function embedText(text: string): Promise<number[]> {
  const results = await embedTexts([text])
  return results[0]!
}

/**
 * Each step exposes two timestamps so the doc generator can pick the most
 * pedagogically useful frame:
 *  - actionAt: cursor on the element / moment of the click. Use when the
 *    screenshot's job is "show where to click".
 *  - resultAt: page settled after any loading. Use when the screenshot's
 *    job is "show what changed". Equal to actionAt for synchronous steps
 *    (no loading, no transition).
 *  - screenshotIntent: Gemini's call on which frame illustrates this step
 *    best. The doc generator extracts the frame at the corresponding ts.
 *
 * Backwards-compat: if Gemini returns the legacy `timestamp` field only
 * (prompt drift, cached cassette), we fan it out to both fields with
 * intent='result' to match the previous result-biased behavior.
 */
const VideoStepSchema = z.object({
  actionAt: z.number().optional(),
  resultAt: z.number().optional(),
  screenshotIntent: z.enum(['action', 'result']).default('result'),
  timestamp: z.number().optional(),
  screenDescription: z.string(),
  userAction: z.string(),
  narration: z.string().nullable(),
}).transform((s) => {
  const fallback = s.timestamp ?? s.actionAt ?? s.resultAt ?? 0
  return {
    actionAt: s.actionAt ?? fallback,
    resultAt: s.resultAt ?? fallback,
    screenshotIntent: s.screenshotIntent,
    screenDescription: s.screenDescription,
    userAction: s.userAction,
    narration: s.narration,
  }
})

const VideoAnalysisSchema = z.object({
  steps: z.array(VideoStepSchema),
  productName: z.string().default(''),
  summary: z.string().default(''),
})

export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>
export type VideoStep = z.infer<typeof VideoStepSchema>

/**
 * Detect and correct Gemini's MM:SS concatenation bug.
 * Gemini sometimes returns "127" meaning 1:27 (87s), not 127 seconds.
 * Applies the correction symmetrically to both actionAt and resultAt so the
 * intent-based frame picking stays consistent.
 */
export function correctTimestamps(steps: VideoStep[], videoDurationSeconds: number): VideoStep[] {
  if (steps.length === 0) return steps
  if (!isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) return steps

  const maxTimestamp = Math.max(...steps.flatMap((s) => [s.actionAt, s.resultAt]))

  // M.SS decimal format: all timestamps clustered way below video duration
  if (steps.length >= 3 && maxTimestamp < videoDurationSeconds * 0.05) {
    console.log(`[gemini] Detected M.SS decimal timestamps (max ${maxTimestamp}s << video ${videoDurationSeconds.toFixed(1)}s). Converting...`)
    const fix = (t: number): number => {
      const minutes = Math.floor(t)
      const seconds = Math.round((t - minutes) * 100)
      return Math.min(minutes * 60 + seconds, videoDurationSeconds - 1)
    }
    return steps.map((s) => ({ ...s, actionAt: fix(s.actionAt), resultAt: fix(s.resultAt) }))
  }

  if (maxTimestamp <= videoDurationSeconds * 1.1) return steps

  // MM:SS concatenated format
  console.log(`[gemini] Detected MM:SS timestamps (max ${maxTimestamp}s > video ${videoDurationSeconds.toFixed(1)}s). Correcting...`)
  const fix = (t: number): number => {
    if (t < 60) return t
    const minutes = Math.floor(t / 100)
    const seconds = t % 100
    if (seconds >= 60) return t
    return minutes * 60 + seconds
  }
  return steps.map((s) => ({ ...s, actionAt: fix(s.actionAt), resultAt: fix(s.resultAt) }))
}

export function isGeminiAvailable(): boolean {
  return !!env.GEMINI_API_KEY
}

export async function analyzeVideoWithGemini(
  videoBuffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<VideoAnalysis> {
  const genAI = getGenAI()
  const fileManager = new GoogleAIFileManager(env.GEMINI_API_KEY!)

  // Upload video to Gemini Files API
  console.log(`[gemini] Uploading video: ${fileName} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`)

  // Write buffer to a temp file for the file manager
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tempPath = join(tmpdir(), `aidoc-video-${Date.now()}-${fileName}`)
  writeFileSync(tempPath, videoBuffer)

  let uploadedFile: { name: string; uri: string; mimeType: string; state: string }
  try {
    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType,
      displayName: fileName,
    })
    uploadedFile = uploadResult.file as typeof uploadedFile
  } finally {
    unlinkSync(tempPath)
  }

  // Wait for file processing
  let file = uploadedFile
  while (file.state === 'PROCESSING') {
    console.log('[gemini] Waiting for video processing...')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const result = await fileManager.getFile(file.name) as typeof file
    file = result
  }

  if (file.state === 'FAILED') {
    throw new Error('Gemini failed to process the video file')
  }

  console.log(`[gemini] Video processed. Analyzing...`)

  // Analyze the video
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: 16384 },
  })

  const result = await withRetry(() => model.generateContent([
    {
      fileData: {
        mimeType: file.mimeType,
        fileUri: file.uri,
      },
    },
    {
      text: `Analyze this screen recording of a web application. Identify the KEY steps — focus on significant actions that a user would need to document, not every micro-interaction.

GROUPING RULES:
- Group related actions into ONE step (e.g. "typed email, typed password, clicked Sign In" → one step: "User logged in")
- Skip trivial actions: scrolling without purpose, mouse movements, brief hovers
- Skip repeated similar actions (e.g. scrolling through a list → one step)
- Aim for 5-10 steps for a typical 1-3 minute video. More only if the video covers many truly different features.
- Each step should represent a meaningful state change or user accomplishment

For each step you MUST return TWO timestamps and an intent — this lets us pick the most useful frame for the documentation screenshot:
1. "actionAt": NUMBER OF SECONDS at the moment of the action itself (cursor on the element being clicked, key being pressed, dropdown opening). This is the "show where to click" moment.
2. "resultAt": NUMBER OF SECONDS once the page is settled AFTER any loading/transition has completed. This is the "show what happened" moment. If the action is synchronous (no loading, no transition), set resultAt = actionAt.
3. "screenshotIntent": "action" or "result" — your call on which frame illustrates this step best:
   - "action" when the pedagogical value is in showing WHERE the user clicks (e.g. "click the small Settings gear icon in the top-right" — the user needs to see the cursor on the gear).
   - "result" when the pedagogical value is in showing WHAT the action produced (e.g. "now your dashboard shows the new project" — the screenshot must show the new project, not a spinner).

Convert minutes to seconds correctly: 1 minute 27 seconds → 87 (= 1×60 + 27), NOT 127. Timestamps are in SECONDS.

4. Describe what's visible on screen at the resultAt moment (UI elements, page layout, text)
5. Describe what the user accomplished (the outcome, not each individual click)
6. If there's narration/voiceover, transcribe what's being said around this step

IMPORTANT:
- Steps MUST be in chronological order (actionAt ascending)
- resultAt MUST be >= actionAt
- If a step has any loading/transition, resultAt should be AFTER it fully completes — not while a spinner or skeleton is still on screen.
- Skip idle moments or pauses where nothing changes
- Timestamps are in SECONDS (e.g. 2:30 = 150, not 230)

Return ONLY valid JSON (no markdown fences):
{
  "steps": [
    {
      "actionAt": 12,
      "resultAt": 12,
      "screenshotIntent": "action",
      "screenDescription": "Cursor hovering over the 'New Project' button in the top-right of the dashboard",
      "userAction": "User clicks New Project to start creating a project",
      "narration": null
    },
    {
      "actionAt": 14,
      "resultAt": 17,
      "screenshotIntent": "result",
      "screenDescription": "Project creation modal fully loaded with empty Name and URL fields",
      "userAction": "User opens the project creation form",
      "narration": null
    }
  ],
  "productName": "Name of the product shown in the recording",
  "summary": "2-3 sentence summary of what this recording covers"
}

Remember: fewer, more meaningful steps is better than many granular ones. Pick screenshotIntent thoughtfully — wrong intent means a screenshot of a spinner or a screenshot of the result without context for where to click.`,
    },
  ]))

  const text = result.response.text()

  // Extract JSON from Gemini response — handle markdown fences, leading/trailing text
  let jsonStr = text.trim()

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!
  }

  // If still not starting with {, find the first { and last }
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  // Fix Gemini returning timestamps as MM:SS or M:SS instead of seconds
  jsonStr = jsonStr.replace(/"(timestamp|actionAt|resultAt)"\s*:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (_match, key, p1, p2, p3) => {
    const mins = parseInt(p1 as string, 10)
    const secs = parseInt(p2 as string, 10)
    const hundredths = p3 ? parseInt(p3 as string, 10) : 0
    return `"${key as string}": ${mins * 60 + secs + hundredths / 100}`
  })

  let parsed
  try {
    parsed = VideoAnalysisSchema.safeParse(JSON.parse(jsonStr))
  } catch {
    // JSON might be truncated — try to repair by closing open brackets
    console.warn('[gemini] JSON parse failed, attempting repair...')
    let repaired = jsonStr

    // Remove trailing incomplete object/value
    repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '')
    repaired = repaired.replace(/,\s*\{[^}]*$/, '')

    // Count and close open brackets
    const openBraces = (repaired.match(/\{/g) ?? []).length
    const closeBraces = (repaired.match(/\}/g) ?? []).length
    const openBrackets = (repaired.match(/\[/g) ?? []).length
    const closeBrackets = (repaired.match(/\]/g) ?? []).length

    repaired += ']'.repeat(Math.max(0, openBrackets - closeBrackets))
    repaired += '}'.repeat(Math.max(0, openBraces - closeBraces))

    try {
      parsed = VideoAnalysisSchema.safeParse(JSON.parse(repaired))
      console.log(`[gemini] JSON repaired successfully — ${parsed.success ? 'valid' : 'invalid schema'}`)
    } catch (repairErr) {
      console.error('[gemini] JSON repair also failed. First 500 chars:', jsonStr.slice(0, 500))
      throw new Error(`Failed to parse Gemini video analysis JSON: ${(repairErr as Error).message}`)
    }
  }

  if (!parsed.success) {
    console.error('[gemini] Analysis validation failed:', parsed.error.flatten())
    throw new Error('Failed to validate video analysis response')
  }

  console.log(`[gemini] Analysis complete: ${parsed.data.steps.length} steps, product: "${parsed.data.productName}"`)

  // Clean up uploaded file
  await fileManager.deleteFile(file.name).catch(() => {})

  return parsed.data
}

/**
 * Generate narration script by having Gemini WATCH the video.
 * The model sees exactly what's on screen at each moment
 * and writes narration that matches the visual content.
 */
export async function generateNarrationFromVideo(
  videoBuffer: Buffer,
  mimeType: string,
  fileName: string,
  prompt: string,
): Promise<{ text: string; usage: GeminiUsage }> {
  const genAI = getGenAI()
  const fileManager = new GoogleAIFileManager(env.GEMINI_API_KEY!)

  console.log(`[gemini] Uploading video for narration: ${fileName} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`)

  const { writeFileSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tempPath = join(tmpdir(), `aidoc-narration-${Date.now()}-${fileName}`)
  writeFileSync(tempPath, videoBuffer)

  let uploadedFile: { name: string; uri: string; mimeType: string; state: string }
  try {
    const uploadResult = await fileManager.uploadFile(tempPath, { mimeType, displayName: fileName })
    uploadedFile = uploadResult.file as typeof uploadedFile
  } finally {
    unlinkSync(tempPath)
  }

  let file = uploadedFile
  while (file.state === 'PROCESSING') {
    console.log('[gemini] Waiting for video processing...')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    file = await fileManager.getFile(file.name) as typeof file
  }

  if (file.state === 'FAILED') throw new Error('Gemini failed to process the video file')

  console.log('[gemini] Video ready — generating narration script...')

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: 8192 },
  })

  const result = await withRetry(() => model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ]))

  await fileManager.deleteFile(file.name).catch(() => {})

  const usage = result.response.usageMetadata
  return {
    text: result.response.text(),
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
  }
}
