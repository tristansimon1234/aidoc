# CLAUDE.md — Doclee

Doclee transforme une vidéo d'écran en **SOP** (markdown + captures + vidéo commentée de 4 min max) ou en **vidéo marketing** de 30/60 s (champ `kind` sur la table `sops`). SaaS payant au crédit.
Voir `README.md` pour l'architecture, la tarification et le déploiement.

## Principe directeur : rester simple

L'ancienne version (éditeur, projets, équipes, chat, widget, analytics, MCP, Try Doc, vidéo marketing…) a été supprimée : trop complexe.
Elle reste consultable dans l'historique git (commit `f3fc06a`).
**Avant d'ajouter une fonctionnalité, se demander si Notion / Google Docs / Confluence ne le font pas déjà.** L'édition et le partage se font dans ces outils.

## Stack

Node 20+ · TypeScript strict · Express 5 · React 19 + Vite · Supabase (auth, Postgres, stockage) · Gemini (`@google/genai`) · ElevenLabs (optionnel) · Stripe · ffmpeg · Vitest.
Deux déploiements : **Vercel** pour l'interface et l'API (`api/index.ts`, Express), **Railway** pour le traitement vidéo (`worker/index.ts`, Dockerfile avec ffmpeg). L'API confie chaque SOP au service vidéo via `POST /process` (secret partagé) ; le service écrit le résultat dans Supabase. Aucun traitement lourd sur Vercel.

## Règles

1. Pas de `any` : `unknown` + validation.
2. Tous les appels Supabase dans `server/db.ts`. Le navigateur n'utilise Supabase que pour la connexion ; les données passent par `/api`.
3. Tous les prompts IA dans `server/pipeline/prompts.ts`. Toute réponse JSON de l'IA est validée avec Zod.
4. Toute entrée externe (requêtes, env, IA) validée avec Zod.
5. Les règles de prix dans `server/credits.ts`. Les mouvements de crédits passent par `db.applyCredits` (atomique, idempotent via `ref`).
6. Une nouvelle migration par changement de schéma dans `supabase/migrations/` (ne jamais modifier une migration existante).
7. Pas de logique métier dans les routes : elles valident, appellent, répondent.
8. Interface : le moins d'écrans et d'options possible, textes de l'interface en anglais. Réutiliser le design system repris de l'ancienne plateforme (`web/src/ui/design-system`, CSS Modules + variables de `globals.css`, jamais de couleur en dur).
9. Mettre à jour `README.md` quand l'architecture, la tarification ou le déploiement changent.

## Vérifier avant de pousser

```bash
npm run typecheck && npm test && npm run build
```
