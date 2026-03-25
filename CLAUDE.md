# CLAUDE.md — AI Documentation Agent

> This file is the source of truth for all code generation in this project.
> Read it fully before writing any code. Never deviate from these rules.

---

## 🎯 Project Overview

An AI agent that:
1. Takes a product feature + URL as input
2. Navigates it with Playwright
3. Asks clarifying questions when blocked
4. Generates a structured SOP document
5. Outputs a simple feature architecture

This is **not a chatbot**. It is an **autonomous agent with a defined run lifecycle**.

---

## 🧱 Core Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript (strict) |
| Framework | Express (minimal, no magic) |
| Browser | Playwright |
| AI | Anthropic SDK (`claude-sonnet-4-20250514`) |
| Database | Supabase (Postgres) |
| Storage | Supabase Storage |
| Validation | Zod |
| Testing | Vitest |
| Linting | ESLint + Prettier |

---

## 📁 Project Structure (Feature-First)

```
src/
  features/
    run/
      run.types.ts        # All types for the run domain
      run.service.ts      # Business logic
      run.routes.ts       # Express routes
      run.schema.ts       # Zod validation schemas
      run.repository.ts   # All DB calls for this feature
    exploration/
      exploration.types.ts
      exploration.service.ts
      exploration.agent.ts    # Anthropic decision loop
      exploration.browser.ts  # Playwright actions
    questions/
      questions.types.ts
      questions.service.ts
      questions.routes.ts
    documentation/
      documentation.types.ts
      documentation.service.ts
      documentation.generator.ts  # Anthropic doc generation
  shared/
    db/
      supabase.client.ts
      supabase.types.ts   # Generated from Supabase CLI
    ai/
      anthropic.client.ts
      anthropic.types.ts
      prompt.builder.ts   # All prompt construction lives here
    browser/
      playwright.client.ts
      browser.types.ts
    middleware/
      error.middleware.ts
      auth.middleware.ts
    config/
      env.ts              # Zod-validated env vars
  ui/
    design-system/
      tokens.ts
      components/
        Button.tsx
        Badge.tsx
        Card.tsx
        StatusIndicator.tsx
        CodeBlock.tsx
    pages/
      RunDashboard.tsx
      RunDetail.tsx
      NewRun.tsx
  app.ts
  server.ts
```

**Rules:**
- No `utils/` catch-all folder. Logic belongs to a feature or `shared/`.
- No barrel `index.ts` re-exports unless in `design-system/components/`.
- One responsibility per file. A service never imports another service directly — use dependency injection or events.

---

## 🔷 TypeScript Rules

```ts
// ✅ Always
type RunStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed'

interface Run {
  id: string
  featureName: string       // camelCase for all properties
  startUrl: string
  goal: string
  status: RunStatus
  createdAt: Date
  updatedAt: Date
}

// ❌ Never
const run: any = {}
function doStuff(data) {}  // no implicit any
```

- `strict: true` in tsconfig — no exceptions
- No `any`. Use `unknown` + type guards if truly needed.
- All async functions return `Promise<T>` with explicit type
- Prefer `type` for unions/primitives, `interface` for objects
- Zod schema is the single source of truth for input validation — derive types from it: `type RunInput = z.infer<typeof RunInputSchema>`

---

## 🗄️ Database Rules

### Naming conventions
- Tables: `snake_case`, plural (`runs`, `run_steps`, `run_questions`, `generated_docs`, `artifacts`)
- Columns: `snake_case`
- All tables have: `id uuid DEFAULT gen_random_uuid()`, `created_at`, `updated_at`

### Repository pattern
Every DB call goes through a `*.repository.ts` file. Services never call Supabase directly.

```ts
// ✅ Correct
// run.repository.ts
export async function findRunById(id: string): Promise<Run | null> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw new DatabaseError(error.message)
  return data ? mapToRun(data) : null
}

// ❌ Wrong — Supabase call inside a service
export async function getRunStatus(id: string) {
  const { data } = await supabase.from('runs').select('status').eq('id', id)
  return data
}
```

### Schema (reference)

```sql
-- runs
id uuid PK
feature_name text NOT NULL
start_url text NOT NULL
goal text NOT NULL
status text NOT NULL DEFAULT 'pending'  -- pending | running | blocked | completed | failed
token_usage integer DEFAULT 0
created_at timestamptz DEFAULT now()
updated_at timestamptz DEFAULT now()

-- run_steps
id uuid PK
run_id uuid FK → runs.id
step_index integer NOT NULL
url text
title text
action text
observation text
screenshot_path text
status text DEFAULT 'completed'  -- completed | blocked | skipped
created_at timestamptz DEFAULT now()

-- run_questions
id uuid PK
run_id uuid FK → runs.id
step_id uuid FK → run_steps.id
question text NOT NULL
answer text
answered_at timestamptz
created_at timestamptz DEFAULT now()

-- generated_docs
id uuid PK
run_id uuid FK → runs.id UNIQUE
markdown_content text
json_content jsonb
created_at timestamptz DEFAULT now()
updated_at timestamptz DEFAULT now()

-- artifacts
id uuid PK
run_id uuid FK → runs.id
type text NOT NULL  -- screenshot | trace | export
path text NOT NULL
created_at timestamptz DEFAULT now()
```

---

## 🤖 AI / Anthropic Rules

### Model
Always use `claude-sonnet-4-20250514`. Never hardcode in call sites — use the constant:
```ts
// shared/ai/anthropic.client.ts
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
```

### Prompt construction
All prompts are built in `shared/ai/prompt.builder.ts`. Never inline a long prompt string in a service or agent file.

```ts
// ✅ Correct
const prompt = buildExplorationStepPrompt({ step, history, goal })
const decision = await callAnthropic(prompt)

// ❌ Wrong
const response = await anthropic.messages.create({
  messages: [{ role: 'user', content: `You are an agent... ${step}... ${history}...` }]
})
```

### Decision loop pattern
The exploration agent maintains a **run context** passed at every Anthropic call:

```ts
interface RunContext {
  goal: string
  featureName: string
  stepHistory: StepSummary[]   // compact — not full screenshots
  currentStep: StepData
  questionHistory: Question[]
}
```

Keep `stepHistory` compact (url + action + observation only) to manage token usage. Track `token_usage` after every call and store it on the run.

### Decision types
```ts
type AgentDecision =
  | { action: 'continue'; nextAction: string }
  | { action: 'ask'; question: string }
  | { action: 'blocked'; reason: string }
  | { action: 'finish'; summary: string }
```

Always parse AI responses with Zod. Never trust raw text output without validation.

---

## 🎭 Playwright Rules

- One browser instance per run. Close it on finish or failure (use `try/finally`).
- Never use `page.waitForTimeout()`. Use `page.waitForSelector()` or `page.waitForLoadState()`.
- All Playwright logic goes in `exploration/exploration.browser.ts`.
- Screenshots are saved to Supabase Storage, not local disk.
- Capture after every meaningful action (click, fill, navigate).

```ts
// ✅ Correct wait pattern
await page.click('#submit')
await page.waitForLoadState('networkidle')
await captureStep(page, run, stepIndex)

// ❌ Never
await page.waitForTimeout(2000)
```

---

## 🌐 API Design

RESTful, no GraphQL for MVP.

```
POST   /runs                    → create + start a run
GET    /runs/:id                → get run with steps
GET    /runs/:id/steps          → list steps
POST   /runs/:id/questions/:qid/answer  → answer a question
GET    /runs/:id/doc            → get generated doc
```

Error format (always):
```ts
interface ApiError {
  error: string      // human-readable
  code: string       // machine-readable: RUN_NOT_FOUND, VALIDATION_ERROR, etc.
  details?: unknown
}
```

HTTP status codes: 200, 201, 400, 401, 404, 422, 500. Nothing exotic.

---

## 🎨 Design System

### Aesthetic direction
**Industrial/utilitarian** — like a terminal that grew up. Dark background, monospaced accents, sharp edges, status colors that mean something. Think Linear meets Raycast.

### Tokens (`ui/design-system/tokens.ts`)

```ts
export const tokens = {
  colors: {
    bg: {
      base: '#0C0C0E',
      surface: '#141416',
      elevated: '#1C1C1F',
      overlay: '#242428',
    },
    border: {
      subtle: '#2A2A2E',
      default: '#3A3A3F',
      strong: '#5A5A62',
    },
    text: {
      primary: '#F2F2F4',
      secondary: '#9898A6',
      muted: '#5C5C6B',
      inverse: '#0C0C0E',
    },
    accent: {
      blue: '#4D9CFF',
      green: '#3DD68C',
      amber: '#F5A623',
      red: '#FF4D4D',
      purple: '#A78BFA',
    },
    status: {
      pending:   { bg: '#1A1A20', text: '#9898A6', border: '#3A3A3F' },
      running:   { bg: '#0D1F35', text: '#4D9CFF', border: '#1A3A5C' },
      blocked:   { bg: '#2D1A0A', text: '#F5A623', border: '#4A2D10' },
      completed: { bg: '#0A1F16', text: '#3DD68C', border: '#124D2C' },
      failed:    { bg: '#1F0A0A', text: '#FF4D4D', border: '#4D1212' },
    }
  },
  spacing: {
    xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '40px', '2xl': '64px'
  },
  radius: {
    sm: '4px', md: '6px', lg: '10px', full: '9999px'
  },
  font: {
    sans: "'Geist', 'DM Sans', system-ui, sans-serif",
    mono: "'Geist Mono', 'JetBrains Mono', monospace",
  },
  fontSize: {
    xs: '11px', sm: '13px', base: '14px', md: '16px', lg: '20px', xl: '28px', '2xl': '40px'
  },
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.4)',
    md: '0 4px 12px rgba(0,0,0,0.5)',
    lg: '0 8px 32px rgba(0,0,0,0.6)',
  }
}
```

### Component rules
- Components are typed with explicit props interfaces, no implicit props
- No inline styles — always use tokens
- Status always uses `tokens.colors.status[status]`
- `CodeBlock` uses monospace font + syntax highlighting (Shiki or Prism)

---

## ⚙️ Environment Variables

All env vars are validated at startup with Zod. App crashes immediately if any are missing.

```ts
// shared/config/env.ts
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
})

export const env = EnvSchema.parse(process.env)
```

---

## 🚫 Hard Rules (never break these)

1. **No `any`** — ever.
2. **No Supabase calls outside repositories.**
3. **No prompt strings outside `prompt.builder.ts`.**
4. **No `waitForTimeout` in Playwright.**
5. **No feature imports another feature's service directly** — only shared modules.
6. **Always close the Playwright browser in a `finally` block.**
7. **Always track token usage per Anthropic call and accumulate on the run.**
8. **Zod validates all external input** (API requests, AI responses, env vars).
9. **One migration file per schema change** — never edit existing migrations.
10. **No business logic in routes** — routes call services, services call repositories.

---

## 🏁 Build Order (MVP)

Follow this order strictly. Do not jump ahead.

```
Phase 1 — Foundation
  [ ] tsconfig + eslint + prettier
  [ ] shared/config/env.ts
  [ ] shared/db/supabase.client.ts
  [ ] shared/ai/anthropic.client.ts
  [ ] Supabase migrations (full schema)

Phase 2 — Run Feature
  [ ] run.types.ts
  [ ] run.schema.ts (Zod)
  [ ] run.repository.ts
  [ ] run.service.ts
  [ ] run.routes.ts

Phase 3 — Exploration
  [ ] exploration.browser.ts (Playwright — navigate, click, fill, screenshot)
  [ ] shared/ai/prompt.builder.ts (exploration prompts)
  [ ] exploration.agent.ts (decision loop)
  [ ] exploration.service.ts (orchestration)

Phase 4 — Questions
  [ ] questions.types.ts + repository + routes

Phase 5 — Documentation
  [ ] prompt.builder.ts (doc generation prompts)
  [ ] documentation.generator.ts
  [ ] documentation.service.ts

Phase 6 — UI
  [ ] Design system tokens + base components
  [ ] RunDashboard, RunDetail, NewRun pages
```

---

*Last updated: project init*
*Stack version: Node 20 / TS 5.x / Playwright 1.x / Anthropic SDK 0.x / Supabase JS 2.x*
