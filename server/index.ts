// Démarrage en local (`npm run dev`). En production, Vercel utilise api/index.ts.
import express from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './env.js'
import { app } from './app.js'

// Sert aussi l'interface buildée si elle existe (`npm run build` puis `npm start`).
const web = join(process.cwd(), 'dist/web')
if (existsSync(web)) {
  app.use(express.static(web))
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(web, 'index.html')))
}

app.listen(env.PORT, () => {
  console.log(`Doclee → http://localhost:${env.PORT}`)
  // Ce qui est branché, pour comprendre d'un coup d'œil pourquoi une voix ou la musique manque.
  console.log(
    `[config] Gemini ${env.GEMINI_API_KEY ? 'oui' : 'NON'} · Claude ${env.ANTHROPIC_API_KEY ? env.CLAUDE_MODEL : 'non (Gemini code les scènes)'} · ElevenLabs ${env.ELEVENLABS_API_KEY ? 'oui (voix premium + musique)' : 'non (ni voix premium ni musique)'}`,
  )
})
