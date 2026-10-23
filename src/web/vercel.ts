import { createClient, type Client } from '@libsql/client/web';
import { CrmError } from '../crm.ts';
import { migrate } from '../schema.ts';
import { createHandler } from './handler.ts';

// Point d'entrée de la fonction Vercel (bundlé par scripts/build-vercel.mjs).
let dbPromise: Promise<Client> | undefined;

function getDb(): Promise<Client> {
  dbPromise ??= (async () => {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new CrmError("Base non configurée : ajoute une base Turso au projet Vercel (onglet Storage).", 503);
    const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
    await migrate(db);
    return db;
  })();
  dbPromise.catch(() => (dbPromise = undefined));
  return dbPromise;
}

export default createHandler({ getDb, password: () => process.env.CRM_PASSWORD });
