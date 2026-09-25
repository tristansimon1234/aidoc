import { ApiError } from '@google/genai'
import { describe, expect, it } from 'vitest'
import { creditsFor } from '../credits.js'
import { rateLimitDelay } from './gemini.js'
import { StoryboardSchema, reviewApproved, storyboardPrompt } from './prompts.js'
import { compileScene, extractCode, lintScene } from './scene-code.js'
import { captionWords, luminance } from './steps.js'

describe('prix de la vidéo marketing', () => {
  it('2 crédits quelle que soit la durée de l’enregistrement', () => {
    expect(creditsFor(30, 'marketing')).toBe(2)
    expect(creditsFor(3000, 'marketing')).toBe(2)
    expect(creditsFor(3000)).toBe(5)
  })
})

describe('code des scènes', () => {
  const scene = `function Scene({ brand }) {
  const frame = Remotion.useCurrentFrame()
  return <Remotion.AbsoluteFill style={{ color: brand.text }}><div>Upload your document {frame}</div></Remotion.AbsoluteFill>
}`

  it('récupère le dernier bloc de code de la réponse', () => {
    const answer = `VERDICT: FIX\n- text too small\n\`\`\`tsx\n${scene}\n\`\`\``
    expect(extractCode(answer)).toBe(scene)
    expect(extractCode('Sorry, I cannot.')).toBeNull()
  })

  it('compile le TSX en JS sans import', async () => {
    const out = await compileScene(`export default ${scene}`)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.code).toContain('React.createElement')
      expect(out.code).not.toContain('export')
    }
  })

  it('refuse ce qui ne se rend pas image par image, sans faux positif sur le texte', async () => {
    expect(lintScene(scene)).toEqual([])
    expect(lintScene(scene.replace('{frame}', '{Math.random()}'))).toHaveLength(1)
    expect(lintScene(`import x from 'y'\n${scene}`)).toHaveLength(1)
    expect(
      lintScene(scene.replace('Remotion.useCurrentFrame()', 'React.useState(0)')),
    ).toHaveLength(1)
    expect(
      lintScene(`const X = () => <div style={{ transition: 'all 1s' }} />\n${scene}`),
    ).toHaveLength(1)
    expect(lintScene('const App = () => null')).toHaveLength(1)
    const broken = await compileScene('function Scene() { return <div> }')
    expect(broken.ok).toBe(false)
  })

  it('reconnaît une relecture validée', () => {
    expect(reviewApproved('VERDICT: OK')).toBe(true)
    expect(reviewApproved('VERDICT: FIX\n```tsx\nfunction Scene(){}\n```')).toBe(false)
  })
})

describe('storyboard', () => {
  it('part des captures et du brief, suit la durée', () => {
    const prompt = storyboardPrompt({
      language: 'fr',
      tone: 'energetic',
      imageCount: 3,
      title: 'Pennylane',
      brief: 'Pour les cabinets comptables',
      targetSeconds: 30,
    })
    expect(prompt).toContain('Pour les cabinets comptables')
    expect(prompt).toContain('30-second')
    expect(prompt).toContain('4 or 5')
    expect(prompt).toContain('Image 1 to Image 3')
  })

  it('remplace les couleurs invalides', () => {
    const board = StoryboardSchema.parse({
      productName: 'Acme',
      brand: { accent: 'purple', accent2: '#FFD84D', background: '#101010' },
      hooks: [{ line: 'Still doing this by hand?', onScreen: 'By hand?' }],
      scenes: [
        { purpose: 'hook', line: 'a', onScreen: 'b', visual: 'c' },
        {
          purpose: 'cta',
          line: 'a',
          onScreen: 'b',
          visual: 'c',
          screenshots: [{ image: 1, what: 'x' }],
        },
      ],
    })
    expect(board.brand.accent).toBe('#6D5BFF')
    expect(board.scenes[0]!.screenshots).toEqual([])
  })
})

describe('sous-titres', () => {
  it('répartit la durée de chaque phrase entre ses mots', () => {
    const words = captionWords([
      { text: 'Hello big world.', startMs: 0, durationMs: 1500 },
      { text: 'Go', startMs: 2000, durationMs: 400 },
    ])
    expect(words.map((w) => w.text)).toEqual(['Hello', 'big', 'world.', 'Go'])
    expect(words[0]!.startMs).toBe(0)
    expect(words[2]!.endMs).toBe(1500)
    expect(words[1]!.endMs - words[1]!.startMs).toBeLessThan(words[0]!.endMs - words[0]!.startMs)
    expect(words[3]).toEqual({ text: 'Go', startMs: 2000, endMs: 2400 })
  })

  it('luminance des couleurs', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#FFFFFF')).toBeCloseTo(1)
  })
})

describe('limites de Gemini', () => {
  it('attend le délai indiqué quand la limite par minute est atteinte', () => {
    const perMinute = new ApiError({
      status: 429,
      message:
        '{"error":{"code":429,"message":"Quota exceeded for metric: generate_requests_per_model, limit: 10, model: gemini-2.5-flash-tts\\nPlease retry in 30.674911047s."}}',
    })
    expect(rateLimitDelay(perMinute)).toBe(31675) // 30,67 s + 1 s de marge
    expect(rateLimitDelay(new ApiError({ status: 500, message: 'boom' }))).toBeNull()
    expect(rateLimitDelay(new Error('x'))).toBeNull()
  })
})
