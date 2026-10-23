import { existsSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { openDb } from './db.ts';
import { ingestFile } from './ingest.ts';

const USAGE = `Usage :
  npm run ingest -- <export Apify .xlsx|.json> [...]`;

async function ingest(db: Client, files: string[]) {
  if (!files.length) throw new Error(USAGE);
  for (const file of files) {
    const r = await ingestFile(db, file);
    console.log(`${r.file} : ${r.rowsRead} lignes lues`);
    console.log(`  ${r.inserted} nouveaux, ${r.updated} mis à jour, ${r.unchanged} inchangés, ${r.duplicates} doublons dans le fichier`);
    if (r.outOfTarget.length) {
      console.log(`  ${r.outOfTarget.length} hors cible (stockés, jamais prospectés) :`);
      for (const o of r.outOfTarget) console.log(`    - ${o.name} — ${o.reason}`);
    }
  }
  const { rows } = await db.execute(`SELECT count(*) AS n FROM leads`);
  console.log(`Base : ${rows[0].n} établissements.`);
}

if (existsSync('.env')) process.loadEnvFile('.env');
const [command, ...args] = process.argv.slice(2);
const db = await openDb();
try {
  if (command === 'ingest') await ingest(db, args);
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
