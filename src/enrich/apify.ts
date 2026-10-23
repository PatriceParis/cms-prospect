// Client minimal de l'API Apify : lance un acteur, attend la fin, lit le dataset.
// Le jeton (APIFY_TOKEN) passe en en-tête, jamais dans l'URL.
const API = 'https://api.apify.com/v2';
const POLL_MS = 5000;
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function token(): string {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error('APIFY_TOKEN manquant (variable d’environnement ou .env)');
  return t;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`Apify ${init.method ?? 'GET'} ${path.split('?')[0]} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

type Run = { id: string; status: string; defaultDatasetId: string; usageTotalUsd?: number };

export type ActorResult<T> = { items: T[]; costUsd: number | null };

// maxChargeUsd plafonne la facture des acteurs payés à l'événement.
export async function runActor<T>(actor: string, input: unknown, { maxChargeUsd, timeoutMs = 20 * 60_000 }: { maxChargeUsd: number; timeoutMs?: number }): Promise<ActorResult<T>> {
  const started = await call<{ data: Run }>(`/acts/${actor.replace('/', '~')}/runs?maxTotalChargeUsd=${maxChargeUsd}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  let run = started.data;
  const deadline = Date.now() + timeoutMs;
  while (!DONE.has(run.status)) {
    if (Date.now() > deadline) throw new Error(`Apify ${actor} : délai dépassé (run ${run.id})`);
    await sleep(POLL_MS);
    run = (await call<{ data: Run }>(`/actor-runs/${run.id}`)).data;
  }
  if (run.status !== 'SUCCEEDED') throw new Error(`Apify ${actor} : run ${run.id} terminé en ${run.status}`);
  const items = await call<T[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
  return { items, costUsd: run.usageTotalUsd ?? null };
}
