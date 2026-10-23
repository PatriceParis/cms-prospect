import type { UniteLegale } from './match.ts';

// API publique de l'État (annuaire-entreprises.data.gouv.fr) : gratuite, sans clé,
// limitée à 7 requêtes/s. On reste à 4/s et on réessaie sans insister.
const ENDPOINT = 'https://recherche-entreprises.api.gouv.fr/search';
const MIN_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 3;

let lastCall = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function searchCompanies(params: Record<string, string>): Promise<UniteLegale[]> {
  const url = new URL(ENDPOINT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('per_page', '10');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Recherche d'entreprises : HTTP ${res.status}`);
    const body = (await res.json()) as { results?: UniteLegale[] };
    return body.results ?? [];
  }
  throw new Error(`Recherche d'entreprises : toujours refusé après ${MAX_ATTEMPTS} essais`);
}
