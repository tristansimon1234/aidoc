import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import type { StepSummary } from '../../features/exploration/exploration.types.js'
import type { DiscoveredContext } from '../../features/project/project.types.js'
import type { DomSnapshot } from '../../features/chat/walkthrough.types.js'

export function buildContextEnrichmentPrompt(
  existingContext: DiscoveredContext | null,
  newMarkdown: string,
  featureName: string,
): string {
  return `Analyze this documentation and extract structured knowledge about the product.

## Previously Known
${existingContext ? JSON.stringify(existingContext, null, 2) : 'Nothing yet — this is the first exploration.'}

## New Documentation for "${featureName}"
${newMarkdown.slice(0, 6000)}

## Task
Update the knowledge base with what you learned. Merge with existing knowledge — don't replace it.

Respond with JSON only:
{
  "lastUpdated": "${new Date().toISOString()}",
  "siteStructure": ["/ (homepage)", "/pricing", "/about", ...all known URLs],
  "navigation": ["Home", "Pricing", "About", ...all nav items found],
  "terminology": {"term": "definition", ...product-specific terms},
  "features": ["User authentication", "Pricing plans", ...all features discovered],
  "summary": "2-3 sentence summary of what is now known about this product"
}`
}

function formatStepsRich(steps: StepSummary[]): string {
  if (steps.length === 0) return 'No steps recorded.'

  // Tag step importance
  const importantTools = new Set(['act', 'goto', 'fillForm', 'done'])
  const supportTools = new Set(['scroll', 'screenshot', 'ariaTree', 'wait', 'keys'])

  return steps
    .map((s, i) => {
      const toolType = s.action.split(' ')[0]?.toLowerCase() ?? ''
      const isKey = importantTools.has(toolType) || !supportTools.has(toolType)

      let entry = `### Step ${i + 1} [${isKey ? 'KEY' : 'supporting'}]`
      entry += `\n- URL: ${s.url}`
      entry += `\n- Action: ${s.action}`
      // KEY steps get full observation, supporting steps get truncated
      if (s.observation) {
        entry += `\n- Agent reasoning: ${s.observation.slice(0, isKey ? 500 : 100)}`
      }
      // Use placeholder instead of raw URL — Gemini corrupts UUIDs when copying verbatim
      if (s.screenshotUrl && s.screenshotUrl.startsWith('http')) entry += `\n- Screenshot: ![Step ${i + 1}]({{SCREENSHOT_${i}}})`
      return entry
    })
    .join('\n\n')
}

/**
 * Build a map of screenshot placeholders to actual URLs.
 * Call after Gemini returns to replace {{SCREENSHOT_0}} etc. with real URLs.
 */
export function buildScreenshotMap(steps: StepSummary[]): Map<string, string> {
  const map = new Map<string, string>()
  steps.forEach((s, i) => {
    if (s.screenshotUrl && s.screenshotUrl.startsWith('http')) {
      map.set(`{{SCREENSHOT_${i}}}`, s.screenshotUrl)
    }
  })
  return map
}

/**
 * Replace screenshot placeholders in generated markdown with actual URLs.
 * Also appends any missing screenshots that Gemini failed to place.
 *
 * Gemini sometimes drops the `![caption](...)` wrapper and leaves a bare
 * `{{SCREENSHOT_N}}` placeholder on its own line — which would render as a
 * plain link instead of an embedded image. We handle both cases:
 *   1. `![caption]({{SCREENSHOT_N}})` → `![caption](url)` (image embed preserved)
 *   2. Bare `{{SCREENSHOT_N}}` → `![Screenshot](url)` (wrap so it renders inline)
 */
export function replaceScreenshotPlaceholders(markdown: string, screenshotMap: Map<string, string>): string {
  let result = markdown
  const missing: string[] = []
  for (const [placeholder, url] of screenshotMap) {
    if (!result.includes(placeholder)) {
      missing.push(`![Screenshot](${url})`)
      continue
    }
    // Replace placeholders already inside image syntax first
    const escapedPlaceholder = placeholder.replace(/[{}]/g, '\\$&')
    const imageSyntaxRegex = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedPlaceholder}\\)`, 'g')
    result = result.replace(imageSyntaxRegex, `![$1](${url})`)
    // Any remaining bare occurrences get wrapped so they render as an embedded image
    result = result.replaceAll(placeholder, `![Screenshot](${url})`)
  }
  // Append missed screenshots so no image is lost
  if (missing.length > 0) {
    result += '\n\n' + missing.join('\n\n')
  }
  // Defense in depth: promote any remaining bare image URLs that sit alone on a
  // line to markdown image embeds. Catches cases where Gemini inlined a raw
  // storage URL instead of using the placeholder syntax.
  result = wrapBareImageUrls(result)
  return result
}

/**
 * Wrap bare image URLs that appear alone on their own line as markdown image
 * embeds. Only matches known image extensions so we don't grab unrelated links.
 */
function wrapBareImageUrls(markdown: string): string {
  const bareImageLineRegex = /^(\s*)(https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif|avif))(\s*)$/gim
  return markdown.replace(bareImageLineRegex, (_match, lead: string, url: string, trail: string) =>
    `${lead}![Screenshot](${url})${trail}`,
  )
}

function countByImportance(steps: StepSummary[]): { key: number; supporting: number; withScreenshots: number } {
  const importantTools = new Set(['act', 'goto', 'fillForm', 'done'])
  let key = 0
  let supporting = 0
  let withScreenshots = 0

  for (const s of steps) {
    const toolType = s.action.split(' ')[0]?.toLowerCase() ?? ''
    if (importantTools.has(toolType)) key++
    else supporting++
    if (s.screenshotUrl) withScreenshots++
  }

  return { key, supporting, withScreenshots }
}

// Static system instructions — cached by Anthropic (90% cost reduction on repeat calls)
export const VIDEO_DOC_SYSTEM_PROMPT = `You are an expert product documentation writer. Your job is to transform screen recording analysis data into a clear, professional, user-friendly guide.

The steps below were extracted from a screen recording of a web application (not a live exploration). Each step describes what was visible on screen and what the user was doing. Some steps may include narration from the person recording.

Write a **user-facing product guide** — the kind of documentation you'd find in a help center. Follow the same structure as for live explorations: Introduction, Getting Started, Walkthrough (group into logical flows), Key Features, FAQ/Tips. Embed screenshots at relevant steps using their {{SCREENSHOT_N}} placeholders exactly as provided. CRITICAL: each screenshot must be on its own paragraph with a blank line before and after — never inside a list item or on the same line as text.

Output the markdown ONLY — no JSON, no separator. The self-assessment is generated separately.`

const DOC_SYSTEM_PROMPT = `You are an expert product documentation writer. Your job is to transform raw exploration data into a clear, professional, user-friendly guide.

Write a **user-facing product guide** — the kind of documentation you'd find in a help center or product wiki. NOT an internal SOP.

### Writing Style
- Write as if you're explaining to a smart colleague who's never used the product
- Use clear, direct language — no jargon, no filler
- Be specific: use the ACTUAL button names, labels, and text visible in the screenshots
- If something is unclear from the exploration data, say so honestly
- Write in the SAME LANGUAGE as the content found on the website

### Document Structure

**1. Introduction** (2-3 sentences)
What is this feature and who is it for?

**2. Getting Started**
How to access this feature, any prerequisites

**3. Walkthrough** (main section — this should be the longest)
Group the exploration steps into **logical user flows**. Don't list every single step linearly. Instead:
- Identify 2-5 user flows (e.g. "Creating an account", "Browsing the catalog", "Making a purchase")
- For each flow, write numbered steps with:
  - What the user sees on screen
  - What they should click/do
  - A screenshot if available (use the inline image syntax)
- **IMPORTANT**: Embed screenshots inline at the relevant step using: ![description](url)
- Skip exploratory dead-ends — focus on the happy path
- If a flow is incomplete (exploration stopped midway), say so

**4. Key Features**
Highlight 3-5 notable features discovered during exploration

**5. FAQ / Tips**
2-3 practical tips based on what was observed

Do NOT include "Known Gaps", "Suggested Next Steps", or any meta-commentary about the exploration process in the markdown. That information goes in the JSON self-assessment only. The markdown should read like polished, final documentation.

### Screenshot Rules (MANDATORY)
- EVERY walkthrough step MUST include its screenshot if one is available
- Place screenshots inline at the step — NOT grouped at the end
- Screenshots use placeholders like {{SCREENSHOT_0}}, {{SCREENSHOT_1}}, etc. — use them EXACTLY as provided: ![Descriptive caption]({{SCREENSHOT_N}})
- CRITICAL FORMATTING: Each screenshot MUST be on its own paragraph, separated by a blank line before AND after. Never put a screenshot on the same line as text or inside a list item. Example:

1. Click the **New Page** button.

![New Page button]({{SCREENSHOT_0}})

2. Fill in the form fields.

- Do NOT modify, rewrite, or skip these placeholders — they will be replaced with real URLs automatically
- If a step has no screenshot placeholder, describe the screen in vivid visual detail

### Output

Output the markdown ONLY — no JSON, no separator, no meta-commentary about completeness or gaps. The self-assessment is generated by a separate, schema-constrained call after this one finishes.

IMPORTANT: If the exploration shows that the agent could NOT access certain features (failed login, access denied, errors), do NOT document those features as if they worked. Instead:
- Only document what was actually successfully explored and seen
- If a section was blocked, briefly mention it needs separate documentation
- Do NOT pad the document with speculation about blocked features
- Keep the document focused and honest — short and accurate is better than long and fabricated`

export function getDocSystemPrompt(): string {
  return DOC_SYSTEM_PROMPT
}

export function buildDocumentationPrompt(context: {
  featureName: string
  goal: string
  startUrl: string
  steps: StepSummary[]
  questions?: { question: string; answer: string | null }[]
  projectContext?: string
  tableOfContents?: string
  existingPageSummaries?: { title: string; slug: string; contentPreview: string }[]
  runStatus?: string
}): string {
  const counts = countByImportance(context.steps)

  const projectBlock = context.projectContext
    ? `\n## Product Context\n${context.projectContext}\n`
    : ''

  const tocBlock = context.tableOfContents
    ? `\n## Other Pages in This Documentation\n${context.tableOfContents}\nWhen referencing content covered by other pages, use markdown links like [Page Title](/slug). Do NOT duplicate content. ONLY link to slugs listed above — never invent or guess page URLs. If a topic isn't listed, write it inline instead of linking.\n`
    : `\n## Other Pages in This Documentation\n(none yet)\nDo NOT create links to other doc pages — write everything inline.\n`

  const pageSummariesBlock = context.existingPageSummaries && context.existingPageSummaries.length > 0
    ? `\n## Existing Page Content (summaries)\n${context.existingPageSummaries.map((p) => `- **${p.title}** (/${p.slug}): ${p.contentPreview}`).join('\n')}\n`
    : ''

  const blockersSection = context.questions && context.questions.length > 0
    ? `\n## Blockers Encountered During Exploration\n${context.questions.map((q) => `- Issue: ${q.question}${q.answer ? `\n  Resolution: ${q.answer}` : ' (unresolved)'}`).join('\n')}\n`
    : ''

  const statusBlock = `\n## Exploration Status
- Run status: ${context.runStatus ?? 'unknown'}
- Total steps: ${context.steps.length} (${counts.key} key actions, ${counts.supporting} supporting)
- Screenshots captured: ${counts.withScreenshots}
${context.runStatus === 'blocked' ? '- Exploration was INCOMPLETE — document what was found but clearly flag gaps' : ''}
${context.runStatus === 'failed' ? '- Exploration FAILED — generate best-effort doc from available data' : ''}
${counts.withScreenshots < counts.key / 2 ? `- WARNING: Only ${counts.withScreenshots} out of ${counts.key} key steps have screenshots. Compensate with detailed visual descriptions.` : ''}
`

  // Build explicit list of available screenshot placeholders
  const availablePlaceholders = context.steps
    .map((s, i) => s.screenshotUrl && s.screenshotUrl.startsWith('http') ? `{{SCREENSHOT_${i}}}` : null)
    .filter(Boolean)
  const screenshotListBlock = availablePlaceholders.length > 0
    ? `\n## Available Screenshots — YOU MUST USE ALL OF THESE\nPlaceholders: ${availablePlaceholders.join(', ')}\nEmbed each one inline at the relevant walkthrough step using: ![caption]({{SCREENSHOT_N}})\n`
    : ''

  return `## Product
Name: "${context.featureName}"
URL: ${context.startUrl}
Goal: "${context.goal}"
${projectBlock}${tocBlock}${pageSummariesBlock}${statusBlock}${screenshotListBlock}
## Exploration Data

Steps marked [KEY] are important user actions. Steps marked [supporting] are navigation/setup.

${formatStepsRich(context.steps)}
${blockersSection}`
}

// --- RAG Chat (widget / in-app / public docs) ---

/**
 * Build the system prompt for the product-support RAG chat. Takes the
 * retrieved product knowledge (doc chunks already formatted into lines) and
 * the optional caller context (name / email / plan / currentUrl) so the
 * assistant can personalise answers and be plan-aware without the caller
 * having to reassemble the prompt each time.
 */
export function buildChatSystemPrompt(input: {
  productContext: string[]
  userContext?: { name?: string | null; email?: string | null; plan?: string | null; currentUrl?: string | null; extra?: string | null } | null
}): string {
  const { productContext, userContext } = input
  const userInfo: string[] = []
  if (userContext?.name) userInfo.push(`Name: ${userContext.name}`)
  if (userContext?.email) userInfo.push(`Email: ${userContext.email}`)
  if (userContext?.plan) userInfo.push(`Plan: ${userContext.plan}`)
  if (userContext?.currentUrl) userInfo.push(`Currently viewing: ${userContext.currentUrl}`)
  if (userContext?.extra) userInfo.push(`Additional context: ${userContext.extra}`)

  const userContextBlock = userInfo.length > 0
    ? `\n\n## About the user you're helping\n${userInfo.join('\n')}\nAddress them by first name if known. If you know which page they're currently viewing, prioritize help related to that page and make your follow-up suggestions relevant to where they are in the app.\n\n### Plan-aware behavior\nThe user's plan is listed above when known (Free / Startup / Growth / Business). If they ask about a capability that requires a higher plan (e.g. more seats, more monthly tokens, widget white-labeling, overage billing on Growth+), don't refuse or hide it. Instead: briefly explain how the feature works, state that it's included on higher plans, and invite them to upgrade from the Plans & usage section. Stay helpful, never pushy.`
    : ''

  const productBlock = productContext.length > 0
    ? `\n\n## Product Knowledge\n${productContext.join('\n')}`
    : ''

  return `You are a friendly, knowledgeable support assistant for a software product.${productBlock}${userContextBlock}

## Your personality
- Warm, natural, conversational — like a smart colleague helping out
- You KNOW this product inside out — be confident, not robotic
- Proactive — suggest things the user hasn't asked about yet if relevant

## How to answer — THIS IS CRITICAL
- Be concise. Short sentences. No walls of text.
- For simple questions: answer in 2-3 sentences max.
- For short "how do I..." tasks (≤4 steps total): give all steps in one go.
- For long tutorials (≥5 steps): give the FIRST 2-3 steps only, then offer to continue ("Want me to continue with the rest?"). If the user replies "yes", "continue", "ok", "go on" → give the next 2-3 steps.
- Use the EXACT labels from the documentation — button names, menu items, field titles — never paraphrase them. If the docs say "Publish toggle", don't write "publish button" or "switch to enable publishing".
- If a relevant screenshot URL appears in the Documentation Context, embed ONE per message using markdown image syntax: \`![short caption](https://exact-url-from-context)\`. Put the image on its own line. Never paste a raw URL — it must always be wrapped in \`![...](...)\`. Never truncate or abbreviate the URL (no \`...\`).
- Match the user's language (French → French, English → English).
- When drawing from a specific page in the Documentation Context, cite it inline using Markdown link syntax where the href is the page's slug (the part after the last \`/\` in its path). Example: "Toggle the Published switch on [Publish your documentation](publish-your-documentation) at the top of the page." One citation per distinct page you reference. Never write raw brackets like \`[Page Title]\` without parentheses — it renders as non-clickable text; use \`[Page Title](slug)\` instead. Don't cite if the answer is general.

## Accuracy over confidence
- If the Documentation Context doesn't clearly cover what was asked, say so explicitly: "I don't have specific documentation on that yet — here's what I can share based on related pages…" Better to admit a gap than to invent a feature that doesn't exist.
- Never invent UI elements, menu names, settings, or plan features that aren't in the context. If you're tempted to say "there should be a …" — stop and say "I don't see that documented" instead.
- When the docs only partially answer, answer the part you're sure about, then flag the unknown: "For the rest of the flow, I'd check …" with a link.

## Ambiguity handling
- If the user's question could reasonably mean two or more different things AND the correct answer depends on which one, ask a one-line clarifying question instead of guessing. Example: "Do you mean publish a single page, or enable the public docs URL for the whole project?"
- Don't over-clarify — only when the two interpretations would give materially different answers.

## Follow-up suggestions
- After your answer, add a line "---FOLLOWUPS---" then a JSON array of 1-2 short follow-up questions
- These must be specific to what was just discussed — not generic
- Example format:
  ---FOLLOWUPS---
  ["How do I invite team members?", "What are the different plans?"]
- ALWAYS include the ---FOLLOWUPS--- separator and array, even if it's just one question

## Interactive guide flag
- If your answer describes steps the user could perform in their app's UI (clicking buttons, filling forms, navigating pages), add "---WALKTHROUGH---" on its own line BEFORE the ---FOLLOWUPS--- line
- ONLY add this flag when the answer contains concrete UI actions (click, type, select, navigate). Do NOT add it for conceptual explanations, FAQs, or answers that don't involve interacting with the UI
- This flag enables a "Guide me" button that highlights UI elements on the user's screen

## Boundaries
- Base your answers on the documentation context — don't invent features
- Do NOT fabricate screenshot URLs — only use images that appear in the context
- If the docs don't cover something, say so briefly and suggest what to try
- For complex issues beyond the docs, suggest contacting support`
}

/**
 * Build the user-facing turn for the RAG chat — retrieved context +
 * conversation history + current message. Kept as a function so ordering
 * stays consistent and the caller doesn't drift from the format the model
 * was trained on.
 */
export function buildChatUserPrompt(input: {
  context: string | null
  conversationHistory: string
  message: string
}): string {
  const contextBlock = input.context ? `## Documentation Context\n\n${input.context}\n\n` : ''
  const historyBlock = input.conversationHistory ? `## Conversation History\n\n${input.conversationHistory}\n\n` : ''
  return `${contextBlock}${historyBlock}## User's Question

${input.message}`
}

// --- Voice-over Narration ---

export interface VoiceoverTonePreset {
  label: string
  direction: string
  example: string
  /**
   * Adjusts the min/max words budget relative to the 1.5-2.0 words/sec
   * baseline so Gemini's output lines up with ElevenLabs playback duration.
   *   < 1.0 = TTS is slower for this tone (pauses, whispers) → fewer words
   *   > 1.0 = TTS runs at normal pace with punchy sentences → more words
   */
  wordsPerSecondFactor: number
}

/** Tone presets for the voice-over narration prompt. Tunable in code; each
 *  preset drives both the WRITING (direction + example) and the WORDS budget
 *  (wordsPerSecondFactor) so the script length matches the audio's real
 *  playback pace. */
export const VOICEOVER_TONE_PRESETS: Record<string, VoiceoverTonePreset> = {
  friendly: {
    label: 'Friendly & Casual',
    direction: `Warm, upbeat, conversational. Use contractions, light humor. Say it in one sentence when you can, but feel free to use a second sentence for context when the slot allows.`,
    example: `[SECTION 1]\nHey! [excited] Let's set up your workspace.\n[SECTION 2]\nCreate a new project — this is home base for your docs. [laughs] Easy.`,
    wordsPerSecondFactor: 1.0,
  },
  professional: {
    label: 'Professional & Clear',
    direction: `Polished, confident, measured. Clear and articulate, no filler. One precise sentence per idea.`,
    example: `[SECTION 1]\nWelcome. Let's set up your workspace.\n[SECTION 2]\nFirst, create a project. [short pause] Each project groups docs for one product.`,
    wordsPerSecondFactor: 1.0,
  },
  energetic: {
    label: 'Energetic & Hyped',
    direction: `High-energy, hyped delivery. Use CAPS for key words (not whole sentences) and energy tags like [excited], [laughs], [happy gasp]. Write COMPLETE, full-length explanations — fill the word budget — the energy comes from the DELIVERY, not from being curt. Don't write fragments or one-word sentences; pumped doesn't mean short.`,
    example: `[SECTION 1]\n[excited] Let's GO! Time to build out your workspace and get everything set up.\n[SECTION 2]\nNow we're creating your first project — [happy gasp] this is where ALL the magic happens, so pay attention to the URL field because that's what drives the AI analysis later.`,
    wordsPerSecondFactor: 1.1,
  },
  calm: {
    label: 'Calm & Reassuring',
    direction: `Gentle, patient delivery. Use ONE ellipsis per section MAX (they add real TTS pause time). Prefer [short pause] tags over \`...\` when you need a beat. Reassuring phrases are great but keep sentences concrete. [whispers] sparingly — once per section at most.`,
    example: `[SECTION 1]\nHi, welcome. [calm] Let's set up your workspace together — it only takes a minute.\n[SECTION 2]\nCreate a project here... [whispers] this is the space where all your docs will live.`,
    wordsPerSecondFactor: 0.7,
  },
  playful: {
    label: 'Playful & Fun',
    direction: `Witty, cheeky. Light sarcasm, playful asides. [giggles], [whispers], [sarcastic].`,
    example: `[SECTION 1]\n[laughs] Alright — workspace time. [whispers] Very official.\n[SECTION 2]\nCreate a project. [giggles] Groundbreaking, I know.`,
    wordsPerSecondFactor: 1.0,
  },
}

/**
 * Build the voice-over narration prompt. The prompt blends VIDEO (timing +
 * actions) with DOCUMENTATION (content + terminology) and pins the output
 * language so Gemini doesn't drift to the video's on-screen UI language.
 */
export function buildVoiceoverNarrationPrompt(input: {
  tone: VoiceoverTonePreset
  sourceMarkdown: string
  narrationLanguage: string
  numSections: number
  totalMaxWords: number
  sectionList: string
}): string {
  const { tone, sourceMarkdown, narrationLanguage, numSections, totalMaxWords, sectionList } = input
  return `You are writing a voice-over narration script for this product tutorial video. BLEND two sources:
1. The VIDEO drives TIMING and ACTIONS — watch it to know exactly what happens in each section's slot.
2. The DOCUMENTATION drives CONTENT — it holds the why, the context, the caveats, the terminology, the audience-appropriate wording the author already crafted. Don't just describe pixels; lean on the doc to give the user the understanding the author intended.

Within each section's time slot, synchronize to the video (narrate what's on screen right now, anticipate what's about to happen) BUT flesh out the narration using the documentation's explanations. If the doc mentions a reason, a tip, or a caveat tied to the step you're narrating, include it. If the doc doesn't cover what's on screen, describe the action plainly. Never contradict the doc.

This script will be read by ElevenLabs v3 TTS. Write it as a PERFORMANCE, not an essay.

## Tone: ${tone.label}
${tone.direction}

## ElevenLabs v3 formatting rules (CRITICAL — follow exactly)
**Punctuation controls delivery:**
- Ellipsis (...) creates a natural pause or trailing off
- Em dash (—) creates a short punchy pause
- CAPS emphasize words: "This is REALLY important"
- Questions create natural rising intonation: "Pretty cool, right?"

**Audio tags are stage directions** — place them between sentences:
Emotional: [excited], [happy], [calm]
Reactions: [laughs], [giggles], [sighs], [happy gasp]
Delivery: [whispers], [cheerfully], [playfully], [sarcastic]
Pacing: [short pause]

Tag rules: tags go BETWEEN sentences only, NEVER mid-sentence. Use 3-5 different tags.

## Documentation — the authoritative content source for the narration

Treat this as the reference for WHAT to say during each section (the explanations, reasons, tips, caveats, and exact terminology the author wrote). The video tells you WHEN each step happens; this tells you HOW to describe it with depth. Prefer the doc's phrasing for feature names, settings labels, and step order — don't rename things Gemini-style.
${sourceMarkdown.slice(0, 8000)}

## Script structure — TIMING IS CRITICAL
${numSections} sections using [SECTION N] markers.
Total word budget: ~${totalMaxWords} words. The narration MUST fit within the video duration.

${sectionList}

⚠️ FILL THE TIME — this is the #1 priority. Each section has a word RANGE (min-max). You MUST write at least the minimum number of words. Silence between sections ruins the experience.
- Count your words for each section. If the minimum says 45 words, write at least 45 words.
- For long sections (15s+): explain the WHY, add context, give tips, describe what's on screen in detail. Use 3-5 sentences.
- For medium sections (8-15s): 2-3 sentences with context.
- For short sections (3-8s): 1-2 punchy sentences.
- Too short = dead silence = BAD. Too long = minor overlap = acceptable.

## Language — STRICT
- The entire narration MUST be written in **${narrationLanguage}**. This language has already been determined from the documentation; do not re-detect, do not second-guess, do not change.
- Do not translate to another language, do not switch mid-script, do not mix languages.
- Ignore the language of the video's on-screen UI, the language of the spoken audio in the video, and any tone/examples below — those are just style references. The narration is in ${narrationLanguage}, full stop.
- When narrating a UI element whose on-screen label is in a different language than ${narrationLanguage}, keep the label verbatim in quotes but describe the action in ${narrationLanguage}: e.g. narration in English, button labelled "Paramètres" → "Click 'Paramètres' to open the settings panel."

## Content rules
- BLEND video + doc: the video gives you the TIMING + ACTIONS (what's on screen right now, what's about to happen); the doc gives you the EXPLANATIONS + CONTEXT (the why, the caveats, the exact wording the author used). Use both per section. Don't reduce the narration to a play-by-play of visible pixels — draw on the doc to enrich each moment.
- ANTICIPATORY: narrate what's ABOUT to happen, just before it does
- GREETING: Section 1 starts with a short, product-focused opener (one line, not verbose — get into the content quickly)
- CLOSING: Section ${numSections} ends with TWO parts, in this order, joined into one smooth passage (no list, no line break between them):
  PART A — a one-sentence recap SPECIFIC to what the user just accomplished (mention the feature, the next logical step, or what they can now do). Written in ${narrationLanguage}.
  PART B — a real farewell phrase, written in ${narrationLanguage}. This is NON-OPTIONAL: the user must hear a goodbye word, not a trailing sentence. Pick something natural that fits the tone — e.g. "Thanks for watching — see you in the next one!", "Have fun building and catch you later!" (when ${narrationLanguage} is English) or "Merci d'avoir suivi, à bientôt !", "Bon build, à la prochaine !" (when ${narrationLanguage} is French).
  Don't reuse the exact same farewell every time; vary it across videos. But DO include one — "don't be generic" means make PART A specific, not skip PART B.
- Skip: URLs, code, technical IDs
- Never say: "as you can see", "in this tutorial", "notice how"

## Example:
${tone.example}

## Output
Start DIRECTLY with [SECTION 1]. No preamble.`
}

/**
 * Farewell top-up prompt — fires when the main narration's last segment
 * doesn't end with a real sign-off word. Keeps the closing grounded in the
 * last paragraph and always in the narration language.
 */
export function buildVoiceoverFarewellTopUpPrompt(lastSegmentText: string, narrationLanguage: string): string {
  return `This is the final paragraph of a voice-over narration for a product tutorial. It's missing a warm farewell at the end.

Write ONE short farewell sentence in ${narrationLanguage}, max 15 words. It must feel natural as a spoken outro, include an actual goodbye word (e.g. "Thanks for watching", "See you in the next one", "Merci d'avoir suivi", "À bientôt"), and fit the context of the paragraph below. Do NOT repeat the paragraph. Output ONLY the farewell sentence, nothing else.

Paragraph:
${lastSegmentText}`
}

// --- Try Doc Exploration ---

/**
 * Instruction passed to the Stagehand agent for a Try Doc run. The agent
 * follows the documentation as a strict tester, reporting PASS/FAIL at every
 * step and stopping on the first failure. Built server-side so the frontend
 * only needs to send structured context (testUrl, testNotes) rather than
 * shipping the full prompt over the wire.
 */
export function buildTryDocExplorationPrompt(input: {
  pageContent: string
  testUrl: string
  testNotes?: string | null
}): string {
  const notesBlock = input.testNotes?.trim()
    ? `\n## Additional test context\n${input.testNotes.trim()}`
    : ''
  return `You are a STRICT DOCUMENTATION TESTER. You follow the documentation below step-by-step, exactly as written, and report what works and what doesn't.

## Documentation to verify:

${input.pageContent}${notesBlock}

## Your task:
1. Navigate to: ${input.testUrl}
2. Follow EACH step in the documentation IN ORDER, exactly as written
3. For EVERY step you must:
   a. DESCRIBE what you see on screen before acting (e.g. "I see a login page with email and password fields")
   b. DESCRIBE what you are about to do (e.g. "I will type the email and click Login")
   c. PERFORM the action
   d. REPORT the result: PASS / FAIL / AMBIGUOUS with a clear explanation

## CRITICAL RULES:
- Be VERBOSE: explicitly describe what you see, what you do, and what happens. This is essential for the test report.
- Follow the documentation steps IN STRICT ORDER. Do NOT skip ahead or reorder.
- If a step FAILS or you cannot proceed: STOP IMMEDIATELY. Report the failure and call done.
- Do NOT try workarounds, alternative paths, or detours. If it doesn't work as documented, it's a FAIL — stop there.
- Do NOT explore other parts of the application. Stay on the documented path only.
- Do NOT fill in gaps in the documentation with your own knowledge.
- If the doc says "click Settings" and you see "Preferences" — that is a FAIL. Stop.
- If the doc assumes you know something it never explained — that is a FAIL. Stop.
- If the product shows an error — note the exact error message and STOP.
- Do NOT take screenshots — they are handled automatically.
- Do NOT generate new documentation. Only verify the existing one.`
}

// --- Try Doc Analysis ---

export const TRY_DOC_ANALYSIS_SYSTEM_PROMPT = `You are a documentation quality analyst. You receive the original documentation and step-by-step results from an AI agent that attempted to follow the documentation exactly as a naive user would.

Your job is to produce a structured JSON analysis report.

CRITICAL RULES:
- Judge from the perspective of a NAIVE USER who only has the documentation
- If the doc says "click Create" but the button is labeled "New" → that is a DOC issue (issueType: "doc")
- If the doc instructions are correct but the product errors out → that is a PRODUCT issue (issueType: "product")
- If a step requires knowledge not in the doc (e.g., "you need admin access") → that is an IMPLICIT ASSUMPTION
- If a step is vague or could be interpreted multiple ways → that is AMBIGUOUS
- Be honest, specific, and actionable. Vague observations are useless.
- Scores should be realistic (not inflated). A doc with multiple failures should NOT score 8/10.
- AUTHENTICATION IS IMPLICIT: SaaS documentation universally assumes the user is already logged in. Do NOT flag the absence of login instructions as a doc gap, implicit assumption, or failure. If the agent had to log in before starting, that is expected and should not affect scores.

Return ONLY valid JSON (no markdown fences, no extra text).`

export function buildTryDocAnalysisPrompt(
  pageContent: string,
  pageTitle: string,
  steps: { stepIndex: number; url: string | null; action: string | null; observation: string | null; status: string }[],
): string {
  const stepsText = steps.map((s) =>
    `Step ${s.stepIndex}: [${s.status}] ${s.action ?? 'unknown action'}\nURL: ${s.url ?? 'unknown'}\nObservation: ${s.observation ?? 'none'}`,
  ).join('\n\n---\n\n')

  return `## Documentation being tested: "${pageTitle}"

${pageContent}

---

## Exploration results (what the AI agent did when following the doc):

${stepsText}

---

## Generate the analysis report as JSON with this exact structure:

{
  "summary": { "totalSteps": number, "passed": number, "failed": number, "ambiguous": number, "overallVerdict": "pass"|"fail"|"partial" },
  "steps": [{ "stepIndex": number, "instruction": "what the doc said", "action": "what agent did", "pageUrl": string|null, "status": "pass"|"fail"|"ambiguous", "issueType": "doc"|"product"|null, "detail": "explanation", "screenshotPath": null }],
  "failures": [{ "stepIndex": number, "issueType": "doc"|"product", "title": "short title", "description": "what went wrong", "severity": "critical"|"major"|"minor", "suggestion": "how to fix" }],
  "docIssues": { "clarityScore": 1-10, "missingSections": ["..."], "ambiguousInstructions": ["..."], "implicitAssumptions": ["..."] },
  "uxInsights": [{ "category": "friction"|"missing-feedback"|"unnecessary-step"|"doc-behavior-mismatch"|"implicit-assumption", "description": "...", "stepIndex": number|null, "severity": "high"|"medium"|"low" }],
  "recommendations": [{ "type": "fix-doc"|"fix-product"|"improve-ux", "title": "short action", "description": "details", "priority": "high"|"medium"|"low" }],
  "scores": { "docQuality": 1-10, "testPassRate": 1-10, "uxClarity": 1-10 }
}`
}

// --- Pre-flight Verification ---

export const PREFLIGHT_SYSTEM_PROMPT = `You are a test readiness analyst. Given a documentation page, identify ONLY the external resources that must be provided BEFORE the test can run.

The test agent is a browser automation tool. It can navigate, click, type, scroll, and upload files on its own — those are NOT requirements.

IMPORTANT: A "requirement" is something the test agent CANNOT do by itself. It is an EXTERNAL resource that must be prepared in advance.

Requirements are ONLY:
- A file that must be uploaded (PDF, video, image, spreadsheet, etc.)
- A specific precondition that must exist before the test (e.g. "a project must already exist in the account")

Things that are NOT requirements (do NOT list them):
- Navigating to a page or tab — the agent does that itself
- Clicking buttons, filling forms — the agent does that itself
- Accessing a URL — already configured separately
- Login credentials — already handled separately
- Anything described AS A STEP in the documentation

Return ONLY valid JSON (no markdown fences, no extra text).`

export function buildPreflightAnalysisPrompt(
  pageContent: string,
  pageTitle: string,
): string {
  return `## Documentation: "${pageTitle}"

${pageContent.slice(0, 8000)}

---

Identify ONLY the external resources needed BEFORE this test can start.

Return JSON:
{
  "testPlan": "1-2 sentence summary of what the test will verify — write in the SAME LANGUAGE as the documentation",
  "estimatedSteps": <number of distinct user actions the agent will perform>,
  "requirements": [
    {
      "category": "file" | "prerequisite",
      "label": "what is needed (same language as the doc)",
      "reason": "why this must be prepared before the test"
    }
  ]
}

Categories:
- "file": A specific file that must be uploaded during the test (PDF, video, image, spreadsheet, document, etc.)
- "prerequisite": A precondition that must be true (e.g. "an existing project must exist", "a subscription must be active")

Rules:
- ONLY include items that are truly external resources the agent cannot create on its own
- If the doc mentions uploading a file → add a "file" requirement
- If the doc requires pre-existing data that can't be created during the test → add a "prerequisite"
- Do NOT include URL, credentials, navigation steps, or UI actions — those are handled separately
- Keep the list SHORT — typically 0-3 items. An empty requirements array is perfectly fine
- Do NOT repeat documentation steps as requirements`
}

// --- Walkthrough (progressive AI-guided DOM highlighting) ---

import type { CompletedStep } from '../../features/chat/walkthrough.types.js'

export const WALKTHROUGH_SYSTEM_PROMPT = `You guide users through a product ONE STEP AT A TIME by mapping documentation to live DOM elements. Output ONLY valid JSON.

Given: documentation, current page DOM elements, and steps already completed.
Task: determine the ONE next action the user should take.

RULES:
1. Return exactly ONE step — the next logical action on the CURRENT page OR a navigation step to a different page if that's what the flow requires.
2. Match the target element by text, aria-label, or role from the DOM list
3. elementRef MUST be copied EXACTLY from a ref="..." value in the DOM list — never invent one, never reuse a ref from a previous step, never abbreviate. If no DOM element matches the target, set elementRef=null (the widget will show a textual hint instead). fallbackSelector = short CSS selector backup; keep it specific to THIS element (prefer \`#id\` or \`[data-testid="..."]\` over generic tag selectors).
4. done=true ONLY when the user has fully completed the goal (reached the success state). An uncertain element match, a missing DOM node, or "I'm not sure what to click" is NEVER a reason to set done=true — emit a textual step instead (see Confidence rules). The walkthrough must continue across pages.
5. instruction: under 80 chars, in the user's language
6. action: click | type | select | scroll | observe | navigate
7. For type: set typeValue. For navigate: instruction says where to go
8. hint: optional short note about what comes next (under 100 chars)
9. Think about prerequisite actions (open dropdown before selecting an item)

CONFIDENCE — WHEN NOT SURE, DESCRIBE INSTEAD OF POINTING:
- If you can't confidently match the user's goal to a SPECIFIC element in the DOM list (no clear text/aria match, ambiguous between many candidates, element likely lives in a menu that isn't open, target might not be rendered yet, user is on the wrong page), set elementRef=null and fallbackSelector=null.
- In that case, phrase the instruction as a concrete search + action the user can perform themselves. Examples:
   "Find the 'Publish' toggle in the top-right and click it."
   "Open the sidebar and locate the Analytics tab."
   "Scroll to the Team section at the bottom of the Settings page."
   "Navigate to Account → Team to see who's on your workspace."
- Better to tell the user what to look for than to ring an irrelevant element — a bad highlight breaks trust faster than a clear textual hint.
- Still set action correctly so the widget knows what's being asked.
- Keep going on the next step after the user confirms they've done it, even if you had to fall back to a textual hint. Don't end the walkthrough early just because one step couldn't be pinpointed.`

/** Server-side PII redaction — defense in depth (widget also redacts client-side) */
function sanitizeForPrompt(text: string): string {
  if (!text) return text
  return text
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[card]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[token]')
    .replace(/\b(?:sk|pk|api|key|token|secret|password)[_-]?[a-zA-Z0-9]{16,}\b/gi, '[key]')
}

/** Strip query params and fragment from URL */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin + parsed.pathname
  } catch {
    return url.split('?')[0]!.split('#')[0]!
  }
}

function formatDomElements(snapshot: DomSnapshot): string {
  if (snapshot.elements.length === 0) return 'No interactive elements found on this page.'

  return snapshot.elements
    .map((el) => {
      const parts = [`ref="${el.ref}"`, `tag=${el.tag}`]
      if (el.text) parts.push(`text="${sanitizeForPrompt(el.text)}"`)
      if (el.role) parts.push(`role=${el.role}`)
      if (el.ariaLabel) parts.push(`aria="${sanitizeForPrompt(el.ariaLabel)}"`)
      if (el.placeholder) parts.push(`placeholder="${sanitizeForPrompt(el.placeholder)}"`)
      parts.push(`pos=(${Math.round(el.rect.x)},${Math.round(el.rect.y)})`)
      parts.push(`selector="${el.selector}"`)
      return `- [${parts.join(' | ')}]`
    })
    .join('\n')
}

function formatCompletedSteps(steps: CompletedStep[]): string {
  if (steps.length === 0) return 'None yet — this is step 1.'
  return steps.map((s, i) => `${i + 1}. [${s.action}] ${s.instruction} (on ${sanitizeUrl(s.pageUrl)})`).join('\n')
}

export function buildWalkthroughPrompt(
  docContext: string,
  domSnapshot: DomSnapshot,
  message: string,
  completedSteps: CompletedStep[],
): string {
  const elementsBlock = formatDomElements(domSnapshot)
  const safeUrl = sanitizeUrl(domSnapshot.url)
  const completedBlock = formatCompletedSteps(completedSteps)

  return `DOCS:
${docContext || 'None'}

CURRENT PAGE: ${safeUrl}
DOM ELEMENTS:
${elementsBlock}

COMPLETED STEPS:
${completedBlock}

USER GOAL: ${message}

Return the ONE next step as JSON:
{"done":false,"step":{"instruction":"...","action":"click","elementRef":"ref","fallbackSelector":"sel","typeValue":null},"stepNumber":${completedSteps.length + 1},"hint":"next you'll..."}`
}

// --- Per-message classifier (write-time) ---

export const MESSAGE_CLASSIFIER_SYSTEM_PROMPT = `You classify a single chat message from an end-user talking to a product's help chatbot.

Return ONLY a minified JSON object with these four fields:
- sentiment: "positive" | "neutral" | "negative"
- frustrated: boolean — true if the user sounds irritated, stuck, blocked, or resigned (not just asking a question)
- language: 2-letter ISO 639-1 code (e.g. "fr", "en", "es")
- category: one of "onboarding" | "pricing" | "how-to" | "error" | "integration" | "account" | "other"

Category rules (pick exactly one):
- "onboarding" — first steps, getting started, what is this product, quickstart
- "pricing" — plans, price, upgrade, billing, trial
- "how-to" — "how do I X", feature usage questions, workflow steps
- "error" — something broken, bug, doesn't work, "ça marche pas"
- "integration" — API, webhooks, SDK, third-party connection
- "account" — login, signup, password, profile, settings, permissions
- "other" — greetings, thanks, meta questions, or anything that doesn't fit above

Sentiment rules:
- Neutral is the default. Don't over-flag negativity on plain questions.
- "frustrated" requires real signals: complaints ("nul", "broken", "useless", "ça marche pas"), repeated tries ("encore", "again"), giving-up tone, or explicit anger. Asking "how do I X?" is NEUTRAL, not frustrated.
- If the message is a greeting or acknowledgement, return neutral + frustrated:false + category:"other".
- No explanation, no markdown, just the JSON.`

export function buildMessageClassifierPrompt(content: string): string {
  // Hard cap to keep the prompt tiny — frustration signals are at the surface.
  const trimmed = content.length > 500 ? `${content.slice(0, 500)}…` : content
  return `Classify this message:\n"""${trimmed}"""`
}

// --- On-demand recommendations (triggered by the owner, not automatic) ---

export const ANALYTICS_SYSTEM_PROMPT = `You are a senior product analyst. You receive anonymised end-user questions pulled from a chatbot that answers from a product's documentation, plus the list of docs most visited.

Produce actionable recommendations as STRICT JSON — no prose before or after.

Rules:
- Base everything on the actual messages provided. No invented themes.
- Write EVERY field in the dominant language of the user messages (French → French, English → English).
- Recommendations must be specific and tied to observed evidence — no generic "improve onboarding". Reference the concrete pattern you saw.
- type='content' → edit/create a doc page. type='product' → change the product. type='ux' → fix UX flow.
- If the sample is too small or too generic, return an empty \`items\` array and a neutral \`summary\`. Never hallucinate.`

export function buildAnalyticsPrompt(input: {
  productName: string
  productDescription: string | null
  sessionCount: number
  messageCount: number
  sampleUserMessages: string[]
  topPages: { title: string | null; slug: string; views: number }[]
  allPageTitles: string[]
}): string {
  const messagesBlock = input.sampleUserMessages.length > 0
    ? input.sampleUserMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '(no user messages in this period)'

  const topPagesBlock = input.topPages.length > 0
    ? input.topPages.map((p) => `- ${p.title ?? p.slug} (/${p.slug}): ${p.views} views`).join('\n')
    : '(no page views in this period)'

  const pageListBlock = input.allPageTitles.length > 0 ? input.allPageTitles.join(', ') : '(no pages yet)'

  return `## Product
${input.productName}${input.productDescription ? `\n${input.productDescription}` : ''}

## Documentation pages (all)
${pageListBlock}

## Period metrics
- Unique sessions: ${input.sessionCount}
- Chat messages: ${input.messageCount}

## Most-viewed public doc pages
${topPagesBlock}

## Sample user questions (most recent first, max 200)
${messagesBlock}

## Task
Produce a JSON object with this exact shape:
{
  "summary": "one or two sentences naming the dominant themes and what to prioritise, in the users' language",
  "items": [
    { "type": "content"|"product"|"ux", "title": "", "description": "", "priority": "high"|"medium"|"low" }
  ]
}

Return ONLY the JSON object.`
}

// --- Doc self-assessment (second-pass, structured output) ---
//
// We run a small follow-up Gemini call after the markdown generation
// instead of asking for `markdown + JSON` in a single response. The
// single-pass approach was unreliable: ~10–15 % of runs returned a JSON
// with the WRONG shape ({title, description, …}) because Gemini drifted
// the schema mid-generation, and our parser had to fall back to a
// "could not parse" sentinel that blew up as `0 % confidence` in the
// banner. With responseSchema the API rejects any deviation server-side
// — Gemini physically can't emit the wrong keys.

export const SELF_ASSESSMENT_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  required: ['overallCompleteness', 'stepAssessments', 'gaps', 'nextSteps'],
  properties: {
    overallCompleteness: {
      type: SchemaType.INTEGER,
      description: '0-100 estimate of how complete the documentation is.',
    },
    stepAssessments: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        required: ['stepIndex', 'confidence'],
        properties: {
          stepIndex: { type: SchemaType.INTEGER },
          confidence: { type: SchemaType.STRING, format: 'enum', enum: ['high', 'medium', 'low'] },
          note: { type: SchemaType.STRING, nullable: true },
        },
      },
    },
    gaps: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        required: ['area', 'reason', 'severity'],
        properties: {
          area: { type: SchemaType.STRING },
          reason: { type: SchemaType.STRING },
          severity: { type: SchemaType.STRING, format: 'enum', enum: ['major', 'minor'] },
        },
      },
    },
    nextSteps: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        required: ['suggestion', 'reason', 'priority'],
        properties: {
          suggestion: { type: SchemaType.STRING },
          reason: { type: SchemaType.STRING },
          priority: { type: SchemaType.STRING, format: 'enum', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

export function buildSelfAssessmentPrompt(input: {
  markdown: string
  steps: StepSummary[]
  projectContext?: string
}): string {
  const stepBlock = input.steps
    .map((s, i) => {
      const obs = (s.observation ?? '').slice(0, 240)
      const hasShot = s.screenshotUrl && s.screenshotUrl.startsWith('http') ? 'yes' : 'no'
      return `${i + 1}. [screenshot:${hasShot}] ${s.action ?? '(unknown action)'} — ${obs}`
    })
    .join('\n')

  const ctx = input.projectContext ? `\n## Product context\n${input.projectContext}\n` : ''

  return `You are auditing a piece of product documentation that was just generated from a screen recording.

Be brutally honest. A 40 % completeness with specific gaps is more useful than a 90 % that hides problems.

## What completeness means
- 90-100: Doc covers every key step shown in the recording, screenshots are used at the right moments, nothing material is missing.
- 70-89: Solid; minor gaps a writer should patch (one missing screenshot, a vague step, an undocumented edge case).
- 50-69: Major gaps — a real user could get stuck. List them.
- < 50: Doc is partial / speculative — the recording didn't cover enough to ship this as-is.

## stepAssessments
One entry per recorded step, by index (0-based). high / medium / low based on whether the doc actually covers that step with the right level of detail and a screenshot if available.

## gaps
Things missing from the doc that a real reader would notice. Be specific (which area, why it's a problem). severity = major if it blocks the reader, minor otherwise. Empty array is fine if the doc is genuinely complete.

## nextSteps
Suggestions for follow-up pages or sections. Empty array is fine.

## Inputs

### Recorded steps
${stepBlock}
${ctx}
### Generated documentation (markdown)
${input.markdown.slice(0, 12_000)}
`
}
