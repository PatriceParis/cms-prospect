import { existsSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { openDb } from './db.ts';
import { ingestFile } from './ingest.ts';
import { scoreLeads } from './score.ts';

const USAGE = `Usage :
  npm run ingest -- <export Apify .xlsx|.json> [...]
  npm run score`;

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

async function score(db: Client) {
  const r = await scoreLeads(db);
  console.log(`${r.scored} leads scorés.\n`);
  const total = { A: 0, B: 0, C: 0 };
  const cell = (n: number) => String(n).padStart(3);
  console.log(`${'Secteur'.padEnd(22)}   A    B    C`);
  for (const [sector, p] of Object.entries(r.bySector).sort()) {
    console.log(`${sector.padEnd(22)} ${cell(p.A)}  ${cell(p.B)}  ${cell(p.C)}`);
    total.A += p.A;
    total.B += p.B;
    total.C += p.C;
  }
  console.log(`${'Total'.padEnd(22)} ${cell(total.A)}  ${cell(total.B)}  ${cell(total.C)}`);

  const { rows } = await db.execute(`
    SELECT name, google_category, reviews_count, rating, claimed, phone_kind, photos_count, score
    FROM leads WHERE priority = 'A' ORDER BY score DESC, reviews_count DESC`);
  if (rows.length) console.log('\nPriorité A :');
  for (const l of rows) {
    const claim = l.claimed ? 'revendiquée' : 'NON revendiquée';
    console.log(`  ${l.score}/8  ${l.name} (${l.google_category}) — ${l.reviews_count} avis, ${l.rating}★, ${l.photos_count} photos, fiche ${claim}, tél. ${l.phone_kind ?? 'aucun'}`);
  }
}

if (existsSync('.env')) process.loadEnvFile('.env');
const [command, ...args] = process.argv.slice(2);
const db = await openDb();
try {
  if (command === 'ingest') await ingest(db, args);
  else if (command === 'score') await score(db);
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
