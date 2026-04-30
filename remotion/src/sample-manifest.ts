import type { Manifest } from './manifest.js'

/**
 * Hardcoded manifest used when the CLI is run without a real runId. Lets a
 * designer iterate on the template without going through the full pipeline
 * (no Gemini, no ElevenLabs, no Supabase). Replace via `npm run
 * marketing:preview <runId>` once you want real data.
 */
export const SAMPLE_MANIFEST: Manifest = {
  runId: 'sample',
  generatedAt: new Date().toISOString(),
  script: {
    hook: {
      voiceover: 'Writing docs that nobody reads is a waste of your time.',
      headline: 'Docs people actually use',
      durationSeconds: 6,
    },
    scenes: [
      {
        voiceover: 'Record your screen once. Doclee turns it into a structured guide with screenshots and voice-over.',
        headline: 'Record once, ship a doc',
        subhead: 'Screen recording → structured guide in 90 seconds',
        screenshotIndex: 0,
        durationSeconds: 11,
      },
      {
        voiceover: 'Embed an AI chat widget on your app. It answers from your own docs in your own voice.',
        headline: 'Your docs, on demand',
        subhead: 'Embeddable widget powered by your content',
        screenshotIndex: 1,
        durationSeconds: 11,
      },
      {
        voiceover: 'Test your doc against the live product. An AI agent follows the steps and reports what fails.',
        headline: 'Your QA on autopilot',
        subhead: 'Try Doc — agent walks the doc, you get a report',
        screenshotIndex: 2,
        durationSeconds: 11,
      },
    ],
    cta: {
      voiceover: 'Stop writing docs nobody reads. Try Doclee free today.',
      headline: 'Make docs count',
      buttonLabel: 'Try Doclee free',
      durationSeconds: 6,
    },
    totalDurationSeconds: 45,
    language: 'en',
  },
  screenshots: [
    { url: 'https://placehold.co/1920x1080/0B0B0F/F5F5F7?text=Recording', caption: 'Screen recorder UI' },
    { url: 'https://placehold.co/1920x1080/0B0B0F/F5F5F7?text=Widget', caption: 'Embedded chat widget' },
    { url: 'https://placehold.co/1920x1080/0B0B0F/F5F5F7?text=Try+Doc', caption: 'Try Doc report' },
  ],
  branding: {
    productName: 'Doclee',
    accentColor: '#5B5BD6',
    bgColor: '#0B0B0F',
    textColor: '#F5F5F7',
    fontFamily: 'Inter',
    logoUrl: null,
  },
  voiceoverUrl: null,
  voiceoverPath: null,
}
