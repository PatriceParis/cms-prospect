# cms-prospect

Machine de prospection des TPE de proximité (coiffeurs, instituts, artisans) pour l'offre de sites vitrines : de l'export Apify Google Maps jusqu'au suivi des réponses.

Node ≥ 22.18 exécute le TypeScript directement, sans étape de build. La base est en SQLite (libSQL) : un fichier local `data/prospection.db` par défaut, ou une base Turso si `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN` sont définies (dans l'environnement ou un fichier `.env`).

## Démarrer

```bash
npm install
npm run ingest -- data/imports/leads-bordeaux-coiffeurs-instituts-ramoneurs.xlsx
npm run score
npm test
```

## Modules

| Module | Commande | Rôle |
| --- | --- | --- |
| `ingest` | `npm run ingest -- <fichier>` | Lit un export Apify `compass/crawler-google-places` (XLSX ou JSON), normalise les téléphones en E.164, dédoublonne sur le Place ID. Relancer le même fichier ne crée rien. Les catégories hors cible sont stockées en `hors_cible` et ne sortent jamais du pipeline. |
| `score` | `npm run score` | Score sur 8 points, priorité A ≥ 7, B ≥ 5, C en dessous. La règle est codée en dur dans `src/score.ts`. |
| `enrich` | `npm run enrich -- --sample 20 [--nouveaux]` · `--rejouer` | Étage 1 : retrouve l'entreprise et la personne derrière la fiche via l'API Recherche d'entreprises (gratuite, sans clé). Par l'adresse d'abord, puis par le nom. Confiance haute ou moyenne ; les cas ambigus et introuvables restent en file manuelle avec leurs candidats. Chaque run est journalisé dans `enrich_runs`. |
| cascade | `npm run enrich -- --cascade [--limit N] [--sans-fullenrich]` | Collecte des contacts, dans l'ordre : 1 registre (gérant·e), 2 Instagram (compte, e-mail public, via Google puis le scraper de profils), 3 LinkedIn (Google, nom + salon ou ville + métier), 4 FullEnrich en dernier recours pour les dirigeants nommés encore sans e-mail. Chaque étape saute les leads déjà traités. Les meilleurs contacts sont consolidés sur le lead. |
| CRM | `npm run crm` | Interface de suivi des leads (http://localhost:3000 en local). |

La cascade utilise `APIFY_TOKEN` (Apify, environ 0,005 $ par lead) et `FULLENRICH_API_KEY` (1 crédit par e-mail pro, 3 par e-mail perso, jamais de téléphone). Mesure du 23/10 sur 20 leads : téléphone 15, gérant·e nommé·e 13, Instagram 9, e-mail 4, LinkedIn 2.

## CRM

Accès par un mot de passe partagé (`CRM_PASSWORD`).

- **Aujourd'hui** : la file de travail du SDR. Relances dues, puis les meilleurs leads jamais contactés (15 nouveaux par jour), avec Appeler, WhatsApp (mobiles), DM Instagram et e-mail en un clic. Bandeau hors du créneau lundi-vendredi 9 h-18 h (Paris).
- **Fiche** : canaux de contact, résultat en un clic (pas de réponse → relance J+2, contacté → J+3, intéressé → rappel J+1, pas intéressé, ne plus contacter), lead suivant automatique dans la file, navigation ↑ ↓, historique.
- **Garde-fous côté serveur** : un seul contact sortant par lead et par jour, tous canaux confondus ; NE PAS CONTACTER est une opposition définitive (plus de statut ni de relance).
- **Tous les leads** : indicateurs, onglets de statut, filtres (priorité, secteur, téléphone, canal disponible, fiche non revendiquée, à relancer), tri par colonne.
- **Scripts et messages** (`public/scripts.js`) : script d'appel en cinq temps avec objections et message de messagerie, DM Instagram, WhatsApp pré-rempli (`wa.me`), e-mail (brouillon `mailto:`), et leurs relances pour les leads déjà contactés. Personnalisés avec le prénom de la gérante, le salon, les avis, la fiche non revendiquée et l'exemple de site du secteur (`PREVIEW_LINKS`). Chaque message laisse une porte de sortie (« je ne vous relancerai pas », « STOP »). Prénom de l'expéditeur et marque : menu ⋯ → Réglages des messages.
- Import d'un export Apify depuis le navigateur (ingest puis score), export CSV pour Excel avec gérant·e, e-mail, Instagram et LinkedIn.

`npm run crm` utilise la base du `.env` (la production si les variables Turso y sont) ; `npm run crm:local` force la base locale `data/prospection.db`, sur le port 3001, pour tester sans rien écrire en production.

## Déploiement Vercel

`npm run build` produit `.vercel/output` (Build Output API) : `public/` en statique et l'API dans une seule fonction Node bundlée par esbuild.

Variables d'environnement du projet Vercel :

| Variable | Rôle |
| --- | --- |
| `CRM_PASSWORD` | Mot de passe d'accès. Sans lui, l'API refuse tout. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base Turso, renseignées par l'intégration Turso (onglet Storage du projet). |

Une fois la base branchée, charger les leads avec le bouton « Importer » du CRM.

## Données

`data/` n'est jamais versionné : les exports contiennent des données personnelles (téléphones de micro-entrepreneurs). Déposer les exports Apify dans `data/imports/` ; les tests d'intégration les utilisent s'ils sont présents.
