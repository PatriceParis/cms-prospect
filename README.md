# cms-prospect

Machine de prospection des TPE de proximité (coiffeurs, instituts, artisans) pour l'offre de sites vitrines : de l'export Apify Google Maps jusqu'au suivi des réponses.

Node ≥ 22.18 exécute le TypeScript directement, sans étape de build. La base est en SQLite (libSQL) : un fichier local `data/prospection.db` par défaut, ou une base Turso si `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN` sont définies (dans l'environnement ou un fichier `.env`).

## Démarrer

```bash
npm install
npm run ingest -- data/imports/leads-bordeaux-coiffeurs-instituts-ramoneurs.xlsx
npm test
```

## Modules

| Module | Commande | Rôle |
| --- | --- | --- |
| `ingest` | `npm run ingest -- <fichier>` | Lit un export Apify `compass/crawler-google-places` (XLSX ou JSON), normalise les téléphones en E.164, dédoublonne sur le Place ID. Relancer le même fichier ne crée rien. Les catégories hors cible sont stockées en `hors_cible` et ne sortent jamais du pipeline. |

## Données

`data/` n'est jamais versionné : les exports contiennent des données personnelles (téléphones de micro-entrepreneurs). Déposer les exports Apify dans `data/imports/` ; les tests d'intégration les utilisent s'ils sont présents.
