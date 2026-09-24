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
- Chronological order. All times between 0 and ${Math.ceil(durationSeconds)}. Cover the WHOLE recording until its very end: the task often continues late in the video, keep listing steps up to the last action.
- Never copy sensitive values seen on screen or said aloud (passwords, tokens, bank details, personal emails or phone numbers): describe them instead ("the client's email").

"title": short name of the task, e.g. "Create a supplier invoice in Pennylane".

Return ONLY JSON:
{"title": "...", "transcript": [{"start": 0, "text": "So today I'll show you how we book a supplier invoice..."}], "steps": [{"timestamp": 4, "action": "Open the 'Invoices' menu", "screen": "Sidebar with 'Invoices' highlighted", "spoken": "First go to Invoices, not Purchases, because..."}]}`
}

export const MissingStepsSchema = VideoStepsSchema.pick({ steps: true })

/** Relance ciblée sur un passage où aucune étape n'a été trouvée. */
export function missingStepsPrompt(input: {
  start: number
  end: number
  before: string | null
  after: string | null
  transcript: Transcript
}): string {
  const said = input.transcript.filter((t) => t.start >= input.start - 2 && t.start <= input.end)
  return `You are watching AND listening to the same screen recording. A list of steps was extracted from it, but NO step was found between ${Math.floor(input.start)}s and ${Math.ceil(input.end)}s.
${
  input.before
    ? `
Last step before this part: ${input.before}`
    : ''
}${
    input.after
      ? `
First step after this part: ${input.after}`
      : ''
  }

Watch that part carefully (between ${Math.floor(input.start)}s and ${Math.ceil(input.end)}s) and list every meaningful step of the task done there, with the same rules: one step = one meaningful action or state change, exact on-screen labels in quotes, "timestamp" IN SECONDS of the frame that best illustrates the step (between ${Math.floor(input.start)} and ${Math.ceil(input.end)}), "spoken" = what the person says while doing it (or null). If truly nothing happens there (waiting, talking without acting on screen), return an empty list.

What the person says in this part:
${formatTranscript(said)}

Return ONLY JSON: {"steps": [{"timestamp": 0, "action": "...", "screen": "...", "spoken": null}]}`
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
- The steps of the SOP are the STEPS listed below, in order, each with its own screenshot. Merge two steps only if they are really the same action (keep both screenshots). If the video shows an action missing from the list, describe it inside the closest listed step instead of adding a step without screenshot. Never invent a step, button, field or rule that is not in the video.
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

/**
 * Remplace {{SCREENSHOT_N}} par les vraies URLs. Une capture oubliée par l'IA est placée à la fin de
 * la section de son étape (« ### N. » ou « #### N. »), sinon à la fin du document.
 */
export function insertScreenshots(markdown: string, urls: (string | null)[]): string {
  let out = normalizeImageLinks(markdown)
  const forgotten: string[] = []
  urls.forEach((url, i) => {
    const placeholder = `{{SCREENSHOT_${i}}}`
    if (!url) {
      out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\{\\{SCREENSHOT_${i}\\}\\}\\)\\n?`, 'g'), '')
      out = out.replaceAll(placeholder, '')
      return
    }
    if (!out.includes(placeholder)) {
      const placed = placeUnderStep(out, i + 1, `![](${url})`)
      if (placed) out = placed
      else forgotten.push(`![](${url})`)
      return
    }
    out = out.replace(
      new RegExp(`!\\[([^\\]]*)\\]\\(\\{\\{SCREENSHOT_${i}\\}\\}\\)`, 'g'),
      `![$1](${url})`,
    )
    out = out.replaceAll(placeholder, `![](${url})`)
  })
  // Repères restés sans capture (numéro inventé par l'IA) : l'image est retirée plutôt que cassée.
  out = out.replace(/^[ \t]*!\[[^\]]*\]\(\{\{SCREENSHOT_\d+\}\}\)[ \t]*\n?/gm, '')
  out = out.replace(/!\[[^\]]*\]\(\{\{SCREENSHOT_\d+\}\}\)|\{\{SCREENSHOT_\d+\}\}/g, '')
  return forgotten.length > 0 ? `${out.trimEnd()}\n\n${forgotten.join('\n\n')}\n` : out
}

/**
 * L'IA déforme parfois les repères de capture (« {{ SCREENSHOT_7 }} », « SCREENSHOT_7 »,
 * « screenshot-7.png », « step-8.jpg »…) : on les ramène à « {{SCREENSHOT_N}} ». Toute autre image
 * (adresse inventée) est retirée : une SOP ne contient que nos captures.
 */
function normalizeImageLinks(markdown: string): string {
  return markdown
    .replace(/\{\{\s*SCREENSHOT[\s_-]*(\d+)\s*\}\}/gi, '{{SCREENSHOT_$1}}')
    .replace(
      /^[ \t]*!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)[ \t]*$/gm,
      (line, alt: string, target: string) => {
        if (/^\{\{SCREENSHOT_\d+\}\}$/.test(target)) return line
        const placeholder = /SCREENSHOT[\s_-]*(\d+)/i.exec(target)
        if (placeholder) return `![${alt}]({{SCREENSHOT_${placeholder[1]}}})`
        const step = /step[\s_-]*(\d+)\.(?:jpe?g|png)/i.exec(target)
        if (step && Number(step[1]) > 0) return `![${alt}]({{SCREENSHOT_${Number(step[1]) - 1}}})`
        return ''
      },
    )
}

/** Ajoute `image` à la fin de la section de l'étape `n` ; null si l'étape n'est pas trouvée. */
function placeUnderStep(markdown: string, n: number, image: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^#{3,4}\\s+${n}[.)]\\s`).test(l))
  if (start === -1) return null
  const level = /^#+/.exec(lines[start]!)![0].length
  let end = lines.findIndex(
    (l, k) => k > start && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level,
  )
  if (end === -1) end = lines.length
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  lines.splice(end, 0, '', image)
  return lines.join('\n')
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

/**
 * Mots maximum pour un créneau de voix off : ~2 mots / seconde (une voix lit ~2,5 mots / s), pour que
 * la phrase tienne dans le passage sans accélérer la vidéo. Mieux vaut dire moins que décaler.
 */
export function maxWordsFor(seconds: number): number {
  return Math.max(4, Math.floor(seconds * 2))
}

/** Un texte court par créneau ; le budget de mots suit la durée du créneau. */
export function narrationPrompt(input: {
  language: string
  tone: Tone
  sop: string
  slots: { start: number; seconds: number; action: string; spoken: string }[]
}): string {
  const slots = input.slots
    .map((s, i) => {
      const max = maxWordsFor(s.seconds)
      const min = Math.max(3, Math.floor(max * 0.6))
      const said = s.spoken ? `\n   What the person said here: "${s.spoken}"` : ''
      return `${i + 1}. [${s.start.toFixed(0)}s, ${s.seconds.toFixed(0)}s available → ${min}-${max} words] On screen: ${s.action}${said}`
    })
    .join('\n')

  return `Write the voice-over of a short tutorial video, in ${languageName(input.language)}. A text-to-speech voice will read it over the screen recording.

The video is split into ${input.slots.length} time slots. Write exactly ONE text per slot, in order. The voice must stay in sync with the screen: in each slot, talk ONLY about what happens on screen in that slot. Aim at the word range given for each slot (a long slot gets several sentences, a short one a few words), NEVER more words than the slot's maximum. Every slot gets a text: when the person said nothing there, explain what is done and why. The video plays at real speed and is never sped up to fit the voice, so a text that is too long ends up talking about the next screen: when in doubt, say less. The written SOP already holds all the details; the voice only guides the eye and gives the key "why".

- The voice-over replaces the person's own voice. Base each slot on the essential of WHAT THEY SAID during it (the main reason or warning), condensed into clean, confident sentences, in ${languageName(input.language)}. Keep their meaning, drop hesitations, repetitions and side remarks.
- When they said nothing useful in a slot, explain what is being done and why, using the SOP below. Do not just describe the screen.
- A critical point (rule, figure, deadline, warning) is said in the slot where it applies, with exact figures and names; nothing else from other slots.
- Slot 1 starts with one short sentence saying what we are about to do.
- The last slot ends with one sentence confirming what has been achieved.
- Tone: ${TONES[input.tone].direction} Speak to the viewer ("click…", "here you choose… because…").
- Say on-screen labels as they appear. No URLs, IDs, passwords or personal data, no markdown, no emojis, no stage directions.

SLOTS
${slots}

SOP
${input.sop.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, '').slice(0, 60000)}

Return ONLY JSON: {"lines": ["text for slot 1", "text for slot 2", ...]} with exactly ${input.slots.length} entries.`
}

export const NarrationFixSchema = z.object({
  lines: z.array(z.object({ slot: z.number().int(), text: z.string() })),
})

/**
 * Deuxième passe de la voix off : les textes dont la durée lue ne tient pas dans leur passage (trop
 * longs) ou le laissent trop longtemps muet (trop courts) sont réécrits au nombre de mots mesuré.
 */
export function narrationFixPrompt(input: {
  language: string
  tone: Tone
  items: { slot: number; action: string; spoken: string; current: string; words: number }[]
}): string {
  const items = input.items
    .map(
      (it) =>
        `Slot ${it.slot}: rewrite in about ${it.words} words (${Math.max(2, it.words - 3)}-${it.words}).\n   On screen: ${it.action}${it.spoken ? `\n   What the person said: "${it.spoken}"` : ''}\n   Current text: "${it.current}"`,
    )
    .join('\n\n')
  return `These voice-over texts of a tutorial video, in ${languageName(input.language)}, do not fit the length of their part of the video once read aloud. Rewrite each one to the given number of words, measured on the real voice: longer texts get shorter, keeping the essential; short ones get the useful explanation (why, what to watch out for) about what is on screen in that part. Talk ONLY about what happens on screen in that slot, never about the next action. Tone: ${TONES[input.tone].direction} No markdown, no URLs, no personal data.

${items}

Return ONLY JSON: {"lines": [{"slot": <slot number>, "text": "..."}]}`
}

// ── 4. Vidéo marketing animée (Remotion) : storyboard, accroche, code des scènes, relecture ──

const hex = (fallback: string) =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .catch(fallback)

export const StoryboardSchema = z.object({
  productName: z.string().min(1).catch('Our product'),
  brand: z.object({
    accent: hex('#6D5BFF'),
    accent2: hex('#FFD84D'),
    background: hex('#0E0B1F'),
  }),
  hooks: z
    .array(z.object({ line: z.string().min(1), onScreen: z.string().min(1) }))
    .min(1)
    .max(3),
  scenes: z
    .array(
      z.object({
        purpose: z.string(),
        line: z.string().min(1),
        onScreen: z.string(),
        visual: z.string(),
        screenshots: z
          .array(z.object({ time: z.number(), what: z.string() }))
          .max(3)
          .default([]),
      }),
    )
    .min(2)
    .max(8),
  musicPrompt: z.string().default('modern upbeat electronic background music, positive, driving'),
})
export type Storyboard = z.infer<typeof StoryboardSchema>

/** Gemini regarde et écoute l'enregistrement, puis écrit le storyboard d'une vidéo animée. */
export function storyboardPrompt(input: {
  language: string
  tone: Tone
  durationSeconds: number
  title: string
  brief: string | null
  targetSeconds: number
}): string {
  const language = languageName(input.language)
  const scenes = input.targetSeconds <= 30 ? '4 or 5' : '6 to 8'
  const words = Math.round(input.targetSeconds * 2.3)
  return `You are a creative director at a top SaaS motion-design studio. From this screen recording of "${input.title}", write the storyboard of a ${input.targetSeconds}-second animated marketing video (motion design, like the launch videos of Linear, Stripe or Notion). It is NOT a cut of the recording: each scene is animated from scratch, using the real screenshots of the product as material. A voice-over in ${language} runs over the whole video, with captions.
${input.brief ? `\nBRIEF FROM THE USER (follow it: what to highlight, for whom, which message, which call to action):\n${input.brief}\n` : ''}
Understand the product first: what it does, for whom, the real benefits. Use what the person says in the recording (their vocabulary, figures, promises); never invent features or figures.

Write:
- "productName": the product's name as seen or heard (or a short descriptive name).
- "brand": colors taken from the product's interface: "accent" = its main brand/UI color, "accent2" = a bright complementary highlight color (readable on a dark background), "background" = a deep, dark, slightly tinted background color that goes with the accent. Hex "#RRGGBB".
- "hooks": 3 different opening hooks (first 3 seconds, decides if people keep watching): "line" = the voice-over sentence (6 to 12 words, in ${language}); "onScreen" = the 2-5 words shown big on screen. Vary the angle: a pain point, a bold promise, a surprising question.
- "scenes": ${scenes} scenes forming a story: scene 1 is the hook (write it with the best of your hooks), then the problem or the promise, then 2-4 key benefits shown in the product, then the call to action (last scene). For each scene:
  - "purpose": one short phrase (e.g. "hook", "benefit: invoices sorted automatically", "cta");
  - "line": the voice-over for that scene, in ${language}, one or two short sentences, 6 to 22 words. The lines follow each other as one fluid text. At most ${words} words in total for all scenes.
  - "onScreen": the few words shown big on screen (2 to 7 words, in ${language}), not a copy of the line: the key idea.
  - "visual": the animation idea, precise and visual (what appears, how it moves, what the camera zooms on, which UI element is rebuilt big, where a cursor clicks, what number counts up). Vary the layouts from scene to scene. The hook and the call to action can be pure typography and shapes.
  - "screenshots": 0 to 2 moments of the recording to use as material: "time" in seconds (between 0 and ${Math.floor(input.durationSeconds)}), at a frame where the interface is clean and shows the thing (no loading, no open menu unless it is the point); "what": what is visible and where on the screen (e.g. "invoice list, 'Paid' badges in the right column").
- "musicPrompt": fitting background music (style, mood, tempo).

Tone: ${TONES[input.tone].direction} No URLs, no personal data (names, emails, amounts that look private), no stage directions in the lines.

Return ONLY JSON:
{"productName": "...", "brand": {"accent": "#...", "accent2": "#...", "background": "#..."}, "hooks": [{"line": "...", "onScreen": "..."}], "scenes": [{"purpose": "hook", "line": "...", "onScreen": "...", "visual": "...", "screenshots": [{"time": 12.5, "what": "..."}]}], "musicPrompt": "..."}`
}

export const HookPickSchema = z.object({ best: z.number().int(), reason: z.string().default('') })

/** Choisit la meilleure des accroches proposées. */
export function hookPickPrompt(input: {
  productName: string
  brief: string | null
  hooks: Storyboard['hooks']
}): string {
  const hooks = input.hooks
    .map((h, i) => `${i + 1}. Voice: "${h.line}" / On screen: "${h.onScreen}"`)
    .join('\n')
  return `You judge the opening hooks of a short marketing video for "${input.productName}".${input.brief ? `\nBrief: ${input.brief}` : ''}

Pick the hook most likely to make the target audience keep watching after 3 seconds: specific, concrete, about THEIR problem or gain, easy to grasp instantly, not generic hype ("Revolutionize your workflow" is bad).

${hooks}

Return ONLY JSON: {"best": <number of the best hook>, "reason": "..."}`
}

/**
 * Prompt système du modèle qui code les scènes : la boîte à outils disponible et les règles.
 * Identique pour toutes les scènes (mis en cache par Claude) : ne rien y mettre qui change d'une vidéo à l'autre.
 */
export const SCENE_SYSTEM_PROMPT = `You are a senior motion designer who codes. You write ONE scene of an animated marketing video as a React component rendered by Remotion, frame by frame, at 30 fps. Your scenes look like the launch videos of Linear, Stripe, Vercel or Notion: bold typography, generous space, depth, smooth motion, the real product front and center.

# Output

Reply with the complete code of the scene in ONE \`\`\`tsx block. Nothing else is needed.

\`\`\`tsx
function Scene({ brand, shots, durationInFrames }) {
  const frame = Remotion.useCurrentFrame()
  const { fps, width, height } = Remotion.useVideoConfig()
  // ...
  return <Remotion.AbsoluteFill style={{ background: brand.background }}>...</Remotion.AbsoluteFill>
}
\`\`\`

- \`React\` and \`Remotion\` are in scope. NO imports, NO exports. Helper components and constants may be defined above \`Scene\`, in the same block. TypeScript types are optional.
- Props: \`brand\` = { productName, accent, accent2, background, text } (hex colors); \`shots\` = the real screenshots of the product for this scene: [{ src, width, height, description }] (may be empty); \`durationInFrames\` = length of the scene.
- Everything is a pure function of \`frame\`: no useState/useEffect, no timers, no Math.random (use \`Remotion.random('any-seed')\`, deterministic, 0-1), no Date, no CSS animations/transitions/@keyframes, no window/document, no network, no external images or fonts, no <video>/<audio>. Hooks allowed: useCurrentFrame, useVideoConfig, React.useMemo.
- Use inline styles. The font (Inter) is already set. Sizes in px for the given \`width\`/\`height\` (1920×1080 landscape or 1080×1920 portrait: adapt the layout to both, e.g. \`const vertical = height > width\`).
- Only use the APIs listed below. Guard every array access (\`shots[0]\` may be undefined).

# Remotion API (all on the \`Remotion\` object)

Core: \`useCurrentFrame()\`, \`useVideoConfig()\` → { fps, width, height, durationInFrames }, \`interpolate(frame, [in0, in1], [out0, out1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing })\`, \`spring({ frame, fps, delay?, config?: { damping, stiffness, mass }, durationInFrames? })\` → 0..1 (damping 200 = no bounce; 12 = bouncy), \`Easing.bezier(x1,y1,x2,y2)\` / \`Easing.out(Easing.cubic)\` / \`Easing.inOut(Easing.quad)\`, \`interpolateColors(frame, [a, b], [colorA, colorB])\`, \`random(seed)\`, \`<AbsoluteFill style>\` (full-size absolutely positioned flex column), \`<Sequence from={f} durationInFrames={n}>\` (children see frame reset to 0 at \`from\`), \`<Img src style>\`.

Product material:
- \`<Remotion.Screenshot shot={shots[0]} focus={{ x: 72, y: 30, zoom: 1.6 }} startFrame={20} zoomFrames={40} radius={16} style={...} />\`: the real screenshot, fully visible (object-fit contain) in its container, with a camera push towards \`focus\` (x/y in % of the screenshot, zoom factor), eased. Without \`focus\`: slow subtle zoom. Give it a sized container (width/height or flex). This is the most convincing material: show the real product, then zoom on what the voice talks about.
- \`<Remotion.MockFrame url="app.acme.com" tone="light|dark" style>children</Remotion.MockFrame>\`: browser window chrome (traffic lights, URL bar) around children, fills its container. Nice around a Screenshot, optional.
- \`<Remotion.AnimatedCursor leftPct topPct accentColor ripple? rippleRadius? rippleOpacity? />\`: mouse pointer at % of its positioned parent, with optional click ripple you animate yourself.
- \`<Remotion.Pill tone="success|warning|danger|accent|muted" dot? accentColor style>label</Remotion.Pill>\`: status badge.
- \`<Remotion.AccentGlow color size? opacity? frame? position="center|top|bottom|left|right" style? />\`: big blurred color glow for depth, behind the focal element (pass \`frame\` for a slow pulse).
- \`Remotion.Icons.<LucideName>\`: every lucide icon (Sparkles, Zap, Check, CheckCircle2, ArrowRight, FileText, Clock, Users, Search, Bell, Shield, TrendingUp, Wand2, MousePointerClick, Send, Calendar, Mail…), props { size, color, strokeWidth }. Assign to a capitalized variable before use: \`const Zap = Remotion.Icons.Zap\`.
- \`Remotion.Charts\`: recharts (ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell). Always \`isAnimationActive={false}\` and animate the data yourself with interpolate.
- Motion primitives: \`<TypewriterText text startFrame? charsPerFrame? cursor? cursorColor? style />\`, \`<FadeInStagger startFrame? stagger? fadeFrames? slideY? style>children</FadeInStagger>\`, \`<PulseGlow color intensity? period?>children</PulseGlow>\`, \`<BreathingScale amplitude? period?>children</BreathingScale>\`, \`<OrbitingDot center={{x,y}} radius period phase size color />\`, \`<Connector from={{x,y}} to={{x,y}} color thickness startFrame drawFrames traveling />\`, \`<TravelingPhoton from to speed size color />\`, \`<ParticleField count color size drift seed opacity />\` (all under \`Remotion.\`; positions in % of a position:relative parent).

# Craft rules

- One idea per scene. The on-screen text is short (2-7 words), BIG (landscape: 72-140 px, weight 700-900, letter-spacing -0.02em to -0.04em; portrait: 80-150 px), max 2 lines, never a paragraph. Use exactly the on-screen text you are given (same language).
- Show the product: when there are shots, build the scene around them (big, with depth: shadow, slight 3D tilt via perspective/rotateX/rotateY, glow behind), and move the camera to the part the voice talks about. You can also REBUILD a key UI element from the screenshot big and clean (a card, a button, a row, a badge, a number) with divs, in the product's colors, and animate it (cursor click, value filling, badge appearing, number counting up). Never invent a different interface.
- Motion: the first element is visible by frame 8-12 (no empty start), entrances are staggered and eased (spring or Easing.out), something keeps moving until the end (slow push, drift, glow, parallax) so no frame is frozen. No exit animation needed: the next scene fades in over the last frames. Keep timings proportional to \`durationInFrames\`.
- Layout: everything inside the frame with at least 80 px margins; nothing overlaps unless on purpose; text never clipped or overflowing (set maxWidth, test long words); strong contrast (text on dark background = light; on a light card = dark).
- CAPTIONS ZONE: the voice-over captions are drawn over the bottom of the video. Keep the bottom 22% of the height free of any text or important element (backgrounds and decorative glows are fine).
- Colors: brand.background as the base (you may add a subtle gradient or noise of it), brand.accent for the key element, brand.accent2 for small highlights. Stay coherent with the other scenes (same background, same type style).
- Quality bar: this must look designed by a studio, not like a slide. Depth, hierarchy, rhythm. Avoid clutter: 1 focal point, 1-3 supporting elements.`

/** Demande du code d'une scène (les captures sont jointes en images après ce texte). */
export function scenePrompt(input: {
  language: string
  productName: string
  brief: string | null
  storyboard: { purpose: string; line: string; onScreen: string }[]
  index: number
  visual: string
  seconds: number
  frames: number
  width: number
  height: number
  brand: { accent: string; accent2: string; background: string; text: string }
  shots: { what: string }[]
}): string {
  const scene = input.storyboard[input.index]!
  const story = input.storyboard
    .map(
      (s, i) => `${i + 1}. [${s.purpose}] "${s.line}"${i === input.index ? '   ← THIS SCENE' : ''}`,
    )
    .join('\n')
  const shots =
    input.shots.length > 0
      ? input.shots.map((s, i) => `shots[${i}]: ${s.what} (image ${i + 1} below)`).join('\n')
      : 'none: use typography, shapes and icons.'
  return `Video: ${input.productName} — ${input.storyboard.length} scenes, voice-over in ${languageName(input.language)}.${input.brief ? `\nBrief: ${input.brief}` : ''}

Whole script (for continuity):
${story}

THIS SCENE: ${input.index + 1} of ${input.storyboard.length} — ${scene.purpose}
- Voice-over during the scene: "${scene.line}"
- On-screen text (use exactly): "${scene.onScreen}"
- Animation idea: ${input.visual}
- Duration: ${input.frames} frames (${input.seconds.toFixed(1)} s) at 30 fps
- Format: ${input.width}×${input.height}
- brand = ${JSON.stringify({ productName: input.productName, ...input.brand })}
- Screenshots: ${shots}

Write the scene.`
}

/** Le rendu a échoué : l'erreur est renvoyée au modèle. */
export function sceneFixPrompt(error: string): string {
  return `The scene could not be rendered. Error:

${error.slice(0, 3000)}

Fix it and reply with the complete corrected code in one \`\`\`tsx block.`
}

/** Relecture « directeur artistique » : le modèle voit des images du rendu de sa scène. */
export function sceneReviewPrompt(frames: number[], total: number): string {
  return `Here is your scene rendered at frames ${frames.join(', ')} of ${total} (half resolution), in that order.

Review it like a demanding art director. Check: text clipped, overflowing or overlapping; anything in the bottom 22% captions zone; empty or unbalanced composition; unreadable text or poor contrast; screenshot too small to read or badly cropped; elements off-screen; a first frame that is still empty; nothing moving between frames; generic "slide" look.

If it is good enough to ship, reply exactly: VERDICT: OK
Otherwise reply "VERDICT: FIX", the list of problems, then the complete improved code in one \`\`\`tsx block.`
}

export function reviewApproved(answer: string): boolean {
  return /VERDICT:\s*OK/i.test(answer) && !/```/.test(answer)
}
