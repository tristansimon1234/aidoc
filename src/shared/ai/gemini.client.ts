import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ResponseSchema } from '@google/generative-ai'
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

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 429 && attempt < maxRetries) {
        // Short first-attempt backoff so a long-running SSE exploration
        // has a shot at two retries within the 300s Vercel fn timeout.
        // Previous values (30/60/90s) burned the whole window and left
        // runs stuck in `running` when the function timed out.
        const waitSec = Math.min(10 * (attempt + 1), 30)
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
  /** Constrained-generation schema. When set (and `json` is true), Gemini
   *  is server-side-forced to emit JSON matching this shape — no missing
   *  fields, no wrong types, no extra envelope keys. Use for any JSON we
   *  Zod-validate downstream so the model can't drift the shape. */
  responseSchema?: ResponseSchema
  /** Thinking budget cap. Gemini 2.5 Flash + Pro both have "thinking"
   *  on by default, which silently consumes maxOutputTokens. For
   *  structured-JSON tasks (template fills, schema-constrained extracts)
   *  thinking adds nothing and just eats budget — pass `0` to disable.
   *  For open-ended reasoning (chat, code-rewrites) leave undefined. */
  thinkingBudget?: number
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
        ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
        // thinkingConfig is a Gemini 2.5 feature — set thinkingBudget=0
        // to disable internal reasoning tokens for structured tasks.
        ...(opts.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } }
          : {}),
      } as Record<string, unknown>,
    }),
  )

  const usage = result.response.usageMetadata
  let text = ''
  try {
    text = result.response.text()
  } catch (textErr) {
    // SDK throws when the response has no text-bearing candidate (e.g.
    // safety block). We log + return empty rather than propagate, so
    // upstream rescue paths can fall back gracefully.
    console.warn(`[gemini] response.text() threw: ${(textErr as Error).message}`)
  }
  // When Gemini returns no text, surface WHY upstream — the SDK's text()
  // returns '' for several distinct reasons and "Pro returned empty"
  // is too vague to debug:
  //   - finishReason: 'SAFETY' → safety filter blocked the output
  //   - finishReason: 'RECITATION' → matched copyrighted training data
  //   - finishReason: 'MAX_TOKENS' → hit the cap before producing any
  //     content (very long input vs very small maxTokens)
  //   - finishReason: 'OTHER' → model error, often a 503 retry path
  //   - no candidates → the request itself was rejected (prompt block)
  // Surface anomalous finishReasons EVEN when text is non-empty.
  // MAX_TOKENS with non-empty text means the response was TRUNCATED —
  // callers compiling TSX would get "Unexpected end of file" without
  // knowing why. SAFETY/RECITATION mid-response is rarer but still
  // worth logging.
  const candidates = result.response.candidates ?? []
  const finishReason = candidates[0]?.finishReason ?? 'NO_CANDIDATES'
  if (text && text.trim().length > 0 && finishReason && finishReason !== 'STOP') {
    console.warn(
      `[gemini] Truncated response from ${opts.model ?? GEMINI_MODEL}: finishReason=${finishReason} ` +
      `inputTokens=${usage?.promptTokenCount ?? '?'} outputTokens=${usage?.candidatesTokenCount ?? '?'} ` +
      `(consider raising maxTokens above ${opts.maxTokens ?? '?'})`,
    )
  }
  if (!text || text.trim().length === 0) {
    const safetyRatings = candidates[0]?.safetyRatings ?? []
    const blockedRatings = safetyRatings.filter((r) =>
      r.probability && r.probability !== 'NEGLIGIBLE' && r.probability !== 'LOW',
    )
    const promptFeedback = result.response.promptFeedback
    console.warn(
      `[gemini] Empty response from ${opts.model ?? GEMINI_MODEL}: finishReason=${finishReason}` +
      (blockedRatings.length ? ` blocked=${blockedRatings.map((r) => `${r.category}:${r.probability}`).join(',')}` : '') +
      (promptFeedback?.blockReason ? ` promptBlock=${promptFeedback.blockReason}` : '') +
      ` inputTokens=${usage?.promptTokenCount ?? '?'} outputTokens=${usage?.candidatesTokenCount ?? '?'}`,
    )
  }
  return {
    text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    },
  }
}

/**
 * Streamed text generation. Yields the same response as `generateText` but
 * exposes incremental chunks as Gemini emits them, so SSE callers can flush
 * tokens to the client as they arrive instead of buffering the whole answer.
 *
 * Same retry behaviour as generateText for the initial connection (handles
 * the 429 backoff). Once the stream is open we don't retry — partial
 * deltas have already been sent and the caller's protocol handles
 * mid-stream errors.
 *
 * Usage:
 *   const stream = await generateTextStream(opts)
 *   for await (const delta of stream.deltas) { res.write(delta) }
 *   const { fullText, usage } = await stream.result
 */
export async function generateTextStream(opts: {
  systemPrompt?: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  model?: string
}): Promise<{
  deltas: AsyncIterable<string>
  result: Promise<{ fullText: string; usage: GeminiUsage }>
}> {
  const genAI = getGenAI()
  const model = genAI.getGenerativeModel({
    model: opts.model ?? GEMINI_MODEL,
    ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
  })

  const streamResult = await withRetry(() =>
    model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    }),
  )

  // Capture the full text + usage as the stream drains. Caller awaits
  // `result` after consuming `deltas` to get the final state.
  let fullText = ''
  let resolveResult: (v: { fullText: string; usage: GeminiUsage }) => void
  let rejectResult: (e: unknown) => void
  const result = new Promise<{ fullText: string; usage: GeminiUsage }>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  async function* deltaIterator(): AsyncIterable<string> {
    try {
      for await (const chunk of streamResult.stream) {
        const text = chunk.text()
        if (text) {
          fullText += text
          yield text
        }
      }
      const final = await streamResult.response
      const usage = final.usageMetadata
      resolveResult({
        fullText,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
        },
      })
    } catch (err) {
      rejectResult(err)
      throw err
    }
  }

  return { deltas: deltaIterator(), result }
}

// --- Embeddings ---

const EMBEDDING_DIMENSIONS = 768

// Default embedding model — pinned to avoid a ListModels round-trip on
// Embedding model selection. We try the env override first (so an
// operator can pin a specific model without a deploy), then fall back
// to ListModels discovery — that lets us survive Google's periodic
// model deprecations / regional rollouts without code changes. The
// ListModels round-trip costs ~200-400ms but only fires once per
// Vercel cold start; subsequent calls hit the in-process cache.
//
// Earlier versions of this code hard-coded `text-embedding-004`, which
// turned out NOT to be visible to every API key (it's gated by region
// + project enablement) and caused a 404 on first chat. Discovery is
// the safer default.
let _cachedEmbeddingModel: string | null = null

async function getEmbeddingModel(): Promise<string> {
  if (_cachedEmbeddingModel) return _cachedEmbeddingModel

  const override = process.env.GEMINI_EMBEDDING_MODEL?.replace(/^models\//, '')
  if (override) {
    _cachedEmbeddingModel = override
    return _cachedEmbeddingModel
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`,
  )
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`)

  const data = (await res.json()) as { models: { name: string; supportedGenerationMethods: string[] }[] }
  const embeddingModel = data.models.find((m) =>
    m.supportedGenerationMethods.includes('embedContent'),
  )
  if (!embeddingModel) throw new Error('No embedding model available for this API key')

  _cachedEmbeddingModel = embeddingModel.name.replace(/^models\//, '')
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

const VideoStepSchema = z.object({
  timestamp: z.number(),
  screenDescription: z.string(),
  userAction: z.string(),
  narration: z.string().nullable(),
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
 * We detect this by comparing max timestamp against actual video duration.
 */
export function correctTimestamps(steps: VideoStep[], videoDurationSeconds: number): VideoStep[] {
  if (steps.length === 0) return steps

  // If duration is unknown/infinite, skip correction
  if (!isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) return steps

  const maxTimestamp = Math.max(...steps.map((s) => s.timestamp))

  // Detect M.SS decimal format: all timestamps clustered in a tiny range
  // relative to video duration (e.g. 0.0-1.2 for a 106s video)
  if (steps.length >= 3 && maxTimestamp < videoDurationSeconds * 0.05) {
    console.log(`[gemini] Detected M.SS decimal timestamps (max ${maxTimestamp}s << video ${videoDurationSeconds.toFixed(1)}s). Converting...`)
    return steps.map((s) => {
      const minutes = Math.floor(s.timestamp)
      const seconds = Math.round((s.timestamp - minutes) * 100)
      const corrected = minutes * 60 + seconds
      return { ...s, timestamp: Math.min(corrected, videoDurationSeconds - 1) }
    })
  }

  // If max timestamp is within video duration (+10% tolerance), timestamps are fine
  if (maxTimestamp <= videoDurationSeconds * 1.1) return steps

  // Timestamps likely in MM:SS concatenated format — convert
  console.log(`[gemini] Detected MM:SS timestamps (max ${maxTimestamp}s > video ${videoDurationSeconds.toFixed(1)}s). Correcting...`)
  return steps.map((s) => {
    if (s.timestamp < 60) return s // sub-60 already correct
    const minutes = Math.floor(s.timestamp / 100)
    const seconds = s.timestamp % 100
    if (seconds >= 60) return s // not MM:SS format
    const corrected = minutes * 60 + seconds
    return { ...s, timestamp: corrected }
  })
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

For each step:
1. Provide the timestamp as a NUMBER OF SECONDS (integer or decimal). You MUST convert minutes to seconds:
   - 45 seconds → 45
   - 1 minute 27 seconds → 87 (= 1×60 + 27), NOT 127
   - 2 minutes 8 seconds → 128 (= 2×60 + 8), NOT 208
   Pick the SINGLE FRAME a doc author would screenshot to illustrate this step — the frame that shows the user WHAT TO DO, not the consequence (the consequence belongs to the NEXT step's screenshot). Three concrete patterns:
   - **CTA / button click** (Submit, Save, "Continue", a navigation link) → frame AT the click — the button is still visible on the current page, the cursor / pointer is on or near it, the surrounding context is intact. NOT after the result loads — the result is the next step's frame, capturing it here would just duplicate it.
   - **Form fill / input** (typing in a field, picking a date, choosing from a select) → frame where the field is fully filled with the new value, captured BEFORE the user moves to the next field or clicks anything else. The reader needs to see what value goes in.
   - **Presentation of an element** (opening a menu, modal, tooltip, panel; revealing a section; showing a feature) → frame where ALL of the element's contents are fully visible — animations done, dropdown fully expanded, modal centred and stable.
   Do NOT systematically pick "1 second after the action" — pick the frame that's most informative for this specific step's intent. Never so late that the next step has already begun.
2. Describe what's visible on screen at that frame (UI elements, page layout, text)
3. Describe what the user accomplished (not each individual click — the outcome)
4. If there's narration/voiceover, transcribe what's being said at that moment

IMPORTANT:
- Steps MUST be in chronological order (timestamps ascending)
- The timestamp MUST point to the most illustrative frame for the step, NOT a generic "+1s after click" offset
- Skip idle moments or pauses where nothing changes
- Timestamps are in SECONDS — convert from MM:SS to seconds (e.g. 2:30 = 150, not 230)

Return ONLY valid JSON (no markdown fences):
{
  "steps": [
    {
      "timestamp": 3,
      "screenDescription": "The dashboard with a list of projects and a 'New Project' button",
      "userAction": "User navigated to the dashboard after logging in",
      "narration": null
    },
    {
      "timestamp": 15,
      "screenDescription": "Project creation form with name and URL fields filled in",
      "userAction": "User created a new project by entering the name and URL",
      "narration": null
    }
  ],
  "productName": "Name of the product shown in the recording",
  "summary": "2-3 sentence summary of what this recording covers"
}

Remember: fewer, more meaningful steps is better than many granular ones.`,
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
  jsonStr = jsonStr.replace(/"timestamp"\s*:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (_match, p1, p2, p3) => {
    const mins = parseInt(p1 as string, 10)
    const secs = parseInt(p2 as string, 10)
    const hundredths = p3 ? parseInt(p3 as string, 10) : 0
    return `"timestamp": ${mins * 60 + secs + hundredths / 100}`
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
