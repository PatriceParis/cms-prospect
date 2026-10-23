import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { LOCAL_DB_URL, openDb } from '../db.ts';
import { createHandler } from './handler.ts';

// Serveur local : sert public/ et l'API sur la base Turso du .env, ou sur la base locale
// avec --local (npm run crm:local) : de quoi tester sans jamais écrire en production.
if (existsSync('.env')) process.loadEnvFile('.env');
const local = process.argv.includes('--local');

const PUBLIC_DIR = resolve('public');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 3000));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const db = await openDb(local ? LOCAL_DB_URL : undefined);
const api = createHandler({ getDb: async () => db, password: () => process.env.CRM_PASSWORD });

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) return api(req, res);

  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  const where = local || !process.env.TURSO_DATABASE_URL ? 'base locale data/prospection.db' : 'BASE DE PRODUCTION (Turso)';
  console.log(`CRM : http://localhost:${PORT} · ${where}`);
});
