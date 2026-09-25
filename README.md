# Doclee

Filmez votre écran → recevez au choix :

- **une SOP** : la procédure écrite avec captures + une vidéo commentée de 4 min max ;
- **une vidéo marketing** animée de 30 ou 60 s (motion design), à partir de **quelques captures du produit** et d'un brief (pas de vidéo à envoyer) : une voix off qui vend (accroche → bénéfices → appel à l'action), sous-titres mot à mot, musique de fond en option, guidée par un brief.

L'accueil a deux onglets (SOPs / Marketing videos) ; la création se fait en 4 étapes : type → vidéo (SOP) ou captures (marketing, 8 max) → options → lancement.

L'édition, le partage et la recherche se font dans vos outils habituels : bouton **« Copier pour Notion / Docs »** (colle texte + images), export **PDF**, **Markdown** et **vidéo MP4**.

## Comment ça marche

```
Vidéo (upload ou enregistrement dans le navigateur)
  → ffmpeg : MP4 720p
  → Gemini regarde la vidéo et liste les étapes horodatées
  → ffmpeg extrait quelques images autour de chaque étape, Gemini choisit la meilleure capture
  → Gemini rédige la SOP (markdown)
  → ffmpeg monte une vidéo de 4 min max (un extrait autour de chaque étape)
  → Gemini écrit la voix off (à partir de ce que la personne a dit), synthèse vocale (Gemini ou ElevenLabs),
    puis chaque passage de vidéo est accéléré ou ralenti pour durer exactement le temps de sa phrase (aucun blanc)
```

**Vidéo marketing animée** (`server/pipeline/marketing.ts`, projet Remotion dans `remotion/`) :

```
Captures (converties en JPEG par le navigateur) + brief → Gemini écrit le storyboard (4 à 8 scènes, 3 accroches,
        couleurs du produit tirées des captures, captures à utiliser par scène) → la meilleure accroche est choisie
  → voix off par scène (chaque scène dure le temps de sa phrase)
  → pour chaque scène, Claude (ou Gemini sans clé Anthropic) écrit le code React/Remotion de l'animation,
    avec une boîte à outils (captures animées, cadre de navigateur, curseur, icônes, graphiques, effets)
    → compilation + rendu de 3 images ; en cas d'erreur, elle est renvoyée au modèle (3 essais)
    → relecture « directeur artistique » : le modèle voit les images de sa scène et peut la corriger
    → si rien ne passe : scène de secours (titre + capture en mouvement)
  → Remotion rend la vidéo (1920×1080, 30 i/s, sous-titres), ffmpeg ajoute la voix et la musique
```

Si la vidéo animée échoue entièrement, la création passe en échec et les crédits sont remboursés. Le code des scènes est contrôlé avant rendu (pas d'import, de réseau, d'aléatoire ni d'animation CSS : `server/pipeline/scene-code.ts`). Remotion est gratuit pour les structures de 3 personnes max ; au-delà, licence entreprise (remotion.pro).

**Voix off** : l'utilisateur choisit la voix (30 voix Gemini incluses ; avec `ELEVENLABS_API_KEY`, toutes les voix du compte ElevenLabs, voix clonées comprises, proposées en premier et par défaut ; modèle Flash pour les SOP, v3 pour les vidéos marketing : `ELEVENLABS_MODEL`, `ELEVENLABS_MARKETING_MODEL`) et le ton (amical, professionnel, énergique, calme, joueur), et peut écouter un extrait avant de lancer. Liste des voix : `server/voices.ts` ; tons : `TONES` dans `server/pipeline/prompts.ts`.

La vidéo livrée dure **4 minutes maximum**, quelle que soit la durée de l'enregistrement : au-delà, on garde un extrait autour de chaque étape (surtout ce qui précède l'action) et on coupe le reste. La voix off est calée sur ce montage. Réglage : `MAX_SOP_VIDEO_SECONDS` dans `server/pipeline/steps.ts`.

Deux déploiements, un seul repo :

- **Vercel** : l'interface (statique) et l'API (`api/index.ts`, Express) : connexion, crédits, Stripe, liste des SOPs. Quand une vidéo est envoyée, l'API débite les crédits et confie la SOP au service vidéo.
- **Railway** : le service vidéo (`worker/index.ts`, `Dockerfile`) : ffmpeg, Gemini, voix off, sans limite de durée. Il lit la vidéo depuis Supabase et y écrit directement le résultat ; l'interface suit l'avancement en lisant la SOP.

Les deux parlent via `POST /process` protégé par un secret partagé (`VIDEO_SERVICE_SECRET`). Supabase sert pour la connexion, la base et le stockage des fichiers. Stripe gère le paiement.

## Code

```
api/index.ts        point d'entrée Vercel (renvoie l'app Express)
vercel.json         build de l'interface + redirections /api
worker/index.ts     service vidéo Railway (POST /process, file d'attente)
Dockerfile          image du service vidéo (Node + ffmpeg), railway.json
server/
  app.ts            app Express (API + webhook Stripe)
  index.ts          démarrage en local
  dispatch.ts       envoie une SOP au service vidéo (ou la traite sur place en local)
  routes.ts         les routes de l'API
  db.ts             tous les appels Supabase (base + stockage)
  billing.ts        Stripe : achat, abonnement, webhook
  credits.ts        règles de prix (crédits / durée vidéo)
  env.ts            variables d'environnement
  pipeline/
    index.ts        orchestration vidéo → SOP → vidéo narrée
    queue.ts        file d'attente du service vidéo (2 à la fois)
    prompts.ts      tous les prompts IA
    gemini.ts       analyse vidéo, texte, synthèse vocale
    elevenlabs.ts   voix premium
    marketing.ts    vidéo marketing animée : storyboard, code des scènes, rendu
    claude.ts       Claude (code des scènes), ou Gemini à défaut
    scene-code.ts   contrôle et compilation du code des scènes (esbuild)
    remotion.ts     rendu Remotion (images de test, vidéo complète)
    ffmpeg.ts       conversion, captures, montage audio
    steps.ts        nettoyage des étapes, montage 4 min, découpage de la voix off
remotion/           compositions Remotion (vidéo marketing, test d'une scène), boîte à outils des scènes
scripts/bundle-remotion.mjs  construit le bundle Remotion (au build Docker)
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
supabase/migrations/  schéma de la base (3 tables) + choix de la voix et du ton
```

## Tarification

- SOP : 1 crédit = une vidéo de 10 min max (texte + captures + voix off). Une vidéo de 25 min coûte 3 crédits.
- Vidéo marketing : 2 crédits (`MARKETING_CREDITS`), quelle que soit la durée de l'enregistrement.
- 1 crédit offert à l'inscription.
- Deux offres Stripe : **pack** (paiement unique → 10 crédits) et **abonnement mensuel** (→ 30 crédits / mois).
- Les prix se règlent dans Stripe. Le nombre de crédits se règle dans `server/credits.ts`.
- En cas d'échec, les crédits sont remboursés automatiquement.

## Lancer en local (sans compte, sans connexion)

Prérequis : Node 20+, `ffmpeg` installé, une clé Gemini (et une clé Anthropic pour les vidéos marketing). Pour le rendu Remotion en local, `npm run bundle:remotion` télécharge son navigateur (ou `REMOTION_BROWSER_EXECUTABLE` = un Chrome installé).

```bash
npm install
echo "GEMINI_API_KEY=ta-cle" > .env
npm run dev            # http://localhost:5173
npm test
```

Sans `SUPABASE_URL` ni `VITE_SUPABASE_URL`, l'app démarre en **mode local** : pas d'écran de connexion, 100 crédits, base et fichiers dans `.local-data/`, vidéos traitées dans le même process. Pour repartir de zéro : supprimer `.local-data/`.

## Tester en ligne sans Supabase (Vercel + Railway)

Le service Railway peut faire tout le travail sans Supabase : API, traitement vidéo, stockage sur son disque, pas de connexion (100 crédits).

- **Railway** : déployer le repo (Dockerfile). Variables : `GEMINI_API_KEY` (+ `ANTHROPIC_API_KEY` pour que Claude code les scènes des vidéos marketing, `ELEVENLABS_API_KEY` en option) et `LOCAL_MODE=true` (force le mode sans Supabase, même si ses variables sont là). Générer un domaine public. Sans volume, les données sont effacées à chaque déploiement ; pour les garder, monter un volume sur `/app/.local-data`.
- **Vercel** : `VITE_API_URL` = l'URL Railway (`https://` ajouté si besoin). Les variables Supabase peuvent rester : `VITE_API_URL` a la priorité. Redéployer.

⚠️ Sans connexion, quiconque connaît l'URL peut lancer des générations avec ta clé Gemini : à réserver aux tests. Pour revenir à la version normale : retirer `VITE_API_URL` (Vercel) et `LOCAL_MODE` (Railway).

## Tester un déploiement complet sans se connecter (mode test)

Sur un déploiement avec Supabase + Railway, mettre `DISABLE_LOGIN=true` et `VITE_DISABLE_LOGIN=true` (Vercel) : plus d'écran de connexion, tout le monde utilise le compte partagé `test@doclee.dev` (1000 crédits, créé automatiquement). **Uniquement sur un déploiement protégé.**

## Mise en production

1. **Supabase** : créer un projet et exécuter `supabase/migrations/20260924000000_init.sql` dans l'éditeur SQL.
   - Auth → URL Configuration : mettre l'URL de l'app en *Site URL* (pour le lien de connexion par email).
   - Storage → Settings : la taille max par fichier est de 50 Mo sur le plan gratuit. Pour des vidéos d'écran de plusieurs minutes, passer au plan Pro et la monter (le bucket accepte jusqu'à 2 Go).
2. **Railway (service vidéo)** : *New service → GitHub repo* `aidoc`. `railway.json` + `Dockerfile` sont détectés.
   - Variables : `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `VIDEO_SERVICE_SECRET` (une longue chaîne aléatoire), `ANTHROPIC_API_KEY` (Claude code les scènes des vidéos marketing ; sans elle, Gemini), et `ELEVENLABS_API_KEY` pour la voix premium.
   - Le build Docker installe le navigateur headless de Remotion et construit le bundle des vidéos marketing (`scripts/bundle-remotion.mjs`).
   - *Settings → Networking → Generate Domain* : c'est le `VIDEO_SERVICE_URL`.
3. **Vercel (interface + API)** : importer le repo, `vercel.json` règle le build.
   - Variables : `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `APP_URL`, `VIDEO_SERVICE_URL`, `VIDEO_SERVICE_SECRET` (le même que sur Railway), les variables Stripe, et `ELEVENLABS_API_KEY` si la voix premium doit être proposée.
4. **Stripe** : créer 2 prix (un paiement unique, un récurrent mensuel) et mettre leurs IDs dans `STRIPE_PRICE_PACK` / `STRIPE_PRICE_MONTHLY`.
   - Webhook vers `https://<app>/api/stripe/webhook`, évènements `checkout.session.completed` et `invoice.paid`.
   - Activer le portail client (Settings → Billing → Customer portal).
5. **Modèles IA** : `GEMINI_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_CODE_MODEL` et `CLAUDE_MODEL` sont réglables par variable d'environnement. Vérifier qu'ils sont toujours proposés.

## Limites connues

- Les fichiers sont dans un bucket public, à des adresses impossibles à deviner (nécessaire pour que les images collées dans Notion s'affichent). Ne convient pas à des vidéos très sensibles.
- La file d'attente du service vidéo est en mémoire (2 vidéos à la fois). S'il redémarre pendant un traitement, la SOP passe en échec et les crédits sont remboursés. Si une SOP n'avance plus pendant 30 min (service tombé), idem.
- Les vidéos sources sont limitées à 60 minutes (`MAX_VIDEO_MINUTES` dans `server/credits.ts`).
