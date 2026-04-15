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
  let lastSegmentEnd = 0 // Track actual end of previous segment for gap calculation

  for (let i = 0; i < steps.length; i++) {
    let text = stepTexts[i] ?? steps[i]!.text

    const rawStart = timestamps[i] ?? 0
    const nextStart = timestamps[i + 1]
    const slotDuration = (nextStart ?? (rawStart + 15)) - rawStart

    // Skip truly empty segments but keep index alignment
    if (!text || text.length < 3) {
      segments.push({ stepIndex: steps[i]!.stepIndex, startTime: rawStart, endTime: rawStart + 0.5, text: '' })
      lastSegmentEnd = rawStart + 0.5
      continue
    }

    // Anticipation: start narration before the action
    // Use actual previous segment end (not hardcoded +5s)
    const gapBefore = rawStart - lastSegmentEnd
    const anticipation = gapBefore > 5 ? 3 : gapBefore > 2 ? 1.5 : 0.5
    const startTime = Math.max(0, rawStart - anticipation)

    // Synthesize — retry with shorter text if audio overflows the slot
    let buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
    let estimatedDuration = Math.max(1, buffer.length / 16000)

    if (estimatedDuration > slotDuration * 1.1 && text.split(/\s+/).length > 6) {
      const words = text.split(/\s+/)
      const targetWords = Math.floor(words.length * (slotDuration / estimatedDuration))
      const shortened = words.slice(0, Math.max(4, targetWords)).join(' ')
      const lastDot = shortened.lastIndexOf('.')
      text = lastDot > shortened.length * 0.4 ? shortened.slice(0, lastDot + 1) : shortened + '.'

      console.log(`[voiceover] Segment ${i}: overflow (${estimatedDuration.toFixed(1)}s > ${slotDuration.toFixed(1)}s slot) — retrying with ${text.split(/\s+/).length} words`)

      buffer = await synthesizeSpeech(text, { voiceId: options?.voiceId })
      estimatedDuration = Math.max(1, buffer.length / 16000)
    }

    const segPath = `runs/${runId}/voiceover-seg-${i}.mp3`
    await uploadToStorage('artifacts', segPath, buffer, 'audio/mpeg')

    const actualEnd = startTime + estimatedDuration
    lastSegmentEnd = actualEnd
    console.log(`[voiceover] Segment ${i}: ${(buffer.length / 1024).toFixed(0)}KB, ~${estimatedDuration.toFixed(1)}s/${slotDuration.toFixed(0)}s slot`)

    segmentPaths.push({ audioPath: segPath, targetStartTime: startTime })
    segments.push({ stepIndex: steps[i]!.stepIndex, startTime, endTime: actualEnd, text })
  }

  // Concatenate with silence padding via video service
  const { isVideoServiceConfigured, concatAudio } = await import('../../shared/video/video.client.js')

  if (!isVideoServiceConfigured()) {
    throw new Error('Voice-over assembly requires the video service (VIDEO_SERVICE_URL). Configure it to concatenate audio segments.')
  }

  if (segmentPaths.length === 0) {
    throw new Error('No audio segments were generated')
  }

  let audioPath: string
  if (segmentPaths.length === 1) {
    audioPath = segmentPaths[0]!.audioPath
  } else {
    console.log(`[voiceover] Concatenating ${segmentPaths.length} segments...`)
    audioPath = await concatAudio(runId, segmentPaths)
  }

  const audioUrl = `${getPublicUrl('artifacts', audioPath) ?? ''}?v=${Date.now()}`

  console.log(`[voiceover] Done → ${audioUrl}`)

  return { audioPath, audioUrl, segments }
}
