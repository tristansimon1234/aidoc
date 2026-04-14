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
 * Generate a single voice-over audio file.
 * The narration text already contains [pause] / [short pause] audio tags
 * from ElevenLabs v3 to control pacing.
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

  // Build the full narration text — segments joined with [long pause] between them
  const segments: VoiceoverSegment[] = []
  const textParts: string[] = []

  for (let i = 0; i < steps.length; i++) {
    const text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const startTime = timestamps[i] ?? 0
    const endTime = timestamps[i + 1] ?? (startTime + 30)

    // Add a pause between segments (not before the first one)
    if (textParts.length > 0) {
      textParts.push('[long pause]')
    }

    textParts.push(text)

    segments.push({
      stepIndex: steps[i]!.stepIndex,
      startTime,
      endTime,
      text,
    })
  }

  const fullText = textParts.join(' ')

  console.log(`[voiceover] Full text for ElevenLabs (${fullText.length} chars, ${segments.length} segments)`)
  console.log(`[voiceover] "${fullText.slice(0, 300)}${fullText.length > 300 ? '...' : ''}"`)

  // Single ElevenLabs call
  const buffer = await synthesizeSpeech(fullText, { voiceId: options?.voiceId })

  console.log(`[voiceover] ElevenLabs returned ${(buffer.length / 1024).toFixed(0)}KB`)

  const audioPath = `runs/${runId}/voiceover.mp3`
  await uploadToStorage('artifacts', audioPath, buffer, 'audio/mpeg')
  const audioUrl = `${getPublicUrl('artifacts', audioPath) ?? ''}?v=${Date.now()}`

  console.log(`[voiceover] Uploaded → ${audioPath}`)
  console.log(`[voiceover] URL → ${audioUrl}`)

  return { audioPath, audioUrl, segments }
}
