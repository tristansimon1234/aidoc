import { execFileSync } from 'node:child_process'
import { createReadStream, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { creditsFor } from '../credits.js'
import { withAbsoluteUrls } from '../urls.js'
import {
  addMusic,
  cutVideo,
  durationOf,
  extractFrame,
  normalizeVideo,
  renderNarrated,
} from './ffmpeg.js'
import {
  addUpdatedDate,
  cleanMarketingSegments,
  insertScreenshots,
  marketingPrompt,
  narrationPrompt,
  sopPrompt,
} from './prompts.js'
import {
  applyPickedTimes,
  candidateTimes,
  cleanSteps,
  fitSegment,
  limitWords,
  narrationSlots,
  planEdit,
} from './steps.js'

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const step = (timestamp: number, action = 'a', spoken: string | null = null) => ({
  timestamp,
  action,
  screen: '',
  spoken,
})

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
  it('raconte chaque étape avant sa capture, fusionne les créneaux trop courts, garde ce qui a été dit', () => {
    const slots = narrationSlots(
      [step(10, 'A', 'Why A'), step(12, 'B', 'Why B'), step(30, 'C', 'Why C')],
      45,
    )
    expect(slots).toEqual([
      { start: 0, seconds: 10, action: 'A', spoken: 'Why A' },
      { start: 10, seconds: 35, action: 'B Then: C', spoken: 'Why B Why C' },
    ])
    const merged = narrationSlots([step(2, 'A'), step(20, 'B', 'Why B')], 40)
    expect(merged).toEqual([{ start: 0, seconds: 40, action: 'A Then: B', spoken: 'Why B' }])
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

describe('prompts', () => {
  it('donnent à la rédaction et à la voix off ce que la personne a dit', () => {
    const sop = sopPrompt({
      title: 'Book an invoice',
      language: 'fr',
      steps: [step(4, "Open 'Invoices'", 'Always start from Invoices, never Purchases')],
      transcript: [{ start: 0, text: 'Here is how we book supplier invoices at the firm.' }],
    })
    expect(sop).toContain('[0s] Here is how we book supplier invoices at the firm.')
    expect(sop).toContain('Said while doing it: Always start from Invoices, never Purchases')
    expect(sop).toContain('written in French')

    expect(sop).toContain('Key points')
    expect(sop).toContain('warning callout comes FIRST')

    const voice = narrationPrompt({
      language: 'en',
      tone: 'calm',
      sop: '# SOP\n\n![x](https://a/1.jpg)\n',
      slots: [{ start: 0, seconds: 10, action: 'Open', spoken: 'Never use Purchases' }],
    })
    expect(voice).toContain('What the person said here: "Never use Purchases"')
    expect(voice).not.toContain('https://a/1.jpg')
    expect(voice).toContain('Gentle, patient and reassuring')
  })
})

describe('adresses des fichiers', () => {
  it('complète les adresses relatives et répare localhost, sans toucher le reste', () => {
    const base = 'https://api.example.app'
    expect(withAbsoluteUrls('/api/local-files/u/s/video.mp4', base)).toBe(
      'https://api.example.app/api/local-files/u/s/video.mp4',
    )
    expect(
      withAbsoluteUrls(
        '![a](/api/local-files/1.jpg)\n![b](http://localhost:8080/api/local-files/2.jpg)',
        base,
      ),
    ).toBe(
      '![a](https://api.example.app/api/local-files/1.jpg)\n![b](https://api.example.app/api/local-files/2.jpg)',
    )
    const done = '![c](https://other.app/api/local-files/3.jpg)'
    expect(withAbsoluteUrls(done, base)).toBe(done)
  })
})

describe('captures', () => {
  it('cherche autour de l’horodatage sans déborder sur les étapes voisines', () => {
    const steps = [step(10), step(12), step(30)]
    expect(candidateTimes(steps, 1, 40)).toEqual([10.3, 11, 12, 13, 14])
    expect(candidateTimes(steps, 0, 40)).toEqual([7, 8, 9, 10, 11, 11.7])
    expect(candidateTimes(steps, 2, 31)).toEqual([27, 28, 29, 30, 30.8])
  })

  it('garde les étapes dans l’ordre même si un choix recule', () => {
    const steps = [step(10), step(12), step(30)]
    expect(applyPickedTimes(steps, [11.7, 10.3, null]).map((s) => s.timestamp)).toEqual([
      11.7, 12, 30,
    ])
  })

  it('cale chaque passage sur sa voix off', () => {
    expect(fitSegment(10, 3.6)).toEqual({ factor: 0.4, freeze: 0, length: 4, tempo: 1 })
    expect(fitSegment(4, 5.6)).toEqual({ factor: 1.5, freeze: 0, length: 6, tempo: 1 })
    // Voix bien trop longue : accélérée de 20 % avant de figer l'image.
    const long = fitSegment(2, 5.6)
    expect(long.tempo).toBe(1.2)
    expect(long.factor).toBe(1.5)
    expect(long.freeze).toBeCloseTo(5.6 / 1.2 + 0.4 - 3)
    expect(fitSegment(5, 0).length).toBeCloseTo(2)
  })
})

describe('vidéo marketing', () => {
  it('suit le brief et la durée demandée', () => {
    const prompt = marketingPrompt({
      language: 'fr',
      tone: 'energetic',
      durationSeconds: 300,
      title: 'Pennylane',
      brief: 'Pour les cabinets comptables, finir sur « Réservez une démo »',
      targetSeconds: 30,
    })
    expect(prompt).toContain('at most 30 seconds')
    expect(prompt).toContain('3 to 5 moments')
    expect(prompt).toContain('Pour les cabinets comptables')
    expect(prompt).toContain('narrated by a voice-over in French')
  })

  it('garde des moments valides, dans l’ordre et sans chevauchement', () => {
    const out = cleanMarketingSegments(
      [
        { start: 30, end: 38, line: 'Then the result.' },
        { start: 2, end: 9, line: 'The hook.' },
        { start: 7, end: 12, line: 'Overlaps the hook.' },
        { start: 50, end: 70, line: 'Runs past the end.' },
        { start: 40, end: 40.5, line: 'Too short.' },
      ],
      60,
    )
    expect(out).toEqual([
      { start: 2, end: 9, line: 'The hook.' },
      { start: 9, end: 12, line: 'Overlaps the hook.' },
      { start: 30, end: 38, line: 'Then the result.' },
      { start: 50, end: 60, line: 'Runs past the end.' },
    ])
  })
})

describe('limitWords', () => {
  it('coupe à la dernière phrase complète sous la limite', () => {
    expect(limitWords('Click Save. Then check the list below carefully.', 5)).toBe('Click Save.')
    expect(limitWords('Short one.', 5)).toBe('Short one.')
    expect(limitWords('Open the menu, then pick the invoices tab and wait', 5)).toBe(
      'Open the menu, then pick.',
    )
  })
})

describe('addUpdatedDate', () => {
  it('ajoute la date sous le titre, dans la langue de la SOP', () => {
    const out = addUpdatedDate('# Book an invoice\n\nIntro', 'fr', new Date('2026-09-24'))
    expect(out).toBe('# Book an invoice\n\n_Mise à jour: 24 septembre 2026_\n\nIntro')
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
  it('normalise (depuis une URL), capture une image, monte et cale la vidéo sur la voix off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doclee-test-'))
    const src = join(dir, 'src.webm')
    const voice = join(dir, 'voice.wav')
    execFileSync(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1920x1080:rate=15:duration=6',
      '-c:v',
      'libvpx',
      src,
    ])
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', voice])

    // Comme en production : ffmpeg lit la source par URL (stockage Supabase), sans la télécharger.
    const server = createServer((_req, res) => createReadStream(src).pipe(res)).listen(0)
    const port = (server.address() as { port: number }).port
    const video = join(dir, 'video.mp4')
    await normalizeVideo(`http://127.0.0.1:${port}/src.webm`, video)
    server.close()
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

    // La vidéo suit la voix : un passage de 3 s avec 1 s de voix est accéléré,
    // un passage de 1 s avec 3 s de voix est ralenti puis figé. Aucun blanc.
    const shortVoice = join(dir, 'short.wav')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', shortVoice])
    const out = join(dir, 'out.mp4')
    await renderNarrated(
      video,
      [
        { start: 0, end: 3, audio: shortVoice, ...fitSegment(3, 1) },
        { start: 3, end: 4, audio: voice, ...fitSegment(1, 3) },
      ],
      out,
    )
    expect(await durationOf(out)).toBeCloseTo(1.4 + 3.4, 0)
    const silences = execFileSync(
      ffmpeg,
      ['-i', out, '-af', 'silencedetect=noise=-40dB:d=0.6', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    expect(silences).not.toContain('silence_start')

    // Musique de fond sous la voix : la durée du clip ne change pas.
    const music = join(dir, 'music.mp3')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', music])
    const withMusic = join(dir, 'with-music.mp4')
    await addMusic(out, music, withMusic)
    expect(await durationOf(withMusic)).toBeCloseTo(await durationOf(out), 0)
  }, 60_000)

  it('ne dérive pas : image et voix gardent la même durée sur 30 passages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doclee-drift-'))
    const src = join(dir, 'src.mp4')
    const voice = join(dir, 'voice.wav')
    execFileSync(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=15:duration=30',
      '-pix_fmt',
      'yuv420p',
      src,
    ])
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.53', voice])

    // Montage 4 min : 30 extraits aux bornes « bizarres ».
    const cut = join(dir, 'cut.mp4')
    const clips = Array.from({ length: 30 }, (_, i) => ({ start: i + 0.013, end: i + 0.71 }))
    await cutVideo(src, clips, cut, false)

    // Voix off : 30 passages de 0,53 s de voix sur des créneaux de 0,69 s (les derniers dépassent
    // même un peu la fin de la vidéo montée : ils doivent quand même avoir leurs images).
    const segments = Array.from({ length: 30 }, (_, i) => ({
      start: i * 0.69,
      end: i * 0.69 + 0.69,
      audio: voice,
      ...fitSegment(0.69, 0.53),
    }))
    const out = join(dir, 'out.mp4')
    await renderNarrated(cut, segments, out)

    const streams = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', out],
      { encoding: 'utf8' },
    )
    const duration = (type: string) =>
      Number(
        streams
          .split('\n')
          .find((l) => l.startsWith(type))
          ?.split(',')[1],
      )
    expect(Math.abs(duration('video') - duration('audio'))).toBeLessThan(0.1)
    const expected = segments.reduce((sum, seg) => sum + Math.round(seg.length * 15) / 15, 0)
    expect(duration('video')).toBeCloseTo(expected, 1)
  }, 120_000)
})
