# SaaS Video

AI-generated product videos for SaaS. User writes a brief, gets a 45-second polished promo with AI-designed animated UI mocks, voice-over, and music.

> Extracted from the Doclee codebase (`aidoc` repo). The marketing-video pipeline (Gemini script → ElevenLabs voice + music → Remotion render with esbuild-compiled scene mocks) is the same engine; persistence, branding, billing, and auth surfaces are rewritten as standalone.

## Stack

- Node 20 / TypeScript 5.9 strict
- Express 5 (serverless on Vercel, `maxDuration: 300`)
- React 19 + Vite 8 + React Router 7
- Supabase Postgres + Auth + Storage + RLS
- Gemini 2.5 Flash (script generation), ElevenLabs (voice + music)
- Remotion render service (re-uses the existing Doclee `VIDEO_SERVICE_URL` for now)
- Stripe Checkout (credit packs)

## Data model

Three tables:

- `brands` — per-user brand identities (logo, colors, font, website). One user can have multiple brands.
- `marketing_videos` — first-class persistence for each generated video. Manifest (JSONB) holds the rendered script + screenshots + branding snapshot.
- `user_credits` — balance + total bought. Decremented on successful render. Topped up by Stripe webhook.

## API

```
# Authed (Supabase JWT)
GET    /api/profile                  # current user
POST   /api/brands                   # create brand
GET    /api/brands                   # list own brands
PATCH  /api/brands/:id               # update
DELETE /api/brands/:id               # delete

POST   /api/marketing-videos         # generate (consumes 1 credit)
GET    /api/marketing-videos         # list own
GET    /api/marketing-videos/:id     # detail
POST   /api/marketing-videos/:id/edit          # AI refine
POST   /api/marketing-videos/:id/render        # re-render after edit
POST   /api/marketing-videos/:id/thumbnail     # upload thumbnail

GET    /api/credits                  # balance + history
POST   /api/credits/checkout         # start Stripe Checkout for a credit pack

# Public
POST   /api/stripe/webhook           # Stripe sends credit-pack purchases here

# Static config (cached at edge)
GET    /api/voices                   # ElevenLabs voices
GET    /api/music-presets            # AI music styles
```

## Env vars

```
NODE_ENV
PORT
SUPABASE_URL
SUPABASE_SERVICE_KEY
GEMINI_API_KEY
ELEVENLABS_API_KEY
VIDEO_SERVICE_URL            # Remotion render service
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
PUBLIC_APP_URL
SENTRY_DSN                   # optional
UPSTASH_REDIS_REST_URL       # optional in dev, required in prod
UPSTASH_REDIS_REST_TOKEN
```

Frontend (Vite prefix):
```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_STRIPE_PUBLISHABLE_KEY
```

## Development

```sh
npm install
npm run dev:server    # Express on :3000
npm run dev:client    # Vite on :5173, proxies /api to :3000
```

## Status

See `EXTRACTION_PLAN.md` for what's done and what's left.
