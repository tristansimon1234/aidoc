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
    let text = stepTexts[i] ?? steps[i]!.text
    if (!text || text.length < 3) continue

    const startTime = timestamps[i] ?? 0
    const nextStart = timestamps[i + 1]
    const slotDuration = (nextStart ?? (startTime + 15)) - startTime

    // Synthesize — retry with shorter text if audio overflows the slot
    let buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
    let estimatedDuration = Math.max(1, buffer.length / 16000)

    const isLastSegment = i === steps.length - 1
    // Allow last segment to overflow slightly (2s) — better to end naturally than leave silence
    const overflowThreshold = isLastSegment ? 1.25 : 1.1

    if (estimatedDuration > slotDuration * overflowThreshold && text.split(/\s+/).length > 6) {
      const words = text.split(/\s+/)
      // Target 95% of slot to leave minimal margin
      const targetWords = Math.ceil(words.length * (slotDuration / estimatedDuration) * 1.05)
      const shortened = words.slice(0, Math.max(4, targetWords)).join(' ')
      const lastDot = shortened.lastIndexOf('.')
      text = lastDot > shortened.length * 0.4 ? shortened.slice(0, lastDot + 1) : shortened + '.'
      // Preserve closing phrase for last segment
      if (isLastSegment && !text.match(/thanks|bye|wrap|watching/i)) {
        text += ' Thanks for watching!'
      }

      console.log(`[voiceover] Segment ${i}: overflow (${estimatedDuration.toFixed(1)}s > ${slotDuration.toFixed(1)}s slot) — retrying with ${text.split(/\s+/).length} words`)

      buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
      estimatedDuration = Math.max(1, buffer.length / 16000)
    }

    const segPath = `runs/${runId}/voiceover-seg-${i}.mp3`
    await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

    const endTime = startTime + estimatedDuration
    console.log(`[voiceover] Segment ${i}: ${(buffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s/${slotDuration.toFixed(0)}s slot, ${startTime.toFixed(1)}→${endTime.toFixed(1)}s`)

    segmentPaths.push({ audioPath: segPath, targetStartTime: startTime })
    segments.push({ stepIndex: steps[i]!.stepIndex, startTime, endTime, text })
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
