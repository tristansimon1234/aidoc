# Doclee

Filmez votre écran pendant que vous faites une tâche → recevez **la procédure écrite (SOP) avec captures** et **une vidéo commentée**.

L'édition, le partage et la recherche se font dans vos outils habituels : bouton **« Copier pour Notion / Docs »** (colle texte + images), export **PDF**, **Markdown** et **vidéo MP4**.

## Comment ça marche

```
Vidéo (upload ou enregistrement dans le navigateur)
  → ffmpeg : MP4 720p
  → Gemini regarde la vidéo et liste les étapes horodatées
  → ffmpeg : une capture par étape
  → Gemini rédige la SOP (markdown)
  → ffmpeg monte une vidéo de 4 min max (un extrait autour de chaque étape)
  → Gemini écrit la voix off, synthèse vocale (Gemini ou ElevenLabs), ffmpeg la pose sur la vidéo
```

La vidéo livrée dure **4 minutes maximum**, quelle que soit la durée de l'enregistrement : au-delà, on garde un extrait autour de chaque étape (surtout ce qui précède l'action) et on coupe le reste. La voix off est calée sur ce montage. Réglage : `MAX_SOP_VIDEO_SECONDS` dans `server/pipeline/steps.ts`.

Tout tourne sur **Vercel** : l'interface en statique, l'API dans une seule fonction (`api/index.ts`). La génération est lancée en tâche de fond après la réponse (`waitUntil`) et a jusqu'à 800 s pour finir ; ffmpeg est embarqué dans la fonction (`ffmpeg-static`) et lit la vidéo source directement depuis le stockage. Supabase sert pour la connexion, la base et le stockage des fichiers. Stripe gère le paiement.

## Code

```
api/index.ts        point d'entrée Vercel (renvoie l'app Express)
vercel.json         build, durée max (800 s), ffmpeg embarqué, redirections
server/
  app.ts            app Express (API + webhook Stripe)
  index.ts          démarrage en local
  routes.ts         les routes de l'API
  db.ts             tous les appels Supabase (base + stockage)
  billing.ts        Stripe : achat, abonnement, webhook
  credits.ts        règles de prix (crédits / durée vidéo)
  env.ts            variables d'environnement
  pipeline/
    index.ts        orchestration vidéo → SOP → vidéo narrée
    prompts.ts      tous les prompts IA
    gemini.ts       analyse vidéo, texte, synthèse vocale
    elevenlabs.ts   voix premium
    ffmpeg.ts       conversion, captures, montage audio
    steps.ts        nettoyage des étapes, montage 4 min, découpage de la voix off
web/src/
  main.tsx          routes
  api.ts            appels au serveur
  pages/            Login, Home, SopPage, Credits
  ui/
    design-system/  design system de l'ancienne plateforme (thème clair/sombre, Button, Card,
                    Badge, StatusIndicator, ProgressLoader, MarkdownRenderer avec encadrés…)
    layout/         Shell, rail latéral, menu avatar, thème
    ScreenRecorder  enregistrement d'écran + dépôt de vidéo
    NarratedPlayer  lecteur vidéo
supabase/migrations/  schéma de la base (3 tables)
```

## Tarification

- 1 crédit = une vidéo de 10 min max (texte + captures + voix off). Une vidéo de 25 min coûte 3 crédits.
- 1 crédit offert à l'inscription.
- Deux offres Stripe : **pack** (paiement unique → 10 crédits) et **abonnement mensuel** (→ 30 crédits / mois).
- Les prix se règlent dans Stripe. Le nombre de crédits se règle dans `server/credits.ts`.
- En cas d'échec, les crédits sont remboursés automatiquement.

## Lancer en local

Prérequis : Node 20+, `ffmpeg` installé.

```bash
cp .env.example .env   # remplir les clés
npm install
npm run dev            # interface http://localhost:5173, API :3000
npm test
```

## Mise en production

1. **Supabase** : créer un projet et exécuter `supabase/migrations/20260924000000_init.sql` dans l'éditeur SQL.
   - Auth → URL Configuration : mettre l'URL de l'app en *Site URL* (pour le lien de connexion par email).
   - Storage → Settings : la taille max par fichier est de 50 Mo sur le plan gratuit. Pour des vidéos d'écran de plusieurs minutes, passer au plan Pro et la monter (le bucket accepte jusqu'à 2 Go).
2. **Vercel** (plan Pro, nécessaire pour les 800 s) : importer le repo, `vercel.json` règle le reste.
   - Settings → Environment Variables : celles de `.env.example` (sauf `PORT`), `VITE_*` compris. `APP_URL` = l'URL de l'app.
   - Settings → Functions : *Fluid compute* activé, et *Function CPU* sur **Performance** (ffmpeg va plus vite).
3. **Stripe** : créer 2 prix (un paiement unique, un récurrent mensuel) et mettre leurs IDs dans `STRIPE_PRICE_PACK` / `STRIPE_PRICE_MONTHLY`.
   - Webhook vers `https://<app>/api/stripe/webhook`, évènements `checkout.session.completed` et `invoice.paid`.
   - Activer le portail client (Settings → Billing → Customer portal).
4. **Modèles IA** : `GEMINI_MODEL` et `GEMINI_TTS_MODEL` sont réglables par variable d'environnement. Vérifier qu'ils sont toujours proposés par Google.

## Limites connues

- Les fichiers sont dans un bucket public, à des adresses impossibles à deviner (nécessaire pour que les images collées dans Notion s'affichent). Ne convient pas à des vidéos très sensibles.
- Un traitement doit tenir en 800 s (limite Vercel Pro). S'il n'avance plus pendant 15 min, la SOP passe en échec et les crédits sont remboursés automatiquement.
- Les vidéos sources sont limitées à 30 minutes (`MAX_VIDEO_MINUTES` dans `server/credits.ts`), pour tenir dans ce délai.
