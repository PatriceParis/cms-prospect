import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { Client } from '@libsql/client';
import { CHANNELS, CRM_STATUSES, CrmError, exportCsv, getLead, listLeads, updateLead } from '../crm.ts';
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

export function createHandler(deps: HandlerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const password = deps.password();

    try {
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

      if (path === '/api/leads' && method === 'GET') return send(res, 200, { leads: await listLeads(await deps.getDb()) });

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
