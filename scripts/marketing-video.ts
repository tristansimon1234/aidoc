/**
 * CLI: regenerate a marketing-video manifest for a given runId, write it to
 * `remotion/manifest.json`, and print the next command to preview/render.
 *
 *   npm run marketing:preview <runId> [--no-voiceover] [--prompt "..."]
 *
 * Runs the same backend service the HTTP route would, but bypasses Express
 * + auth — handy for local iteration where you just want to feed Remotion
 * fresh data without booting the full stack.
 *
 * --no-voiceover   skip ElevenLabs synthesis (saves €0.30 per iteration)
 * --prompt "..."   pass a creative brief to bias Gemini's framing
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateMarketingVideoForRun } from '../src/features/marketing-video/marketing-video.service.js'

interface ParsedArgs {
  runId: string | null
  withVoiceover: boolean
  userPrompt: string | null
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { runId: null, withVoiceover: true, userPrompt: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-voiceover') {
      args.withVoiceover = false
    } else if (a === '--prompt') {
      args.userPrompt = argv[i + 1] ?? null
      i++
    } else if (a && !a.startsWith('--') && !args.runId) {
      args.runId = a
    }
  }
  return args
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)

  if (!args.runId) {
    console.error('Usage: npm run marketing:preview <runId> [--no-voiceover] [--prompt "creative brief"]')
    process.exit(1)
  }

  console.log(`[marketing-cli] Generating manifest for run ${args.runId}`)
  if (args.userPrompt) console.log(`[marketing-cli] Brief: ${args.userPrompt}`)
  if (!args.withVoiceover) console.log('[marketing-cli] Voice-over disabled')

  const summary = await generateMarketingVideoForRun(args.runId, {
    withVoiceover: args.withVoiceover,
    userPrompt: args.userPrompt ?? undefined,
  })

  const here = dirname(fileURLToPath(import.meta.url))
  const manifestPath = join(here, '..', 'remotion', 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(summary.manifest, null, 2), 'utf-8')

  console.log(`[marketing-cli] Wrote ${manifestPath}`)
  console.log(`[marketing-cli] Manifest stored at ${summary.manifestUrl ?? '(no public URL)'}`)
  console.log('')
  console.log('Next steps:')
  console.log('  Preview real data: npm run remotion:preview:run')
  console.log('  Preview sample:    npm run remotion:preview')
  console.log('  Render to MP4:     npm run remotion:render')
}

main().catch((err: unknown) => {
  console.error('[marketing-cli] Failed:', err)
  process.exit(1)
})
