import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { Client } from '@libsql/client';
import { CHANNELS, CRM_STATUSES, CrmError, exportCsv, getLead, listLeads, updateLead } from '../crm.ts';
import { foldConfigured, handleFoldEvent, signatureHeader, syncMaquettes, verifySignature } from '../fold.ts';
import { ingestBuffer } from '../ingest.ts';
import { scoreLeads } from '../score.ts';
import { checkPassword, clearedCookie, createSession, readCookie, sessionCookie, verifySession } from './auth.ts';

export type HandlerDeps = {
  getDb: () => Promise<Client>;
  password: () => string | undefined;
};

const JSON_LIMIT = 64 * 1024;
const IMPORT_LIMIT = 4 * 1024 * 1024; // sous la limite de 4,5 Mo des fonctions Vercel
const FAILED_LOGIN_DELAY_MS = 800;

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new CrmError('Fichier trop volumineux', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Exiger application/json sur les POST bloque les formulaires cross-site (CSRF),
// en plus du cookie SameSite=Strict.
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new CrmError('Content-Type application/json attendu', 415);
  try {
    const value = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CrmError) throw err;
    throw new CrmError('JSON invalide');
  }
}

const meta = { statuses: CRM_STATUSES, channels: CHANNELS };

// Vues et demandes des maquettes : relues dans l'API au plus toutes les 5 minutes, à
// l'ouverture de la liste (les notifications, si configurées, arrivent en direct).
const SYNC_EVERY_MS = 5 * 60_000;
let lastFoldSync = 0;

async function refreshMaquettes(db: Client) {
  if (!foldConfigured() || Date.now() - lastFoldSync < SYNC_EVERY_MS) return;
  lastFoldSync = Date.now();
  try {
    await syncMaquettes(db, { timeoutMs: 4000 });
  } catch (err) {
    console.error('synchronisation des maquettes', err);
  }
}

export function createHandler(deps: HandlerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const password = deps.password();

    try {
      // Diagnostic public : présence des variables (jamais leurs valeurs) et accès à la base.
      if (path === '/api/health' && method === 'GET') {
        const config = {
          CRM_PASSWORD: Boolean(password),
          TURSO_DATABASE_URL: Boolean(process.env.TURSO_DATABASE_URL),
          TURSO_AUTH_TOKEN: Boolean(process.env.TURSO_AUTH_TOKEN),
        };
        let database: 'ok' | 'injoignable' = 'injoignable';
        try {
          await (await deps.getDb()).execute('SELECT 1');
          database = 'ok';
        } catch (err) {
          console.error('health: base injoignable', err);
        }
        // Empreinte de l'adresse de la base : permet de vérifier qu'un poste et la production
        // visent la même base Turso sans jamais exposer l'adresse elle-même.
        const url = process.env.TURSO_DATABASE_URL;
        const databaseFingerprint = url ? createHash('sha256').update(url).digest('hex').slice(0, 8) : null;
        // Préfixe attendu de chaque valeur (fold_ pour la clé, whsec_ pour le secret) :
        // détecte deux valeurs inversées sans rien exposer.
        const keyState = (v: string | undefined, prefix: string) => (!v ? 'absente' : v.trim().startsWith(prefix) ? 'ok' : `valeur inattendue (doit commencer par ${prefix})`);
        const maquettes = {
          FOLD_API_KEY: keyState(process.env.FOLD_API_KEY, 'fold_'),
          FOLD_WEBHOOK_SECRET: keyState(process.env.FOLD_WEBHOOK_SECRET, 'whsec_'),
        };
        return send(res, 200, { ok: Object.values(config).every(Boolean) && database === 'ok', config, maquettes, database, databaseFingerprint });
      }

      // Notifications de l'outil de maquettes : publiques, authentifiées par leur signature
      // HMAC calculée sur le corps brut. Réponse rapide ; un échec n'est pas renvoyé, la
      // synchronisation (GET /maquettes?since=…) rattrape.
      if (path === '/api/fold/webhook' && method === 'POST') {
        const secret = process.env.FOLD_WEBHOOK_SECRET;
        if (!secret) throw new CrmError("FOLD_WEBHOOK_SECRET n'est pas défini.", 503);
        const raw = await readBody(req, JSON_LIMIT);
        if (!verifySignature(raw, signatureHeader(req.headers), secret)) throw new CrmError('Signature invalide', 401);
        let event: unknown;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new CrmError('JSON invalide');
        }
        if (!event || typeof event !== 'object') throw new CrmError('JSON invalide');
        return send(res, 200, { ok: true, handled: await handleFoldEvent(await deps.getDb(), event as Record<string, unknown>) });
      }

      if (!password) throw new CrmError("CRM_PASSWORD n'est pas défini : l'accès est fermé.", 503);

      if (path === '/api/login' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.password !== 'string' || !checkPassword(body.password, password)) {
          await new Promise(r => setTimeout(r, FAILED_LOGIN_DELAY_MS));
          throw new CrmError('Mot de passe incorrect', 401);
        }
        return send(res, 200, meta, { 'Set-Cookie': sessionCookie(createSession(password), secure) });
      }
      if (path === '/api/logout' && method === 'POST') {
        return send(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie(secure) });
      }

      if (!verifySession(readCookie(req.headers.cookie), password)) throw new CrmError('Connexion requise', 401);

      if (path === '/api/me' && method === 'GET') return send(res, 200, meta);

      if (path === '/api/leads' && method === 'GET') {
        const db = await deps.getDb();
        await refreshMaquettes(db);
        return send(res, 200, { leads: await listLeads(db) });
      }

      const leadMatch = /^\/api\/leads\/([^/]+)$/.exec(path);
      if (leadMatch) {
        const placeId = decodeURIComponent(leadMatch[1]);
        if (method === 'GET') return send(res, 200, await getLead(await deps.getDb(), placeId));
        if (method === 'POST') return send(res, 200, await updateLead(await deps.getDb(), placeId, await readJson(req)));
      }

      if (path === '/api/export.csv' && method === 'GET') {
        const day = new Date().toISOString().slice(0, 10);
        return send(res, 200, await exportCsv(await deps.getDb()), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="leads-${day}.csv"`,
        });
      }

      // Import d'un export Apify depuis le navigateur : ingest puis score, en une fois.
      // L'en-tête X-Filename impose une requête « non simple », donc pas de CSRF possible.
      if (path === '/api/import' && method === 'POST') {
        const filename = basename(String(req.headers['x-filename'] ?? ''));
        if (!filename) throw new CrmError('En-tête X-Filename manquant');
        const db = await deps.getDb();
        const data = await readBody(req, IMPORT_LIMIT);
        try {
          const ingest = await ingestBuffer(db, decodeURIComponent(filename), data);
          return send(res, 200, { ingest, score: await scoreLeads(db) });
        } catch (err) {
          throw new CrmError(`Import impossible : ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      throw new CrmError('Route inconnue', 404);
    } catch (err) {
      if (err instanceof CrmError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Erreur interne' });
    }
  };
}
