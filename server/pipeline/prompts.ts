// Tous les prompts IA du projet.
import { z } from 'zod'

export const LANGUAGES: Record<string, string> = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
}

export function languageName(code: string): string {
  return LANGUAGES[code] ?? 'English'
}

// ── 1. Analyse de la vidéo → étapes horodatées ───────────────

export const VideoStepsSchema = z.object({
  title: z.string().default(''),
  steps: z.array(
    z.object({
      timestamp: z.number().nonnegative(),
      action: z.string(),
      screen: z.string(),
      spoken: z.string().nullable().default(null),
    }),
  ),
})
export type VideoSteps = z.infer<typeof VideoStepsSchema>

export function videoAnalysisPrompt(durationSeconds: number): string {
  const minutes = Math.max(1, Math.round(durationSeconds / 60))
  return `You are watching a screen recording (about ${minutes} min) of someone performing a task in a software tool. It will become a Standard Operating Procedure (SOP) that a new colleague can follow on their own.

Extract every step needed to reproduce the task.

RULES
- One step = one meaningful action or state change (open a page, fill a form, click a button, choose an option, check a result). Merge micro-actions that form one operation ("typed email + password + clicked Sign in" = one step).
- Ignore noise: aimless mouse moves, hesitations, going back after a mistake, meeting/webcam framing, small talk.
- Keep the exact labels visible on screen (button names, menu items, field names), in quotes.
- "timestamp": the moment (IN SECONDS, e.g. 1 min 27 s → 87) of the frame that best illustrates the step: the button/field is visible and the value is filled, BEFORE the next step starts.
- "screen": short description of what is visible at that frame.
- "spoken": what the presenter says during this step if audible, otherwise null.
- Steps in chronological order. Timestamps must be within 0–${Math.ceil(durationSeconds)}.
- "title": short name of the task, e.g. "Create a supplier invoice in Pennylane".

Return ONLY JSON:
{"title": "...", "steps": [{"timestamp": 4, "action": "Open the Invoices menu", "screen": "Sidebar with 'Invoices' highlighted", "spoken": null}]}`
}

// ── 2. Rédaction de la SOP (markdown) ────────────────────────

export function sopPrompt(input: {
  title: string
  language: string
  steps: VideoSteps['steps']
}): string {
  const steps = input.steps
    .map(
      (s, i) =>
        `STEP ${i + 1}\n- Action: ${s.action}\n- Screen: ${s.screen}${s.spoken ? `\n- Presenter says: ${s.spoken}` : ''}\n- Screenshot: {{SCREENSHOT_${i}}}`,
    )
    .join('\n\n')

  return `Write a Standard Operating Procedure (SOP) in ${languageName(input.language)} from the steps below, extracted from a screen recording.

Task: "${input.title}"

FORMAT (Markdown)
# <clear title of the procedure>

<1–2 sentences: what this procedure achieves and when to use it.>

## Prerequisites
<bullets: access, tools, information needed. Only what the recording shows or clearly implies. Omit the section if nothing.>

## Steps
Numbered steps. For each step:
### <number>. <short imperative title>
<1–3 sentences: exactly what to do, with on-screen labels in **bold**. Add the "why" when the presenter explained it.>

![<short caption>]({{SCREENSHOT_N}})

## Result
<how to check the task is done.>

RULES
- Use EVERY screenshot placeholder exactly once, under its step, on its own line with a blank line before and after.
- Merge steps only if they are trivially the same action; keep their screenshot.
- Tips or warnings the presenter mentioned: use a quote block starting with "> **Tip:**" or "> **Warning:**" (translated).
- Plain, direct language for someone who has never used the tool. No filler, no meta-commentary.
- Output the Markdown only.

STEPS
${steps}`
}

/** Remplace {{SCREENSHOT_N}} par les vraies URLs ; ajoute à la fin les captures oubliées. */
export function insertScreenshots(markdown: string, urls: (string | null)[]): string {
  let out = markdown
  const forgotten: string[] = []
  urls.forEach((url, i) => {
    const placeholder = `{{SCREENSHOT_${i}}}`
    if (!url) {
      out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\{\\{SCREENSHOT_${i}\\}\\}\\)\\n?`, 'g'), '')
      out = out.replaceAll(placeholder, '')
      return
    }
    if (!out.includes(placeholder)) {
      forgotten.push(`![](${url})`)
      return
    }
    out = out.replace(
      new RegExp(`!\\[([^\\]]*)\\]\\(\\{\\{SCREENSHOT_${i}\\}\\}\\)`, 'g'),
      `![$1](${url})`,
    )
    out = out.replaceAll(placeholder, `![](${url})`)
  })
  return forgotten.length > 0 ? `${out.trimEnd()}\n\n${forgotten.join('\n\n')}\n` : out
}

// ── 3. Script de la voix off ─────────────────────────────────

export const NarrationSchema = z.object({ lines: z.array(z.string()) })

/** Une phrase par créneau ; le budget de mots suit la durée du créneau (~2,3 mots / seconde). */
export function narrationPrompt(input: {
  language: string
  sop: string
  slots: { start: number; seconds: number; action: string }[]
}): string {
  const slots = input.slots
    .map((s, i) => {
      const max = Math.max(6, Math.floor(s.seconds * 2.3))
      const min = Math.max(3, Math.floor(max * 0.6))
      return `${i + 1}. [${s.start.toFixed(0)}s, ${s.seconds.toFixed(0)}s available → ${min}-${max} words] ${s.action}`
    })
    .join('\n')

  return `Write the voice-over for a tutorial video, in ${languageName(input.language)}. It will be read by a text-to-speech voice over the screen recording.

The video is split into ${input.slots.length} time slots. Write exactly ONE text per slot, in order, that explains what happens on screen during that slot. Respect each word range so the voice stays in sync.

- Slot 1 opens with one short sentence saying what we are going to do.
- The last slot ends with one sentence confirming what was achieved.
- Friendly, clear, professional. Say on-screen labels as they appear. No URLs, no IDs, no markdown, no emojis.
- Use the SOP below for the "why" and the correct vocabulary.

SLOTS
${slots}

SOP
${input.sop.slice(0, 12000)}

Return ONLY JSON: {"lines": ["text for slot 1", "text for slot 2", ...]} with exactly ${input.slots.length} entries.`
}
