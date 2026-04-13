import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { uploadToStorage, getPublicUrl } from '../../shared/db/storage.repository.js'

/** A single narration segment synced to a video timestamp range */
export interface VoiceoverSegment {
  stepIndex: number
  startTime: number
  endTime: number
  audioPath: string
  audioUrl: string
  text: string
}

export interface VoiceoverResult {
  segments: VoiceoverSegment[]
  fullAudioPath: string
  fullAudioUrl: string
}

/**
 * Generate voice-over narration synced to video timestamps.
 *
 * Instead of narrating the whole doc as one block, this generates
 * one audio segment per step, each mapped to the step's video timestamp.
 * The player can then play the right narration at the right moment.
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
    // Parse back into individual step texts
    const parts = translated.text.split(/\[STEP \d+\]\n?/)
    if (parts.length > 1) {
      stepTexts = parts.filter((p) => p.trim()).map((p) => p.trim())
    }
  }

  // Generate audio for each step
  const segments: VoiceoverSegment[] = []
  const allBuffers: Buffer[] = []

  for (let i = 0; i < steps.length; i++) {
    const text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })

    // Upload individual segment
    const segPath = `runs/${runId}/voiceover-step-${i}.mp3`
    await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

    // Calculate time range from timestamps
    const startTime = timestamps[i] ?? 0
    const endTime = timestamps[i + 1] ?? (startTime + 30) // last step: 30s after

    segments.push({
      stepIndex: steps[i]!.stepIndex,
      startTime,
      endTime,
      audioPath: segPath,
      audioUrl: getPublicUrl('artifacts', segPath) ?? '',
      text,
    })

    allBuffers.push(buffer)
  }

  // Also upload a concatenated full audio (for fallback / download)
  const fullBuffer = Buffer.concat(allBuffers)
  const fullPath = `runs/${runId}/voiceover-full.mp3`
  await uploadToStorage('artifacts', fullPath, fullBuffer, 'audio/mpeg')

  return {
    segments,
    fullAudioPath: fullPath,
    fullAudioUrl: getPublicUrl('artifacts', fullPath) ?? '',
  }
}
