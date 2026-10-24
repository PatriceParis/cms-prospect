import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Client, InStatement } from '@libsql/client';

// API « Connexion CRM » de l'outil de maquettes (Fold) : une maquette de site par
// prospect, identifiée par son Place ID Google. Le lien est un code aléatoire : on ne le
// construit jamais, on le lit toujours dans la réponse.
// Clé : FOLD_API_KEY (jamais dans le code ni le navigateur). Adresse : FOLD_API_URL.

const DEFAULT_URL = 'https://test.fold-medias.com/api/v1';
const TIMEOUT_MS = 30_000;

export type Maquette = {
  place_id: string;
  name?: string;
  status: string; // creating | active | … (valeurs de l'outil)
  link: string | null;
  expires_at?: string | null;
  views?: number;
  first_view_at?: string | null;
  last_view_at?: string | null;
  requests?: number;
  last_request_at?: string | null;
  sector?: string | null;
  city?: string | null;
  created_at?: string | null;
  created?: boolean;
};

export class FoldError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const foldConfigured = () => Boolean(process.env.FOLD_API_KEY);

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: T }> {
  const key = process.env.FOLD_API_KEY;
  if (!key) throw new FoldError('FOLD_API_KEY manquante (variable d’environnement ou .env)', 0);
  const base = (process.env.FOLD_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    const retry = Number(res.headers.get('retry-after'));
    throw new FoldError(`Fold ${init.method ?? 'GET'} ${path.split('?')[0]} : HTTP ${res.status} ${b.error ?? ''} ${b.message ?? ''}`.trim(), res.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return { status: res.status, body: body as T };
}

// 202 : en préparation (link null) ; 201 : créée (attendre=1) ; 200 : existait déjà.
export async function createMaquette(item: Record<string, unknown>, { wait = false } = {}): Promise<{ status: number; maquette: Maquette }> {
  const { status, body } = await call<Maquette>(`/maquettes${wait ? '?attendre=1' : ''}`, { method: 'POST', body: JSON.stringify(item) }, wait ? 90_000 : TIMEOUT_MS);
  return { status, maquette: body };
}

export async function getMaquette(placeId: string): Promise<Maquette | null> {
  try {
    return (await call<Maquette>(`/maquettes/${encodeURIComponent(placeId)}`)).body;
  } catch (err) {
    if (err instanceof FoldError && err.status === 404) return null;
    throw err;
  }
}

export async function listMaquettes({ since, limit = 500 }: { since?: string; limit?: number } = {}, timeoutMs = TIMEOUT_MS): Promise<Maquette[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (since) q.set('since', since);
  return (await call<{ items: Maquette[] }>(`/maquettes?${q}`, {}, timeoutMs)).body.items ?? [];
}

export async function prolongMaquette(placeId: string): Promise<Maquette> {
  return (await call<Maquette>(`/maquettes/${encodeURIComponent(placeId)}/prolonger`, { method: 'POST' })).body;
}

// --- Élément envoyé : format d'un résultat de l'acteur Apify Google Maps ---------------

const DAYS: Record<string, string> = { lun: 'lundi', mar: 'mardi', mer: 'mercredi', jeu: 'jeudi', ven: 'vendredi', sam: 'samedi', dim: 'dimanche' };

// « ven 10:00 to 19:00; dim Fermé » (stocké à l'import) → [{ day: 'vendredi', hours: '10:00 to 19:00' }, …]
export function openingHoursOf(stored: string | null | undefined): { day: string; hours: string }[] | null {
  const out = String(stored ?? '').split(';').map(s => s.trim()).filter(Boolean).flatMap(part => {
    const m = /^(\S+)\s+(.+)$/.exec(part);
    return m ? [{ day: DAYS[m[1].toLowerCase()] ?? m[1], hours: m[2] }] : [];
  });
  return out.length ? out : null;
}

const UNDELIVERABLE = new Set(['sans_mx', 'inexistant']);

// Lead du CRM → élément Apify. Le site déclaré n'est jamais transmis : ces prospects n'ont
// pas de site (ou un site mort), c'est l'objet même de la maquette.
export function toApifyItem(l: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const email = str(l.email);
  const item: Record<string, unknown> = {
    placeId: l.place_id,
    title: l.name,
    categoryName: str(l.google_category),
    phone: str(l.phone),
    phoneUnformatted: str(l.phone),
    street: str(l.address),
    postalCode: str(l.postal_code),
    city: str(l.city),
    neighborhood: str(l.neighborhood),
    totalScore: l.rating === null || l.rating === undefined ? null : Number(l.rating),
    reviewsCount: Number(l.reviews_count ?? 0),
    imagesCount: Number(l.photos_count ?? 0),
    url: str(l.maps_url),
    claimThisBusiness: Number(l.claimed) !== 1,
    openingHours: openingHoursOf(str(l.opening_hours)),
    website: null,
    emails: email && !UNDELIVERABLE.has(String(l.email_check)) ? [email] : [],
    instagrams: l.instagram ? [`https://www.instagram.com/${l.instagram}/`] : [],
    facebooks: l.facebook ? [String(l.facebook)] : [],
  };
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== null));
}

// --- Notifications signées --------------------------------------------------------------

// Signature HMAC-SHA256 du corps brut, au format « sha256=<hex> ».
export function verifySignature(rawBody: Buffer | string, received: string | null | undefined, secret: string): boolean {
  if (!received || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(received.trim());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// L'en-tête de signature est coupé dans la documentation reçue (« x-fol… ») :
// x-fold-signature, sinon le premier en-tête x-fold-* qui porte une valeur « sha256=… ».
export function signatureHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const named = first(headers['x-fold-signature']);
  if (named) return named;
  for (const [k, v] of Object.entries(headers)) {
    const value = first(v);
    if (k.toLowerCase().startsWith('x-fold') && value?.startsWith('sha256=')) return value;
  }
  return null;
}

// --- Enregistrement dans le CRM ------------------------------------------------------

export type Demande = Record<string, unknown>;

const OPEN_STATUSES = new Set(['A_CONTACTER', 'CONTACTE', 'PAS_DE_REP']);

function demandeText(d: Demande | null): string {
  if (!d) return 'Le prospect a demandé ce site depuis sa maquette (« Je veux ce site »).';
  const parts = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k} : ${String(v)}`);
  return `Demande « Je veux ce site » depuis la maquette.${parts.length ? ` ${parts.join(' · ')}` : ''}`;
}

// Enregistre l'état d'une maquette. Une nouvelle demande (« Je veux ce site ») est notée
// dans l'historique et le lead passe en RÉP POSITIVE, à rappeler le jour même.
// Renvoie false si le Place ID n'est pas un lead du CRM.
export async function recordMaquette(db: Client, m: Maquette, { demande = null, now = new Date() }: { demande?: Demande | null; now?: Date } = {}): Promise<boolean> {
  const lead = (await db.execute({
    sql: `SELECT l.crm_status, m.requests FROM leads l LEFT JOIN maquettes m ON m.place_id = l.place_id WHERE l.place_id = ?`,
    args: [m.place_id],
  })).rows[0];
  if (!lead) return false;
  const at = now.toISOString();
  const writes: InStatement[] = [{
    sql: `INSERT INTO maquettes (place_id, status, link, expires_at, views, first_view_at, last_view_at, requests, last_request_at, created_at, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (place_id) DO UPDATE SET status = excluded.status, link = coalesce(excluded.link, maquettes.link),
            expires_at = coalesce(excluded.expires_at, maquettes.expires_at), views = coalesce(excluded.views, maquettes.views),
            first_view_at = coalesce(excluded.first_view_at, maquettes.first_view_at), last_view_at = coalesce(excluded.last_view_at, maquettes.last_view_at),
            requests = coalesce(excluded.requests, maquettes.requests), last_request_at = coalesce(excluded.last_request_at, maquettes.last_request_at),
            created_at = coalesce(excluded.created_at, maquettes.created_at), error = NULL, synced_at = excluded.synced_at`,
    // Champ absent de la réponse : la valeur connue est conservée.
    args: [
      m.place_id, m.status ?? 'inconnu', m.link ?? null, m.expires_at ?? null, m.views ?? null, m.first_view_at ?? null,
      m.last_view_at ?? null, m.requests ?? null, m.last_request_at ?? null, m.created_at ?? null, at,
    ],
  }];
  const before = Number(lead.requests ?? 0);
  if ((m.requests ?? before) > before || demande) {
    writes.push({
      sql: `INSERT INTO activities (place_id, at, author, kind, body) VALUES (?, ?, '', 'demande', ?)`,
      args: [m.place_id, m.last_request_at ?? at, demandeText(demande)],
    });
    if (OPEN_STATUSES.has(String(lead.crm_status))) {
      writes.push({
        sql: `INSERT INTO activities (place_id, at, author, kind, from_status, to_status, body) VALUES (?, ?, '', 'statut', ?, 'REP_POSITIVE', 'Automatique : demande reçue depuis la maquette')`,
        args: [m.place_id, at, String(lead.crm_status)],
      });
      writes.push({
        sql: `UPDATE leads SET crm_status = 'REP_POSITIVE', next_action_at = ?, crm_updated_at = ? WHERE place_id = ?`,
        args: [at.slice(0, 10), at, m.place_id],
      });
    }
  }
  await db.batch(writes, 'write');
  return true;
}

export async function recordError(db: Client, placeId: string, error: string, now = new Date()) {
  await db.execute({
    sql: `INSERT INTO maquettes (place_id, status, error, synced_at) VALUES (?, 'erreur', ?, ?)
          ON CONFLICT (place_id) DO UPDATE SET error = excluded.error, synced_at = excluded.synced_at`,
    args: [placeId, error.slice(0, 300), now.toISOString()],
  });
}

// --- Synchronisation incrémentale -----------------------------------------------------

const SYNC_KEY = 'fold_synced_at';

// Maquettes créées, vues, demandées ou converties depuis la dernière synchronisation.
export async function syncMaquettes(db: Client, { full = false, timeoutMs = TIMEOUT_MS, now = new Date() } = {}): Promise<{ items: number; recorded: number }> {
  const last = full ? null : (await db.execute({ sql: `SELECT value FROM app_state WHERE key = ?`, args: [SYNC_KEY] })).rows[0]?.value;
  // Marge d'une minute : une vue enregistrée pendant la requête précédente n'est pas perdue.
  const since = last ? new Date(new Date(String(last)).getTime() - 60_000).toISOString() : undefined;
  const items = await listMaquettes({ since, limit: 500 }, timeoutMs);
  let recorded = 0;
  for (const m of items) if (m.place_id && (await recordMaquette(db, m, { now }))) recorded++;
  await db.execute({
    sql: `INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    args: [SYNC_KEY, now.toISOString()],
  });
  return { items: items.length, recorded };
}

// --- Génération en lot --------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 3; // l'outil refuse une 4e maquette en préparation (429)
const DAILY_LIMIT_SECONDS = 600; // au-delà, un 429 signale la limite quotidienne : on s'arrête

async function waitForLink(placeId: string, timeoutMs = 120_000): Promise<Maquette | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await getMaquette(placeId);
    if (m?.link) return m;
    await sleep(5000);
  }
  return null;
}

export type GenerateReport = { created: number; existing: number; errors: { placeId: string; name: string; error: string }[]; notTried: number };

// Une maquette pour chaque lead cible qui n'a pas encore de lien (jamais pour une opposition).
export async function generateMaquettes(db: Client, { limit, onDone }: { limit?: number; onDone?: (name: string, outcome: string) => void } = {}): Promise<GenerateReport> {
  const { rows } = await db.execute(`
    SELECT l.* FROM leads l LEFT JOIN maquettes m ON m.place_id = l.place_id
    WHERE l.status = 'nouveau' AND l.crm_status <> 'NE_PAS_CONTACTER' AND m.link IS NULL
    ORDER BY l.score DESC, l.reviews_count DESC`);
  const queue = rows.slice(0, limit ?? rows.length).map(r => ({ ...r }) as Record<string, unknown>);
  const report: GenerateReport = { created: 0, existing: 0, errors: [], notTried: 0 };
  let stop: string | null = null;

  const one = async (lead: Record<string, unknown>) => {
    const placeId = String(lead.place_id);
    const name = String(lead.name);
    for (let attempt = 1; ; attempt++) {
      try {
        const { status, maquette } = await createMaquette(toApifyItem(lead), { wait: true });
        const m = maquette.link ? maquette : await waitForLink(placeId);
        if (!m) throw new FoldError('lien toujours absent après 2 minutes', 504);
        await recordMaquette(db, m);
        if (status === 200 && maquette.created === false) report.existing++;
        else report.created++;
        onDone?.(name, status === 200 && maquette.created === false ? 'existante' : 'créée');
        return;
      } catch (err) {
        const e = err instanceof FoldError ? err : new FoldError(String(err instanceof Error ? err.message : err), 0);
        if (e.status === 401 || e.status === 0 && e.message.includes('FOLD_API_KEY')) {
          stop = e.message;
          return;
        }
        if (e.status === 429) {
          if (!e.retryAfter || e.retryAfter > DAILY_LIMIT_SECONDS) {
            stop = `limite quotidienne de l'outil atteinte (${e.message})`;
            return;
          }
          await sleep(e.retryAfter * 1000);
          continue;
        }
        if (e.status === 409 && !/client/i.test(e.message)) {
          const m = await waitForLink(placeId); // création déjà en cours
          if (m) {
            await recordMaquette(db, m);
            report.created++;
            onDone?.(name, 'créée');
            return;
          }
        }
        const retriable = e.status >= 500 || e.status === 0;
        if (retriable && attempt < 3) {
          await sleep(5000 * attempt);
          continue;
        }
        await recordError(db, placeId, e.message);
        report.errors.push({ placeId, name, error: e.message });
        onDone?.(name, `erreur : ${e.message}`);
        return;
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (!stop && next < queue.length) await one(queue[next++]);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report.notTried = queue.length - next;
  if (stop) throw Object.assign(new Error(`Arrêt : ${stop}`), { report });
  return report;
}

// --- Notification reçue (déjà authentifiée par sa signature) ----------------------------

// L'état de la maquette est relu dans l'API, qui fait foi ; la notification apporte le
// détail d'une demande (nom, e-mail…), donnée personnelle traitée comme le reste du CRM.
export async function handleFoldEvent(db: Client, event: Record<string, unknown>): Promise<string> {
  const type = String(event.event ?? '');
  if (type === 'test') return 'test';
  const embedded = event.maquette && typeof event.maquette === 'object' ? (event.maquette as Record<string, unknown>) : null;
  const placeId = String(embedded?.place_id ?? event.place_id ?? event.placeId ?? '');
  if (!placeId) return 'ignoré : pas de Place ID';
  let m = foldConfigured() ? await getMaquette(placeId).catch(() => null) : null;
  m ??= embedded ? ({ ...embedded, place_id: placeId } as Maquette) : null;
  if (!m) return 'ignoré : maquette introuvable';
  const demande = type === 'maquette.demande' && event.demande && typeof event.demande === 'object' ? (event.demande as Demande) : null;
  return (await recordMaquette(db, m, { demande })) ? type : 'ignoré : lead inconnu';
}
