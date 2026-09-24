import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { creditsFor } from '../credits.js'
import { cutVideo, durationOf, extractFrame, muxNarration, normalizeVideo } from './ffmpeg.js'
import { insertScreenshots } from './prompts.js'
import { cleanSteps, narrationSlots, planEdit } from './steps.js'

const step = (timestamp: number, action = 'a') => ({ timestamp, action, screen: '', spoken: null })

describe('creditsFor', () => {
  it('1 crédit par tranche de 10 min commencée', () => {
    expect(creditsFor(30)).toBe(1)
    expect(creditsFor(600)).toBe(1)
    expect(creditsFor(601)).toBe(2)
    expect(creditsFor(3600)).toBe(6)
  })
})

describe('cleanSteps', () => {
  it('trie, borne à la vidéo et garde un écart avant l’étape suivante', () => {
    const out = cleanSteps([step(20), step(-3), step(20.2), step(500)], 60)
    expect(out.map((s) => s.timestamp)).toEqual([0, 19.7, 20.2, 59.8])
  })
})

describe('narrationSlots', () => {
  it('raconte chaque étape avant sa capture et fusionne les créneaux trop courts', () => {
    const slots = narrationSlots([step(10, 'A'), step(12, 'B'), step(30, 'C')], 45)
    expect(slots).toEqual([
      { start: 0, seconds: 10, action: 'A' },
      { start: 10, seconds: 35, action: 'B Then: C' },
    ])
    const merged = narrationSlots([step(2, 'A'), step(20, 'B')], 40)
    expect(merged).toEqual([{ start: 0, seconds: 40, action: 'A Then: B' }])
  })
})

describe('planEdit', () => {
  it('ne touche pas une vidéo de 4 min ou moins', () => {
    const plan = planEdit([step(10), step(100)], 200)
    expect(plan.clips).toEqual([{ start: 0, end: 200 }])
    expect(plan.duration).toBe(200)
  })

  it('condense une vidéo de 20 min à 4 min max, étapes repositionnées', () => {
    const steps = [60, 300, 305, 600, 1100].map((t) => step(t))
    const plan = planEdit(steps, 1200)
    expect(plan.duration).toBeLessThanOrEqual(240)
    // 20 s par étape : 14 s avant la capture, 6 s après ; 300 et 305 fusionnent.
    expect(plan.clips[0]).toEqual({ start: 46, end: 66 })
    expect(plan.clips).toHaveLength(4)
    expect(plan.steps.map((s) => s.timestamp)).toEqual([14, 34, 39, 59, 79])
  })

  it('garde 4 min max même avec énormément d’étapes', () => {
    const steps = Array.from({ length: 200 }, (_, i) => step(i * 30 + 10))
    const plan = planEdit(steps, 6000)
    expect(plan.duration).toBeLessThanOrEqual(240)
    expect(plan.steps.length).toBeGreaterThan(100)
  })
})

describe('insertScreenshots', () => {
  it('remplace les repères, retire les captures ratées, ajoute les oubliées', () => {
    const md = '1\n\n![Ouvrir]({{SCREENSHOT_0}})\n\n2\n\n![x]({{SCREENSHOT_1}})\n'
    const out = insertScreenshots(md, ['https://a/0.jpg', null, 'https://a/2.jpg'])
    expect(out).toContain('![Ouvrir](https://a/0.jpg)')
    expect(out).not.toContain('SCREENSHOT')
    expect(out.trimEnd().endsWith('![](https://a/2.jpg)')).toBe(true)
  })
})

describe('ffmpeg', () => {
  it('normalise, capture une image et pose la voix off (en figeant la fin si elle déborde)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doclee-test-'))
    const src = join(dir, 'src.webm')
    const voice = join(dir, 'voice.wav')
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1920x1080:rate=15:duration=6',
      '-c:v',
      'libvpx',
      src,
    ])
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', voice])

    const video = join(dir, 'video.mp4')
    await normalizeVideo(src, video)
    expect(await durationOf(video)).toBeCloseTo(6, 0)

    await extractFrame(video, 2, join(dir, 'frame.jpg'))

    const cut = join(dir, 'cut.mp4')
    await cutVideo(
      video,
      [
        { start: 0.5, end: 2 },
        { start: 4, end: 5 },
      ],
      cut,
      false,
    )
    expect(await durationOf(cut)).toBeCloseTo(2.5, 0)

    const out = join(dir, 'out.mp4')
    await muxNarration(
      video,
      [
        { file: voice, start: 1 },
        { file: voice, start: 5 },
      ],
      8.3,
      out,
    )
    expect(await durationOf(out)).toBeGreaterThan(8)
  }, 60_000)
})
