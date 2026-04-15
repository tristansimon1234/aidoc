import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { uploadToStorage, getPublicUrl } from '../../shared/db/storage.repository.js'

export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text: string
}

export interface VoiceoverResult {
  audioPath: string
  audioUrl: string
  segments: VoiceoverSegment[]
}

/**
 * Generate voice-over: one ElevenLabs call per segment,
 * then concatenate with precise silence padding via ffmpeg.
 */
export async function generateVoiceover(
  runId: string,
  steps: { stepIndex: number; text: string }[],
  timestamps: number[],
  options?: { voiceId?: string; language?: string },
): Promise<VoiceoverResult> {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured — set ELEVENLABS_API_KEY')
  }

  if (steps.length === 0) {
    throw new Error('No steps to narrate')
  }

  // Translate if requested
  let stepTexts = steps.map((s) => s.text)
  if (options?.language) {
    const { generateText } = await import('../../shared/ai/gemini.client.js')
    const allText = stepTexts.map((t, i) => `[STEP ${i}]\n${t}`).join('\n\n')
    const translated = await generateText({
      userPrompt: `Translate each step to ${options.language}. Keep the [STEP N] markers. Keep it natural and conversational — this will be read aloud. Output ONLY the translated text.\n\n${allText}`,
      maxTokens: 8192,
    })
    const parts = translated.text.split(/\[STEP \d+\]\n?/)
    if (parts.length > 1) {
      stepTexts = parts.filter((p) => p.trim()).map((p) => p.trim())
    }
  }

  // Generate each segment individually
  const segments: VoiceoverSegment[] = []
  const segmentPaths: { audioPath: string; targetStartTime: number }[] = []

  for (let i = 0; i < steps.length; i++) {
    const text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const rawStart = timestamps[i] ?? 0
    const nextStart = timestamps[i + 1]

    // Start narration before the action. If there's a long gap before this step,
    // start earlier to reduce dead silence (up to 3s early, minimum 1.5s)
    const prevEnd = segmentPaths.length > 0 ? segmentPaths[segmentPaths.length - 1]!.targetStartTime + 5 : 0
    const gapBefore = rawStart - prevEnd
    const anticipation = gapBefore > 5 ? 3 : 1.5
    const startTime = Math.max(0, rawStart - anticipation)

    console.log(`[voiceover] Segment ${i}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}" (${text.length} chars, ${startTime.toFixed(1)}s, gap=${gapBefore.toFixed(1)}s)`)

    const buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
    const segPath = `runs/${runId}/voiceover-seg-${i}.mp3`
    await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

    // Estimate audio duration from MP3 buffer size (~16KB/sec at 128kbps)
    const estimatedDuration = Math.max(1, buffer.length / 16000)
    const actualEnd = Math.min(startTime + estimatedDuration, nextStart ?? (rawStart + 20))

    console.log(`[voiceover] Segment ${i}: ${(buffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s audio`)

    segmentPaths.push({ audioPath: segPath, targetStartTime: startTime })
    segments.push({ stepIndex: steps[i]!.stepIndex, startTime, endTime: actualEnd, text })
  }

  // Concatenate with silence padding via video service
  const { isVideoServiceConfigured, concatAudio } = await import('../../shared/video/video.client.js')

  let audioPath: string
  if (isVideoServiceConfigured() && segmentPaths.length > 1) {
    console.log(`[voiceover] Concatenating ${segmentPaths.length} segments...`)
    audioPath = await concatAudio(runId, segmentPaths)
  } else {
    // Fallback: use first segment only
    audioPath = segmentPaths[0]?.audioPath ?? `runs/${runId}/voiceover.mp3`
  }

  const audioUrl = `${getPublicUrl('artifacts', audioPath) ?? ''}?v=${Date.now()}`

  console.log(`[voiceover] Done → ${audioUrl}`)

  return { audioPath, audioUrl, segments }
}
