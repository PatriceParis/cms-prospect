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
| CRM | `npm run crm` | Interface de suivi des leads (http://localhost:3000 en local). |

## CRM

Accès par un mot de passe partagé (`CRM_PASSWORD`).

- Statuts : À CONTACTER, CONTACTÉ, PAS DE RÉP, RÉP POSITIVE, RÉP NÉGATIVE, NE PAS CONTACTER. Ce dernier est une opposition définitive : le lead ne peut plus changer de statut ni recevoir de relance.
- Fiche lead : téléphone cliquable, lien vers la fiche Google, canal de contact, note, date de relance (pré-remplie à J+3 ouvrés quand on passe en CONTACTÉ ou PAS DE RÉP) et historique daté.
- Filtres : priorité, secteur, type de numéro, fiche non revendiquée, « à relancer aujourd'hui ». Indicateurs : contactés, taux de réponse, réponses positives.
- Import d'un export Apify depuis le navigateur (ingest puis score), export CSV pour Excel.

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
