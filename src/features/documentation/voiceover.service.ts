import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { uploadToStorage, getPublicUrl } from '../../shared/db/storage.repository.js'

/** A single narration segment synced to a video timestamp range */
export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  text: string
}

export interface VoiceoverResult {
  segments: VoiceoverSegment[]
  audioPath: string
  audioUrl: string
}

/**
 * Generate a single voice-over audio track with timed pauses between steps.
 *
 * Uses ElevenLabs <break> tags to insert silences that match the video
 * timestamp gaps, so the narration naturally syncs with the video.
 * This produces one continuous audio file with natural flow instead of
 * choppy per-segment files.
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

  // Translate all step texts at once if language is specified
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

  // Build a single text block with <break> tags between steps.
  // The break duration matches the time gap between consecutive steps
  // in the video, so the narration stays in sync.
  const segments: VoiceoverSegment[] = []
  const textParts: string[] = []

  for (let i = 0; i < steps.length; i++) {
    const text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const startTime = timestamps[i] ?? 0
    const endTime = timestamps[i + 1] ?? (startTime + 30)

    segments.push({
      stepIndex: steps[i]!.stepIndex,
      startTime,
      endTime,
      text,
    })

    // Add break before this step (except the first one)
    if (textParts.length > 0) {
      // Calculate the gap between the end of the previous step's narration
      // and the start of this step. Use the timestamp gap as a guide.
      const prevTimestamp = timestamps[i - 1] ?? 0
      const gapSeconds = Math.max(0.5, Math.min(5, startTime - prevTimestamp - 2))
      textParts.push(`<break time="${gapSeconds.toFixed(1)}s" />`)
    }

    textParts.push(text)
  }

  const fullText = textParts.join(' ')

  // Single ElevenLabs call for the entire narration
  const buffer = await synthesizeSpeech(fullText, { voiceId: options?.voiceId })

  // Upload the single audio file
  const audioPath = `runs/${runId}/voiceover.mp3`
  await uploadToStorage('artifacts', audioPath, buffer, 'audio/mpeg')
  const audioUrl = getPublicUrl('artifacts', audioPath) ?? ''

  return {
    segments,
    audioPath,
    audioUrl,
  }
}
