import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import { z } from 'zod'
import { env } from '../config/env.js'

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
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured')
  }

  const fileManager = new GoogleAIFileManager(env.GEMINI_API_KEY)
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY)

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
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

  const generateWithRetry = async (content: Parameters<typeof model.generateContent>[0], maxRetries = 3) => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await model.generateContent(content)
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

  const result = await generateWithRetry([
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
  ])

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
