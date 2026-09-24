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
  return `You are watching a screen recording (about ${minutes} min) of someone performing a task in a software tool. It will become a Standard Operating Procedure (SOP) that a new colleague can follow alone, without the video.

Extract every step needed to reproduce the task, from the first screen to the final result.

RULES
- One step = one meaningful action or state change: open a page, fill a form, click a button, choose an option, check a result. Merge micro-actions that form one operation ("typed email + password + clicked Sign in" = one step).
- Ignore noise: aimless mouse moves, hesitations, loading screens, mistakes that were undone, webcam / meeting framing, small talk.
- If the same action is repeated (e.g. filling 5 similar rows), keep ONE step and say it is repeated.
- Copy the exact labels visible on screen (buttons, menus, fields, tabs), in quotes, in their original language.
- Never copy sensitive values seen on screen (passwords, tokens, bank details, personal emails or phone numbers): describe them instead ("the client's email").
- "timestamp": the moment IN SECONDS (1 min 27 s → 87, not 127) of the frame that best illustrates the step: the button or field is visible and the value is filled in, BEFORE the next step starts.
- "screen": short description of what is visible at that frame.
- "spoken": what the person says during this step if audible (it often explains WHY), otherwise null.
- Chronological order. Timestamps between 0 and ${Math.ceil(durationSeconds)}.
- "title": short name of the task, e.g. "Create a supplier invoice in Pennylane".

Return ONLY JSON:
{"title": "...", "steps": [{"timestamp": 4, "action": "Open the 'Invoices' menu", "screen": "Sidebar with 'Invoices' highlighted", "spoken": null}]}`
}

// ── 2. Rédaction de la SOP (markdown) ────────────────────────

export function sopPrompt(input: {
  title: string
  language: string
  steps: VideoSteps['steps']
}): string {
  const language = languageName(input.language)
  const steps = input.steps
    .map(
      (s, i) =>
        `STEP ${i + 1}\n- Action: ${s.action}\n- Screen: ${s.screen}${s.spoken ? `\n- Said while doing it: ${s.spoken}` : ''}\n- Screenshot placeholder: {{SCREENSHOT_${i}}}`,
    )
    .join('\n\n')

  return `You write Standard Operating Procedures (SOPs). Write one in ${language} from the steps below, which were extracted from a screen recording of someone doing the task.

Task (as named by the user): "${input.title}"

The reader has never done this task and will follow the SOP alone, screen by screen. The document must be correct, complete and easy to scan.

STRUCTURE (Markdown, every heading and sentence written in ${language})
# <title of the procedure, starting with a verb>

<1–2 sentences: what this procedure achieves and when to use it.>

## <"Prerequisites" in ${language}>
<bullets: accounts, access rights, files or information needed before starting. Only what the steps show or clearly imply. Omit the whole section if there is nothing.>

## <"Steps" in ${language}>
### 1. <short imperative title>
<1–3 sentences saying exactly what to do and where. On-screen labels in **bold**, written exactly as on screen.>

![<short caption>]({{SCREENSHOT_0}})

### 2. …

## <"Result" in ${language}>
<1–2 sentences: how the reader checks the task is done.>

RULES
- Use every screenshot placeholder exactly once, under the step it belongs to, alone on its line with a blank line before and after. Never change the placeholder text.
- Keep the steps in order. Merge two steps only if they are really the same action (keep both screenshots). Never invent a step, button or field that is not in the data.
- Explain the WHY when the person said it. Turn their advice into callouts:
  > [!TIP]
  > <advice>

  > [!WARNING]
  > <thing that can go wrong or must not be done>
  Keep the markers [!TIP] and [!WARNING] exactly like that (they are not translated).
- Replace example values typed in the recording by what they represent ("enter the client's name"), unless the value is always the same. Never write passwords, tokens or personal data.
- Never mention the video, the recording, the presenter or "the user": address the reader directly.
- Output only the Markdown, without code fences.

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

  return `Write the voice-over of a short tutorial video, in ${languageName(input.language)}. A text-to-speech voice will read it over the screen recording.

The video is split into ${input.slots.length} time slots. Write exactly ONE text per slot, in order, describing what happens on screen during that slot. Stay within each word range: too long and the voice falls behind the image.

- Slot 1 starts with one short sentence saying what we are about to do.
- The last slot ends with one sentence confirming what has been achieved.
- Friendly, clear, professional; speak to the viewer ("click…", "you now see…").
- Say on-screen labels as they appear. No URLs, IDs, passwords or personal data, no markdown, no emojis, no stage directions.
- Use the SOP below for the "why", the tips and the right vocabulary.

SLOTS
${slots}

SOP
${input.sop.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '').slice(0, 12000)}

Return ONLY JSON: {"lines": ["text for slot 1", "text for slot 2", ...]} with exactly ${input.slots.length} entries.`
}
