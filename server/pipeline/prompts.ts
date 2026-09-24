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

// ── 1. Analyse de la vidéo → transcription + étapes horodatées ──

export const VideoStepsSchema = z.object({
  title: z.string().default(''),
  // Tout ce que dit la personne, mot pour mot : c'est la meilleure source d'explications.
  transcript: z.array(z.object({ start: z.number().nonnegative(), text: z.string() })).default([]),
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
export type Transcript = VideoSteps['transcript']

export function videoAnalysisPrompt(durationSeconds: number): string {
  const minutes = Math.max(1, Math.round(durationSeconds / 60))
  return `You are watching AND listening to a screen recording (about ${minutes} min) of someone doing a task in a software tool while explaining it out loud. It will become a Standard Operating Procedure (SOP) that a new colleague can follow alone, without the video.

Do two things.

1. "transcript": transcribe EVERYTHING the person says, word for word, in the language spoken, as consecutive segments of one or a few sentences, each with its start time IN SECONDS. Do not summarize, do not skip anything: the explanations, reasons, rules, exceptions and warnings they give are the most valuable part. Remove only filler sounds ("euh", "um"). If nobody speaks, return an empty list.

2. "steps": every step needed to reproduce the task, from the first screen to the final result.
- One step = one meaningful action or state change: open a page, fill a form, click a button, choose an option, check a result. Merge micro-actions that form one operation ("typed email + password + clicked Sign in" = one step).
- Ignore noise: aimless mouse moves, hesitations, loading screens, mistakes that were undone, webcam / meeting framing, small talk.
- If the same action is repeated (e.g. filling 5 similar rows), keep ONE step and say it is repeated.
- "action": what is done, with the exact labels visible on screen (buttons, menus, fields, tabs) in quotes, in their original language.
- "screen": short description of what is visible at the step's frame.
- "spoken": everything the person says while doing this step, word for word (it usually explains WHY and what to watch out for), or null if silent.
- "timestamp": the moment IN SECONDS (1 min 27 s → 87, not 127) of the frame that best illustrates the step: the button or field is visible and the value is filled in, BEFORE the next step starts.
- Chronological order. All times between 0 and ${Math.ceil(durationSeconds)}.
- Never copy sensitive values seen on screen or said aloud (passwords, tokens, bank details, personal emails or phone numbers): describe them instead ("the client's email").

"title": short name of the task, e.g. "Create a supplier invoice in Pennylane".

Return ONLY JSON:
{"title": "...", "transcript": [{"start": 0, "text": "So today I'll show you how we book a supplier invoice..."}], "steps": [{"timestamp": 4, "action": "Open the 'Invoices' menu", "screen": "Sidebar with 'Invoices' highlighted", "spoken": "First go to Invoices, not Purchases, because..."}]}`
}

function formatTranscript(transcript: Transcript): string {
  if (transcript.length === 0) return '(the person does not speak)'
  return transcript.map((t) => `[${Math.floor(t.start)}s] ${t.text}`).join('\n')
}

// ── 2. Rédaction de la SOP (markdown), avec la vidéo sous les yeux ──

export function sopPrompt(input: {
  title: string
  language: string
  steps: VideoSteps['steps']
  transcript: Transcript
}): string {
  const language = languageName(input.language)
  const steps = input.steps
    .map(
      (s, i) =>
        `STEP ${i + 1} (at ${Math.floor(s.timestamp)}s)\n- Action: ${s.action}\n- Screen: ${s.screen}${s.spoken ? `\n- Said while doing it: ${s.spoken}` : ''}\n- Screenshot placeholder: {{SCREENSHOT_${i}}}`,
    )
    .join('\n\n')

  return `You write Standard Operating Procedures (SOPs). Write one in ${language} for the task shown in this screen recording. You can watch AND hear the video; below are its full transcript and the list of steps already extracted from it.

Task (as named by the user): "${input.title}"

WHERE THE CONTENT COMES FROM
- What the person SAYS is the main source. Their explanations are why this SOP is worth more than a screenshot tour: the purpose of each step, the business rules, which option to pick and why, exceptions, common mistakes, what to check. Every useful piece of information they say must end up in the SOP, rewritten clearly (not as a transcript).
- The SCREEN gives the exact labels and where things are. Use it for precision, not as the content itself: do not just describe what is visible.
- If the person says something that contradicts the screen, follow what they say and mention the point in a warning.

The reader has never done this task and will follow the SOP alone, screen by screen.

STRUCTURE (Markdown, every heading and sentence written in ${language})
# <title of the procedure, starting with a verb>

<2–3 sentences: what this procedure achieves, when and why to use it (from what the person explains).>

## <"Prerequisites" in ${language}>
<bullets: accounts, access rights, files or information needed before starting. Omit the whole section if there is nothing.>

## <"Steps" in ${language}>
### 1. <short imperative title>
<What to do and where (on-screen labels in **bold**, exactly as on screen), then the why / the rule / what to pay attention to, as explained by the person. 1–5 sentences.>

![<short caption>]({{SCREENSHOT_0}})

### 2. …

## <"Result" in ${language}>
<how the reader checks the task is done.>

RULES
- Use every screenshot placeholder exactly once, under the step it belongs to, alone on its line with a blank line before and after. Never change the placeholder text.
- Keep the steps in order. Merge two steps only if they are really the same action (keep both screenshots). Never invent a step, button or field that is not in the video.
- Turn advice and warnings the person gives into callouts:
  > [!TIP]
  > <advice>

  > [!WARNING]
  > <thing that can go wrong or must not be done>
  Keep the markers [!TIP] and [!WARNING] exactly like that (they are not translated).
- Replace example values typed in the recording by what they represent ("enter the client's name"), unless the value is always the same. Never write passwords, tokens or personal data.
- Never mention the video, the recording, the presenter or "the user": address the reader directly.
- Output only the Markdown, without code fences.

TRANSCRIPT
${formatTranscript(input.transcript)}

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
  slots: { start: number; seconds: number; action: string; spoken: string }[]
}): string {
  const slots = input.slots
    .map((s, i) => {
      const max = Math.max(6, Math.floor(s.seconds * 2.3))
      const min = Math.max(3, Math.floor(max * 0.6))
      const said = s.spoken ? `\n   What the person said here: "${s.spoken}"` : ''
      return `${i + 1}. [${s.start.toFixed(0)}s, ${s.seconds.toFixed(0)}s available → ${min}-${max} words] On screen: ${s.action}${said}`
    })
    .join('\n')

  return `Write the voice-over of a short tutorial video, in ${languageName(input.language)}. A text-to-speech voice will read it over the screen recording.

The video is split into ${input.slots.length} time slots. Write exactly ONE text per slot, in order. Stay within each word range: too long and the voice falls behind the image.

- The voice-over replaces the person's own voice. Base each slot on WHAT THEY SAID during it (their explanations, reasons and warnings), rewritten as clean, confident sentences, in ${languageName(input.language)}. Keep their meaning, drop hesitations and repetitions.
- When they said nothing useful in a slot, explain what is being done and why, using the SOP below. Do not just describe the screen.
- Slot 1 starts with one short sentence saying what we are about to do.
- The last slot ends with one sentence confirming what has been achieved.
- Friendly, clear, professional; speak to the viewer ("click…", "here you choose… because…").
- Say on-screen labels as they appear. No URLs, IDs, passwords or personal data, no markdown, no emojis, no stage directions.

SLOTS
${slots}

SOP
${input.sop.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '').slice(0, 12000)}

Return ONLY JSON: {"lines": ["text for slot 1", "text for slot 2", ...]} with exactly ${input.slots.length} entries.`
}
