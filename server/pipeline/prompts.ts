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

STRUCTURE (Markdown). Every heading and sentence is written in ${language}; the <…> below describe what to write, translate the section names.
# <title of the procedure, starting with a verb>

<1–2 sentences: what this procedure achieves and why it matters.>

- **<"When" in ${language}>:** <what triggers it and how often, e.g. "each time a supplier invoice arrives">
- **<"Who" in ${language}>:** <role that performs it>
(Only the lines you can support from the video; omit this list if neither is known.)

## <"Key points" in ${language}>
<3–5 bullets: the most important rules, figures, deadlines and warnings the person stated, kept word for word for facts. Omit the section if nothing important was said.>

## <"Before you start" in ${language}>
<bullets: accounts, access rights, files, information needed before starting. Omit if nothing.>

## <"Steps" in ${language}>
<With 10 steps or fewer:>
### 1. <short title starting with a verb>
<Same pattern for every step, in this order:>
<1. If something can go wrong or must not be done in this step, the warning callout comes FIRST, before the action.>
<2. The action: one action per step, imperative, short active sentences, on-screen labels in **bold** exactly as on screen, where to find them.>
<3. Why / the rule to apply, from what the person explained (only when useful).>
<4. Decisions as "If <situation>, <what to do>." lines when the person mentions alternatives or exceptions.>
<5. The screenshot:>

![<short caption>]({{SCREENSHOT_0}})

<6. On key steps, what the reader should now see, as "<"Expected result" in ${language}>: …" in italics.>

<With more than 10 steps: group them into 2–5 phases, each "### <phase name>", and the steps inside as "#### 1. …" with numbering continuing across phases.>

## <"Final check" in ${language}>
<a checklist "- [ ] …" of what to verify to be sure the task is done correctly.>

## <"Troubleshooting" in ${language}>
<"**<problem>** → <solution>" lines, ONLY for problems, errors or edge cases the person mentioned. Omit the section otherwise.>

RULES
- Write for the least experienced person on the team: short sentences, active voice, no jargon unless the tool uses it (then explain it once).
- Use every screenshot placeholder exactly once, under the step it belongs to, alone on its line with a blank line before and after. Never change the placeholder text.
- Keep the steps in order. Merge two steps only if they are really the same action (keep both screenshots). Never invent a step, button, field or rule that is not in the video.
- Precise facts the person states (amounts, thresholds, deadlines, account numbers, codes, names of tools or teams, business rules) are copied exactly, never rounded or paraphrased.
- Callouts:
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

const UPDATED_LABEL: Record<string, string> = {
  fr: 'Mise à jour',
  en: 'Last updated',
  es: 'Actualizado',
  de: 'Aktualisiert',
  it: 'Aggiornato',
  pt: 'Atualizado',
  nl: 'Bijgewerkt',
}

/** Ajoute la date de mise à jour sous le titre (pour savoir si la SOP est encore à jour). */
export function addUpdatedDate(markdown: string, language: string, date = new Date()): string {
  const line = `_${UPDATED_LABEL[language] ?? UPDATED_LABEL.en}: ${date.toLocaleDateString(language, { day: 'numeric', month: 'long', year: 'numeric' })}_`
  const lines = markdown.split('\n')
  const title = lines.findIndex((l) => l.startsWith('# '))
  if (title === -1) return `${line}\n\n${markdown}`
  lines.splice(title + 1, 0, '', line)
  return lines.join('\n')
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

// ── 2 bis. Choix de la meilleure capture pour chaque étape ──

export const FramePickSchema = z.object({
  picks: z.array(z.object({ step: z.number().int(), image: z.number().int() })),
})

/** `steps[].images` = numéros des images candidates de l'étape (dans l'ordre chronologique). */
export function framePickPrompt(
  steps: { step: number; action: string; screen: string; images: number[] }[],
): string {
  const list = steps
    .map(
      (s) =>
        `STEP ${s.step}: ${s.action}\n  Expected on screen: ${s.screen}\n  Candidate images: ${s.images.join(', ')}`,
    )
    .join('\n\n')
  return `These images are frames from a screen recording. For each step of a written procedure, pick the ONE candidate image that best illustrates it as a screenshot in the procedure.

The best frame:
- shows the element the reader must act on (button, menu, field) and, for a form, the value already filled in;
- shows the screen BEFORE the next action changes it (not the result of the next step);
- for a step about checking a result, shows that result;
- is not a transition, a loading screen, a blurred frame, or a frame hidden by an unrelated popup.

${list}

Return ONLY JSON: {"picks": [{"step": <step number>, "image": <chosen image number>}, ...]} with one entry per step.`
}

// ── 2 ter. Vidéo marketing (30 ou 60 s) ───────────────────

export const MarketingPlanSchema = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), line: z.string() })),
  musicPrompt: z.string().default('modern upbeat corporate background music, light and positive'),
})
export type MarketingPlan = z.infer<typeof MarketingPlanSchema>

export function marketingPrompt(input: {
  language: string
  tone: Tone
  durationSeconds: number
  title: string
  brief: string | null
  targetSeconds: number
}): string {
  const language = languageName(input.language)
  const moments = input.targetSeconds <= 30 ? '3 to 5' : '4 to 7'
  const words = Math.round(input.targetSeconds * 2.2)
  return `From this screen recording, plan a punchy marketing video of at most ${input.targetSeconds} seconds for "${input.title}". It will be cut from the recording and narrated by a voice-over in ${language}.
${input.brief ? `\nBRIEF FROM THE USER (follow it: what to highlight, for whom, which message):\n${input.brief}\n` : ''}
Pick ${moments} moments of the recording that show the VALUE best (results, key features, "wow" moments), not every click. For each moment give:
- "start" and "end" in seconds (between 0 and ${Math.floor(input.durationSeconds)}), 3 to 12 seconds long, in chronological order, not overlapping;
- "line": the voice-over sentence for that moment, in ${language}, 8 to 25 words.

The lines together tell a story: the first opens with a hook (the problem or the promise), the middle shows the benefits, the last ends with a clear call to action. At most ${words} words in total. Use what the person says in the recording for the real benefits and vocabulary. Tone: ${TONES[input.tone].direction} No URLs, no personal data, no stage directions.

"musicPrompt": one short description of fitting background music (style, mood, tempo), e.g. "upbeat electronic, driving rhythm, positive".

Return ONLY JSON: {"segments": [{"start": 12, "end": 18, "line": "..."}], "musicPrompt": "..."}`
}

/** Garde les moments valides du plan marketing : dans la vidéo, dans l'ordre, sans chevauchement. */
export function cleanMarketingSegments(
  segments: MarketingPlan['segments'],
  durationSeconds: number,
): MarketingPlan['segments'] {
  const out: MarketingPlan['segments'] = []
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, s.start, out[out.length - 1]?.end ?? 0)
    const end = Math.min(durationSeconds, s.end)
    if (end - start >= 1.5 && s.line.trim()) out.push({ start, end, line: s.line.trim() })
  }
  return out.slice(0, 7)
}

// ── 3. Script de la voix off ─────────────────────────────────

/** Tons proposés pour la voix off : `direction` guide l'écriture, `speech` l'intonation de la synthèse Gemini. */
export const TONES = {
  friendly: {
    label: 'Friendly',
    direction:
      'Warm, upbeat and conversational, like a helpful colleague. Contractions and a light touch of humour are welcome.',
    speech: 'Say this in a warm, friendly, conversational tone',
  },
  professional: {
    label: 'Professional',
    direction: 'Polished, confident and measured. Clear and precise, no filler, no jokes.',
    speech: 'Say this in a clear, confident, professional tone',
  },
  energetic: {
    label: 'Energetic',
    direction:
      'High energy and enthusiastic, dynamic rhythm, stresses the key words. Still complete sentences, never curt.',
    speech: 'Say this in an energetic, enthusiastic tone',
  },
  calm: {
    label: 'Calm',
    direction: 'Gentle, patient and reassuring, as if guiding a beginner. Unhurried sentences.',
    speech: 'Say this in a calm, gentle, reassuring tone',
  },
  playful: {
    label: 'Playful',
    direction: 'Witty and light-hearted, with playful asides, while staying clear and accurate.',
    speech: 'Say this in a playful, lively tone',
  },
} as const

export type Tone = keyof typeof TONES
export const DEFAULT_TONE: Tone = 'friendly'

export function toTone(value: string | null | undefined): Tone {
  return value && value in TONES ? (value as Tone) : DEFAULT_TONE
}

export const NarrationSchema = z.object({ lines: z.array(z.string()) })

/** Un texte par créneau ; le budget de mots suit la durée du créneau (~2,6 mots / seconde, au moins 80 %). */
export function narrationPrompt(input: {
  language: string
  tone: Tone
  sop: string
  slots: { start: number; seconds: number; action: string; spoken: string }[]
}): string {
  const slots = input.slots
    .map((s, i) => {
      const max = Math.max(8, Math.floor(s.seconds * 2.6))
      const min = Math.max(5, Math.floor(max * 0.8))
      const said = s.spoken ? `\n   What the person said here: "${s.spoken}"` : ''
      return `${i + 1}. [${s.start.toFixed(0)}s, ${s.seconds.toFixed(0)}s available → ${min}-${max} words] On screen: ${s.action}${said}`
    })
    .join('\n')

  return `Write the voice-over of a short tutorial video, in ${languageName(input.language)}. A text-to-speech voice will read it over the screen recording.

The video is split into ${input.slots.length} time slots. Write exactly ONE text per slot, in order. Use each slot's word range fully: the voice should talk from the start to the end of the slot, with no dead air. Aim for the upper half of the range.

- The voice-over replaces the person's own voice. Base each slot on WHAT THEY SAID during it (their explanations, reasons and warnings), rewritten as clean, confident sentences, in ${languageName(input.language)}. Keep their meaning, drop hesitations and repetitions.
- When they said nothing useful in a slot, explain what is being done and why, using the SOP below. Do not just describe the screen.
- Repeat the critical points (rules, figures, deadlines, warnings) in the slot where they apply, keeping figures and names exact.
- Slot 1 starts with one short sentence saying what we are about to do.
- The last slot ends with one sentence confirming what has been achieved.
- Tone: ${TONES[input.tone].direction} Speak to the viewer ("click…", "here you choose… because…").
- Say on-screen labels as they appear. No URLs, IDs, passwords or personal data, no markdown, no emojis, no stage directions.

SLOTS
${slots}

SOP
${input.sop.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '').slice(0, 12000)}

Return ONLY JSON: {"lines": ["text for slot 1", "text for slot 2", ...]} with exactly ${input.slots.length} entries.`
}
