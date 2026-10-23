import { mkdirSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { migrate } from './schema.ts';

// En local : fichier SQLite. En production : base Turso (libSQL), que l'intégration
// Vercel renseigne dans TURSO_DATABASE_URL et TURSO_AUTH_TOKEN.
export const LOCAL_DB_URL = 'file:data/prospection.db';

export async function openDb(url = process.env.TURSO_DATABASE_URL ?? LOCAL_DB_URL): Promise<Client> {
  const local = url.startsWith('file:');
  if (local) mkdirSync('data', { recursive: true });
  const db = createClient({ url, authToken: local ? undefined : process.env.TURSO_AUTH_TOKEN });
  await migrate(db);
  return db;
}
