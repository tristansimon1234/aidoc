import { synthesizeSpeech, isElevenLabsConfigured } from '../../shared/ai/elevenlabs.client.js'
import { uploadToStorage, getSignedUrl } from '../../shared/db/storage.repository.js'

const MAX_CHUNK_LENGTH = 4500 // ElevenLabs limit ~5000 chars, leave margin

export interface VoiceoverResult {
  audioPath: string
  audioUrl: string
  duration: number
}

/**
 * Strip markdown formatting to produce clean narration text.
 */
function markdownToNarration(markdown: string): string {
  return markdown
    // Remove images
    .replace(/!\[.*?\]\(.*?\)/g, '')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    // Remove headers markers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic markers
    .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1')
    .replace(/_{1,3}(.*?)_{1,3}/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove blockquote markers
    .replace(/^>\s+/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split text into chunks that fit within the ElevenLabs character limit.
 * Splits on paragraph boundaries to maintain natural speech flow.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text]

  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > MAX_CHUNK_LENGTH) {
      if (current) chunks.push(current.trim())
      // If a single paragraph exceeds the limit, split on sentences
      if (paragraph.length > MAX_CHUNK_LENGTH) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) ?? [paragraph]
        let sentenceChunk = ''
        for (const sentence of sentences) {
          if (sentenceChunk.length + sentence.length > MAX_CHUNK_LENGTH) {
            if (sentenceChunk) chunks.push(sentenceChunk.trim())
            sentenceChunk = sentence
          } else {
            sentenceChunk += sentence
          }
        }
        current = sentenceChunk
      } else {
        current = paragraph
      }
    } else {
      current += (current ? '\n\n' : '') + paragraph
    }
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks
}

/**
 * Generate a voice-over narration from markdown documentation content.
 * Returns the path and URL of the audio file in Supabase storage.
 */
export async function generateVoiceover(
  runId: string,
  markdownContent: string,
  options?: { voiceId?: string; language?: string },
): Promise<VoiceoverResult> {
  if (!isElevenLabsConfigured()) {
    throw new Error('ElevenLabs is not configured — set ELEVENLABS_API_KEY')
  }

  // 1. Convert markdown to clean narration text
  let narrationText = markdownToNarration(markdownContent)

  // 2. If language translation is requested, translate via Gemini
  if (options?.language) {
    const { generateText } = await import('../../shared/ai/gemini.client.js')
    const translated = await generateText({
      userPrompt: `Translate the following text to ${options.language}. Keep it natural and conversational — this will be read aloud as a narration. Do NOT add any introduction or explanation, just output the translated text.\n\n${narrationText}`,
      maxTokens: 8192,
    })
    narrationText = translated.text
  }

  if (!narrationText || narrationText.length < 10) {
    throw new Error('Documentation content too short to generate voice-over')
  }

  // 3. Split into chunks and synthesize
  const chunks = splitIntoChunks(narrationText)
  const audioBuffers: Buffer[] = []

  for (const chunk of chunks) {
    const buffer = await synthesizeSpeech(chunk, {
      voiceId: options?.voiceId,
    })
    audioBuffers.push(buffer)
  }

  // 4. Concatenate audio buffers
  const combinedBuffer = Buffer.concat(audioBuffers)

  // 5. Estimate duration (mp3 at ~128kbps = ~16KB per second)
  const estimatedDuration = Math.round(combinedBuffer.length / (128 * 1024 / 8))

  // 6. Upload to Supabase storage
  const langSuffix = options?.language ? `-${options.language}` : ''
  const audioPath = `runs/${runId}/voiceover${langSuffix}.mp3`
  await uploadToStorage('artifacts', audioPath, combinedBuffer, 'audio/mpeg')

  // 7. Get public URL
  const audioUrl = await getSignedUrl('artifacts', audioPath) ?? ''

  return { audioPath, audioUrl, duration: estimatedDuration }
}
