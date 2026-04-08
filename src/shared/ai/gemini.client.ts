import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import { z } from 'zod'
import { env } from '../config/env.js'

// --- Shared Gemini client ---

const GEMINI_MODEL = 'gemini-2.5-flash'

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
}): Promise<{ text: string; usage: GeminiUsage }> {
  const genAI = getGenAI()
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
  })

  const result = await withRetry(() =>
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: opts.userPrompt }] }],
      generationConfig: { maxOutputTokens: opts.maxTokens },
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

const EMBEDDING_MODEL = 'text-embedding-004'

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const genAI = getGenAI()
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL })

  const results: number[][] = []
  // Batch in groups of 100 (API limit)
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100)
    const response = await withRetry(() =>
      model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { role: 'user', parts: [{ text }] },
        })),
      }),
    )
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
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL })

  const result = await withRetry(() => model.generateContent([
    {
      fileData: {
        mimeType: file.mimeType,
        fileUri: file.uri,
      },
    },
    {
      text: `Analyze this screen recording of a web application. For each distinct action or screen change, identify what's happening.

For each step:
1. Provide the timestamp in seconds
2. Describe what's visible on screen (UI elements, page layout, text)
3. Describe what the user is doing (clicking, typing, navigating, scrolling)
4. If there's narration/voiceover, transcribe what's being said at that moment

Return ONLY valid JSON (no markdown fences):
{
  "steps": [
    {
      "timestamp": 0,
      "screenDescription": "The login page with email and password fields, a 'Sign in' button, and company logo",
      "userAction": "User is viewing the login page",
      "narration": "Let me show you how to sign in to the platform"
    },
    {
      "timestamp": 15,
      "screenDescription": "The login form with email field filled in",
      "userAction": "User types their email address in the email field",
      "narration": null
    }
  ],
  "productName": "Name of the product shown in the recording",
  "summary": "2-3 sentence summary of what this recording covers"
}

Be thorough — capture every meaningful action. Skip idle moments or pauses where nothing changes.`,
    },
  ]))

  const text = result.response.text()

  // Parse JSON response
  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  const parsed = VideoAnalysisSchema.safeParse(JSON.parse(jsonStr))
  if (!parsed.success) {
    console.error('[gemini] Analysis validation failed:', parsed.error.flatten())
    throw new Error('Failed to parse video analysis')
  }

  console.log(`[gemini] Analysis complete: ${parsed.data.steps.length} steps, product: "${parsed.data.productName}"`)

  // Clean up uploaded file
  await fileManager.deleteFile(file.name).catch(() => {})

  return parsed.data
}
