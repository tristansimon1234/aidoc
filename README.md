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
  → Gemini écrit la voix off, synthèse vocale (Gemini ou ElevenLabs), ffmpeg la pose sur la vidéo
```

Tout tourne dans **un seul serveur Node** (API + interface + traitement vidéo). Supabase sert pour la connexion, la base et le stockage des fichiers. Stripe gère le paiement.

## Code

```
server/
  index.ts          serveur Express (API + interface web + webhook Stripe)
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
    steps.ts        nettoyage des étapes, découpage de la voix off
web/src/
  main.tsx          routes + en-tête
  api.ts            appels au serveur
  pages/            Login, Home, SopPage, Credits
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
2. **Serveur** : déployer le `Dockerfile` (Railway, Render, Fly…) avec les variables de `.env.example`. Les variables `VITE_*` doivent aussi être fournies **au build** (build args).
3. **Stripe** : créer 2 prix (un paiement unique, un récurrent mensuel) et mettre leurs IDs dans `STRIPE_PRICE_PACK` / `STRIPE_PRICE_MONTHLY`.
   - Webhook vers `https://<app>/api/stripe/webhook`, évènements `checkout.session.completed` et `invoice.paid`.
   - Activer le portail client (Settings → Billing → Customer portal).
4. **Modèles IA** : `GEMINI_MODEL` et `GEMINI_TTS_MODEL` sont réglables par variable d'environnement. Vérifier qu'ils sont toujours proposés par Google.

## Limites connues

- Les fichiers sont dans un bucket public, à des adresses impossibles à deviner (nécessaire pour que les images collées dans Notion s'affichent). Ne convient pas à des vidéos très sensibles.
- La file de traitement est en mémoire (2 vidéos à la fois). Si le serveur redémarre pendant un traitement, la SOP passe en échec et les crédits sont remboursés.
- Les vidéos sont limitées à 60 minutes.
